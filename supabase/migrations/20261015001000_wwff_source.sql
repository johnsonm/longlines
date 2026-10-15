-- WWFF (World Wide Flora & Fauna) as a sixth source.
-- Spec: docs/superpowers/specs/2026-10-15-wwff-design.md.
--
-- pg_cron calls ingest-wwff once a minute; it polls spots.wwff.co and stores
-- spots in raw_spots through ingest_spots, like POTA. The reference and its
-- name get their own columns. A WWFF spot matches only subscriptions that list
-- wwff (as with DX Cluster), and the Stats snapshot and profiles treat WWFF as
-- a peer of POTA and SOTA.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

alter table raw_spots
  add column wwff_reference      text,
  add column wwff_reference_name text;

comment on column raw_spots.wwff_reference is 'WWFF reference (KFF-5268); wwff spots only';
comment on column raw_spots.wwff_reference_name is 'WWFF reference name as the feed gives it; wwff spots only';

alter table raw_spots drop constraint raw_spots_source_check;
alter table raw_spots add constraint raw_spots_source_check
  check (source in ('pota', 'sotawatch', 'rbn', 'dxcluster', 'wwff'));

alter table ingest_state drop constraint ingest_state_source_check;
alter table ingest_state add constraint ingest_state_source_check
  check (source in ('pota', 'sotawatch', 'rbn', 'dxcluster', 'aprs', 'wwff'));

-- The record_ingest_* RPCs update this row and silently do nothing without it.
insert into ingest_state (source) values ('wwff') on conflict do nothing;

alter table archive_log drop constraint archive_log_source_check;
alter table archive_log add constraint archive_log_source_check
  check (source in ('pota', 'sotawatch', 'rbn', 'dxcluster', 'aprs', 'wwff'));

alter table country_daily_spots drop constraint country_daily_spots_source_check;
alter table country_daily_spots add constraint country_daily_spots_source_check
  check (source in ('pota', 'sotawatch', 'dxcluster', 'rbn', 'wwff'));

-- ---------------------------------------------------------------------------
-- 2. Ingest
-- ---------------------------------------------------------------------------

-- ingest_spots: same as 20261006000014 plus the two WWFF columns.
create or replace function public.ingest_spots(p_spots jsonb)
returns table (id bigint, source text, source_spot_id text)
language sql
security definer
set search_path = public, pgmq
as $$
  with ins as (
    insert into raw_spots (
      source, source_spot_id, content_hash, spot_time, callsign, spotter,
      frequency_khz, band, mode, mode_family, comment,
      pota_reference, pota_park_name, pota_location, sota_summit_ref,
      wwff_reference, wwff_reference_name,
      raw_payload
    )
    select
      x.source, x.source_spot_id, x.content_hash, x.spot_time, x.callsign, x.spotter,
      x.frequency_khz, x.band, x.mode, x.mode_family, coalesce(x.comment, ''),
      x.pota_reference, x.pota_park_name, x.pota_location, x.sota_summit_ref,
      x.wwff_reference, x.wwff_reference_name,
      x.raw_payload
    from jsonb_to_recordset(p_spots) as x(
      source text, source_spot_id text, content_hash text, spot_time timestamptz,
      callsign text, spotter text, frequency_khz numeric, band text, mode text,
      mode_family text, comment text, pota_reference text, pota_park_name text,
      pota_location text, sota_summit_ref text, wwff_reference text,
      wwff_reference_name text, raw_payload jsonb
    )
    on conflict (source, source_spot_id, content_hash) do nothing
    returning raw_spots.id, raw_spots.source, raw_spots.source_spot_id
  ),
  sent as (
    select count(*) as message_count
    from pgmq.send_batch(
      'spot_events',
      coalesce(
        (select array_agg(jsonb_build_object('spot_id', ins.id, 'source', ins.source)) from ins),
        '{}'::jsonb[]
      )
    )
  )
  select ins.id, ins.source, ins.source_spot_id
  from ins cross join sent
  order by ins.id;
$$;

-- Once a minute: the feed is served with max-age=60.
select cron.schedule(
  'ingest-wwff',
  '* * * * *',
  $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'longlines_supabase_url')
             || '/functions/v1/ingest-wwff',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'longlines_service_role_key')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  $$
);

-- ---------------------------------------------------------------------------
-- 3. Matching
-- ---------------------------------------------------------------------------

-- An empty sources list ("any source") leaves out DX Cluster and WWFF: both
-- are opt-in. About half of WWFF spots are US parks that are POTA activations
-- too, so "any source" subscribers would otherwise get duplicate alerts.
create or replace function public.source_matches(p_sources text[], p_source text)
returns boolean
language sql
immutable
as $$
  select case when cardinality(p_sources) = 0 then p_source not in ('dxcluster', 'wwff')
              else p_source = any (p_sources) end;
$$;

-- rule_matches: as in 20261014000500, with the WWFF reference in the
-- reference rule's haystack.
create or replace function public.rule_matches(p_rule jsonb, spot raw_spots)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case when p_rule ->> 'op' in ('is_not', 'not_contains') then not coalesce(h.hit, false)
              else coalesce(h.hit, false) end
  from (
    select case p_rule ->> 'field'
      when 'callsign' then public.callsign_matches(
        array(select jsonb_array_elements_text(p_rule -> 'values')), spot.callsign, spot.base_callsign)
      when 'group' then public.group_matches(
        array(select x::uuid from jsonb_array_elements_text(p_rule -> 'values') as x), spot.base_callsign)
      when 'band' then spot.band in (select jsonb_array_elements_text(p_rule -> 'values'))
      when 'mode' then spot.mode in (select jsonb_array_elements_text(p_rule -> 'values'))
                    or spot.mode_family in (select jsonb_array_elements_text(p_rule -> 'values'))
      when 'reference' then exists (
        select 1 from jsonb_array_elements_text(p_rule -> 'values') as v
        where position(lower(v) in
          lower(concat_ws(',', spot.pota_reference, spot.pota_location, spot.sota_summit_ref,
                          spot.wwff_reference))) > 0)
      when 'frequency' then case p_rule ->> 'op'
        when 'gt' then spot.frequency_khz > (p_rule -> 'values' ->> 0)::numeric
        when 'lt' then spot.frequency_khz < (p_rule -> 'values' ->> 0)::numeric
        else spot.frequency_khz = (p_rule -> 'values' ->> 0)::numeric end
    end as hit
  ) h;
$$;

-- preview_subscription: as in 20261014000500, with the WWFF columns in the
-- spot JSON. Same return type, so the grants carry over.
create or replace function public.preview_subscription(filter jsonb)
returns table (count bigint, spots jsonb, station_count bigint, window_size bigint)
language sql
stable
security definer
set search_path = public
as $$
  with sub as (
    select jsonb_populate_record(null::subscriptions, jsonb_build_object(
      'id', gen_random_uuid(), 'user_id', auth.uid(), 'name', '', 'enabled', true,
      'sources', to_jsonb(public.jsonb_text_array(filter -> 'sources', 'lower')),
      'rules', public.normalize_subscription_rules(filter -> 'rules', auth.uid(), false),
      'quiet_minutes', 0, 'created_at', now(), 'updated_at', now(), 'group_ids', '[]'::jsonb
    )) as s
  ),
  positive as (
    select r ->> 'field' as field, v.value
    from sub
    cross join lateral jsonb_array_elements((sub.s).rules) as g
    cross join lateral jsonb_array_elements(g) as r
    cross join lateral jsonb_array_elements_text(r -> 'values') as v(value)
    where r ->> 'op' = 'is' and r ->> 'field' in ('callsign', 'group')
  ),
  stations as (
    select count(distinct t.b) as n
    from (
      select public.base_callsign(p.value) as b from positive p where p.field = 'callsign'
      union all
      select m.callsign
      from positive p
      join callsign_group_members m on m.group_id::text = p.value
      where p.field = 'group'
    ) t
  ),
  recent as (
    select r.* from raw_spots r, sub
    where r.spot_time > now() - interval '24 hours'
      and (cardinality((sub.s).sources) = 0 or r.source = any ((sub.s).sources))
    order by r.spot_time desc
    limit 200
  ),
  matched as (
    select r.* from recent r, sub where public.spot_matches(sub.s, r)
  )
  select
    (select count(*) from matched),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'spot_time', m.spot_time, 'callsign', m.callsign, 'spotter', m.spotter,
        'frequency_khz', m.frequency_khz, 'band', m.band, 'mode', m.mode, 'mode_family', m.mode_family,
        'comment', m.comment,
        'pota_reference', m.pota_reference, 'pota_park_name', m.pota_park_name,
        'pota_location', m.pota_location, 'sota_summit_ref', m.sota_summit_ref,
        'wwff_reference', m.wwff_reference, 'wwff_reference_name', m.wwff_reference_name,
        'source', m.source
      ) order by m.spot_time desc)
      from matched m
    ), '[]'::jsonb),
    (select n from stations),
    (select count(*) from recent)
  where auth.uid() is not null;
$$;

-- ---------------------------------------------------------------------------
-- 4. Delivery
-- ---------------------------------------------------------------------------

-- claim_deliveries: as in 20261014000100, with the WWFF columns in the spot.
create or replace function public.claim_deliveries(p_limit int default 200, p_vt int default 60)
returns table (
  msg_id bigint, delivery_id bigint, subscription_id uuid, attempts int, created_at timestamptz,
  destination jsonb, spot jsonb
)
language plpgsql
security definer
set search_path = public, pgmq
as $$
declare
  v_msgs    jsonb;
  v_orphans bigint[];
begin
  select jsonb_agg(jsonb_build_object('msg_id', m.msg_id, 'delivery_id', (m.message ->> 'delivery_id')::bigint))
    into v_msgs
  from pgmq.read('deliveries_queue', p_vt, p_limit) m;

  if v_msgs is null then
    return;
  end if;

  select array_agg((x ->> 'msg_id')::bigint) into v_orphans
  from jsonb_array_elements(v_msgs) x
  where not exists (select 1 from deliveries d where d.id = (x ->> 'delivery_id')::bigint);
  if v_orphans is not null then
    perform pgmq.archive('deliveries_queue', v_orphans);
  end if;

  return query
    select
      (x ->> 'msg_id')::bigint,
      d.id, d.subscription_id, d.attempts, d.created_at,
      jsonb_build_object(
        'id', dest.id, 'type', dest.type, 'name', dest.name, 'url', dest.url,
        'signing_secret', dest.signing_secret, 'health', dest.health,
        'consecutive_failures', dest.consecutive_failures
      ) || case when dest.type = 'push' then jsonb_build_object('devices', dv.devices) else '{}'::jsonb end,
      jsonb_build_object(
        'id', r.id, 'source', r.source, 'spot_time', r.spot_time, 'callsign', r.callsign,
        'base_callsign', r.base_callsign,
        'spotter', r.spotter, 'frequency_khz', r.frequency_khz, 'band', r.band, 'mode', r.mode,
        'mode_family', r.mode_family,
        'comment', r.comment, 'pota_reference', r.pota_reference, 'pota_park_name', r.pota_park_name,
        'pota_location', r.pota_location, 'sota_summit_ref', r.sota_summit_ref,
        'wwff_reference', r.wwff_reference, 'wwff_reference_name', r.wwff_reference_name
      )
    from jsonb_array_elements(v_msgs) x
    join deliveries d on d.id = (x ->> 'delivery_id')::bigint
    join destinations dest on dest.id = d.destination_id
    join raw_spots r on r.id = d.spot_id
    cross join lateral (
      select coalesce(jsonb_agg(jsonb_build_object('endpoint', p.endpoint, 'p256dh', p.p256dh, 'auth', p.auth)
                                order by p.created_at, p.id), '[]'::jsonb) as devices
      from push_devices p
      where dest.type = 'push' and p.user_id = dest.user_id
    ) dv
    order by d.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Read models
-- ---------------------------------------------------------------------------

-- recent_spots gains the WWFF columns before source. "create or replace view"
-- can only append, so recreate it and list_recent_spots, which returns its row
-- type. Invoker view, no client grants (20261006000020); clients read it
-- through list_recent_spots.
drop function public.list_recent_spots(text, int);
drop view recent_spots;

create view recent_spots with (security_invoker = true) as
select
  id, spot_time, callsign, spotter, frequency_khz, band, mode, mode_family, comment,
  pota_reference, pota_park_name, pota_location, sota_summit_ref,
  wwff_reference, wwff_reference_name, source
from raw_spots
where spot_time > now() - interval '24 hours';

revoke all on recent_spots from anon, authenticated;

-- As in 20261011000009, with two more nulls on the RBN branch.
create function public.list_recent_spots(p_source text, max_rows int)
returns setof recent_spots
language sql
stable
security definer
set search_path = public
as $$
  (select * from recent_spots
   where p_source <> 'rbn' and source = p_source
   order by spot_time desc
   limit max_rows)
  union all
  (select null::bigint, r.spot_time, r.callsign, r.spotter, r.frequency_khz, r.band, r.mode, r.mode_family,
          format('%s dB %s %s %s', r.snr, r.speed, r.speed_unit, r.spot_type),
          null, null, null, null, null, null, 'rbn'
   from rbn_spots r
   where p_source = 'rbn' and r.spot_time > now() - interval '24 hours'
   order by r.spot_time desc
   limit max_rows);
$$;

revoke all on function public.list_recent_spots(text, int) from public, anon, authenticated;
grant execute on function public.list_recent_spots(text, int) to authenticated;

-- list_callsign_groups: as in 20261013000210, with the WWFF reference in the
-- on-air spot. Same return type, so create or replace keeps the grants.
create or replace function public.list_callsign_groups()
returns table (id uuid, name text, callsigns text[], member_count bigint, subscription_count bigint,
               updated_at timestamptz, on_air jsonb)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  return query
  select
    g.id,
    g.name,
    m.calls,
    cardinality(m.calls)::bigint,
    (select count(*) from subscriptions s where s.user_id = v_user and g.id = any (s.group_ids)),
    g.updated_at,
    jsonb_build_object('count', a.n, 'latest', a.latest)
  from callsign_groups g
  cross join lateral (
    select coalesce(array_agg(cm.callsign order by cm.callsign), '{}') as calls
    from callsign_group_members cm
    where cm.group_id = g.id
  ) m
  cross join lateral (
    select count(distinct r.base_callsign) as n,
           (array_agg(jsonb_build_object(
              'callsign', r.callsign, 'frequency_khz', r.frequency_khz, 'band', r.band, 'mode', r.mode,
              'source', r.source, 'reference', coalesce(r.pota_reference, r.sota_summit_ref, r.wwff_reference),
              'spot_time', r.spot_time)
            order by r.spot_time desc, r.id desc))[1] as latest
    from callsign_group_members cm
    join raw_spots r on r.base_callsign = cm.callsign and r.spot_time > now() - interval '30 minutes'
    where cm.group_id = g.id
  ) a
  where g.user_id = v_user
  order by lower(g.name);
end;
$$;

-- spot_stream: as in 20261012000040, with WWFF as a third program. Same
-- columns, so create or replace keeps the view's privileges.
create or replace view spot_stream with (security_invoker = true) as
select r.source,
       r.spot_time,
       r.callsign,
       r.base_callsign,
       r.spotter,
       public.base_callsign(r.spotter)          as spotter_base,
       r.frequency_khz,
       r.band,
       r.mode,
       public.mode_bucket(r.mode, r.mode_family) as mode_bucket,
       null::smallint                            as snr,
       case when r.pota_reference is not null then 'POTA'
            when r.sota_summit_ref is not null then 'SOTA'
            when r.wwff_reference is not null then 'WWFF' end as program,
       coalesce(r.pota_reference, r.sota_summit_ref, r.wwff_reference) as reference,
       case when r.pota_reference is not null then r.pota_park_name
            when r.sota_summit_ref is null then r.wwff_reference_name end as reference_name,
       case when r.pota_reference is not null then r.pota_location end  as reference_location
from raw_spots r
where r.source <> 'rbn'
union all
select 'rbn',
       s.spot_time,
       s.callsign,
       public.base_callsign(s.callsign),
       s.spotter,
       public.base_callsign(s.spotter),
       s.frequency_khz,
       s.band,
       s.mode,
       public.mode_bucket(s.mode, s.mode_family),
       s.snr,
       null, null, null, null
from rbn_spots s;

-- ---------------------------------------------------------------------------
-- 6. Archive
-- ---------------------------------------------------------------------------

create or replace function public.archive_slice_minutes(p_source text)
returns int
language sql
immutable
set search_path = ''
as $$
  select case p_source
           when 'rbn' then 10
           when 'pota' then 60
           when 'sotawatch' then 60
           when 'dxcluster' then 60
           when 'wwff' then 60
           when 'aprs' then 5
         end;
$$;

-- archive_columns: as in 20261014000400, with wwff in the raw_spots branch and
-- the two WWFF columns in every raw_spots source's files.
create or replace function public.archive_columns(p_source text, p_from timestamptz, p_to timestamptz)
returns table (row_count int, columns json)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_source = 'rbn' then
    return query
      select count(*)::int,
             case when count(*) > 0 then json_build_object(
               'spot_time', json_agg((extract(epoch from r.spot_time) * 1000)::bigint order by r.o),
               'received_at', json_agg((extract(epoch from r.received_at) * 1000)::bigint order by r.o),
               'spotter', json_agg(r.spotter order by r.o),
               'callsign', json_agg(r.callsign order by r.o),
               'frequency_khz', json_agg(r.frequency_khz order by r.o),
               'band', json_agg(r.band order by r.o),
               'mode', json_agg(r.mode order by r.o),
               'mode_family', json_agg(r.mode_family order by r.o),
               'snr', json_agg(r.snr order by r.o),
               'speed', json_agg(r.speed order by r.o),
               'speed_unit', json_agg(r.speed_unit order by r.o),
               'spot_type', json_agg(r.spot_type order by r.o),
               'line', json_agg(r.line order by r.o)
             ) end
      from (
        select x.*,
               row_number() over (order by x.spot_time, x.spotter, x.callsign, x.frequency_khz) as o
        from rbn_spots x
        where x.spot_time >= p_from and x.spot_time < p_to
      ) r;
  elsif p_source = 'aprs' then
    -- Every column but line_md5, which only orders packets received in the same instant.
    return query
      select count(*)::int,
             case when count(*) > 0 then json_build_object(
               'received_at', json_agg((extract(epoch from r.received_at) * 1000)::bigint order by r.o),
               'source_call', json_agg(r.source_call order by r.o),
               'destination', json_agg(r.destination order by r.o),
               'path', json_agg(r.path order by r.o),
               'q_construct', json_agg(r.q_construct order by r.o),
               'igate', json_agg(r.igate order by r.o),
               'packet_type', json_agg(r.packet_type order by r.o),
               'line', json_agg(r.line order by r.o)
             ) end
      from (
        select x.*, row_number() over (order by x.received_at, x.line_md5) as o
        from aprs_packets x
        where x.received_at >= p_from and x.received_at < p_to
      ) r;
  elsif p_source in ('pota', 'sotawatch', 'dxcluster', 'wwff') then
    return query
      select count(*)::int,
             case when count(*) > 0 then json_build_object(
               'source', json_agg(r.source order by r.o),
               'source_spot_id', json_agg(r.source_spot_id order by r.o),
               'content_hash', json_agg(r.content_hash order by r.o),
               'spot_time', json_agg((extract(epoch from r.spot_time) * 1000)::bigint order by r.o),
               'ingested_at', json_agg((extract(epoch from r.ingested_at) * 1000)::bigint order by r.o),
               'callsign', json_agg(r.callsign order by r.o),
               'spotter', json_agg(r.spotter order by r.o),
               'frequency_khz', json_agg(r.frequency_khz order by r.o),
               'band', json_agg(r.band order by r.o),
               'mode', json_agg(r.mode order by r.o),
               'mode_family', json_agg(r.mode_family order by r.o),
               'comment', json_agg(r.comment order by r.o),
               'pota_reference', json_agg(r.pota_reference order by r.o),
               'pota_park_name', json_agg(r.pota_park_name order by r.o),
               'pota_location', json_agg(r.pota_location order by r.o),
               'sota_summit_ref', json_agg(r.sota_summit_ref order by r.o),
               'wwff_reference', json_agg(r.wwff_reference order by r.o),
               'wwff_reference_name', json_agg(r.wwff_reference_name order by r.o),
               'raw_payload', json_agg(r.raw_payload::text order by r.o)
             ) end
      from (
        select x.*,
               row_number() over (order by x.spot_time, x.source_spot_id, x.content_hash) as o
        from raw_spots x
        where x.source = p_source and x.spot_time >= p_from and x.spot_time < p_to
      ) r;
  else
    raise exception 'unknown archive source: %', p_source;
  end if;
end;
$$;

create or replace view archive_status with (security_invoker = true) as
select s.source,
       (select max(l.slice_end) from archive_log l where l.source = s.source) as archived_through,
       (select count(*) from public.archive_pending_slices(s.source, now() - interval '2 hours', 100000))
         as pending_slices
from (values ('pota'), ('sotawatch'), ('rbn'), ('dxcluster'), ('aprs'), ('wwff')) as s(source);

-- ---------------------------------------------------------------------------
-- 7. Stats
-- ---------------------------------------------------------------------------

-- rollup_country_day: as in 20261015000100, with WWFF among the raw_spots
-- sources. Days already rolled up stay as they are.
create or replace function public.rollup_country_day(p_day date)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from timestamptz := p_day::timestamp at time zone 'utc';
  v_to   timestamptz := (p_day + 1)::timestamp at time zone 'utc';
begin
  if not exists (select 1 from cty_load) then
    return false;
  end if;

  delete from country_daily_spots where day = p_day;

  with calls as materialized (
    select r.source, r.callsign, count(*)::int as n
    from raw_spots r
    where r.spot_time >= v_from and r.spot_time < v_to
      and r.source in ('pota', 'sotawatch', 'dxcluster', 'wwff')
    group by r.source, r.callsign
    union all
    select 'rbn', s.callsign, s.spots
    from rbn_daily_stations s
    where s.day = p_day
  ),
  geo as materialized (
    select d.callsign, l.entity
    from (select distinct callsign from calls) d
    cross join lateral public.cty_lookup(d.callsign) l
  )
  insert into country_daily_spots (day, source, entity, spots)
  select p_day, c.source, g.entity, sum(c.n)::int
  from calls c
  join geo g using (callsign)
  group by c.source, g.entity;

  insert into country_rollup_days (day, rolled_at) values (p_day, now())
  on conflict (day) do update set rolled_at = excluded.rolled_at;
  return true;
end;
$$;

-- refresh_stats_snapshot_at, as in 20261015000100, with WWFF as a peer of POTA
-- and SOTA: in the activity window and every figure drawn from it, a wwff key
-- in daily, hourly, bands and countries, wwffSpots/wwffActivations/wwffChasers
-- in totals, and payload.wwffPrograms (top 10 national programs by spots, the
-- counterpart of sotaAssociations). See 20261014000200 for the rest of the header.
create or replace function public.refresh_stats_snapshot_at(p_now timestamptz)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_end   timestamptz := date_trunc('day', p_now at time zone 'utc') at time zone 'utc';
  v_window_start timestamptz := (date_trunc('day', p_now at time zone 'utc') - interval '7 days') at time zone 'utc';
  v_first_day    date        := (p_now at time zone 'utc')::date - 7;
  v_end_day      date        := (p_now at time zone 'utc')::date;
  v_hour_end     timestamptz := date_trunc('hour', p_now at time zone 'utc') at time zone 'utc';
  v_hour_start   timestamptz := (date_trunc('hour', p_now at time zone 'utc') - interval '7 days') at time zone 'utc';
  v_day          date;
  v_rolled       boolean     := false;
  v_from         timestamptz;
begin
  -- RBN rollups: every window day without one, and any day rolled up within
  -- an hour of its end (see 20261011000007).
  for v_day in
    select v_first_day + i
    from generate_series(0, 6) as i
    left join rbn_rollup_days l on l.day = v_first_day + i
    where l.day is null
       or l.rolled_at < (v_first_day + i + 1)::timestamp at time zone 'utc' + interval '1 hour'
    order by i
  loop
    perform public.rollup_rbn_day(v_day);
    v_rolled := true;
  end loop;
  delete from rbn_hourly where hour < v_window_start;
  delete from rbn_daily_skimmers where day < v_first_day;
  delete from rbn_daily_stations where day < v_first_day;
  delete from rbn_rollup_days where day < v_first_day;

  -- RBN hours of today for the hourly series: every complete hour without a
  -- count, and any hour counted within an hour of its end, recounted from the
  -- oldest such hour up to now in one range scan (see the header). Hours of
  -- earlier days belong to the day rollups.
  select min(h) into v_from
  from generate_series(v_window_end, v_hour_end - interval '1 hour', interval '1 hour') as h
  left join rbn_rollup_hours l on l.hour = h
  where l.hour is null or l.rolled_at < h + interval '2 hours';
  if v_from is not null then
    perform public.rollup_rbn_hours(v_from, v_hour_end);
  end if;
  delete from rbn_rollup_hours where hour < v_window_end;

  -- APRS rollups (20261014000030): the same rule as the RBN days. Retention
  -- keeps a day until it has a final rollup, so a re-roll never finds it gone.
  for v_day in
    select v_first_day + i
    from generate_series(0, 6) as i
    left join aprs_rollup_days l on l.day = v_first_day + i
    where l.day is null
       or l.rolled_at < (v_first_day + i + 1)::timestamp at time zone 'utc' + interval '1 hour'
    order by i
  loop
    perform public.rollup_aprs_day(v_day);
  end loop;
  delete from aprs_daily_stations where day < v_first_day;
  delete from aprs_daily_igates where day < v_first_day;
  delete from aprs_daily_types where day < v_first_day;

  -- Country rollups (20261015000100): the same rule again, after the RBN
  -- days so rbn_daily_stations is final. A day is skipped, not marked, while
  -- no cty.dat is loaded, so it rolls up once import-cty has run.
  for v_day in
    select v_first_day + i
    from generate_series(0, 6) as i
    left join country_rollup_days l on l.day = v_first_day + i
    where l.day is null
       or l.rolled_at < (v_first_day + i + 1)::timestamp at time zone 'utc' + interval '1 hour'
    order by i
  loop
    perform public.rollup_country_day(v_day);
  end loop;
  delete from country_daily_spots where day < v_first_day;
  delete from country_rollup_days where day < v_first_day;

  -- Most heard stations by base call, recounted only when a day rollup changed
  -- or the window moved (see 20261012000090).
  if v_rolled or not exists (select 1 from rbn_top_stations where window_start = v_window_start) then
    delete from rbn_top_stations;
    insert into rbn_top_stations (window_start, callsign, spots, skimmers)
    with week as materialized (
      select callsign, sum(spots) as n
      from rbn_daily_stations
      where day >= v_first_day and day < v_end_day
      group by callsign
    ),
    bases as materialized (
      select public.base_callsign(callsign) as base, n from week
    ),
    top as (
      select base, sum(n)::int as n
      from bases
      group by base
      order by n desc, base asc
      limit 8
    )
    select v_window_start, t.base, t.n,
           (select count(distinct r.spotter)
            from rbn_spots r
            where public.base_callsign(r.callsign) = t.base
              and r.spot_time >= v_window_start and r.spot_time < v_window_end)
    from top t;
  end if;

  insert into stats_snapshots (window_start, window_end, payload)
  with
  -- Every in-window row.
  in_window as (
    select r.*
    from raw_spots r
    where r.spot_time >= v_window_start
      and r.spot_time <  v_window_end
      -- The page describes POTA, SOTA and WWFF activity. Any other source (RBN
      -- skimmer reports of watched callsigns, DX Cluster) is not an activation
      -- and stays out.
      and r.source in ('pota', 'sotawatch', 'wwff')
  ),
  -- base_callsign() once per distinct spotter, not per row (see the header).
  spotter_bases as materialized (
    select d.spotter, public.base_callsign(d.spotter) as base
    from (select distinct spotter from in_window where spotter is not null) as d
  ),
  -- Every in-window row with its UTC day and hour.
  spots as (
    select r.id, r.source, r.spot_time, r.callsign, r.spotter, r.band, r.mode, r.mode_family,
           r.pota_reference, r.pota_park_name, r.pota_location, r.sota_summit_ref,
           r.wwff_reference, r.wwff_reference_name,
           to_char(r.spot_time at time zone 'utc', 'YYYY-MM-DD') as day,
           extract(hour from r.spot_time at time zone 'utc')::int as hour,
           -- A chaser spot has a spotter who is not the activator: is_self_spot's
           -- rule, on base calls already resolved.
           (r.spotter is not null and not coalesce(sb.base = r.base_callsign, false)) as chased
    from in_window r
    left join spotter_bases sb on sb.spotter = r.spotter
  ),
  totals as (
    select count(*)                                                         as spots,
           count(*) filter (where source = 'pota')                          as pota_spots,
           count(*) filter (where source = 'sotawatch')                     as sota_spots,
           count(*) filter (where source = 'wwff')                          as wwff_spots,
           count(distinct callsign)                                         as activators,
           count(distinct pota_reference) + count(distinct sota_summit_ref)
             + count(distinct wwff_reference)                               as references,
           -- Activations: distinct (callsign, reference, UTC day) per program.
           count(distinct (callsign, pota_reference, day)) filter (where pota_reference is not null)  as pota_activations,
           count(distinct (callsign, sota_summit_ref, day)) filter (where sota_summit_ref is not null) as sota_activations,
           count(distinct (callsign, wwff_reference, day)) filter (where wwff_reference is not null)   as wwff_activations,
           -- Chasers: distinct spotters on chased spots, overall and per source.
           count(distinct spotter) filter (where chased)                            as chasers,
           count(distinct spotter) filter (where chased and source = 'pota')        as pota_chasers,
           count(distinct spotter) filter (where chased and source = 'sotawatch')   as sota_chasers,
           count(distinct spotter) filter (where chased and source = 'wwff')        as wwff_chasers
    from spots
  ),
  -- Hour of day with the most spots summed over all seven days.
  peak_hour as (
    select hour from spots
    group by hour
    order by count(*) desc, hour asc
    limit 1
  ),
  -- The single busiest (day, hour) bucket.
  busiest_slot as (
    select day, hour from spots
    group by day, hour
    order by count(*) desc, day asc, hour asc
    limit 1
  ),
  -- daily: exactly seven days, oldest first, zero-filled. Day arithmetic is
  -- done on a date so a DST change in the session zone cannot skip a day.
  days as (
    select to_char((v_window_start at time zone 'utc')::date + i, 'YYYY-MM-DD') as day
    from generate_series(0, 6) as i
  ),
  daily_counts as (
    select day,
           count(*) filter (where source = 'pota')      as pota,
           count(*) filter (where source = 'sotawatch') as sota,
           count(*) filter (where source = 'wwff')      as wwff
    from spots
    group by day
  ),
  daily_rbn as (
    select to_char(hour at time zone 'utc', 'YYYY-MM-DD') as day, sum(spots) as rbn
    from rbn_hourly
    where hour >= v_window_start and hour < v_window_end
    group by 1
  ),
  daily_aprs as (
    select to_char(hour_start at time zone 'utc', 'YYYY-MM-DD') as day, sum(packets) as aprs
    from aprs_packet_hours
    where hour_start >= v_window_start and hour_start < v_window_end
    group by 1
  ),
  daily_dx as (
    select to_char(spot_time at time zone 'utc', 'YYYY-MM-DD') as day, count(*) as dx
    from raw_spots
    where source = 'dxcluster'
      and spot_time >= v_window_start
      and spot_time <  v_window_end
    group by 1
  ),
  daily as (
    select jsonb_agg(
             jsonb_build_object('day', d.day, 'pota', coalesce(c.pota, 0), 'sota', coalesce(c.sota, 0),
                                'wwff', coalesce(c.wwff, 0), 'rbn', coalesce(r.rbn, 0), 'aprs', coalesce(a.aprs, 0), 'dx', coalesce(x.dx, 0))
             order by d.day
           ) as v
    from days d
    left join daily_counts c using (day)
    left join daily_rbn r using (day)
    left join daily_aprs a using (day)
    left join daily_dx x using (day)
  ),
  -- hourly: exactly 168 hours, oldest first, zero-filled, ending at the last
  -- complete hour rather than at window_end (see the header). POTA,
  -- SOTAwatch and WWFF come from raw_spots over those hours, RBN from the rollups.
  slots as (
    select generate_series(v_hour_start, v_hour_end - interval '1 hour', interval '1 hour') as slot
  ),
  slot_counts as (
    select date_bin(interval '1 hour', r.spot_time, timestamptz '2000-01-01 00:00+00') as slot,
           count(*) filter (where r.source = 'pota')      as pota,
           count(*) filter (where r.source = 'sotawatch') as sota,
           count(*) filter (where r.source = 'wwff')      as wwff
    from raw_spots r
    where r.spot_time >= v_hour_start
      and r.spot_time <  v_hour_end
      and r.source in ('pota', 'sotawatch', 'wwff')
    group by 1
  ),
  slot_dx as (
    select date_bin(interval '1 hour', r.spot_time, timestamptz '2000-01-01 00:00+00') as slot,
           count(*) as dx
    from raw_spots r
    where r.source = 'dxcluster'
      and r.spot_time >= v_hour_start
      and r.spot_time <  v_hour_end
    group by 1
  ),
  hourly as (
    select jsonb_agg(
             jsonb_build_object(
               'hour', to_char(s.slot at time zone 'utc', 'YYYY-MM-DD"T"HH24":00:00Z"'),
               'pota', coalesce(c.pota, 0), 'sota', coalesce(c.sota, 0), 'wwff', coalesce(c.wwff, 0),
               'rbn', coalesce(h.spots, 0),
               'aprs', coalesce(ah.packets, 0), 'dx', coalesce(sx.dx, 0)
             )
             order by s.slot
           ) as v
    from slots s
    left join slot_counts c using (slot)
    left join rbn_hourly h on h.hour = s.slot
    left join aprs_packet_hours ah on ah.hour_start = s.slot
    left join slot_dx sx on sx.slot = s.slot
  ),
  -- potaByState: 50 states + DC, zero-filled. pota_location is a raw
  -- comma-separated list ("US-NC,US-VA"); a park spanning two states counts
  -- once in each. Entries are trimmed because upstream sometimes pads after
  -- the comma. Non-US entries and US territories (US-PR, US-GU, ...) fall out
  -- of the join and are ignored.
  states as (
    select unnest(array[
      'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME',
      'MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI',
      'SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'
    ]) as code
  ),
  state_counts as (
    select substr(trim(x), 4, 2) as code, count(*) as n
    from spots s, regexp_split_to_table(s.pota_location, ',') as x
    where trim(x) ~ '^US-[A-Z]{2}$'
    group by 1
  ),
  pota_by_state as (
    select jsonb_object_agg(st.code, coalesce(sc.n, 0)) as v
    from states st
    left join state_counts sc using (code)
  ),
  -- countries: every country with a spot in the window, from the day rollups,
  -- busiest first. A country is ISO 3166-1 alpha-2 through
  -- cty_entity_countries, so England and Scotland are both GB and Alaska is
  -- US; an entity with no country (Spratly Islands) is left out.
  country_counts as (
    select c.country as code,
           coalesce(sum(d.spots) filter (where d.source = 'pota'), 0)      as pota,
           coalesce(sum(d.spots) filter (where d.source = 'sotawatch'), 0) as sota,
           coalesce(sum(d.spots) filter (where d.source = 'wwff'), 0)      as wwff,
           coalesce(sum(d.spots) filter (where d.source = 'dxcluster'), 0) as dx,
           coalesce(sum(d.spots) filter (where d.source = 'rbn'), 0)       as rbn
    from country_daily_spots d
    join cty_entity_countries c using (entity)
    where d.day >= v_first_day and d.day < v_end_day
    group by c.country
  ),
  countries as (
    select coalesce(
             jsonb_agg(jsonb_build_object('code', code, 'pota', pota, 'sota', sota, 'wwff', wwff,
                                          'dx', dx, 'rbn', rbn)
                       order by pota + sota + wwff + dx + rbn desc, code asc),
             '[]'::jsonb
           ) as v
    from country_counts
  ),
  -- sotaAssociations: top 10 by spots; the association is the part before
  -- the first '/', so refs without a '/' are skipped.
  sota_association_counts as (
    select split_part(sota_summit_ref, '/', 1) as code, count(*) as n
    from spots
    where sota_summit_ref like '%/%'
    group by 1
    order by n desc, code asc
    limit 10
  ),
  sota_associations as (
    select coalesce(
             jsonb_agg(jsonb_build_object('code', code, 'spots', n) order by n desc, code asc),
             '[]'::jsonb
           ) as v
    from sota_association_counts
  ),
  -- wwffPrograms: top 10 by spots; the national program is the part before
  -- the first '-' (KFF-5268 is KFF), so refs without a '-' are skipped.
  wwff_program_counts as (
    select split_part(wwff_reference, '-', 1) as code, count(*) as n
    from spots
    where wwff_reference like '%-%'
    group by 1
    order by n desc, code asc
    limit 10
  ),
  wwff_programs as (
    select coalesce(
             jsonb_agg(jsonb_build_object('code', code, 'spots', n) order by n desc, code asc),
             '[]'::jsonb
           ) as v
    from wwff_program_counts
  ),
  -- bands: fixed order, zero-filled; other bands and null are excluded here
  -- but still counted in totals.
  band_order as (
    select * from (values
      ('160m', 1), ('80m', 2), ('60m', 3), ('40m', 4), ('30m', 5), ('20m', 6),
      ('17m', 7), ('15m', 8), ('12m', 9), ('10m', 10), ('6m', 11), ('2m', 12)
    ) as b(band, ord)
  ),
  band_counts as (
    select band,
           count(*) filter (where source = 'pota')      as pota,
           count(*) filter (where source = 'sotawatch') as sota,
           count(*) filter (where source = 'wwff')      as wwff
    from spots
    where band is not null
    group by band
  ),
  bands as (
    select jsonb_agg(
             jsonb_build_object('band', bo.band, 'pota', coalesce(c.pota, 0), 'sota', coalesce(c.sota, 0),
                                'wwff', coalesce(c.wwff, 0))
             order by bo.ord
           ) as v
    from band_order bo
    left join band_counts c using (band)
  ),
  -- modes: five fixed labels, integer percents that sum to exactly 100.
  -- The labels are mode_bucket() (20261012000040), which profiles use too;
  -- a null mode is Other.
  -- Each share is rounded (round() is half away from zero), then whatever is
  -- left over after rounding (100 - sum, possibly negative) is added to the
  -- bucket with the most spots. With no spots every percent is 0.
  mode_labels as (
    select * from (values ('CW', 1), ('SSB', 2), ('FT8/FT4', 3), ('FM', 4), ('Other', 5)) as l(label, ord)
  ),
  mode_counts as (
    select public.mode_bucket(mode, mode_family) as label, count(*) as n
    from spots
    group by 1
  ),
  mode_rounded as (
    select l.label, l.ord, coalesce(c.n, 0) as n,
           case when t.spots = 0 then 0
                else round(100.0 * coalesce(c.n, 0) / t.spots)::int
           end as pct
    from mode_labels l
    left join mode_counts c using (label)
    cross join totals t
  ),
  mode_fixed as (
    select label, ord,
           case when sum(pct) over () = 0 then 0
                when row_number() over (order by n desc, ord asc) = 1
                  then pct + (100 - sum(pct) over ())::int
                else pct
           end as percent
    from mode_rounded
  ),
  modes as (
    select jsonb_agg(jsonb_build_object('label', label, 'percent', percent) order by ord) as v
    from mode_fixed
  ),
  -- topActivators: top 8 by distinct references, then spots, then callsign.
  -- activations is per (reference, UTC day) within the callsign; base is the
  -- profile the Stats page links to.
  activators as (
    select callsign,
           count(distinct pota_reference) + count(distinct sota_summit_ref)
             + count(distinct wwff_reference) as refs,
           count(distinct (pota_reference, day)) filter (where pota_reference is not null)
             + count(distinct (sota_summit_ref, day)) filter (where sota_summit_ref is not null)
             + count(distinct (wwff_reference, day)) filter (where wwff_reference is not null) as activations,
           count(*) as n
    from spots
    group by callsign
    order by refs desc, n desc, callsign asc
    limit 8
  ),
  activator_bands as (
    select callsign, band,
           row_number() over (partition by callsign order by count(*) desc, band asc) as rn
    from spots
    where band is not null
      and callsign in (select callsign from activators)
    group by callsign, band
  ),
  top_activators as (
    select coalesce(
             jsonb_agg(
               jsonb_build_object('callsign', a.callsign, 'base', public.base_callsign(a.callsign),
                                  'references', a.refs, 'activations', a.activations,
                                  'spots', a.n, 'topBand', ab.band)
               order by a.refs desc, a.n desc, a.callsign asc
             ),
             '[]'::jsonb
           ) as v
    from activators a
    left join activator_bands ab on ab.callsign = a.callsign and ab.rn = 1
  ),
  -- topReferences: top 8 across the three programs by spots.
  -- activations is per (callsign, UTC day) within the reference.
  reference_counts as (
    select pota_reference as reference, 'POTA' as program, count(*) as n,
           count(distinct (callsign, day)) as activations
    from spots
    where pota_reference is not null
    group by pota_reference
    union all
    select sota_summit_ref, 'SOTA', count(*), count(distinct (callsign, day))
    from spots
    where sota_summit_ref is not null
    group by sota_summit_ref
    union all
    select wwff_reference, 'WWFF', count(*), count(distinct (callsign, day))
    from spots
    where wwff_reference is not null
    group by wwff_reference
  ),
  top_reference_rows as (
    select * from reference_counts
    order by n desc, reference asc
    limit 8
  ),
  -- The name is looked up only for the eight kept rows: the most recent
  -- non-null pota_park_name or wwff_reference_name by spot_time; SOTA has no name.
  top_reference_names as (
    select r.reference, r.program, r.n, r.activations,
           case when r.program = 'POTA' then (
             select s.pota_park_name
             from spots s
             where s.pota_reference = r.reference and s.pota_park_name is not null
             order by s.spot_time desc
             limit 1
           ) when r.program = 'WWFF' then (
             select s.wwff_reference_name
             from spots s
             where s.wwff_reference = r.reference and s.wwff_reference_name is not null
             order by s.spot_time desc
             limit 1
           ) end as name
    from top_reference_rows r
  ),
  top_references as (
    select coalesce(
             jsonb_agg(
               jsonb_build_object('reference', reference, 'name', name, 'program', program,
                                  'activations', activations, 'spots', n)
               order by n desc, reference asc
             ),
             '[]'::jsonb
           ) as v
    from top_reference_names
  ),
  -- rbn: everything below reads the rollup tables, never rbn_spots. Skimmers
  -- are distinct callsigns over the whole week, counted as stored.
  rbn_skimmer_rows as (
    select spotter, band, spots from rbn_daily_skimmers
    where day >= v_first_day and day < v_end_day
  ),
  rbn_totals as (
    select (select coalesce(sum(spots), 0) from rbn_hourly
             where hour >= v_window_start and hour < v_window_end) as spots,
           (select count(distinct spotter) from rbn_skimmer_rows)  as skimmers
  ),
  -- RBN bands: the same fixed order as bands, zero-filled, so the three band
  -- charts share an axis. Other bands and null are counted in spots only.
  rbn_band_counts as (
    select band, sum(spots) as n from rbn_skimmer_rows where band is not null group by band
  ),
  rbn_bands as (
    select jsonb_agg(jsonb_build_object('band', bo.band, 'spots', coalesce(c.n, 0)) order by bo.ord) as v
    from band_order bo
    left join rbn_band_counts c using (band)
  ),
  rbn as (
    select jsonb_build_object(
             'spots', t.spots, 'skimmers', t.skimmers,
             'bands', b.v,
             'topStations', coalesce(
               (select jsonb_agg(
                         jsonb_build_object('callsign', callsign, 'spots', spots, 'skimmers', skimmers)
                         order by spots desc, callsign asc
                       )
                from rbn_top_stations
                where window_start = v_window_start),
               '[]'::jsonb
             )
           ) as v
    from rbn_totals t
    cross join rbn_bands b
  ),
  -- aprs: packets from aprs_packet_hours, the rest from the day rollups; never
  -- aprs_packets. Stations and igates are distinct over the whole week.
  aprs_type_order as (
    select unnest(array[
      'position', 'mic_e', 'object', 'item', 'message', 'status', 'weather',
      'telemetry', 'nmea', 'third_party', 'capabilities', 'query', 'user_defined', 'other'
    ]) as type
  ),
  aprs_type_counts as (
    select packet_type as type, sum(packets) as n
    from aprs_daily_types
    where day >= v_first_day and day < v_end_day
    group by 1
  ),
  aprs as (
    select jsonb_build_object(
             'packets', (select coalesce(sum(packets), 0) from aprs_packet_hours
                         where hour_start >= v_window_start and hour_start < v_window_end),
             'stations', (select count(distinct base) from aprs_daily_stations
                          where day >= v_first_day and day < v_end_day),
             'igates', (select count(distinct igate) from aprs_daily_igates
                        where day >= v_first_day and day < v_end_day),
             'types', (select jsonb_agg(jsonb_build_object('type', o.type, 'packets', coalesce(c.n, 0))
                                        order by coalesce(c.n, 0) desc, o.type asc)
                       from aprs_type_order o
                       left join aprs_type_counts c using (type))
           ) as v
  )
  -- Every CTE above is a single-row aggregate, so the cross joins yield one row.
  select
    v_window_start,
    v_window_end,
    jsonb_build_object(
      'totals', jsonb_build_object(
        'spots', t.spots, 'potaSpots', t.pota_spots, 'sotaSpots', t.sota_spots, 'wwffSpots', t.wwff_spots,
        'activators', t.activators, 'references', t.references,
        'activations', t.pota_activations + t.sota_activations + t.wwff_activations,
        'potaActivations', t.pota_activations, 'sotaActivations', t.sota_activations,
        'wwffActivations', t.wwff_activations,
        'chasers', t.chasers, 'potaChasers', t.pota_chasers, 'sotaChasers', t.sota_chasers,
        'wwffChasers', t.wwff_chasers
      ),
      'peakHour', coalesce((select hour from peak_hour), 0),
      'busiestSlot', coalesce(
        (select jsonb_build_object('day', day, 'hour', hour) from busiest_slot),
        jsonb_build_object('day', to_char(v_window_start at time zone 'utc', 'YYYY-MM-DD'), 'hour', 0)
      ),
      'daily',            d.v,
      'hourly',           h.v,
      'potaByState',      ps.v,
      'countries',        co.v,
      'sotaAssociations', sa.v,
      'wwffPrograms',     wp.v,
      'bands',            b.v,
      'modes',            m.v,
      'topActivators',    ta.v,
      'topReferences',    tr.v,
      'rbn',              r.v,
      'aprs',             ap.v
    )
  from totals t
  cross join daily d
  cross join hourly h
  cross join pota_by_state ps
  cross join countries co
  cross join sota_associations sa
  cross join wwff_programs wp
  cross join bands b
  cross join modes m
  cross join top_activators ta
  cross join top_references tr
  cross join rbn r
  cross join aprs ap;

  -- Keep the 48 most recent snapshots (two days at one per hour).
  delete from stats_snapshots
  where id not in (
    select id from stats_snapshots
    order by generated_at desc, id desc
    limit 48
  );
end;
$$;

comment on function public.refresh_stats_snapshot_at(timestamptz) is
  'Rolls up RBN, APRS and country days and RBN hours, inserts one stats_snapshots row as of p_now (7 complete UTC days; hourly to the last complete hour) and prunes to 48 rows. Cron only, through refresh_stats_snapshot().';

revoke all on function public.refresh_stats_snapshot_at(timestamptz) from public, anon, authenticated;

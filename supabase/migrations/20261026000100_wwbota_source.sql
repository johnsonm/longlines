-- WWBOTA (Worldwide Bunkers on the Air) as a source.
-- Spec: docs/superpowers/specs/2026-10-26-wwbota-design.md.
--
-- pg_cron calls ingest-wwbota once a minute; it polls api.wwbota.net and
-- stores spots in raw_spots through ingest_spots, like WWFF. A spot can name
-- several bunkers: every reference goes in wwbota_references, the first
-- bunker's name in wwbota_reference_name. A WWBOTA spot matches only
-- connections that list wwbota (as with DX Cluster and WWFF). Profiles and
-- group statistics pick WWBOTA up through spot_stream; the Stats snapshot only
-- gains its daily and hourly counts, for the catalog's rates.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

alter table raw_spots
  add column wwbota_references     text[],
  add column wwbota_reference_name text;

comment on column raw_spots.wwbota_references is 'WWBOTA bunker references (B/G-2114), in the feed''s order; wwbota spots only';
comment on column raw_spots.wwbota_reference_name is 'Name of the first bunker in wwbota_references; wwbota spots only';

alter table raw_spots drop constraint raw_spots_source_check;
alter table raw_spots add constraint raw_spots_source_check
  check (source in ('pota', 'sotawatch', 'rbn', 'dxcluster', 'wwff', 'wwbota'));

alter table ingest_state drop constraint ingest_state_source_check;
alter table ingest_state add constraint ingest_state_source_check
  check (source in ('pota', 'sotawatch', 'rbn', 'dxcluster', 'aprs', 'wwff', 'wwbota'));

-- The record_ingest_* RPCs update this row and silently do nothing without it.
insert into ingest_state (source) values ('wwbota') on conflict do nothing;

alter table archive_log drop constraint archive_log_source_check;
alter table archive_log add constraint archive_log_source_check
  check (source in ('pota', 'sotawatch', 'rbn', 'dxcluster', 'aprs', 'wwff', 'wwbota'));

-- ---------------------------------------------------------------------------
-- 2. Ingest
-- ---------------------------------------------------------------------------

-- ingest_spots: as in 20261015001000, plus the two WWBOTA columns.
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
      wwbota_references, wwbota_reference_name,
      raw_payload
    )
    select
      x.source, x.source_spot_id, x.content_hash, x.spot_time, x.callsign, x.spotter,
      x.frequency_khz, x.band, x.mode, x.mode_family, coalesce(x.comment, ''),
      x.pota_reference, x.pota_park_name, x.pota_location, x.sota_summit_ref,
      x.wwff_reference, x.wwff_reference_name,
      x.wwbota_references, x.wwbota_reference_name,
      x.raw_payload
    from jsonb_to_recordset(p_spots) as x(
      source text, source_spot_id text, content_hash text, spot_time timestamptz,
      callsign text, spotter text, frequency_khz numeric, band text, mode text,
      mode_family text, comment text, pota_reference text, pota_park_name text,
      pota_location text, sota_summit_ref text, wwff_reference text,
      wwff_reference_name text, wwbota_references text[], wwbota_reference_name text,
      raw_payload jsonb
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

-- Once a minute, like WWFF: the feed holds the last hour and is small.
select cron.schedule('ingest-wwbota', '* * * * *',
  $$ select public.cron_call_function('ingest-wwbota', 'ingest-wwbota', '{}'::jsonb, 30000); $$);

-- ---------------------------------------------------------------------------
-- 3. Matching
-- ---------------------------------------------------------------------------

-- An empty sources list ("any source") leaves out DX Cluster, WWFF and
-- WWBOTA: all three are opt-in. Bunker activations are often POTA or WWFF
-- activations too, and there is no cross-source dedup.

-- source_matches: as in 20261015001000, with wwbota opt-in.
create or replace function public.source_matches(p_sources text[], p_source text)
returns boolean
language sql
immutable
as $$
  select case when cardinality(p_sources) = 0 then p_source not in ('dxcluster', 'wwff', 'wwbota')
              else p_source = any (p_sources) end;
$$;

-- rule_matches: as in 20261015001000, with every WWBOTA reference in the reference rule's haystack, so a rule
-- naming the third bunker of an n-fer matches.
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
                          spot.wwff_reference, array_to_string(spot.wwbota_references, ',')))) > 0)
      when 'frequency' then case p_rule ->> 'op'
        when 'gt' then spot.frequency_khz > (p_rule -> 'values' ->> 0)::numeric
        when 'lt' then spot.frequency_khz < (p_rule -> 'values' ->> 0)::numeric
        else spot.frequency_khz = (p_rule -> 'values' ->> 0)::numeric end
    end as hit
  ) h;
$$;

-- normalize_subscription_sources: as in 20261017003000, accepting wwbota.
create or replace function public.normalize_subscription_sources(p_sources jsonb)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_out     text[];
  v_unknown text;
begin
  if p_sources is null or jsonb_typeof(p_sources) = 'null' then
    return '{}'::text[];
  end if;
  if jsonb_typeof(p_sources) <> 'array' then
    raise exception 'sources must be a list.';
  end if;
  v_out := public.jsonb_text_array(p_sources, 'lower');
  -- raw_spots_source_check without aprs, which never reaches matching.
  select s into v_unknown
  from unnest(v_out) as s
  where s not in ('pota', 'sotawatch', 'wwff', 'wwbota', 'rbn', 'dxcluster')
  order by s
  limit 1;
  if v_unknown is not null then
    raise exception 'Unknown source: %.', v_unknown;
  end if;
  return v_out;
end;
$$;

-- preview_subscription: as in 20261017003000, with the WWBOTA columns in the spot JSON. Same return
-- type, so the grants carry over.
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
      'sources', to_jsonb(public.normalize_subscription_sources(filter -> 'sources')),
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
      and public.source_matches((sub.s).sources, r.source)
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
        'wwbota_references', m.wwbota_references, 'wwbota_reference_name', m.wwbota_reference_name,
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

-- claim_deliveries, the previews and the tests all build the spot with
-- delivery_spot_json, so the claim itself does not change.

-- delivery_spot_json: as in 20261016000400, with the WWBOTA keys.
create or replace function public.delivery_spot_json(r raw_spots)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id, 'source', r.source, 'spot_time', r.spot_time, 'callsign', r.callsign,
    'base_callsign', r.base_callsign,
    'spotter', r.spotter, 'frequency_khz', r.frequency_khz, 'band', r.band, 'mode', r.mode,
    'mode_family', r.mode_family,
    'comment', r.comment, 'pota_reference', r.pota_reference, 'pota_park_name', r.pota_park_name,
    'pota_location', r.pota_location, 'sota_summit_ref', r.sota_summit_ref,
    'wwff_reference', r.wwff_reference, 'wwff_reference_name', r.wwff_reference_name,
    'wwbota_references', r.wwbota_references, 'wwbota_reference_name', r.wwbota_reference_name);
$$;

-- push_sample_spot: as in 20261016000400, with the WWBOTA keys as null.
create or replace function public.push_sample_spot()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', 0, 'source', 'pota', 'spot_time', now(), 'callsign', 'N0CALL', 'base_callsign', 'N0CALL',
    'spotter', 'LONGLINES', 'frequency_khz', 14062, 'band', '20m', 'mode', 'cw', 'mode_family', 'cw',
    'comment', 'Test spot from Long Lines. Not a real activation.',
    'pota_reference', 'US-0000', 'pota_park_name', 'Test Park', 'pota_location', 'US-TEST',
    'sota_summit_ref', null, 'wwff_reference', null, 'wwff_reference_name', null,
    'wwbota_references', null, 'wwbota_reference_name', null);
$$;

-- push_source_label: as in 20261016000400, with WWBOTA.
create or replace function public.push_source_label(p_source text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_source
    when 'pota' then 'POTA'
    when 'sotawatch' then 'SOTAwatch'
    when 'rbn' then 'RBN'
    when 'dxcluster' then 'DX Cluster'
    when 'wwff' then 'WWFF'
    when 'wwbota' then 'WWBOTA'
    else p_source
  end;
$$;

-- discord_source_color: as in 20261018000100, with WWBOTA gold (discord.py's gold).
create or replace function public.discord_source_color(p_source text)
returns int
language sql
immutable
set search_path = ''
as $$
  select case p_source
    when 'pota' then 3066993
    when 'sotawatch' then 10181046
    when 'wwff' then 1752220
    when 'wwbota' then 15844367
    when 'dxcluster' then 3447003
    when 'rbn' then 15105570
    else 9807270
  end;
$$;

-- render_push_field: as in 20261021000300, with WWBOTA: reference is every bunker, joined
-- with ", " so an n-fer shows them all, and place_name the first bunker's name.
-- spot_source_url is unchanged: WWBOTA has no public page per bunker.
create or replace function public.render_push_field(p_field text, p_spot jsonb)
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(case p_field
    when 'callsign' then p_spot ->> 'callsign'
    when 'first_name' then public.spot_license_name(p_spot, 'first')
    when 'last_name' then public.spot_license_name(p_spot, 'last')
    when 'frequency' then to_char((p_spot ->> 'frequency_khz')::numeric / 1000, 'FM9999990.000') || ' MHz'
    when 'band' then p_spot ->> 'band'
    when 'mode' then upper(p_spot ->> 'mode')
    when 'source' then public.push_source_label(p_spot ->> 'source')
    when 'reference' then coalesce(nullif(p_spot ->> 'pota_reference', ''), nullif(p_spot ->> 'sota_summit_ref', ''),
                                   nullif(p_spot ->> 'wwff_reference', ''),
                                   (select string_agg(x, ', ' order by o)
                                    from jsonb_array_elements_text(
                                           case when jsonb_typeof(p_spot -> 'wwbota_references') = 'array'
                                                then p_spot -> 'wwbota_references' end) with ordinality as t(x, o)))
    when 'place_name' then coalesce(nullif(p_spot ->> 'pota_park_name', ''), nullif(p_spot ->> 'wwff_reference_name', ''),
                                    p_spot ->> 'wwbota_reference_name')
    when 'state' then (
      select string_agg(coalesce(nullif(split_part(trim(x), '-', 2), ''), trim(x)), '/')
      from regexp_split_to_table(p_spot ->> 'pota_location', ',') x
      where trim(x) <> '')
    when 'spotter' then p_spot ->> 'spotter'
    when 'comment' then p_spot ->> 'comment'
    when 'time' then to_char((p_spot ->> 'spot_time')::timestamptz at time zone 'UTC', 'HH24:MI') || 'Z'
  end, '');
$$;

-- ---------------------------------------------------------------------------
-- 5. Read models
-- ---------------------------------------------------------------------------

-- recent_spots gains the WWBOTA columns before source. "create or replace
-- view" can only append, so recreate it and list_recent_spots, which returns
-- its row type. Invoker view, no client grants (20261006000020); clients read
-- it through list_recent_spots.
drop function public.list_recent_spots(text, int);
drop view recent_spots;

create view recent_spots with (security_invoker = true) as
select
  id, spot_time, callsign, spotter, frequency_khz, band, mode, mode_family, comment,
  pota_reference, pota_park_name, pota_location, sota_summit_ref,
  wwff_reference, wwff_reference_name, wwbota_references, wwbota_reference_name, source
from raw_spots
where spot_time > now() - interval '24 hours';

revoke all on recent_spots from anon, authenticated;

-- As in 20261016000200, with two more nulls on the RBN branch.
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
   limit least(greatest(coalesce(max_rows, 50), 0), 200))
  union all
  (select null::bigint, r.spot_time, r.callsign, r.spotter, r.frequency_khz, r.band, r.mode, r.mode_family,
          format('%s dB %s %s %s', r.snr, r.speed, r.speed_unit, r.spot_type),
          null, null, null, null, null, null, null, null, 'rbn'
   from rbn_spots r
   where p_source = 'rbn' and r.spot_time > now() - interval '24 hours'
   order by r.spot_time desc
   limit least(greatest(coalesce(max_rows, 50), 0), 200));
$$;

revoke all on function public.list_recent_spots(text, int) from public, anon, authenticated;
grant execute on function public.list_recent_spots(text, int) to authenticated;

-- callsign_group_rows: as in 20261021000500, with the first WWBOTA reference as the on-air
-- spot's reference.
create or replace function public.callsign_group_rows(p_id uuid)
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
              'source', r.source, 'reference', coalesce(r.pota_reference, r.sota_summit_ref, r.wwff_reference, r.wwbota_references[1]),
              'spot_time', r.spot_time)
            order by r.spot_time desc, r.id desc))[1] as latest
    from callsign_group_members cm
    join raw_spots r on r.base_callsign = cm.callsign and r.spot_time > now() - interval '30 minutes'
    where cm.group_id = g.id
  ) a
  where g.user_id = v_user and (p_id is null or g.id = p_id)
  order by lower(g.name);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Archive
-- ---------------------------------------------------------------------------

-- archive_slice_minutes: as in 20261015001000, with WWBOTA hourly.
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
           when 'wwbota' then 60
           when 'aprs' then 5
         end;
$$;

-- archive_columns: as in 20261015001000, with wwbota in the raw_spots branch and the two
-- WWBOTA columns in every raw_spots source's files. The references go as one
-- string joined with ',', which no reference contains.
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
  elsif p_source in ('pota', 'sotawatch', 'dxcluster', 'wwff', 'wwbota') then
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
               'wwbota_references', json_agg(array_to_string(r.wwbota_references, ',') order by r.o),
               'wwbota_reference_name', json_agg(r.wwbota_reference_name order by r.o),
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

-- As in 20261015001000, with wwbota.
create or replace view archive_status with (security_invoker = true) as
select s.source,
       (select max(l.slice_end) from archive_log l where l.source = s.source) as archived_through,
       (select count(*) from public.archive_pending_slices(s.source, now() - interval '2 hours', 100000))
         as pending_slices
from (values ('pota'), ('sotawatch'), ('rbn'), ('dxcluster'), ('aprs'), ('wwff'), ('wwbota')) as s(source);

-- ---------------------------------------------------------------------------
-- 7. Profiles
-- ---------------------------------------------------------------------------

-- spot_stream: as in 20261015001000, with a WWBOTA arm. An n-fer credits its
-- first bunker, as a POTA spot credits the park it names. The rollups,
-- callsign_profile and group_statistics_at are generic over program; days
-- already rolled up are never re-rolled.
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
            when r.wwff_reference is not null then 'WWFF'
            when r.wwbota_references[1] is not null then 'WWBOTA' end as program,
       coalesce(r.pota_reference, r.sota_summit_ref, r.wwff_reference, r.wwbota_references[1]) as reference,
       case when r.pota_reference is not null then r.pota_park_name
            when r.sota_summit_ref is not null then null
            when r.wwff_reference is not null then r.wwff_reference_name
            else r.wwbota_reference_name end as reference_name,
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
-- 8. Stats: daily and hourly counts only
-- ---------------------------------------------------------------------------

-- build_stats_snapshot_at: as in 20261022000100, with daily[].wwbota and hourly[].wwbota, for
-- the catalog's rates. Like DX Cluster's dx, they come from their own CTEs
-- over raw_spots: WWBOTA stays out of in_window, so every other figure is
-- unchanged. Same signature, so the grants carry over.
create or replace function public.build_stats_snapshot_at(p_now timestamptz)
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
  v_from         timestamptz;
begin
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
  daily_wwbota as (
    select to_char(spot_time at time zone 'utc', 'YYYY-MM-DD') as day, count(*) as wwbota
    from raw_spots
    where source = 'wwbota'
      and spot_time >= v_window_start
      and spot_time <  v_window_end
    group by 1
  ),
  daily as (
    select jsonb_agg(
             jsonb_build_object('day', d.day, 'pota', coalesce(c.pota, 0), 'sota', coalesce(c.sota, 0),
                                'wwff', coalesce(c.wwff, 0), 'rbn', coalesce(r.rbn, 0), 'aprs', coalesce(a.aprs, 0), 'dx', coalesce(x.dx, 0),
                                'wwbota', coalesce(w.wwbota, 0))
             order by d.day
           ) as v
    from days d
    left join daily_counts c using (day)
    left join daily_rbn r using (day)
    left join daily_aprs a using (day)
    left join daily_dx x using (day)
    left join daily_wwbota w using (day)
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
  slot_wwbota as (
    select date_bin(interval '1 hour', r.spot_time, timestamptz '2000-01-01 00:00+00') as slot,
           count(*) as wwbota
    from raw_spots r
    where r.source = 'wwbota'
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
               'aprs', coalesce(ah.packets, 0), 'dx', coalesce(sx.dx, 0),
               'wwbota', coalesce(sw.wwbota, 0)
             )
             order by s.slot
           ) as v
    from slots s
    left join slot_counts c using (slot)
    left join rbn_hourly h on h.hour = s.slot
    left join aprs_packet_hours ah on ah.hour_start = s.slot
    left join slot_dx sx on sx.slot = s.slot
    left join slot_wwbota sw on sw.slot = s.slot
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

-- ---------------------------------------------------------------------------
-- 9. Health
-- ---------------------------------------------------------------------------

-- health_snapshot: as in 20261021000400, with WWBOTA among the pulled sources and in the
-- spots series.
create or replace function public.health_snapshot(p_range text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now      timestamptz := now();
  v_bucket   interval;
  v_count    int;
  v_end      timestamptz;
  v_start    timestamptz;
  v_spots    record;
  v_dels     record;
  v_ready    int;
  v_conn     int;
  v_max_conn int := current_setting('max_connections')::int;
  v_bytes    bigint := pg_database_size(current_database());
  v_feeds    text[];
  v_sender   worker_heartbeats%rowtype;
  v_relay    worker_heartbeats%rowtype;
  v_checks   jsonb;
  v_series   jsonb;
  v_jobs     jsonb;
  v_pulled   jsonb;
  v_relayed  jsonb;
  v_archived timestamptz;
begin
  case p_range
    when '1h' then v_bucket := interval '1 minute'; v_count := 60;
    when '24h' then v_bucket := interval '30 minutes'; v_count := 48;
    when '7d' then v_bucket := interval '3 hours'; v_count := 56;
    else raise exception 'Unknown range.' using errcode = '22023';
  end case;
  -- Buckets on a fixed UTC grid; the last one holds now.
  v_end := date_bin(v_bucket, v_now, timestamptz '2000-01-01 00:00:00+00') + v_bucket;
  v_start := v_end - v_bucket * v_count;

  -- Live figures.
  select * into v_spots from pgmq.metrics('spot_events');
  select * into v_dels from pgmq.metrics('deliveries_queue');
  v_ready := public.health_oldest_ready_seconds(v_now);
  select count(*) into v_conn from pg_stat_activity where backend_type = 'client backend';

  select * into v_sender from worker_heartbeats
  where worker = 'sender' order by received_at desc limit 1;
  select * into v_relay from worker_heartbeats
  where worker = 'relay' order by received_at desc limit 1;

  -- Feeds checked: the relay's own list when it reported in the last 10
  -- minutes, else the relay sources that succeeded in the last 7 days.
  if v_relay.received_at > v_now - interval '10 minutes' then
    select coalesce(array_agg(f ->> 'id' order by f ->> 'id'), '{}') into v_feeds
    from jsonb_array_elements(v_relay.feeds) f;
  else
    select coalesce(array_agg(source order by source), '{}') into v_feeds
    from ingest_state
    where source in ('rbn', 'dxcluster', 'aprs') and last_success_at > v_now - interval '7 days';
  end if;

  select jsonb_agg(jsonb_build_object(
           'source', s.source,
           'seconds', extract(epoch from v_now - s.last_success_at)::int) order by s.source)
  into v_pulled
  from ingest_state s where s.source in ('pota', 'sotawatch', 'wwff', 'wwbota');

  select coalesce(jsonb_agg(jsonb_build_object(
           'source', f.id,
           'seconds', extract(epoch from v_now - s.last_success_at)::int) order by f.id), '[]'::jsonb)
  into v_relayed
  from unnest(v_feeds) f(id)
  left join ingest_state s on s.source = f.id;

  select max(archived_at) into v_archived from archive_log;

  -- Jobs: cron's own runs, except that a cron_call_function job's successful
  -- runs are its HTTP responses (a request still unanswered is left out).
  with jobs as (
    select j.jobid, j.jobname, j.schedule, j.command like '%cron_call_function(%' as http
    from cron.job j
    where j.active
  ),
  runs as (
    select j.jobname as job, d.start_time as at, d.status = 'succeeded' as ok,
           null::int as http_status, false as timed_out,
           extract(epoch from d.end_time - d.start_time) as seconds
    from cron.job_run_details d
    join jobs j on j.jobid = d.jobid
    where d.start_time > v_now - interval '8 days'
      and d.status in ('succeeded', 'failed')
      and (not j.http or d.status = 'failed')
    union all
    select r.job, r.sent_at,
           coalesce(r.status_code between 200 and 299, false) and not coalesce(r.timed_out, false),
           r.status_code, coalesce(r.timed_out, false),
           r.run_seconds
    from cron_http_requests r
    where r.sent_at > v_now - interval '8 days'
      and r.answered_at is not null
  ),
  ranked as (
    select runs.*, row_number() over (partition by runs.job order by runs.at desc) as rn
    from runs
  ),
  -- Run times are successful runs' only. The range's figures are shown; the
  -- last hour against the 7 days before it decides whether a job is unusual.
  stats as (
    select x.job,
           count(*) filter (where x.at >= v_start) as runs,
           count(*) filter (where x.at >= v_start and not x.ok) as failed,
           avg(x.seconds) filter (where x.at >= v_start and x.ok) as avg_s,
           stddev_samp(x.seconds) filter (where x.at >= v_start and x.ok) as sd_s,
           percentile_cont(0.95) within group (order by x.seconds) filter (where x.at >= v_start and x.ok) as p95_s,
           count(*) filter (where x.at >= v_now - interval '1 hour') as runs_1h,
           avg(x.seconds) filter (where x.at >= v_now - interval '1 hour' and x.ok) as avg_1h,
           count(*) filter (where x.at >= v_now - interval '7 days 1 hour' and x.at < v_now - interval '1 hour') as base_runs,
           count(*) filter (where x.at >= v_now - interval '7 days 1 hour' and x.at < v_now - interval '1 hour'
                              and not x.ok) as base_failed,
           count(x.seconds) filter (where x.at >= v_now - interval '7 days 1 hour' and x.at < v_now - interval '1 hour'
                                      and x.ok) as base_timed,
           avg(x.seconds) filter (where x.at >= v_now - interval '7 days 1 hour' and x.at < v_now - interval '1 hour'
                                    and x.ok) as base_avg,
           stddev_samp(x.seconds) filter (where x.at >= v_now - interval '7 days 1 hour' and x.at < v_now - interval '1 hour'
                                            and x.ok) as base_sd
    from runs x
    group by x.job
  ),
  per_job as (
    select j.jobname, j.schedule,
           s.runs, s.failed, s.avg_s, s.sd_s, s.p95_s, s.runs_1h, s.avg_1h,
           s.base_runs, s.base_failed, s.base_timed, s.base_avg, s.base_sd,
           greatest(
             (select max(d.start_time) from cron.job_run_details d
              where d.jobid = j.jobid and d.start_time > v_now - interval '8 days'),
             (select max(r.sent_at) from cron_http_requests r
              where r.job = j.jobname and r.sent_at > v_now - interval '8 days')) as last_run_at,
           (select to_jsonb(x) - 'job' - 'at' - 'rn' from ranked x where x.job = j.jobname and x.rn = 1) as last,
           (select count(*) from ranked x where x.job = j.jobname and x.rn <= 3 and not x.ok) as failed_of_last3,
           (select count(*) from ranked x where x.job = j.jobname and x.rn <= 3) as last3,
           (select count(*) from ranked x
            where x.job = j.jobname and not x.ok and x.at > v_now - interval '24 hours') as failed_24h,
           (select count(*) from ranked x
            where x.job = j.jobname and not x.ok and x.at > v_now - interval '1 hour') as failed_1h
    from jobs j
    left join stats s on s.job = j.jobname
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'name', p.jobname,
           'schedule', p.schedule,
           'last_run_at', p.last_run_at,
           'result', case when p.last is null then null else jsonb_build_object(
                       'ok', (p.last ->> 'ok')::boolean,
                       'http_status', p.last -> 'http_status',
                       'timed_out', (p.last ->> 'timed_out')::boolean,
                       'seconds', round((p.last ->> 'seconds')::numeric, 1)) end,
           'status', case
                       when p.last is null then 'unknown'
                       when p.last3 = 3 and p.failed_of_last3 = 3 then 'failing'
                       when not (p.last ->> 'ok')::boolean then 'delayed'
                       else 'healthy' end,
           'failed_24h', p.failed_24h,
           'failed_1h', p.failed_1h,
           'timing', jsonb_build_object(
                       'runs', coalesce(p.runs, 0),
                       'failed', coalesce(p.failed, 0),
                       'average', round(p.avg_s::numeric, 2),
                       'sd', round(p.sd_s::numeric, 2),
                       'p95', round(p.p95_s::numeric, 2)),
           -- failures: 3 or more in the last hour, over 3 standard deviations
           -- (Poisson) above what the 7-day failure rate predicts for that many runs.
           -- slow: the last hour's average over 3 standard deviations and at least
           -- a second above the 7-day average, from at least 10 timed runs.
           'unusual', case
                        when p.failed_1h >= 3 and p.base_runs > 0
                             and p.failed_1h > p.base_failed::numeric / p.base_runs * p.runs_1h
                                               + 3 * sqrt(p.base_failed::numeric / p.base_runs * p.runs_1h)
                        then 'failures'
                        when p.base_timed >= 10 and p.avg_1h is not null
                             and p.avg_1h > p.base_avg + 3 * coalesce(p.base_sd, 0)
                             and p.avg_1h - p.base_avg >= 1
                        then 'slow'
                      end)
         order by p.last_run_at desc nulls last, p.jobname), '[]'::jsonb)
  into v_jobs
  from per_job p;

  v_checks := jsonb_build_object(
    'pulled', jsonb_build_object(
      'status', case when exists (select 1 from jsonb_array_elements(v_pulled) e
                                  where (e ->> 'seconds') is null or (e ->> 'seconds')::int > 180)
                     then 'delayed' else 'healthy' end,
      'sources', v_pulled),
    'relay', jsonb_build_object(
      'status', case when jsonb_array_length(v_relayed) = 0 then 'unknown'
                     when exists (select 1 from jsonb_array_elements(v_relayed) e
                                  where (e ->> 'seconds') is null or (e ->> 'seconds')::int > 180)
                     then 'delayed' else 'healthy' end,
      'feeds', v_relayed,
      'reconnects_24h', (
        select sum(g.hi - case when g.started_at < v_now - interval '24 hours' then g.lo else 0 end)::int
        from (select h.started_at, max(h.reconnects) as hi, min(h.reconnects) as lo
              from worker_heartbeats h
              where h.worker = 'relay' and h.received_at > v_now - interval '24 hours'
              group by h.started_at) g)),
    'match_queue', jsonb_build_object(
      'status', case when coalesce(v_spots.oldest_msg_age_sec, 0) > 120 then 'delayed' else 'healthy' end,
      'waiting', v_spots.queue_length,
      'oldest_seconds', v_spots.oldest_msg_age_sec),
    'delivery_queue', jsonb_build_object(
      'status', case when coalesce(v_ready, 0) > 120 then 'delayed' else 'healthy' end,
      'waiting', v_dels.queue_length,
      'oldest_ready_seconds', v_ready,
      'throttled', (select count(*) from destinations where throttled_until > v_now)),
    'sender', jsonb_build_object(
      'status', case when v_sender.id is null then 'unknown'
                     when v_now - coalesce(v_sender.last_progress_at, v_sender.started_at) > interval '120 seconds'
                     then 'failing' else 'healthy' end,
      'progress_seconds', extract(epoch from v_now - coalesce(v_sender.last_progress_at, v_sender.started_at))::int,
      'restarts_24h', case when v_sender.id is null then null else (
        select greatest(count(distinct h.started_at) - 1, 0)::int from worker_heartbeats h
        where h.worker = 'sender' and h.received_at > v_now - interval '24 hours') end,
      'memory_bytes', v_sender.rss_bytes),
    'database', jsonb_build_object(
      'status', case when v_conn > 0.8 * v_max_conn or v_bytes > 0.8 * public.health_disk_limit_bytes()
                     then 'delayed' else 'healthy' end,
      'connections', v_conn,
      'max_connections', v_max_conn,
      'bytes', v_bytes,
      'disk_limit_bytes', public.health_disk_limit_bytes()),
    'jobs', jsonb_build_object(
      'status', case when exists (select 1 from jsonb_array_elements(v_jobs) j where j ->> 'status' = 'failing')
                     then 'failing'
                     when exists (select 1 from jsonb_array_elements(v_jobs) j where j ->> 'unusual' is not null)
                     then 'delayed' else 'healthy' end,
      'count', jsonb_array_length(v_jobs),
      'unusual', (select count(*) from jsonb_array_elements(v_jobs) j where j ->> 'unusual' is not null),
      'failed_1h', (select coalesce(sum((j ->> 'failed_1h')::int), 0) from jsonb_array_elements(v_jobs) j)),
    'archive', jsonb_build_object(
      'status', case when v_archived is null or v_archived < v_now - interval '2 hours'
                     then 'delayed' else 'healthy' end,
      'seconds', extract(epoch from v_now - v_archived)::int)
  );

  -- Series, one value per bucket (null where nothing was recorded). Gauges are
  -- the bucket's maximum, counts its sum; percentiles come from the rows.
  with buckets as (
    select i, v_start + v_bucket * i as t
    from generate_series(0, v_count - 1) i
  ),
  samples as (
    select date_bin(v_bucket, s.sampled_at, v_start) as t,
           max(s.match_waiting) as match_waiting,
           max(s.delivery_waiting) as delivery_waiting,
           max(s.delivery_oldest_ready_seconds) as oldest_ready,
           max(s.db_connections) as connections,
           max(s.db_bytes) as db_bytes
    from health_samples s
    where s.sampled_at >= v_start and s.sampled_at < v_end
    group by 1
  ),
  totals as (
    select s.sampled_at, e.key as source, e.value::bigint as total,
           lag(e.value::bigint) over (partition by e.key order by s.sampled_at) as prev
    from health_samples s
    cross join lateral jsonb_each_text(s.spots_total) e
    where s.sampled_at >= v_start - interval '10 minutes' and s.sampled_at < v_end
      and e.key in ('pota', 'sotawatch', 'wwff', 'wwbota', 'dxcluster')
  ),
  spots as (
    select date_bin(v_bucket, t.sampled_at, v_start) as t,
           sum(greatest(t.total - t.prev, 0)) filter (where t.source = 'pota') as pota,
           sum(greatest(t.total - t.prev, 0)) filter (where t.source = 'sotawatch') as sotawatch,
           sum(greatest(t.total - t.prev, 0)) filter (where t.source = 'wwff') as wwff,
           sum(greatest(t.total - t.prev, 0)) filter (where t.source = 'wwbota') as wwbota,
           sum(greatest(t.total - t.prev, 0)) filter (where t.source = 'dxcluster') as dxcluster
    from totals t
    where t.sampled_at >= v_start and t.prev is not null
    group by 1
  ),
  sent as (
    select date_bin(v_bucket, d.sent_at, v_start) as t,
           percentile_cont(0.5) within group (order by extract(epoch from d.sent_at - d.created_at)) as p50,
           percentile_cont(0.95) within group (order by extract(epoch from d.sent_at - d.created_at)) as p95
    from deliveries d
    where d.sent_at >= v_start and d.sent_at < v_end
    group by 1
  ),
  failed as (
    select date_bin(v_bucket, d.last_failed_at, v_start) as t, count(*) as n
    from deliveries d
    where d.last_failed_at >= v_start and d.last_failed_at < v_end
    group by 1
  ),
  expired as (
    -- The claim's unwanted sweep also stamps dropped_at for a paused webhook; that is not expiry.
    select date_bin(v_bucket, d.dropped_at, v_start) as t, count(*) as n
    from deliveries d
    join destinations dest on dest.id = d.destination_id
    where d.dropped_at >= v_start and d.dropped_at < v_end and dest.auto_disabled_at is null
    group by 1
  ),
  memory as (
    select date_bin(v_bucket, h.received_at, v_start) as t,
           max(h.rss_bytes) filter (where h.worker = 'sender') as sender,
           max(h.rss_bytes) filter (where h.worker = 'relay') as relay
    from worker_heartbeats h
    where h.received_at >= v_start and h.received_at < v_end
    group by 1
  )
  select jsonb_build_object(
    'match_waiting', jsonb_agg(sa.match_waiting order by b.i),
    'delivery_waiting', jsonb_agg(sa.delivery_waiting order by b.i),
    'oldest_ready_seconds', jsonb_agg(sa.oldest_ready order by b.i),
    'connections', jsonb_agg(sa.connections order by b.i),
    'db_bytes', jsonb_agg(sa.db_bytes order by b.i),
    -- deliveries keeps 7 days, so an empty bucket is a true 0.
    'failed', jsonb_agg(coalesce(f.n, 0) order by b.i),
    'expired', jsonb_agg(coalesce(e.n, 0) order by b.i),
    'latency_p50', jsonb_agg(round(se.p50::numeric, 1) order by b.i),
    'latency_p95', jsonb_agg(round(se.p95::numeric, 1) order by b.i),
    'spots', jsonb_build_object(
      'pota', jsonb_agg(sp.pota order by b.i),
      'sotawatch', jsonb_agg(sp.sotawatch order by b.i),
      'wwff', jsonb_agg(sp.wwff order by b.i),
      'wwbota', jsonb_agg(sp.wwbota order by b.i),
      'dxcluster', jsonb_agg(sp.dxcluster order by b.i)),
    'sender_memory', jsonb_agg(m.sender order by b.i),
    'relay_memory', jsonb_agg(m.relay order by b.i))
  into v_series
  from buckets b
  left join samples sa on sa.t = b.t
  left join spots sp on sp.t = b.t
  left join sent se on se.t = b.t
  left join failed f on f.t = b.t
  left join expired e on e.t = b.t
  left join memory m on m.t = b.t;

  return jsonb_build_object(
    'range', p_range,
    'start', v_start,
    'bucket_seconds', extract(epoch from v_bucket)::int,
    'checks', v_checks,
    'limits', jsonb_build_object(
      'match_batch', 500,
      'oldest_ready_seconds', 120,
      'max_connections', v_max_conn,
      'worker_memory_bytes', public.health_worker_memory_bytes()),
    'series', v_series,
    'jobs', v_jobs
  );
end;
$$;

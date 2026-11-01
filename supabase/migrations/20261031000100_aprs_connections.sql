-- APRS-IS as a connection source.
-- Plan: APRS-IS as a connection source (2026-10-31), modelled on RBN, the other firehose.
--
-- Every APRS-IS packet still goes only to aprs_packets. As with RBN, ingest-aprs now also sends the
-- position-bearing packets (position, Mic-E, object, item) of stations a connection names
-- (watched_among('aprs', ...)) through runIngest into raw_spots and the matcher. So in raw_spots
-- 'aprs' is the watched subset, and everywhere else (ingest_state, ingest_health, the archive, the
-- Stats CTEs over aprs_packet_hours, archive-aprs) 'aprs' keeps meaning packets; none of those change.
--
-- An APRS spot is one station per 15-minute bucket: source_spot_id '<callsign>|<bucket>' and the
-- content hash of (callsign, bucket), so every further packet from that station in the window hits
-- ingest_spots' ON CONFLICT DO NOTHING. A beacon has no frequency, band or mode, so
-- raw_spots.frequency_khz becomes nullable (every other source still sets it); the comment is the
-- packet's info field as received.
--
-- APRS-IS is opt-in for matching, like DX Cluster, WWFF, WWBOTA and logged contacts: an "any
-- source" connection never gets beacons. Like RBN, an APRS spot passes only an AND group that names
-- stations, and an APRS-only connection must name them in every group. A beacon is not activity a
-- profile, the rollups, group statistics, Stats, the band map, the "on air" count or the recent spots
-- list describe, so every reader of spots leaves it out; the preview and the Home page count it.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

alter table raw_spots alter column frequency_khz drop not null;

comment on column raw_spots.frequency_khz is
  'Spot frequency in kHz; null only for aprs spots (APRS-IS beacons carry no frequency).';

alter table raw_spots drop constraint raw_spots_source_check;
alter table raw_spots add constraint raw_spots_source_check
  check (source in ('pota', 'sotawatch', 'rbn', 'dxcluster', 'wwff', 'wwbota', 'logged', 'aprs'));

-- ---------------------------------------------------------------------------
-- 2. Matching
-- ---------------------------------------------------------------------------

-- source_matches: as in 20261028000300, with aprs opt-in: an "any source" connection with a
-- callsign rule must not start getting a station's beacons.
create or replace function public.source_matches(p_sources text[], p_source text)
returns boolean
language sql
immutable
as $$
  select case when cardinality(p_sources) = 0 then p_source not in ('dxcluster', 'wwff', 'wwbota', 'logged', 'aprs')
              else p_source = any (p_sources) end;
$$;

-- normalize_subscription_sources: as in 20261028000300, accepting aprs.
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
  -- raw_spots_source_check's list.
  select s into v_unknown
  from unnest(v_out) as s
  where s not in ('pota', 'sotawatch', 'wwff', 'wwbota', 'rbn', 'dxcluster', 'logged', 'aprs')
  order by s
  limit 1;
  if v_unknown is not null then
    raise exception 'Unknown source: %.', v_unknown;
  end if;
  return v_out;
end;
$$;

-- spot_matches: as in 20261014000500, with APRS under the RBN guard: only watched stations' beacons
-- reach raw_spots, so a group that names no stations could match them only by accident.
create or replace function public.spot_matches(sub subscriptions, spot raw_spots)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(
        public.source_matches(sub.sources, spot.source)
    and exists (
          select 1
          from jsonb_array_elements(
                 case when jsonb_array_length(sub.rules) = 0 then '[[]]'::jsonb else sub.rules end) as g
          where (spot.source not in ('rbn', 'aprs') or public.rules_name_stations(jsonb_build_array(g)))
            and not exists (
                  select 1 from jsonb_array_elements(g) as c
                  where not public.rule_matches(c, spot))),
    false);
$$;

-- subscriptions_rbn_needs_callsign: as in 20261014000500, covering every connection whose sources
-- are only RBN and APRS-IS (either or both): it could never match without stations to watch. The
-- web's needsCallsign states the same check. Security definer as since 20261015001100 (create or
-- replace would otherwise drop it).
create or replace function public.subscriptions_rbn_needs_callsign()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_who text;
begin
  if cardinality(new.sources) > 0 and new.sources <@ array['rbn', 'aprs']
     and not public.rules_name_stations(new.rules) then
    v_who := case when new.sources @> array['rbn', 'aprs'] then 'RBN and APRS-IS report'
                  when 'rbn' = any (new.sources) then 'RBN reports'
                  else 'APRS-IS reports' end;
    if jsonb_array_length(new.rules) > 1 then
      raise exception '% stations by callsign. Each Or needs its own callsign or group rule.', v_who;
    end if;
    raise exception '% stations by callsign. Add at least one callsign.', v_who;
  end if;
  return new;
end;
$$;

-- match_pending_spots: as in 20261029000100, with the local_cluster guard treating a missing
-- frequency like zero, so no APRS spot (which has none) reaches a relay. Signature, result and
-- grants unchanged.
create or replace function public.match_pending_spots(batch_size int default 500)
returns int
language plpgsql
security definer
set search_path = public, pgmq
as $$
declare
  v_msg_ids      bigint[];
  v_spot_ids     bigint[];
  v_delivery_ids bigint[];
begin
  -- One run at a time (see 20261029000100). Keyed by a fixed name; pgTAP looks for this key.
  perform pg_advisory_xact_lock(hashtextextended('match_pending_spots', 0));

  select array_agg(m.msg_id), array_agg((m.message ->> 'spot_id')::bigint)
    into v_msg_ids, v_spot_ids
  from pgmq.read('spot_events', 60, batch_size) m;

  if v_msg_ids is null then
    return 0;
  end if;

  with candidates as (
    select s.id as subscription_id, s.quiet_minutes, r.id as spot_id, r.callsign, r.spot_time,
           r.source, r.frequency_khz
    from raw_spots r
    join subscriptions s on s.enabled and public.spot_matches(s, r)
      and exists (select 1 from subscription_destinations sd
                  join destinations dd on dd.id = sd.destination_id and dd.enabled
                  where sd.subscription_id = s.id
                    and not (dd.type = 'local_cluster'
                             and (coalesce(r.frequency_khz, 0) <= 0
                                  or (r.source = 'logged'
                                      and exists (select 1 from logged_contacts lc
                                                  where lc.spot_id = r.id and lc.user_id = dd.user_id)))))
    where r.id = any (v_spot_ids)
      and r.retracted_at is null
  ),
  -- With a quiet window, only the earliest spot per callsign in this batch is eligible.
  eligible as (
    (
      select distinct on (c.subscription_id, c.callsign) c.*
      from candidates c
      where c.quiet_minutes > 0
      order by c.subscription_id, c.callsign, c.spot_time, c.spot_id
    )
    union all
    select c.* from candidates c where c.quiet_minutes = 0
  ),
  allowed as (
    select e.*
    from eligible e
    left join subscription_quiet q
      on q.subscription_id = e.subscription_id and q.callsign = e.callsign
    where e.quiet_minutes = 0
       or q.last_sent_at is null
       or q.last_sent_at <= now() - make_interval(mins => e.quiet_minutes)
  ),
  stamp_quiet as (
    insert into subscription_quiet (subscription_id, callsign, last_sent_at)
    select distinct a.subscription_id, a.callsign, now()
    from allowed a
    where a.quiet_minutes > 0
    on conflict (subscription_id, callsign) do update set last_sent_at = excluded.last_sent_at
  ),
  ins as (
    insert into deliveries (subscription_id, destination_id, spot_id)
    select distinct on (sd.destination_id, a.spot_id) a.subscription_id, sd.destination_id, a.spot_id
    from allowed a
    join subscription_destinations sd on sd.subscription_id = a.subscription_id
    join destinations dd on dd.id = sd.destination_id and dd.enabled
    where not (dd.type = 'local_cluster'
               and (coalesce(a.frequency_khz, 0) <= 0
                    or (a.source = 'logged'
                        and exists (select 1 from logged_contacts lc
                                    where lc.spot_id = a.spot_id and lc.user_id = dd.user_id))))
    order by sd.destination_id, a.spot_id, a.subscription_id
    on conflict (destination_id, spot_id) do nothing
    returning id
  )
  select array_agg(ins.id) into v_delivery_ids from ins;

  if v_delivery_ids is not null then
    perform pgmq.send_batch(
      'deliveries_queue',
      (select array_agg(jsonb_build_object('delivery_id', d)) from unnest(v_delivery_ids) as d)
    );
  end if;

  perform pgmq.archive('spot_events', v_msg_ids);

  -- Tell a listening sender there is work (delivered on commit). The sender polls today and
  -- will LISTEN on this channel later; until then the notify has no subscriber.
  if v_delivery_ids is not null then
    perform pg_notify('deliveries', '');
  end if;

  return coalesce(cardinality(v_delivery_ids), 0);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Delivery
-- ---------------------------------------------------------------------------

-- render_push_field, discord_spot_fields and webhook_spot_fields already render a missing
-- frequency as a missing value. spot_source_url gets no aprs branch: there is no page to link.

-- push_source_label: as in 20261028000300, with APRS-IS.
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
    when 'logged' then 'Logged contacts'
    when 'aprs' then 'APRS-IS'
    else p_source
  end;
$$;

-- discord_source_color: as in 20261028000300, with APRS-IS dark orange (discord.py's dark_orange):
-- the catalog marks it in the warning colour, as RBN, and RBN already has orange.
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
    when 'logged' then 15277667
    when 'dxcluster' then 3447003
    when 'rbn' then 15105570
    when 'aprs' then 11027200
    else 9807270
  end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Read models
-- ---------------------------------------------------------------------------

-- recent_spots: as in 20261028000300, without APRS spots: the interesting recent list for APRS-IS
-- is packets, not the beacons of watched stations, so list_recent_spots('aprs') returns nothing,
-- like an unknown source. Same columns, so list_recent_spots (which returns its row type) and the
-- grants carry over.
create or replace view recent_spots with (security_invoker = true) as
select
  id, spot_time, callsign, spotter, frequency_khz, band, mode, mode_family, comment,
  pota_reference, pota_park_name, pota_location, sota_summit_ref,
  wwff_reference, wwff_reference_name, wwbota_references, wwbota_reference_name,
  iota_reference, iota_reference_name, source
from raw_spots
where spot_time > now() - interval '24 hours'
  and retracted_at is null
  and source <> 'aprs';

revoke all on recent_spots from anon, authenticated;

-- callsign_group_rows: as in 20261028000300, with an APRS beacon never on the air: it is a station
-- moving, not a contact to be had.
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
              'source', r.source, 'reference', coalesce(r.pota_reference, r.sota_summit_ref, r.wwff_reference, r.wwbota_references[1],
                                                 r.iota_reference),
              'spot_time', r.spot_time)
            order by r.spot_time desc, r.id desc))[1] as latest
    from callsign_group_members cm
    join raw_spots r on r.base_callsign = cm.callsign and r.spot_time > now() - interval '30 minutes'
                    and r.retracted_at is null and r.source <> 'aprs'
    where cm.group_id = g.id
  ) a
  where g.user_id = v_user and (p_id is null or g.id = p_id)
  order by lower(g.name);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Profiles
-- ---------------------------------------------------------------------------

-- spot_stream: as in 20261028000300, leaving APRS spots out of the raw_spots arm as it leaves RBN's
-- (RBN has its own arm over the firehose; APRS-IS has none). Profiles, the rollups and group
-- statistics read only this view, so none of them count a beacon, and callsign_seen's
-- last_frequency_khz never meets a null.
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
            when r.wwbota_references[1] is not null then 'WWBOTA'
            when r.iota_reference is not null then 'IOTA' end as program,
       coalesce(r.pota_reference, r.sota_summit_ref, r.wwff_reference, r.wwbota_references[1],
                r.iota_reference) as reference,
       case when r.pota_reference is not null then r.pota_park_name
            when r.sota_summit_ref is not null then null
            when r.wwff_reference is not null then r.wwff_reference_name
            when r.wwbota_references[1] is not null then r.wwbota_reference_name
            else r.iota_reference_name end as reference_name,
       case when r.pota_reference is not null then r.pota_location end  as reference_location,
       r.comment
from raw_spots r
where r.source not in ('rbn', 'aprs')
  and r.retracted_at is null
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
       null, null, null, null,
       null
from rbn_spots s;

revoke all on spot_stream from anon, authenticated;

-- first_rollup_day: as in 20261019000200, leaving APRS spots out with RBN's, so the first day is
-- one spot_stream can hold.
create or replace function public.first_rollup_day()
returns date
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return coalesce(
    least((select min(r.day) from callsign_rollup_days r),
          (select (min(s.spot_time) at time zone 'utc')::date from raw_spots s where s.source not in ('rbn', 'aprs'))),
    (select (min(s.spot_time) at time zone 'utc')::date from spot_stream s));
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Home
-- ---------------------------------------------------------------------------

-- home_flow: as in 20261028000300, with aprs among the sources a connection can take, under the
-- same "names stations" condition as RBN (the matcher's guard).
create or replace function public.home_flow()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with mine as (
    select d.subscription_id, d.destination_id, d.spot_id, d.created_at, d.sent_at
    from destinations dd
    join deliveries d on d.destination_id = dd.id
    where dd.user_id = auth.uid()
      and (d.created_at > now() - interval '24 hours' or d.sent_at > now() - interval '24 hours')
  ),
  matched as (
    select m.subscription_id, r.source, m.spot_id
    from mine m
    join raw_spots r on r.id = m.spot_id
    where m.created_at > now() - interval '24 hours'
  ),
  sent as (
    select m.subscription_id, m.destination_id from mine m where m.sent_at > now() - interval '24 hours'
  )
  select jsonb_build_object(
    'matched', (select count(distinct spot_id) from matched),
    'delivered', (select count(*) from sent),
    'sources', coalesce((
      select jsonb_agg(jsonb_build_object('source', s.source, 'matched', s.n) order by s.source)
      from (select source, count(distinct spot_id) as n from matched group by source) s
    ), '[]'::jsonb),
    'subscriptions', coalesce((
      select jsonb_agg(jsonb_build_object('subscription_id', s.subscription_id, 'source', s.source, 'matched', s.n)
                       order by s.subscription_id, s.source)
      from (select subscription_id, source, count(distinct spot_id) as n from matched group by subscription_id, source) s
    ), '[]'::jsonb),
    'links', coalesce((
      select jsonb_agg(jsonb_build_object('subscription_id', s.subscription_id, 'destination_id', s.destination_id, 'delivered', s.n)
                       order by s.subscription_id, s.destination_id)
      from (select subscription_id, destination_id, count(*) as n from sent group by subscription_id, destination_id) s
    ), '[]'::jsonb),
    'subscription_sources', coalesce((
      select jsonb_agg(jsonb_build_object('subscription_id', s.id, 'source', src.source) order by s.id, src.source)
      from subscriptions s
      cross join unnest(array['pota', 'sotawatch', 'wwff', 'wwbota', 'rbn', 'dxcluster', 'logged', 'aprs']) as src(source)
      where s.user_id = auth.uid()
        and public.source_matches(s.sources, src.source)
        and (src.source not in ('rbn', 'aprs') or exists (
              select 1 from jsonb_array_elements(s.rules) as g
              where public.rules_name_stations(jsonb_build_array(g))))
    ), '[]'::jsonb)
  )
  where auth.uid() is not null;
$$;

revoke all on function public.home_flow() from public;
grant execute on function public.home_flow() to authenticated;

-- Callsign profiles, part 5 (docs/superpowers/specs/2026-10-12-callsign-lookup-design.md).
--
-- callsign_profile(call) builds one station's public profile as jsonb. The
-- payload's shape is CallsignProfile in web/src/profile/types.ts, pinned by
-- supabase/tests/callsign_profile.test.sql; change the SQL, the type and the
-- test together. It is security definer and not granted to clients: browsers
-- call the callsign-profile Edge Function (_shared/profile.ts), which
-- rate-limits each client through record_profile_lookup() and reads through
-- cached_callsign_profile(), a 15-minute cache in callsign_profile_cache.
--
-- All-time figures come from the rollups (20261012000040). Days without a
-- callsign_rollup_days marker (today, yesterday until 02:25 UTC, a day whose
-- rollup failed) are read live from spot_stream through the base-callsign
-- indexes and added on top. "Heard by" and "Recent spots" are always read
-- live, over the last 7 days. Hunting (what the station spotted for others)
-- comes from the rollups only, so it runs to the last rolled-up day: reading
-- it live would need a spotter index on every source.
--
-- A call in hidden_callsigns gets the not-heard shape with no license.
--
-- rbn_spots gets its base-callsign index here, the one PR 1 deferred. A plain
-- create index on the partitioned table would hold a SHARE lock on every
-- partition until the migration commits, stopping RBN inserts for the whole
-- build (minutes at hosted volume). Instead each partition is indexed on its
-- own, oldest first, so the partitions taking inserts (today's, the empty
-- future ones and the default) come last, and the parent index is created
-- ON ONLY and the partition indexes attached at the end. Inserts wait only for
-- today's partition (docs/OPERATIONS.md, "Callsign profiles"). Partitions
-- created later get the index from the parent.
--
-- The index stores base_callsign() output. Replacing base_callsign() does not
-- rebuild it: a migration that changes the function must reindex it.

do $$
declare
  v_part regclass;
begin
  for v_part in
    select i.inhrelid::regclass
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'public.rbn_spots'::regclass
    order by c.relname = 'rbn_spots_default', c.relname
  loop
    execute format('create index %I on %s (public.base_callsign(callsign), spot_time)',
                   (select relname from pg_class where oid = v_part) || '_base_callsign_spot_time_idx', v_part);
  end loop;

  create index rbn_spots_base_callsign_time_idx on only rbn_spots (public.base_callsign(callsign), spot_time);

  for v_part in
    select i.inhrelid::regclass from pg_inherits i where i.inhparent = 'public.rbn_spots'::regclass
  loop
    execute format('alter index rbn_spots_base_callsign_time_idx attach partition %s',
                   (select format('%I.%I', n.nspname, c.relname || '_base_callsign_spot_time_idx')
                    from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where c.oid = v_part));
  end loop;
end;
$$;

-- Calls whose profile is hidden on request, by base call. Managed by the
-- operator in the SQL editor.
create table hidden_callsigns (
  callsign  text        primary key check (callsign = public.base_callsign(callsign)),
  hidden_at timestamptz not null default now(),
  note      text
);

create table callsign_profile_cache (
  callsign     text        primary key,                 -- base call
  payload      jsonb       not null,
  generated_at timestamptz not null
);

-- Lookups per client per minute. client is a SHA-256 of the client IP, made
-- by the Edge Function, so no address is stored.
create table lookup_rate_limits (
  client       text        not null,
  window_start timestamptz not null,
  lookups      int         not null,
  primary key (client, window_start)
);

alter table hidden_callsigns enable row level security;
alter table callsign_profile_cache enable row level security;
alter table lookup_rate_limits enable row level security;
revoke all on hidden_callsigns, callsign_profile_cache, lookup_rate_limits from anon, authenticated;

create function public.callsign_profile(p_callsign text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_base      text := public.base_callsign(p_callsign);
  v_today     date := (now() at time zone 'utc')::date;
  v_week_from timestamptz := now() - interval '7 days';
  v_live_from date;
  v_header    jsonb;
  v_heard     jsonb;
begin
  -- Input that has no base call (P/1, an empty string) is not a callsign:
  -- null, which the Edge Function answers with a 400.
  if v_base is null or v_base !~ '^[A-Z0-9]+$' then
    return null;
  end if;

  v_header := jsonb_build_object(
    'callsign', v_base,
    'generatedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    -- The prefixes the FCC issues; the page picks its no-license message by it.
    'usPrefix', v_base ~ '^(K|N|W|A[A-L])',
    'country', (select jsonb_build_object('name', l.name, 'continent', l.continent)
                from public.cty_lookup(v_base) l),
    'license', null,
    'heard', null);

  if exists (select 1 from hidden_callsigns h where h.callsign = v_base) then
    return v_header;
  end if;

  v_header := v_header || jsonb_build_object('license', (
    select jsonb_build_object(
             'authority', c.authority, 'name', c.name, 'operatorClass', c.operator_class,
             'status', c.status, 'grantedOn', c.granted_on, 'expiresOn', c.expires_on, 'state', c.state)
    from callsign_licenses c
    where c.callsign = v_base));

  -- The oldest day of the last 14 without a marker; today never has one.
  -- Older unrolled days are past RBN retention and stay out, and so do days
  -- before the first marker: the rollups start at the first spot.
  select min(g.d)::date into v_live_from
  from generate_series(greatest(v_today - 14, (select min(day) from callsign_rollup_days)), v_today,
                       interval '1 day') as g(d)
  where not exists (select 1 from callsign_rollup_days r where r.day = g.d::date);

  -- spot_stream is read three times, each through the base-callsign indexes:
  -- the unrolled days in full, the week grouped by spotter, and the week's
  -- newest 25. Materializing the whole week instead costs a busy station
  -- (20,000 RBN spots a day) about 300 ms.
  with live as materialized (
    select s.source, s.spot_time, s.callsign, s.spotter, s.frequency_khz, s.band, s.mode, s.mode_bucket,
           s.program, s.reference, s.reference_name, s.reference_location,
           (s.spot_time at time zone 'utc')::date as day
    from spot_stream s
    where s.base_callsign = v_base and s.spot_time >= v_live_from::timestamp at time zone 'utc'
      and not exists (select 1 from callsign_rollup_days d
                      where d.day = (s.spot_time at time zone 'utc')::date)
  ),
  heard as (
    select a.period, a.grain, a.source, a.band, a.mode_bucket, a.spots::bigint as n
    from callsign_activity a
    where a.base = v_base and a.role = 'heard'
    union all
    select l.day, 'day', l.source, l.band, l.mode_bucket, count(*)
    from live l
    group by l.day, l.source, l.band, l.mode_bucket
  ),
  totals as (
    select coalesce(sum(n), 0)::bigint as spots from heard
  ),
  sources as (
    select coalesce(jsonb_agg(jsonb_build_object('source', source, 'spots', n) order by n desc, source), '[]') as v
    from (select source, sum(n) as n from heard group by source) s
  ),
  by_month as (
    select date_trunc('month', period::timestamp)::date as month, source, sum(n) as n
    from heard group by 1, 2
  ),
  monthly as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'month', to_char(m.month, 'YYYY-MM'),
             'spots', coalesce((select sum(b.n) from by_month b where b.month = m.month), 0),
             'sources', coalesce((select jsonb_object_agg(b.source, b.n) from by_month b where b.month = m.month), '{}'))
           order by m.month), '[]') as v
    from generate_series((select min(month) from by_month)::timestamp, date_trunc('month', v_today::timestamp),
                         interval '1 month') as m0(m)
    cross join lateral (select m0.m::date as month) m
  ),
  by_day as (
    select period as day, source, sum(n) as n
    from heard where grain = 'day' and period > v_today - 30
    group by 1, 2
  ),
  daily as (
    select jsonb_agg(jsonb_build_object(
             'day', to_char(d.day, 'YYYY-MM-DD'),
             'spots', coalesce((select sum(b.n) from by_day b where b.day = d.day), 0),
             'sources', coalesce((select jsonb_object_agg(b.source, b.n) from by_day b where b.day = d.day), '{}'))
           order by d.day) as v
    from (select v_today - i as day from generate_series(0, 29) as i) d
  ),
  hour_counts as (
    select h.i::int - 1 as hour, h.x::bigint as n
    from callsign_activity a
    cross join lateral unnest(a.hours) with ordinality as h(x, i)
    where a.base = v_base and a.role = 'heard'
    union all
    select extract(hour from l.spot_time at time zone 'utc')::int, count(*)
    from live l group by 1
  ),
  hours as (
    select jsonb_agg(coalesce(c.n, 0) order by g.h) as v
    from generate_series(0, 23) as g(h)
    left join (select hour, sum(n) as n from hour_counts group by hour) c on c.hour = g.h
  ),
  -- The Stats page's bands: fixed order, zero-filled, other bands left out.
  bands as (
    select jsonb_agg(jsonb_build_object(
             'band', bo.band, 'spots', coalesce((select sum(h.n) from heard h where h.band = bo.band), 0))
           order by bo.ord) as v
    from (values ('160m', 1), ('80m', 2), ('60m', 3), ('40m', 4), ('30m', 5), ('20m', 6),
                 ('17m', 7), ('15m', 8), ('12m', 9), ('10m', 10), ('6m', 11), ('2m', 12)) as bo(band, ord)
  ),
  -- The Stats page's mode shares: each rounded, the remainder to the biggest.
  mode_rounded as (
    select ml.label, ml.ord, coalesce(c.n, 0) as n,
           case when t.spots = 0 then 0 else round(100.0 * coalesce(c.n, 0) / t.spots)::int end as pct
    from (values ('CW', 1), ('SSB', 2), ('FT8/FT4', 3), ('FM', 4), ('Other', 5)) as ml(label, ord)
    left join (select mode_bucket, sum(n) as n from heard group by 1) c on c.mode_bucket = ml.label
    cross join totals t
  ),
  modes as (
    select jsonb_agg(jsonb_build_object('label', label, 'spots', n, 'percent', percent) order by ord) as v
    from (
      select label, ord, n,
             case when sum(pct) over () = 0 then 0
                  when row_number() over (order by n desc, ord) = 1 then pct + (100 - sum(pct) over ())::int
                  else pct end as percent
      from mode_rounded
    ) m
  ),
  seen as (
    select * from callsign_seen where base = v_base
  ),
  live_last as (
    select l.spot_time, l.frequency_khz, l.mode
    from live l order by l.spot_time desc, l.frequency_khz desc limit 1
  ),
  last_heard as (
    select case
             when ll.spot_time is not null and (s.last_spot is null or ll.spot_time >= s.last_spot)
               then jsonb_build_object('time', to_char(ll.spot_time at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                                       'frequencyKhz', ll.frequency_khz, 'mode', ll.mode)
             when s.last_spot is not null
               then jsonb_build_object('time', to_char(s.last_spot at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                                       'frequencyKhz', s.last_frequency_khz, 'mode', s.last_mode)
           end as v,
           (select min(l.spot_time) from live l) as live_first,
           s.first_spot,
           coalesce(s.days_on_air, 0) + (select count(distinct l.day) from live l) as days_on_air
    from (select 1) one
    left join seen s on true
    left join live_last ll on true
  ),
  -- Heard from: rolled-up reach plus the live days' spotters, each placed
  -- once, without self-spots. Spotter CTEs are materialized so the self-spot
  -- test runs once per spotter: inlined, the planner pushes it below the
  -- grouping and calls base_callsign() for every spot (350 ms for a busy
  -- RBN station's week).
  live_spotters as materialized (
    select l.spotter, count(*) as n from live l where l.spotter is not null group by 1
  ),
  reach as (
    select country, continent, sum(n) as n
    from (
      select r.country, r.continent, r.spots::bigint as n from callsign_reach r where r.base = v_base
      union all
      select g.name, g.continent, ls.n
      from live_spotters ls
      cross join lateral public.cty_lookup(ls.spotter) g
      where not public.is_self_spot(v_base, ls.spotter)
    ) x
    group by country, continent
  ),
  live_refs as (
    select l.program, l.reference, count(distinct l.day)::bigint as days, count(*)::bigint as spots,
           max(l.day) as last_day,
           (array_agg(l.reference_name order by l.spot_time desc) filter (where l.reference_name is not null))[1] as name,
           (array_agg(l.reference_location order by l.spot_time desc) filter (where l.reference_location is not null))[1] as location
    from live l
    where l.reference is not null and l.program is not null
    group by l.program, l.reference
  ),
  refs as (
    select coalesce(r.program, l.program) as program, coalesce(r.reference, l.reference) as reference,
           coalesce(l.name, r.name) as name, coalesce(l.location, r.location) as location,
           coalesce(r.days, 0) + coalesce(l.days, 0) as days,
           coalesce(r.spots, 0) + coalesce(l.spots, 0) as spots,
           greatest(r.last_day, l.last_day) as last_day
    from (select * from callsign_references where base = v_base) r
    full join live_refs l on l.program = r.program and l.reference = r.reference
  ),
  hunting as (
    select source, sum(spots)::bigint as n
    from callsign_activity
    where base = v_base and role = 'spotter'
    group by source
  ),
  week_spotters as materialized (
    select s.spotter, s.band, count(*) as n, max(s.snr) as best_snr
    from spot_stream s
    where s.base_callsign = v_base and s.spot_time >= v_week_from and s.spotter is not null
    group by s.spotter, s.band
  ),
  heard_by as (
    select spotter, sum(n) as spots, max(best_snr) as best_snr,
           (array_agg(band order by n desc, band) filter (where band is not null))[1] as top_band
    from week_spotters
    group by spotter
    having not public.is_self_spot(v_base, spotter)
    order by spots desc, spotter
    limit 10
  )
  select case
           when (select spots from totals) = 0 and not exists (select 1 from hunting) then null
           else jsonb_build_object(
             'firstHeard', (select to_char(least(first_spot, live_first) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                            from last_heard),
             'lastHeard', (select v from last_heard),
             'spots', (select spots from totals),
             'daysOnAir', (select days_on_air from last_heard),
             'countries', (select count(distinct country) from reach),
             'continents', (select count(distinct continent) from reach),
             'sources', (select v from sources),
             'monthly', (select v from monthly),
             'daily', (select v from daily),
             'hours', (select v from hours),
             'bands', (select v from bands),
             'modes', (select v from modes),
             'activations', (
               select coalesce(jsonb_agg(jsonb_build_object('program', program, 'references', n, 'activations', days)
                                         order by program), '[]')
               from (select program, count(*) as n, sum(days) as days from refs group by program) p),
             'references', (
               select coalesce(jsonb_agg(jsonb_build_object(
                        'reference', reference, 'name', name, 'program', program, 'location', location,
                        'activations', days, 'spots', spots, 'lastDay', to_char(last_day, 'YYYY-MM-DD'))
                      order by last_day desc, days desc, reference), '[]')
               from (select * from refs order by last_day desc, days desc, reference limit 100) r),
             -- A reference spanning states (US-NC,US-VA) counts in each.
             'activationsByLocation', (
               select coalesce(jsonb_object_agg(location, days), '{}')
               from (select trim(loc) as location, sum(days) as days
                     from refs cross join lateral unnest(string_to_array(refs.location, ',')) as loc
                     where trim(loc) <> ''
                     group by 1) x),
             'reach', (
               select coalesce(jsonb_agg(jsonb_build_object('country', country, 'continent', continent, 'spots', n)
                                         order by n desc, country), '[]')
               from reach),
             'variants', (
               select coalesce(jsonb_agg(jsonb_build_object('callsign', callsign, 'spots', n)
                                         order by n desc, callsign), '[]')
               from (select callsign, sum(n) as n
                     from (select v.callsign, v.spots::bigint as n from callsign_variants v where v.base = v_base
                           union all
                           select l.callsign, count(*) from live l group by l.callsign) x
                     group by callsign
                     order by n desc, callsign
                     limit 20) v),
             'hunting', jsonb_build_object(
               'spots', (select coalesce(sum(n), 0) from hunting),
               'sources', (select coalesce(jsonb_agg(jsonb_build_object('source', source, 'spots', n)
                                                     order by n desc, source), '[]')
                           from hunting)),
             'heardBy', (
               select coalesce(jsonb_agg(jsonb_build_object('spotter', spotter, 'spots', spots, 'bestSnr', best_snr,
                                                            'topBand', top_band)
                                         order by spots desc, spotter), '[]')
               from heard_by),
             'recentSpots', (
               select coalesce(jsonb_agg(jsonb_build_object(
                        'time', to_char(spot_time at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                        'callsign', callsign, 'frequencyKhz', frequency_khz, 'band', band, 'mode', mode,
                        'reference', reference, 'source', source, 'spotter', spotter)
                      order by spot_time desc, source, spotter), '[]')
               from (select s.spot_time, s.callsign, s.frequency_khz, s.band, s.mode, s.reference, s.source, s.spotter
                     from spot_stream s
                     where s.base_callsign = v_base and s.spot_time >= v_week_from
                     order by s.spot_time desc
                     limit 25) n))
         end
  into v_heard;

  return v_header || jsonb_build_object('heard', v_heard);
end;
$$;

-- The profile from the cache when it is under 15 minutes old, otherwise built
-- and stored. Null when the input is not a callsign. A hidden call never touches the cache, so hiding and unhiding
-- take effect at once.
create function public.cached_callsign_profile(p_callsign text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base    text := public.base_callsign(p_callsign);
  v_payload jsonb;
begin
  if exists (select 1 from hidden_callsigns h where h.callsign = v_base) then
    return public.callsign_profile(p_callsign);
  end if;

  select c.payload into v_payload
  from callsign_profile_cache c
  where c.callsign = v_base and c.generated_at > now() - interval '15 minutes';
  if found then
    return v_payload;
  end if;

  v_payload := public.callsign_profile(p_callsign);
  if v_payload is null then
    return null;
  end if;
  insert into callsign_profile_cache (callsign, payload, generated_at)
  values (v_base, v_payload, now())
  on conflict (callsign) do update set payload = excluded.payload, generated_at = excluded.generated_at;
  return v_payload;
end;
$$;

-- Counts a lookup against the client's current one-minute window and returns
-- the window's count, this lookup included.
create function public.record_profile_lookup(p_client text)
returns int
language sql
security definer
set search_path = public
as $$
  insert into lookup_rate_limits (client, window_start, lookups)
  values (p_client, date_trunc('minute', now()), 1)
  on conflict (client, window_start) do update set lookups = lookup_rate_limits.lookups + 1
  returning lookups;
$$;

-- Hourly: drops finished rate-limit windows and expired cache entries.
create function public.prune_callsign_lookups()
returns void
language sql
security definer
set search_path = public
as $$
  delete from lookup_rate_limits where window_start < date_trunc('minute', now());
  delete from callsign_profile_cache where generated_at <= now() - interval '15 minutes';
$$;

revoke all on function public.callsign_profile(text) from public, anon, authenticated;
revoke all on function public.cached_callsign_profile(text) from public, anon, authenticated;
revoke all on function public.record_profile_lookup(text) from public, anon, authenticated;
revoke all on function public.prune_callsign_lookups() from public, anon, authenticated;
grant execute on function public.cached_callsign_profile(text) to service_role;
grant execute on function public.record_profile_lookup(text) to service_role;

-- Hourly, clear of the other jobs (:05 stats, :25 rollups, :50 licenses).
select cron.schedule('prune-callsign-lookups', '15 * * * *', $$ select public.prune_callsign_lookups(); $$);

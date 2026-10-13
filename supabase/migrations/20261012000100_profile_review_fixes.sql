-- Review fixes for 20261012000060 (callsign profiles, part 5), which is
-- applied and so not edited.
--
-- recentSpots: the newest 25 were ordered by spot_time alone. RBN times are
-- minute-granular, so a busy station has many rows tied at the cutoff and
-- Postgres picked which 25 at random; the list changed on every cache rebuild
-- with no new data. Both the cutoff and the output now order by every column
-- the entry shows, so the same rows always give the same 25. Nothing else in
-- callsign_profile() changes.
--
-- lookup_rate_limits.client is an HMAC of the client address, keyed with the
-- service-role key (the 000060 comment said SHA-256), and since this change
-- the address is an IPv6 client's /64 rather than the full address
-- (_shared/handlers/callsign_profile.ts).

comment on column lookup_rate_limits.client is
  'HMAC-SHA-256 (keyed with the service-role key) of the client IPv4 address or IPv6 /64, made by the callsign-profile function. Never the address.';

create or replace function public.callsign_profile(p_callsign text)
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
                      order by spot_time desc, source, spotter, callsign, frequency_khz, band, mode, reference), '[]')
               from (select s.spot_time, s.callsign, s.frequency_khz, s.band, s.mode, s.reference, s.source, s.spotter
                     from spot_stream s
                     where s.base_callsign = v_base and s.spot_time >= v_week_from
                     order by s.spot_time desc, s.source, s.spotter, s.callsign, s.frequency_khz, s.band, s.mode,
                              s.reference
                     limit 25) n))
         end
  into v_heard;

  return v_header || jsonb_build_object('heard', v_heard);
end;
$$;

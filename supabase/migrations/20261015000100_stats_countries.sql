-- Stats snapshot: spots per country (payload.countries) for the Stats page's
-- world map. A spot's country is where the station on the air is: the DXCC
-- entity cty_lookup() gives for the callsign as spotted (VP2E/K1ABC is
-- Anguilla), mapped to an ISO 3166-1 country. POTA, SOTAwatch and DX Cluster
-- come from raw_spots, RBN from rbn_daily_stations, never rbn_spots. APRS
-- packets are not spots and stay out, as do raw_spots' watched RBN copies.
--
-- Lookups run once per completed UTC day into country_daily_spots, once per
-- distinct call, the way the RBN day rollups work; the hourly refresh only
-- sums seven days of those rows. Otherwise refresh_stats_snapshot_at is
-- 20261014000200's, verbatim.

-- cty.dat primary prefix (cty_entities.prefix) -> ISO 3166-1 alpha-2. Kept
-- apart from cty_entities, which load_cty replaces every week. An island
-- entity with an ISO code of its own (Guam, Puerto Rico) uses it; the rest
-- go to their country (the Azores are PT, Hawaii and Alaska US). Kosovo is
-- the user-assigned XK. Every entity import-cty loads from the cty.dat
-- fixture is here except the three with no country (1A, 1S, BS7);
-- web/src/stats/countries.test.ts checks.
create table cty_entity_countries (
  entity  text primary key,
  country text not null check (country ~ '^[A-Z]{2}$')
);

insert into cty_entity_countries (entity, country) values
  ('3A', 'MC'), ('3B6', 'MU'), ('3B8', 'MU'), ('3B9', 'MU'), ('3C', 'GQ'), ('3C0', 'GQ'),
  ('3D2', 'FJ'), ('3D2/c', 'FJ'), ('3D2/r', 'FJ'), ('3DA', 'SZ'), ('3V', 'TN'), ('3W', 'VN'),
  ('3X', 'GN'), ('3Y/b', 'BV'), ('3Y/p', 'AQ'), ('4J', 'AZ'), ('4L', 'GE'), ('4O', 'ME'),
  ('4S', 'LK'), ('4U1I', 'CH'), ('4U1U', 'US'), ('4W', 'TL'), ('4X', 'IL'), ('5A', 'LY'),
  ('5B', 'CY'), ('5H', 'TZ'), ('5N', 'NG'), ('5R', 'MG'), ('5T', 'MR'), ('5U', 'NE'), ('5V', 'TG'),
  ('5W', 'WS'), ('5X', 'UG'), ('5Z', 'KE'), ('6W', 'SN'), ('6Y', 'JM'), ('7O', 'YE'), ('7P', 'LS'),
  ('7Q', 'MW'), ('7X', 'DZ'), ('8P', 'BB'), ('8Q', 'MV'), ('8R', 'GY'), ('9A', 'HR'), ('9G', 'GH'),
  ('9H', 'MT'), ('9J', 'ZM'), ('9K', 'KW'), ('9L', 'SL'), ('9M2', 'MY'), ('9M6', 'MY'), ('9N', 'NP'),
  ('9Q', 'CD'), ('9U', 'BI'), ('9V', 'SG'), ('9X', 'RW'), ('9Y', 'TT'), ('A2', 'BW'), ('A3', 'TO'),
  ('A4', 'OM'), ('A5', 'BT'), ('A6', 'AE'), ('A7', 'QA'), ('A9', 'BH'), ('AP', 'PK'), ('BV', 'TW'),
  ('BV9P', 'TW'), ('BY', 'CN'), ('C2', 'NR'), ('C3', 'AD'), ('C5', 'GM'), ('C6', 'BS'), ('C9', 'MZ'),
  ('CE', 'CL'), ('CE0X', 'CL'), ('CE0Y', 'CL'), ('CE0Z', 'CL'), ('CE9', 'AQ'), ('CM', 'CU'),
  ('CN', 'MA'), ('CP', 'BO'), ('CT', 'PT'), ('CT3', 'PT'), ('CU', 'PT'), ('CX', 'UY'), ('CY0', 'CA'),
  ('CY9', 'CA'), ('D2', 'AO'), ('D4', 'CV'), ('D6', 'KM'), ('DL', 'DE'), ('DU', 'PH'), ('E3', 'ER'),
  ('E4', 'PS'), ('E5/n', 'CK'), ('E5/s', 'CK'), ('E6', 'NU'), ('E7', 'BA'), ('EA', 'ES'),
  ('EA6', 'ES'), ('EA8', 'ES'), ('EA9', 'ES'), ('EI', 'IE'), ('EK', 'AM'), ('EL', 'LR'),
  ('EP', 'IR'), ('ER', 'MD'), ('ES', 'EE'), ('ET', 'ET'), ('EU', 'BY'), ('EX', 'KG'), ('EY', 'TJ'),
  ('EZ', 'TM'), ('F', 'FR'), ('FG', 'GP'), ('FH', 'YT'), ('FJ', 'BL'), ('FK', 'NC'), ('FK/c', 'NC'),
  ('FM', 'MQ'), ('FO', 'PF'), ('FO/a', 'PF'), ('FO/c', 'CP'), ('FO/m', 'PF'), ('FP', 'PM'),
  ('FR', 'RE'), ('FS', 'MF'), ('FT/g', 'TF'), ('FT/j', 'TF'), ('FT/t', 'TF'), ('FT/w', 'TF'),
  ('FT/x', 'TF'), ('FT/z', 'TF'), ('FW', 'WF'), ('FY', 'GF'), ('G', 'GB'), ('GD', 'IM'),
  ('GI', 'GB'), ('GJ', 'JE'), ('GM', 'GB'), ('GU', 'GG'), ('GW', 'GB'), ('H4', 'SB'), ('H40', 'SB'),
  ('HA', 'HU'), ('HB', 'CH'), ('HB0', 'LI'), ('HC', 'EC'), ('HC8', 'EC'), ('HH', 'HT'), ('HI', 'DO'),
  ('HK', 'CO'), ('HK0/a', 'CO'), ('HK0/m', 'CO'), ('HL', 'KR'), ('HP', 'PA'), ('HR', 'HN'),
  ('HS', 'TH'), ('HV', 'VA'), ('HZ', 'SA'), ('I', 'IT'), ('IS', 'IT'), ('J2', 'DJ'), ('J3', 'GD'),
  ('J5', 'GW'), ('J6', 'LC'), ('J7', 'DM'), ('J8', 'VC'), ('JA', 'JP'), ('JD/m', 'JP'),
  ('JD/o', 'JP'), ('JT', 'MN'), ('JW', 'SJ'), ('JX', 'SJ'), ('JY', 'JO'), ('K', 'US'), ('KG4', 'CU'),
  ('KH0', 'MP'), ('KH1', 'UM'), ('KH2', 'GU'), ('KH3', 'UM'), ('KH4', 'UM'), ('KH5', 'UM'),
  ('KH6', 'US'), ('KH7K', 'US'), ('KH8', 'AS'), ('KH8/s', 'AS'), ('KH9', 'UM'), ('KL', 'US'),
  ('KP1', 'UM'), ('KP2', 'VI'), ('KP4', 'PR'), ('KP5', 'PR'), ('LA', 'NO'), ('LU', 'AR'),
  ('LX', 'LU'), ('LY', 'LT'), ('LZ', 'BG'), ('OA', 'PE'), ('OD', 'LB'), ('OE', 'AT'), ('OH', 'FI'),
  ('OH0', 'AX'), ('OJ0', 'AX'), ('OK', 'CZ'), ('OM', 'SK'), ('ON', 'BE'), ('OX', 'GL'), ('OY', 'FO'),
  ('OZ', 'DK'), ('P2', 'PG'), ('P4', 'AW'), ('P5', 'KP'), ('PA', 'NL'), ('PJ2', 'CW'), ('PJ4', 'BQ'),
  ('PJ5', 'BQ'), ('PJ7', 'SX'), ('PY', 'BR'), ('PY0F', 'BR'), ('PY0S', 'BR'), ('PY0T', 'BR'),
  ('PZ', 'SR'), ('R1FJ', 'RU'), ('S0', 'EH'), ('S2', 'BD'), ('S5', 'SI'), ('S7', 'SC'), ('S9', 'ST'),
  ('SM', 'SE'), ('SP', 'PL'), ('ST', 'SD'), ('SU', 'EG'), ('SV', 'GR'), ('SV/a', 'GR'),
  ('SV5', 'GR'), ('SV9', 'GR'), ('T2', 'TV'), ('T30', 'KI'), ('T31', 'KI'), ('T32', 'KI'),
  ('T33', 'KI'), ('T5', 'SO'), ('T7', 'SM'), ('T8', 'PW'), ('TA', 'TR'), ('TF', 'IS'), ('TG', 'GT'),
  ('TI', 'CR'), ('TI9', 'CR'), ('TJ', 'CM'), ('TK', 'FR'), ('TL', 'CF'), ('TN', 'CG'), ('TR', 'GA'),
  ('TT', 'TD'), ('TU', 'CI'), ('TY', 'BJ'), ('TZ', 'ML'), ('UA', 'RU'), ('UA2', 'RU'), ('UA9', 'RU'),
  ('UK', 'UZ'), ('UN', 'KZ'), ('UR', 'UA'), ('V2', 'AG'), ('V3', 'BZ'), ('V4', 'KN'), ('V5', 'NA'),
  ('V6', 'FM'), ('V7', 'MH'), ('V8', 'BN'), ('VE', 'CA'), ('VK', 'AU'), ('VK0H', 'HM'),
  ('VK0M', 'AU'), ('VK9C', 'CC'), ('VK9L', 'AU'), ('VK9M', 'AU'), ('VK9N', 'NF'), ('VK9W', 'AU'),
  ('VK9X', 'CX'), ('VP2E', 'AI'), ('VP2M', 'MS'), ('VP2V', 'VG'), ('VP5', 'TC'), ('VP6', 'PN'),
  ('VP6/d', 'PN'), ('VP8', 'FK'), ('VP8/g', 'GS'), ('VP8/h', 'AQ'), ('VP8/o', 'AQ'), ('VP8/s', 'GS'),
  ('VP9', 'BM'), ('VQ9', 'IO'), ('VR', 'HK'), ('VU', 'IN'), ('VU4', 'IN'), ('VU7', 'IN'),
  ('XE', 'MX'), ('XF4', 'MX'), ('XT', 'BF'), ('XU', 'KH'), ('XW', 'LA'), ('XX9', 'MO'), ('XZ', 'MM'),
  ('YA', 'AF'), ('YB', 'ID'), ('YI', 'IQ'), ('YJ', 'VU'), ('YK', 'SY'), ('YL', 'LV'), ('YN', 'NI'),
  ('YO', 'RO'), ('YS', 'SV'), ('YU', 'RS'), ('YV', 'VE'), ('YV0', 'VE'), ('Z2', 'ZW'), ('Z3', 'MK'),
  ('Z6', 'XK'), ('Z8', 'SS'), ('ZA', 'AL'), ('ZB', 'GI'), ('ZC4', 'CY'), ('ZD7', 'SH'),
  ('ZD8', 'SH'), ('ZD9', 'SH'), ('ZF', 'KY'), ('ZK3', 'TK'), ('ZL', 'NZ'), ('ZL7', 'NZ'),
  ('ZL8', 'NZ'), ('ZL9', 'NZ'), ('ZP', 'PY'), ('ZS', 'ZA'), ('ZS8', 'ZA');

-- Spots per (day, source, entity). source is the raw_spots source, or 'rbn'
-- for the firehose.
create table country_daily_spots (
  day    date not null,
  source text not null check (source in ('pota', 'sotawatch', 'dxcluster', 'rbn')),
  entity text not null,
  spots  int  not null,
  primary key (day, source, entity)
);

create table country_rollup_days (
  day       date        primary key,
  rolled_at timestamptz not null
);

-- Service-role only, like the other rollup tables: RLS on, no policies.
alter table cty_entity_countries enable row level security;
alter table country_daily_spots enable row level security;
alter table country_rollup_days enable row level security;
revoke all on cty_entity_countries, country_daily_spots, country_rollup_days from anon, authenticated;

-- Replaces one UTC day's country rows. Calls are grouped per source first and
-- each distinct call is looked up once. A call cty_lookup cannot place is not
-- counted. Returns false, changing nothing, when no cty.dat is loaded, so the
-- day is retried rather than marked empty.
create function public.rollup_country_day(p_day date)
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
      and r.source in ('pota', 'sotawatch', 'dxcluster')
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

revoke all on function public.rollup_country_day(date) from public, anon, authenticated;

-- refresh_stats_snapshot_at, as in 20261014000200, plus the country rollups
-- above and payload.countries: every country with a spot, by total spots
-- descending, then code. See 20261014000200 for the rest of the header.
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
      -- The page describes POTA and SOTA activity. Any other source (RBN skimmer
      -- reports of watched callsigns) is not an activation and stays out.
      and r.source in ('pota', 'sotawatch')
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
           count(distinct callsign)                                         as activators,
           count(distinct pota_reference) + count(distinct sota_summit_ref) as references,
           -- Activations: distinct (callsign, reference, UTC day) per program.
           count(distinct (callsign, pota_reference, day)) filter (where pota_reference is not null)  as pota_activations,
           count(distinct (callsign, sota_summit_ref, day)) filter (where sota_summit_ref is not null) as sota_activations,
           -- Chasers: distinct spotters on chased spots, overall and per source.
           count(distinct spotter) filter (where chased)                            as chasers,
           count(distinct spotter) filter (where chased and source = 'pota')        as pota_chasers,
           count(distinct spotter) filter (where chased and source = 'sotawatch')   as sota_chasers
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
           count(*) filter (where source = 'sotawatch') as sota
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
                                'rbn', coalesce(r.rbn, 0), 'aprs', coalesce(a.aprs, 0), 'dx', coalesce(x.dx, 0))
             order by d.day
           ) as v
    from days d
    left join daily_counts c using (day)
    left join daily_rbn r using (day)
    left join daily_aprs a using (day)
    left join daily_dx x using (day)
  ),
  -- hourly: exactly 168 hours, oldest first, zero-filled, ending at the last
  -- complete hour rather than at window_end (see the header). POTA and
  -- SOTAwatch come from raw_spots over those hours, RBN from the rollups.
  slots as (
    select generate_series(v_hour_start, v_hour_end - interval '1 hour', interval '1 hour') as slot
  ),
  slot_counts as (
    select date_bin(interval '1 hour', r.spot_time, timestamptz '2000-01-01 00:00+00') as slot,
           count(*) filter (where r.source = 'pota')      as pota,
           count(*) filter (where r.source = 'sotawatch') as sota
    from raw_spots r
    where r.spot_time >= v_hour_start
      and r.spot_time <  v_hour_end
      and r.source in ('pota', 'sotawatch')
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
               'pota', coalesce(c.pota, 0), 'sota', coalesce(c.sota, 0), 'rbn', coalesce(h.spots, 0),
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
           coalesce(sum(d.spots) filter (where d.source = 'dxcluster'), 0) as dx,
           coalesce(sum(d.spots) filter (where d.source = 'rbn'), 0)       as rbn
    from country_daily_spots d
    join cty_entity_countries c using (entity)
    where d.day >= v_first_day and d.day < v_end_day
    group by c.country
  ),
  countries as (
    select coalesce(
             jsonb_agg(jsonb_build_object('code', code, 'pota', pota, 'sota', sota, 'dx', dx, 'rbn', rbn)
                       order by pota + sota + dx + rbn desc, code asc),
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
           count(*) filter (where source = 'sotawatch') as sota
    from spots
    where band is not null
    group by band
  ),
  bands as (
    select jsonb_agg(
             jsonb_build_object('band', bo.band, 'pota', coalesce(c.pota, 0), 'sota', coalesce(c.sota, 0))
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
           count(distinct pota_reference) + count(distinct sota_summit_ref) as refs,
           count(distinct (pota_reference, day)) filter (where pota_reference is not null)
             + count(distinct (sota_summit_ref, day)) filter (where sota_summit_ref is not null) as activations,
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
  -- topReferences: top 8 across both programs by spots.
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
  ),
  top_reference_rows as (
    select * from reference_counts
    order by n desc, reference asc
    limit 8
  ),
  -- The name is looked up only for the eight kept rows: a POTA name is the
  -- most recent non-null pota_park_name by spot_time; SOTA has no name.
  top_reference_names as (
    select r.reference, r.program, r.n, r.activations,
           case when r.program = 'POTA' then (
             select s.pota_park_name
             from spots s
             where s.pota_reference = r.reference and s.pota_park_name is not null
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
        'spots', t.spots, 'potaSpots', t.pota_spots, 'sotaSpots', t.sota_spots,
        'activators', t.activators, 'references', t.references,
        'activations', t.pota_activations + t.sota_activations,
        'potaActivations', t.pota_activations, 'sotaActivations', t.sota_activations,
        'chasers', t.chasers, 'potaChasers', t.pota_chasers, 'sotaChasers', t.sota_chasers
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

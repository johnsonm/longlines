-- Stats: Reverse Beacon Network figures and hourly ingest volume.
--
-- Bands now start at 160m (twelve entries, 160m through 2m) for all three
-- band charts; RBN has much of its CW there.
--
-- Replaces refresh_stats_snapshot() as defined in 20261011000006 (applied
-- migrations are not edited). The payload gains two keys and each daily entry
-- gains an RBN count; every existing key keeps its meaning:
--
--   daily[].rbn  RBN spots on that UTC day.
--   hourly       168 entries, one per UTC hour of the window, with the POTA,
--                SOTAwatch and RBN spots stored for that hour.
--   rbn          the week's RBN spots and skimmers, spots per band and the
--                eight most heard stations with how many skimmers heard each.
--
-- RBN rollup. rbn_spots holds every RBN spot, about 1.5 million rows a day,
-- so the hourly refresh does not aggregate it. Instead each complete UTC day
-- is rolled up once into three small tables (spots per hour, per skimmer and
-- band, per station heard), in one scan of that day's partition, and the
-- snapshot reads only those. Distinct skimmers over the week are counted from
-- the per-day rows, so they are exact, not sums of daily counts.
--
-- Most heard stations. The eight stations come from the per-day station rows;
-- how many distinct skimmers heard each over the week cannot be summed from
-- days, so it is counted from rbn_spots through rbn_spots_callsign_time_idx,
-- for those eight callsigns only, and kept in rbn_top_stations until a rollup
-- changes or the window moves (about twice a day).
--
-- When a day is rolled up. The refresh rolls up every window day without a
-- rollup. A day rolled up within an hour of its end is rolled up again on the
-- next refresh after that hour: the relay buffers up to about 50 minutes of
-- lines while ingest-rbn is unreachable, so a late push can still add rows
-- for the previous day. Rows that arrive later than that are not counted.
-- Rollups older than the window are deleted; the archive keeps the spots.
--
-- raw_spots RBN rows (watched callsigns) are copies of rbn_spots rows, so the
-- RBN figures come from rbn_spots only and raw_spots RBN rows still count
-- nowhere on the page.

create table rbn_rollup_days (
  day       date        primary key,
  rolled_at timestamptz not null
);

create table rbn_hourly (
  hour  timestamptz primary key,
  spots int         not null
);

-- band is null when the frequency is outside every band in _shared/bands.ts.
create table rbn_daily_skimmers (
  day     date not null,
  spotter text not null,
  band    text,
  spots   int  not null,
  unique nulls not distinct (day, spotter, band)
);

create table rbn_daily_stations (
  day      date not null,
  callsign text not null,
  spots    int  not null,
  primary key (day, callsign)
);

create table rbn_top_stations (
  window_start timestamptz not null,
  callsign     text        not null,
  spots        int         not null,
  skimmers     int         not null,
  primary key (window_start, callsign)
);

-- Service-role only, like the other internal tables: RLS on, no policies.
alter table rbn_rollup_days enable row level security;
alter table rbn_hourly enable row level security;
alter table rbn_daily_skimmers enable row level security;
alter table rbn_daily_stations enable row level security;
alter table rbn_top_stations enable row level security;
revoke all on rbn_rollup_days, rbn_hourly, rbn_daily_skimmers, rbn_daily_stations, rbn_top_stations
  from anon, authenticated;

-- Rolls up one UTC day of rbn_spots, replacing any earlier rollup of it.
-- One scan: the grouping sets produce the hourly, per-skimmer-and-band and
-- per-station counts together, and grouping() tells the three kinds apart (a
-- null band in a skimmer row is a real null, not a grouping placeholder).
-- Hours without spots are stored as 0 so a rolled-up day always has 24 rows.
create function public.rollup_rbn_day(p_day date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from timestamptz := p_day::timestamp at time zone 'utc';
  v_to   timestamptz := (p_day + 1)::timestamp at time zone 'utc';
begin
  delete from rbn_hourly where hour >= v_from and hour < v_to;
  delete from rbn_daily_skimmers where day = p_day;
  delete from rbn_daily_stations where day = p_day;

  with s as (
    select date_bin(interval '1 hour', r.spot_time, timestamptz '2000-01-01 00:00+00') as hour,
           r.spotter, r.band, r.callsign
    from rbn_spots r
    where r.spot_time >= v_from and r.spot_time < v_to
  ),
  g as materialized (
    select hour, spotter, band, callsign,
           grouping(hour) = 0     as by_hour,
           grouping(spotter) = 0  as by_skimmer,
           grouping(callsign) = 0 as by_station,
           count(*)::int as n
    from s
    group by grouping sets ((hour), (spotter, band), (callsign))
  ),
  hours as (
    insert into rbn_hourly (hour, spots)
    select h, coalesce(g.n, 0)
    from generate_series(v_from, v_to - interval '1 hour', interval '1 hour') as h
    left join g on g.by_hour and g.hour = h
  ),
  skimmers as (
    insert into rbn_daily_skimmers (day, spotter, band, spots)
    select p_day, spotter, band, n from g where by_skimmer
  )
  insert into rbn_daily_stations (day, callsign, spots)
  select p_day, callsign, n from g where by_station;

  insert into rbn_rollup_days (day, rolled_at) values (p_day, now())
  on conflict (day) do update set rolled_at = excluded.rolled_at;
end;
$$;

revoke all on function public.rollup_rbn_day(date) from public, anon, authenticated;

-- Builds the payload in one statement and prunes to the 48 newest rows.
--
-- Time zone handling: the window is computed in timestamp (UTC wall clock)
-- space and converted to timestamptz at the end. `timestamptz - interval
-- '7 days'` would be evaluated in the session time zone and is off by an hour
-- when the week crosses a DST change there; `now() at time zone 'utc'` is a
-- plain timestamp, so date_trunc and the subtraction are DST-free, and the
-- final `at time zone 'utc'` yields midnight UTC regardless of session tz.
-- Hour buckets use date_bin with a UTC origin and one-hour steps, which no
-- session time zone can shift.
--
-- Empty window: jsonb_agg over zero rows is null, so every array is coalesced
-- to '[]'. peakHour falls back to 0 and busiestSlot to {window_start, 0};
-- there is no "no data" marker in the payload shape, and totals.spots = 0
-- tells the client the rest is a zero-filled frame.
create or replace function public.refresh_stats_snapshot()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_end   timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
  v_window_start timestamptz := (date_trunc('day', now() at time zone 'utc') - interval '7 days') at time zone 'utc';
  v_first_day    date        := (now() at time zone 'utc')::date - 7;
  v_end_day      date        := (now() at time zone 'utc')::date;
  v_day          date;
  v_rolled       boolean     := false;
begin
  -- RBN rollups: every window day without one, and any day rolled up within
  -- an hour of its end (see the header).
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

  -- Most heard stations, recounted only when a rollup changed or the window
  -- moved (see the header).
  if v_rolled or not exists (select 1 from rbn_top_stations where window_start = v_window_start) then
    delete from rbn_top_stations;
    insert into rbn_top_stations (window_start, callsign, spots, skimmers)
    select v_window_start, t.callsign, t.n,
           (select count(distinct r.spotter)
            from rbn_spots r
            where r.callsign = t.callsign
              and r.spot_time >= v_window_start and r.spot_time < v_window_end)
    from (
      select callsign, sum(spots)::int as n
      from rbn_daily_stations
      where day >= v_first_day and day < v_end_day
      group by callsign
      order by n desc, callsign asc
      limit 8
    ) as t;
  end if;

  insert into stats_snapshots (window_start, window_end, payload)
  with
  -- Every in-window row with its UTC day and hour.
  spots as (
    select r.id, r.source, r.spot_time, r.callsign, r.spotter, r.band, r.mode, r.mode_family,
           r.pota_reference, r.pota_park_name, r.pota_location, r.sota_summit_ref,
           to_char(r.spot_time at time zone 'utc', 'YYYY-MM-DD') as day,
           extract(hour from r.spot_time at time zone 'utc')::int as hour,
           -- A chaser spot has a spotter who is not the activator (see is_self_spot).
           (r.spotter is not null and not public.is_self_spot(r.callsign, r.spotter)) as chased
    from raw_spots r
    where r.spot_time >= v_window_start
      and r.spot_time <  v_window_end
      -- The page describes POTA and SOTA activity. Any other source (RBN skimmer
      -- reports of watched callsigns) is not an activation and stays out.
      and r.source in ('pota', 'sotawatch')
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
  daily as (
    select jsonb_agg(
             jsonb_build_object('day', d.day, 'pota', coalesce(c.pota, 0), 'sota', coalesce(c.sota, 0),
                                'rbn', coalesce(r.rbn, 0))
             order by d.day
           ) as v
    from days d
    left join daily_counts c using (day)
    left join daily_rbn r using (day)
  ),
  -- hourly: exactly 168 hours, oldest first, zero-filled. POTA and SOTAwatch
  -- come from the in-window raw_spots rows, RBN from the rollup.
  slots as (
    select generate_series(v_window_start, v_window_end - interval '1 hour', interval '1 hour') as slot
  ),
  slot_counts as (
    select date_bin(interval '1 hour', spot_time, timestamptz '2000-01-01 00:00+00') as slot,
           count(*) filter (where source = 'pota')      as pota,
           count(*) filter (where source = 'sotawatch') as sota
    from spots
    group by 1
  ),
  hourly as (
    select jsonb_agg(
             jsonb_build_object(
               'hour', to_char(s.slot at time zone 'utc', 'YYYY-MM-DD"T"HH24":00:00Z"'),
               'pota', coalesce(c.pota, 0), 'sota', coalesce(c.sota, 0), 'rbn', coalesce(h.spots, 0)
             )
             order by s.slot
           ) as v
    from slots s
    left join slot_counts c using (slot)
    left join rbn_hourly h on h.hour = s.slot
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
  -- The labels are chart buckets, not mode families. CW follows mode_family
  -- so every spelling _shared/modes.ts treats as CW counts; SSB, FT8/FT4 and
  -- FM are exact mode strings on purpose, since the phone family also holds
  -- AM and digital voice and the digital family holds RTTY, PSK and so on,
  -- all of which belong in Other.
  -- Each share is rounded (round() is half away from zero), then whatever is
  -- left over after rounding (100 - sum, possibly negative) is added to the
  -- bucket with the most spots. With no spots every percent is 0.
  mode_labels as (
    select * from (values ('CW', 1), ('SSB', 2), ('FT8/FT4', 3), ('FM', 4), ('Other', 5)) as l(label, ord)
  ),
  mode_counts as (
    select case
             when mode_family = 'cw'             then 'CW'
             when mode in ('ssb', 'usb', 'lsb')  then 'SSB'
             when mode in ('ft8', 'ft4')         then 'FT8/FT4'
             when mode = 'fm'                    then 'FM'
             else 'Other'                              -- includes null
           end as label,
           count(*) as n
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
  -- activations is per (reference, UTC day) within the callsign.
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
               jsonb_build_object('callsign', a.callsign, 'references', a.refs, 'activations', a.activations,
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
      'sotaAssociations', sa.v,
      'bands',            b.v,
      'modes',            m.v,
      'topActivators',    ta.v,
      'topReferences',    tr.v,
      'rbn',              r.v
    )
  from totals t
  cross join daily d
  cross join hourly h
  cross join pota_by_state ps
  cross join sota_associations sa
  cross join bands b
  cross join modes m
  cross join top_activators ta
  cross join top_references tr
  cross join rbn r;

  -- Keep the 48 most recent snapshots (two days at one per hour).
  delete from stats_snapshots
  where id not in (
    select id from stats_snapshots
    order by generated_at desc, id desc
    limit 48
  );
end;
$$;

comment on function public.refresh_stats_snapshot() is
  'Rolls up RBN days, inserts one stats_snapshots row for the 7 most recent complete UTC days and prunes to 48 rows. Cron only.';

revoke all on function public.refresh_stats_snapshot() from public, anon, authenticated;

-- The newest snapshot gains the new keys now rather than at the next hourly run.
select public.refresh_stats_snapshot();

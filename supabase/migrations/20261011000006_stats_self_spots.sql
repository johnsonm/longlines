-- Stats review fixes: self-spots, RBNHole spotters, a fresh snapshot.
--
-- Replaces refresh_stats_snapshot() as defined in 20261006000019 (applied
-- migrations are not edited). The payload shape is unchanged.
--
-- Self-spots. 0019 compared the spotter with each '/'-separated part of the
-- activator callsign. That missed an exact self-spot by a slashed call
-- (EA2/G4OBK spotting EA2/G4OBK) and a spotter with its own suffix (KK4PWJ/P
-- spotting KK4PWJ), so both counted as chasers. A self-spot is now one where
-- spotter and activator share a base callsign (base_callsign below), and the
-- rule lives in is_self_spot() so anything else that needs it calls the same
-- function instead of copying an expression.
--
-- Sources. Only POTA and SOTAwatch rows are counted. raw_spots may hold other
-- sources (RBN) whose rows are reports about watched stations, not activity.
--
-- RBNHole. _shared/normalize.ts now stores a null spotter for a SOTAwatch
-- RBNHOLE spot whose comment names no skimmer (the bot is not a station) and
-- uppercases the extracted skimmer. The update below applies the same rule to
-- rows already stored, so the bot stops counting as a chaser now rather than
-- after those rows leave the seven-day window.
--
-- Activations are not a floor on the programs' own numbers: unspotted
-- activations are missing, while a callsign stored two ways (KK4PWJ and
-- KK4PWJ/P) at one park on one day, or an attempt that ends short of the QSO
-- minimum, adds one. The count is an estimate in both directions.
--
-- The newest snapshot is rebuilt at the end so clients never read a row in the
-- old shape until the next hourly run.

-- The base callsign of a possibly prefixed or suffixed call: the longest
-- '/'-separated part, the later one on a tie (W4/G4OBK -> G4OBK, KK4PWJ/P ->
-- KK4PWJ, KH6/K1A -> K1A, VP2V/W1AW -> W1AW).
create function public.base_callsign(p_call text)
returns text
language sql
immutable
as $$
  select part
  from unnest(string_to_array(p_call, '/')) with ordinality as t(part, i)
  order by length(part) desc, i desc
  limit 1;
$$;

-- True when the spotter is the activator under any prefix or suffix on either
-- side. False when either is null.
create function public.is_self_spot(p_callsign text, p_spotter text)
returns boolean
language sql
immutable
as $$
  select coalesce(public.base_callsign(p_spotter) = public.base_callsign(p_callsign), false);
$$;

revoke all on function public.base_callsign(text) from public, anon, authenticated;
revoke all on function public.is_self_spot(text, text) from public, anon, authenticated;

update raw_spots set spotter = null
where source = 'sotawatch' and spotter = 'RBNHOLE';
update raw_spots set spotter = upper(spotter)
where source = 'sotawatch' and spotter <> upper(spotter);

-- Builds the payload in one statement and prunes to the 48 newest rows.
--
-- Time zone handling: the window is computed in timestamp (UTC wall clock)
-- space and converted to timestamptz at the end. `timestamptz - interval
-- '7 days'` would be evaluated in the session time zone and is off by an hour
-- when the week crosses a DST change there; `now() at time zone 'utc'` is a
-- plain timestamp, so date_trunc and the subtraction are DST-free, and the
-- final `at time zone 'utc'` yields midnight UTC regardless of session tz.
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
begin
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
  daily as (
    select jsonb_agg(
             jsonb_build_object('day', d.day, 'pota', coalesce(c.pota, 0), 'sota', coalesce(c.sota, 0))
             order by d.day
           ) as v
    from days d
    left join daily_counts c using (day)
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
      ('80m', 1), ('60m', 2), ('40m', 3), ('30m', 4), ('20m', 5), ('17m', 6),
      ('15m', 7), ('12m', 8), ('10m', 9), ('6m', 10), ('2m', 11)
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
      'potaByState',      ps.v,
      'sotaAssociations', sa.v,
      'bands',            b.v,
      'modes',            m.v,
      'topActivators',    ta.v,
      'topReferences',    tr.v
    )
  from totals t
  cross join daily d
  cross join pota_by_state ps
  cross join sota_associations sa
  cross join bands b
  cross join modes m
  cross join top_activators ta
  cross join top_references tr;

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
  'Inserts one stats_snapshots row for the 7 most recent complete UTC days and prunes to 48 rows. Cron only.';

revoke all on function public.refresh_stats_snapshot() from public, anon, authenticated;

select public.refresh_stats_snapshot();

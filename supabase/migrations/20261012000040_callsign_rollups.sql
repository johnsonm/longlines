-- Callsign profiles, part 3 (docs/superpowers/specs/2026-10-12-callsign-lookup-design.md).
--
-- spot_stream: one row shape over every source, so profiles never name a
-- source. It unions raw_spots (except its RBN rows, which are copies of
-- watched stations' rbn_spots rows) with rbn_spots. A source that writes
-- raw_spots appears with no change; a new firehose table needs one more
-- "union all" arm here.
--
-- Rollups: permanent per-base-callsign aggregates, so a profile covers every
-- day since Long Lines started while rbn_spots keeps only seven. They hold
-- counts and breakdowns, never per-spotter rows; the archive keeps the spots.
--
--   callsign_activity    period, base, role, source, band, mode bucket -> spots, spots by UTC hour
--   callsign_reach       period, base, source, spotter country and continent -> spots
--   callsign_references  base, program, reference -> name, location, days, spots, first and last day
--   callsign_seen        base -> first and last spot, last frequency and mode, days on the air
--   callsign_variants    base, callsign as spotted -> spots, last day
--
-- Role "heard" is the station being spotted. Role "spotter" is the station
-- posting spots of others (a profile's Hunting card); self-spots are left out
-- of it and of reach, since a station does not hear itself. Self-spots still
-- count as heard, as they do on the Stats page.
--
-- Exactly once. rollup_callsign_day(day) inserts the day's marker in
-- callsign_rollup_days (20261012000010) first and does nothing when it is
-- already there. callsign_references, callsign_seen and callsign_variants are
-- running totals (days on the air, days at a reference), so a day rolled up
-- twice would count twice. A day is rolled up from two hours after it ends,
-- since the relay buffers about 50 minutes of lines; a spot that arrives
-- after its day is rolled up is not counted.
--
-- A day is refused, and left for the next run, when it cannot be rolled up
-- whole: no cty.dat is loaded (its reach would be empty for good), or its RBN
-- rows were archived and retired already (retention gives up waiting for a
-- rollup at 14 days). rollup_callsign_day(day, true) rolls up such a day
-- without RBN, for an operator who accepts the gap.
--
-- When. pg_cron runs backfill_callsign_rollups(2) at 25 past every hour, in
-- its own job: it rolls up at most two completed days without a marker,
-- oldest first, each in its own subtransaction, then compacts day rows older
-- than 35 days into month rows. Yesterday is rolled up at 02:25 UTC, ahead of
-- RBN retention at 03:35, and a backlog clears at two days an hour. Keeping it
-- out of maintain_rbn_spots() means a slow or cancelled rollup never holds the
-- partition locks that job takes, or undoes its partitions and retention. The
-- same function is the operator's backfill (docs/OPERATIONS.md).
--
-- Cost. An RBN day is about 1.5 million rows. The rollup reads the day once
-- and groups it by call, spotter, band, mode, hour and reference before
-- anything per-call happens, so base_callsign() and cty_lookup() run once per
-- distinct call and spotter, not per row.
--
-- base_callsign() also changes here, before rollups make its output
-- permanent. It now drops an SSID or skimmer marker (K3PA-1, DK9IP-#) as
-- cty_lookup does, and /QRPP, which otherwise wins on length (K1A/QRPP). Rows
-- whose stored base changes are rewritten, as 20261012000010 asks.
--
-- mode_bucket() is the Stats page's mode grouping as a function. The Stats
-- refresh moves onto it in part 7, which replaces refresh_stats_snapshot()
-- anyway.

create or replace function public.base_callsign(p_call text)
returns text
language sql
immutable
as $$
  with c as (
    select split_part(upper(trim(p_call)), '-', 1) as call
  ),
  parts as (
    select part, i
    from c, unnest(string_to_array(c.call, '/')) with ordinality as t(part, i)
  ),
  kept as (
    select part, i from parts
    where part <> ''
      and part not in ('P', 'M', 'MM', 'AM', 'QRP', 'QRPP', 'R')
      and part !~ '^[0-9]$'
  )
  -- Longest part; on a tie the one with a digit after a letter (a callsign
  -- rather than a bare prefix), then the later one (VP2V/W1AW -> W1AW).
  select coalesce(
    (select part from kept
     order by length(part) desc, (part ~ '[A-Z][0-9]') desc, i desc
     limit 1),
    (select call from c));
$$;

update raw_spots set callsign = callsign
where base_callsign is distinct from public.base_callsign(callsign);

-- The Stats page's mode buckets: CW | SSB | FT8/FT4 | FM | Other. CW follows
-- mode_family so every spelling _shared/modes.ts treats as CW counts; SSB,
-- FT8/FT4 and FM are exact mode strings, since the phone family also holds AM
-- and digital voice and the digital family RTTY, PSK and so on, which belong
-- in Other. A single expression, so the planner inlines it.
create function public.mode_bucket(p_mode text, p_family text)
returns text
language sql
immutable
as $$
  select case
           when p_family = 'cw'                 then 'CW'
           when p_mode in ('ssb', 'usb', 'lsb') then 'SSB'
           when p_mode in ('ft8', 'ft4')        then 'FT8/FT4'
           when p_mode = 'fm'                   then 'FM'
           else 'Other'
         end;
$$;

-- Every spot of every source in one shape. Service-role only, like the tables
-- under it; profiles read it through definer RPCs. base_callsign and
-- spotter_base are computed per row for rbn_spots, so a query over many RBN
-- rows should group by callsign first (as the rollup does) or, for one
-- station, filter on callsign through its index.
create view spot_stream with (security_invoker = true) as
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
            when r.sota_summit_ref is not null then 'SOTA' end as program,
       coalesce(r.pota_reference, r.sota_summit_ref)          as reference,
       case when r.pota_reference is not null then r.pota_park_name end as reference_name,
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

revoke all on spot_stream from anon, authenticated;

-- Elementwise sum of two int arrays of the same length; null is an empty
-- operand. The step function of int_array_sum, which compaction uses to add
-- up hour arrays.
create function public.int_array_add(p_a int[], p_b int[])
returns int[]
language sql
immutable
as $$
  select case
           when p_a is null then p_b
           when p_b is null then p_a
           else array(select coalesce(x, 0) + coalesce(y, 0)
                      from unnest(p_a, p_b) with ordinality as t(x, y, i)
                      order by i)
         end;
$$;

create aggregate public.int_array_sum(int[]) (
  sfunc = public.int_array_add,
  stype = int[]
);

-- Rollup tables. Service-role only: RLS on, no policies, no client grants.
-- period is the first day of the period: the day itself for grain 'day', the
-- first of the month for 'month'. band is null outside the bands in
-- _shared/bands.ts.
create table callsign_activity (
  period      date   not null,
  grain       text   not null check (grain in ('day', 'month')),
  base        text   not null,
  role        text   not null check (role in ('heard', 'spotter')),
  source      text   not null,
  band        text,
  mode_bucket text   not null,
  spots       int    not null,
  hours       int[]  not null check (cardinality(hours) = 24),
  unique nulls not distinct (base, grain, period, role, source, band, mode_bucket)
);

create index callsign_activity_day_idx on callsign_activity (period) where grain = 'day';

-- Countries are cty.dat entity names; a spotter cty_lookup cannot place is
-- not counted here.
create table callsign_reach (
  period    date not null,
  grain     text not null check (grain in ('day', 'month')),
  base      text not null,
  source    text not null,
  country   text not null,
  continent text not null,
  spots     int  not null,
  primary key (base, grain, period, source, country, continent)
);

create index callsign_reach_day_idx on callsign_reach (period) where grain = 'day';

-- days is the number of UTC days the station was spotted at the reference
-- (the profile's activations). name and location are the latest seen.
create table callsign_references (
  base      text not null,
  program   text not null,
  reference text not null,
  name      text,
  location  text,
  days      int  not null,
  spots     int  not null,
  first_day date not null,
  last_day  date not null,
  primary key (base, program, reference)
);

create table callsign_seen (
  base               text          primary key,
  first_spot         timestamptz   not null,
  last_spot          timestamptz   not null,
  last_frequency_khz numeric(12,3) not null,
  last_mode          text,
  days_on_air        int           not null
);

create table callsign_variants (
  base     text not null,
  callsign text not null,
  spots    int  not null,
  last_day date not null,
  primary key (base, callsign)
);

alter table callsign_activity enable row level security;
alter table callsign_reach enable row level security;
alter table callsign_references enable row level security;
alter table callsign_seen enable row level security;
alter table callsign_variants enable row level security;
revoke all on callsign_activity, callsign_reach, callsign_references, callsign_seen, callsign_variants
  from anon, authenticated;

-- Rolls up one completed UTC day from spot_stream. Returns the day's spot
-- count, or null when the day was already rolled up (nothing changes). With
-- p_without_rbn, a day whose RBN rows were retired is rolled up from the other
-- sources (see the header).
--
-- p groups the day's rows by everything the rollups split on, which is the
-- one pass over the day. names and geo resolve each distinct call and spotter
-- once. Every insert below reads b, p with base calls attached.
create function public.rollup_callsign_day(p_day date, p_without_rbn boolean default false)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from  timestamptz := p_day::timestamp at time zone 'utc';
  v_to    timestamptz := (p_day + 1)::timestamp at time zone 'utc';
  v_spots bigint;
begin
  if p_day is null or p_day > public.last_rollup_day() then
    raise exception 'rollup_callsign_day: % is not a completed UTC day (or ended under two hours ago)', p_day;
  end if;
  if not exists (select 1 from cty_load) then
    raise exception 'rollup_callsign_day: no cty.dat loaded, so spotter countries would be lost';
  end if;
  if not p_without_rbn
     and exists (select 1 from archive_log l
                 where l.source = 'rbn' and l.slice_start >= v_from and l.slice_start < v_to and l.row_count > 0)
     and not exists (select 1 from rbn_spots r where r.spot_time >= v_from and r.spot_time < v_to) then
    raise exception 'rollup_callsign_day: the RBN spots of % were retired; rollup_callsign_day(day, true) rolls up the rest', p_day;
  end if;

  insert into callsign_rollup_days (day, rolled_at) values (p_day, now())
  on conflict (day) do nothing;
  if not found then
    return null;
  end if;

  with p as materialized (
    select s.source, s.callsign, s.spotter, s.band, s.mode, s.mode_bucket,
           extract(hour from s.spot_time at time zone 'utc')::int as hour,
           s.program, s.reference,
           count(*)::int                                          as n,
           min(s.spot_time)                                       as first_time,
           max(s.spot_time)                                       as last_time,
           -- The frequency of the latest spot, without an ordered aggregate
           -- (which would sort the whole day): arrays compare element by
           -- element, so the max is the latest [epoch, kHz] pair.
           (max(array[extract(epoch from s.spot_time), s.frequency_khz]))[2] as last_khz,
           -- The latest name and location, by the same trick on text: an
           -- ISO timestamp sorts in time order.
           max(array[to_char(s.spot_time at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS.US'), s.reference_name])
             filter (where s.reference_name is not null)                as name_at,
           max(array[to_char(s.spot_time at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS.US'), s.reference_location])
             filter (where s.reference_location is not null)            as location_at
    from spot_stream s
    where s.spot_time >= v_from and s.spot_time < v_to
    group by s.source, s.callsign, s.spotter, s.band, s.mode, s.mode_bucket, 7, s.program, s.reference
  ),
  names as materialized (
    select c.call, public.base_callsign(c.call) as base
    from (select callsign as call from p union select spotter from p where spotter is not null) c
  ),
  geo as materialized (
    select d.spotter, l.name as country, l.continent
    from (select distinct spotter from p where spotter is not null) d
    cross join lateral public.cty_lookup(d.spotter) l
  ),
  b as materialized (
    select p.*, nc.base, ns.base as spotter_base,
           -- is_self_spot's rule, on base calls already resolved.
           coalesce(ns.base = nc.base, false) as self
    from p
    join names nc on nc.call = p.callsign
    left join names ns on ns.call = p.spotter
  ),
  roles as (
    select base, 'heard' as role, source, band, mode_bucket, hour, n from b
    union all
    select spotter_base, 'spotter', source, band, mode_bucket, hour, n
    from b where spotter_base is not null and not self
  ),
  -- Hours as 24 filtered sums: plain aggregates, where int_array_sum would
  -- call a SQL function for every row (about 9 s of a 1.5M-row RBN day).
  activity as (
    insert into callsign_activity (period, grain, base, role, source, band, mode_bucket, spots, hours)
    select p_day, 'day', base, role, source, band, mode_bucket, sum(n)::int,
           array_replace(array[
             sum(n) filter (where hour = 0),  sum(n) filter (where hour = 1),  sum(n) filter (where hour = 2),
             sum(n) filter (where hour = 3),  sum(n) filter (where hour = 4),  sum(n) filter (where hour = 5),
             sum(n) filter (where hour = 6),  sum(n) filter (where hour = 7),  sum(n) filter (where hour = 8),
             sum(n) filter (where hour = 9),  sum(n) filter (where hour = 10), sum(n) filter (where hour = 11),
             sum(n) filter (where hour = 12), sum(n) filter (where hour = 13), sum(n) filter (where hour = 14),
             sum(n) filter (where hour = 15), sum(n) filter (where hour = 16), sum(n) filter (where hour = 17),
             sum(n) filter (where hour = 18), sum(n) filter (where hour = 19), sum(n) filter (where hour = 20),
             sum(n) filter (where hour = 21), sum(n) filter (where hour = 22), sum(n) filter (where hour = 23)
           ], null, 0)::int[]
    from roles
    group by base, role, source, band, mode_bucket
  ),
  reach as (
    insert into callsign_reach (period, grain, base, source, country, continent, spots)
    select p_day, 'day', b.base, b.source, g.country, g.continent, sum(b.n)::int
    from b join geo g on g.spotter = b.spotter
    where not b.self
    group by b.base, b.source, g.country, g.continent
  ),
  refs as (
    insert into callsign_references (base, program, reference, name, location, days, spots, first_day, last_day)
    select base, program, reference, (max(name_at))[2], (max(location_at))[2], 1, sum(n)::int, p_day, p_day
    from b
    where reference is not null and program is not null
    group by base, program, reference
    on conflict (base, program, reference) do update set
      name      = case when excluded.last_day >= callsign_references.last_day
                       then coalesce(excluded.name, callsign_references.name)
                       else coalesce(callsign_references.name, excluded.name) end,
      location  = case when excluded.last_day >= callsign_references.last_day
                       then coalesce(excluded.location, callsign_references.location)
                       else coalesce(callsign_references.location, excluded.location) end,
      days      = callsign_references.days + 1,
      spots     = callsign_references.spots + excluded.spots,
      first_day = least(callsign_references.first_day, excluded.first_day),
      last_day  = greatest(callsign_references.last_day, excluded.last_day)
  ),
  latest as (
    select base, min(first_time) as first_time, max(last_time) as last_time
    from b group by base
  ),
  seen as (
    insert into callsign_seen (base, first_spot, last_spot, last_frequency_khz, last_mode, days_on_air)
    select distinct on (l.base) l.base, l.first_time, l.last_time, b.last_khz, b.mode, 1
    from latest l
    join b on b.base = l.base and b.last_time = l.last_time
    order by l.base, b.last_khz desc
    on conflict (base) do update set
      first_spot         = least(callsign_seen.first_spot, excluded.first_spot),
      last_spot          = greatest(callsign_seen.last_spot, excluded.last_spot),
      last_frequency_khz = case when excluded.last_spot >= callsign_seen.last_spot
                                then excluded.last_frequency_khz else callsign_seen.last_frequency_khz end,
      last_mode          = case when excluded.last_spot >= callsign_seen.last_spot
                                then excluded.last_mode else callsign_seen.last_mode end,
      days_on_air        = callsign_seen.days_on_air + 1
  ),
  variants as (
    insert into callsign_variants (base, callsign, spots, last_day)
    select base, callsign, sum(n)::int, p_day
    from b
    group by base, callsign
    on conflict (base, callsign) do update set
      spots    = callsign_variants.spots + excluded.spots,
      last_day = greatest(callsign_variants.last_day, excluded.last_day)
  )
  select coalesce(sum(n), 0) into v_spots from p;

  return v_spots;
end;
$$;

-- Folds day rows older than 35 days into month rows. The month rows of a
-- month still partly in day rows are partial; readers sum both grains.
create function public.compact_callsign_rollups()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cutoff date := (now() at time zone 'utc')::date - 35;
begin
  with moved as (
    delete from callsign_activity where grain = 'day' and period < v_cutoff
    returning *
  )
  insert into callsign_activity (period, grain, base, role, source, band, mode_bucket, spots, hours)
  select date_trunc('month', period)::date, 'month', base, role, source, band, mode_bucket,
         sum(spots)::int, public.int_array_sum(hours)
  from moved
  group by date_trunc('month', period), base, role, source, band, mode_bucket
  on conflict (base, grain, period, role, source, band, mode_bucket) do update set
    spots = callsign_activity.spots + excluded.spots,
    hours = public.int_array_add(callsign_activity.hours, excluded.hours);

  with moved as (
    delete from callsign_reach where grain = 'day' and period < v_cutoff
    returning *
  )
  insert into callsign_reach (period, grain, base, source, country, continent, spots)
  select date_trunc('month', period)::date, 'month', base, source, country, continent, sum(spots)::int
  from moved
  group by date_trunc('month', period), base, source, country, continent
  on conflict (base, grain, period, source, country, continent) do update set
    spots = callsign_reach.spots + excluded.spots;
end;
$$;

-- The latest day a rollup may take: the UTC day that ended at least two hours
-- ago.
create function public.last_rollup_day()
returns date
language sql
stable
as $$
  select ((now() at time zone 'utc') - interval '2 hours')::date - 1;
$$;

-- Rolls up completed UTC days since the first spot that have no marker,
-- oldest first, until p_max_days of them are rolled up (all when null), then
-- compacts. A failed day does not count toward p_max_days, so a day that
-- keeps failing cannot hold the others back. One row per day attempted: its
-- spot count, or the error that left it unrolled (that day's changes are
-- undone; the next run tries it again).
create function public.backfill_callsign_rollups(p_max_days int default null)
returns table (rollup_day date, spots bigint, error text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_first  date;
  v_day    date;
  v_rolled int := 0;
begin
  select (min(s.spot_time) at time zone 'utc')::date into v_first from spot_stream s;
  if v_first is null then
    return;
  end if;

  for v_day in
    select g.d::date
    from generate_series(v_first, public.last_rollup_day(), interval '1 day') as g(d)
    where not exists (select 1 from callsign_rollup_days r where r.day = g.d::date)
    order by 1
  loop
    exit when v_rolled >= p_max_days;
    rollup_day := v_day;
    begin
      spots := public.rollup_callsign_day(v_day);
      error := null;
      if spots is not null then
        v_rolled := v_rolled + 1;
      end if;
    exception when others then
      spots := null;
      error := sqlerrm;
      raise warning 'callsign rollup of % failed: %', v_day, sqlerrm;
    end;
    return next;
  end loop;

  -- A compaction error must not undo the days rolled up above.
  begin
    perform public.compact_callsign_rollups();
  exception when others then
    raise warning 'callsign rollup compaction failed: %', sqlerrm;
  end;
end;
$$;

revoke all on function public.mode_bucket(text, text) from public, anon, authenticated;
revoke all on function public.int_array_add(int[], int[]) from public, anon, authenticated;
revoke all on function public.int_array_sum(int[]) from public, anon, authenticated;
revoke all on function public.last_rollup_day() from public, anon, authenticated;
revoke all on function public.rollup_callsign_day(date, boolean) from public, anon, authenticated;
revoke all on function public.compact_callsign_rollups() from public, anon, authenticated;
revoke all on function public.backfill_callsign_rollups(int) from public, anon, authenticated;

-- Hourly, off the archive's */10 grid and the stats refresh at :05.
select cron.schedule(
  'rollup-callsign-days',
  '25 * * * *',
  $$ select count(*) from public.backfill_callsign_rollups(2); $$
);

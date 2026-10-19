-- Daily per-callsign activity, kept forever, and roll-up status
-- (docs/superpowers/specs/2026-10-19-callsign-days-design.md).
--
-- The callsign rollups (20261012000040) already read each completed UTC day
-- once and keep per-station counts, but compact_callsign_rollups() folds
-- callsign_activity's day rows into month rows after 35 days, so "every day
-- this station was active" cannot be answered past that. callsign_days is the
-- slim table that can: one row per base callsign, UTC day and source, with
-- the spot count and the distinct modes and bands heard, never compacted.
-- Modes are the canonical values _shared/modes.ts stored (usb and lsb stay as
-- spelled; a reader that wants one SSB figure groups them), so a new mode
-- needs no schema change. Only the heard role: skimmers and chasers appear
-- as spotters in callsign_activity, not here.
--
-- Filled by rollup_callsign_day from the same grouped pass, in the same
-- transaction as the marker, so it inherits exactly-once. Days rolled up
-- before this migration are filled by backfill_callsign_days, which the
-- hourly job calls in runs that rolled no day up (23 hours of 24), two days
-- a run. Every source but RBN is filled
-- exactly from spot_stream, since raw_spots is never pruned. RBN is exact
-- while the day's rows are still there; once retired (rbn_day_retired: a
-- slice logged with more rows than the database holds) its row comes from
-- callsign_activity's RBN day rows, spots and bands exact and modes only
-- where the bucket is one mode (CW). callsign_rollup_days.days_filled_at
-- records the fill, and compaction leaves a day's rows alone until it is set.
-- A retired day whose day rows were already compacted cannot be filled and
-- is refused, so it shows up rather than being filled short.
--
-- Status. callsign_rollup_days now also records what a day counted (spots)
-- and whether it was rolled up without its retired RBN rows (without_rbn,
-- decided against the archive's counts, and set for the days already rolled
-- up that way). A day that fails in the hourly job lands in
-- callsign_rollup_failures (attempts and the last error) instead of only a
-- Postgres warning; rollup_callsign_day removes the row when the day succeeds,
-- from the job or by hand. RBN retention still retires a day without its
-- roll-up at 14 days (an RBN day is ~350 MB; a stuck roll-up must not fill the
-- disk) but now records that too. callsign_rollup_status is one row per UTC
-- day since the first spot: done, done_without_rbn, fill_failed, rbn_retired,
-- failed or pending. Service-role only, like the tables.
--
-- backfill_callsign_rollups found the first day with min(spot_time) over
-- spot_stream every hour, which has no leading spot_time index on rbn_spots
-- and so scanned every partition. first_rollup_day() takes the earlier of the
-- first marker and the first raw_spots row (an index probe) and scans
-- spot_stream only when there is neither, so a spot day before the first
-- marker is still rolled up (scripts/smoke-test.sql relies on it).
--
-- The hourly job holds row locks on callsign_rollup_days while it runs; the
-- alter table below would otherwise queue behind it with the whole migration
-- transaction open. A lock timeout fails the push, which can simply be run
-- again (away from :25). Transaction-scoped, as supabase db push applies a
-- migration; applied by hand with psql, wrap the file in begin/commit.
select set_config('lock_timeout', '10s', true);

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table callsign_days (
  base   text   not null,
  day    date   not null,
  source text   not null,
  spots  int    not null,
  -- Distinct canonical modes heard, sorted; spots without a mode count in
  -- spots but add nothing here.
  modes  text[] not null,
  -- Distinct bands heard, sorted; likewise for spots outside the band list.
  bands  text[] not null,
  primary key (base, day, source)
);

alter table callsign_days enable row level security;
revoke all on callsign_days from anon, authenticated;

alter table callsign_rollup_days
  add column spots          bigint,
  add column without_rbn    boolean not null default false,
  add column days_filled_at timestamptz;

create table callsign_rollup_failures (
  day             date        primary key,
  attempts        int         not null,
  first_failed_at timestamptz not null,
  last_failed_at  timestamptz not null,
  last_error      text        not null
);

alter table callsign_rollup_failures enable row level security;
revoke all on callsign_rollup_failures from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Records a failed attempt at a day; the day's success deletes the row.
create function public.record_callsign_rollup_failure(p_day date, p_error text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into callsign_rollup_failures (day, attempts, first_failed_at, last_failed_at, last_error)
  values (p_day, 1, now(), now(), p_error)
  on conflict (day) do update set
    attempts       = callsign_rollup_failures.attempts + 1,
    last_failed_at = now(),
    last_error     = excluded.last_error;
$$;

-- RBN rows of the day the archive has logged.
create function public.rbn_day_archived_rows(p_day date)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(l.row_count), 0)::bigint
  from archive_log l
  where l.source = 'rbn'
    and l.slice_start >= p_day::timestamp at time zone 'utc'
    and l.slice_start < (p_day + 1)::timestamp at time zone 'utc';
$$;

-- Whether the day's RBN rows are gone: some slice of the day is logged with
-- more rows than the database holds for it, the test rbn_day_archived
-- (20261017004020) uses. Only retention removes rows, so fewer than logged
-- means retired; late lines of a retired day cannot hide it unless they
-- refill every logged slice. A day the archive has nothing for is not
-- retired, whether it had no RBN rows or is not archived yet.
--
-- Written out rather than through rbn_day_slices: it runs on the hourly
-- paths, and each logged slice here is a range probe of rbn_spots' unique
-- index, which leads with spot_time, stopping at the first short slice. A
-- day with nothing archived costs one archive_log probe.
create function public.rbn_day_retired(p_day date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from archive_log l
    where l.source = 'rbn'
      and l.slice_start >= p_day::timestamp at time zone 'utc'
      and l.slice_start < (p_day + 1)::timestamp at time zone 'utc'
      and l.row_count > (select count(*) from rbn_spots r
                         where r.spot_time >= l.slice_start
                           and r.spot_time < l.slice_start
                                             + make_interval(mins => public.archive_slice_minutes('rbn'))));
$$;

-- The first UTC day the roll-ups cover: the earlier of the first marker and
-- the first raw spot spot_stream reads (not raw_spots' RBN copies), both
-- index probes; spot_stream is scanned only while there is neither (a
-- database with RBN rows alone).
create function public.first_rollup_day()
returns date
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    least((select min(r.day) from callsign_rollup_days r),
          (select (min(s.spot_time) at time zone 'utc')::date from raw_spots s where s.source <> 'rbn')),
    (select (min(s.spot_time) at time zone 'utc')::date from spot_stream s));
$$;

-- Days already rolled up with (day, true): the archive has their RBN rows,
-- the roll-up counted none. Only days whose day rows are still there, since a
-- compacted day has no RBN day rows either way.
update callsign_rollup_days d
set without_rbn = true
where public.rbn_day_archived_rows(d.day) > 0
  and exists (select 1 from callsign_activity a
              where a.grain = 'day' and a.period = d.day and a.role = 'heard')
  and not exists (select 1 from callsign_activity a
                  where a.grain = 'day' and a.period = d.day and a.role = 'heard' and a.source = 'rbn');

-- ---------------------------------------------------------------------------
-- rollup_callsign_day: as in 20261012000040, plus the callsign_days insert
-- from the same grouped pass, the marker's spots, without_rbn and
-- days_filled_at, the failures row cleared on success, and the retired test
-- against the archive's counts.
-- ---------------------------------------------------------------------------

create or replace function public.rollup_callsign_day(p_day date, p_without_rbn boolean default false)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from     timestamptz := p_day::timestamp at time zone 'utc';
  v_to       timestamptz := (p_day + 1)::timestamp at time zone 'utc';
  v_spots    bigint;
  v_rbn      bigint;
  v_archived bigint;
begin
  if p_day is null or p_day > public.last_rollup_day() then
    raise exception 'rollup_callsign_day: % is not a completed UTC day (or ended under two hours ago)', p_day;
  end if;
  if not exists (select 1 from cty_load) then
    raise exception 'rollup_callsign_day: no cty.dat loaded, so spotter countries would be lost';
  end if;
  if not p_without_rbn
     and not exists (select 1 from callsign_rollup_days r where r.day = p_day)
     and public.rbn_day_retired(p_day) then
    raise exception 'rollup_callsign_day: the RBN spots of % were retired; rollup_callsign_day(day, true) rolls up the rest', p_day;
  end if;

  insert into callsign_rollup_days (day, rolled_at) values (p_day, now())
  on conflict (day) do nothing;
  if not found then
    return null;
  end if;
  -- Same transaction as the marker: a failure below puts the row back.
  delete from callsign_rollup_failures f where f.day = p_day;
  -- Before the pass, so a slice the archive logs meanwhile (which may hold a
  -- line that arrived after the pass's snapshot) cannot set without_rbn.
  v_archived := public.rbn_day_archived_rows(p_day);

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
  -- The day's summary per station and source: every b row is a heard row,
  -- so summing n here counts each spot once. A row already there (a day
  -- rebuilt from the archive before it was marked) wins.
  days as (
    insert into callsign_days (base, day, source, spots, modes, bands)
    select base, p_day, source, sum(n)::int,
           coalesce(array_agg(distinct mode order by mode) filter (where mode is not null), '{}'),
           coalesce(array_agg(distinct band order by band) filter (where band is not null), '{}')
    from b
    group by base, source
    on conflict (base, day, source) do nothing
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
  select coalesce(sum(n), 0), coalesce(sum(n) filter (where source = 'rbn'), 0)
    into v_spots, v_rbn
  from p;

  -- without_rbn when the archive holds RBN rows of the day the roll-up did
  -- not see: the whole day when the operator accepted the gap, or a late
  -- line or two of a retired day.
  update callsign_rollup_days
  set spots          = v_spots,
      without_rbn    = v_rbn < v_archived,
      days_filled_at = now()
  where day = p_day;

  return v_spots;
end;
$$;

-- ---------------------------------------------------------------------------
-- callsign_days for days rolled up before this migration
-- ---------------------------------------------------------------------------

-- Fills callsign_days for one rolled-up day whose days_filled_at is null.
-- Returns the day's spot count and whether its RBN row is exact, or no row
-- when the day is not rolled up or already filled. Locks the marker row, so
-- two fills of one day cannot both insert.
--
-- One grouped pass over spot_stream (by callsign first; base calls are
-- resolved per distinct call). Every source but RBN is inserted from it:
-- raw_spots is never pruned, so those rows are complete. RBN is inserted from
-- it while the day is not retired and the pass holds at least the RBN spots
-- the roll-up counted (late rows are included rather than losing the day to
-- the approximate path); otherwise the RBN row comes from callsign_activity's
-- RBN day rows, spots and bands exact and modes only where the bucket names
-- one mode the RBN rows can hold (CW; RBN reports no FM, and the SSB,
-- FT8/FT4 and Other buckets hold several modes). A retired day with no day
-- rows left (compacted before this migration) is refused: only the archive
-- has it.
create function public.fill_callsign_days(p_day date)
returns table (spots bigint, exact boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from      timestamptz := p_day::timestamp at time zone 'utc';
  v_to        timestamptz := (p_day + 1)::timestamp at time zone 'utc';
  v_filled    timestamptz;
  v_retired   boolean;
  v_no_rbn    boolean;
  v_day_rows  boolean;
  v_ref_rbn   bigint;
  v_fresh     bigint;
  v_fresh_rbn bigint;
  v_exact     boolean;
  v_spots     bigint;
begin
  select r.days_filled_at, r.without_rbn into v_filled, v_no_rbn
  from callsign_rollup_days r where r.day = p_day
  for update;
  if not found or v_filled is not null then
    return;
  end if;

  select count(*) > 0, coalesce(sum(a.spots) filter (where a.source = 'rbn'), 0)
    into v_day_rows, v_ref_rbn
  from callsign_activity a
  where a.grain = 'day' and a.period = p_day and a.role = 'heard';

  -- Compacted: no day rows at all, yet RBN month rows for its month. A day
  -- rolled up knowingly without RBN has no RBN rows to lose and is filled.
  v_retired := public.rbn_day_retired(p_day);
  if v_retired and not v_no_rbn and not v_day_rows
     and exists (select 1 from callsign_activity a
                 where a.grain = 'month' and a.period = date_trunc('month', p_day)::date
                   and a.role = 'heard' and a.source = 'rbn') then
    raise exception 'fill_callsign_days: the RBN spots of % were retired and its day rows compacted; only the archive has it', p_day;
  end if;

  with p as materialized (
    select s.source, s.callsign, s.mode, s.band, count(*)::int as n
    from spot_stream s
    where s.spot_time >= v_from and s.spot_time < v_to
    group by s.source, s.callsign, s.mode, s.band
  ),
  names as materialized (
    select c.callsign, public.base_callsign(c.callsign) as base
    from (select distinct callsign from p) c
  ),
  b as materialized (
    select p.*, nm.base from p join names nm on nm.callsign = p.callsign
  ),
  total as (
    select coalesce(sum(n), 0)::bigint                                   as fresh,
           coalesce(sum(n) filter (where source = 'rbn'), 0)::bigint     as fresh_rbn,
           not v_retired and coalesce(sum(n) filter (where source = 'rbn'), 0) >= v_ref_rbn as rbn_exact
    from b
  ),
  exact_fill as (
    insert into callsign_days (base, day, source, spots, modes, bands)
    select base, p_day, source, sum(n)::int,
           coalesce(array_agg(distinct mode order by mode) filter (where mode is not null), '{}'),
           coalesce(array_agg(distinct band order by band) filter (where band is not null), '{}')
    from b
    where source <> 'rbn' or (select t.rbn_exact from total t)
    group by base, source
    on conflict (base, day, source) do nothing
  ),
  approx_fill as (
    insert into callsign_days (base, day, source, spots, modes, bands)
    select a.base, p_day, a.source, sum(a.spots)::int,
           coalesce(array_agg(distinct a.mode order by a.mode) filter (where a.mode is not null), '{}'),
           coalesce(array_agg(distinct a.band order by a.band) filter (where a.band is not null), '{}')
    from (select ca.base, ca.source, ca.band, ca.spots,
                 case ca.mode_bucket when 'CW' then 'cw' end as mode
          from callsign_activity ca
          where ca.grain = 'day' and ca.period = p_day and ca.role = 'heard' and ca.source = 'rbn') a
    where not (select t.rbn_exact from total t)
    group by a.base, a.source
    on conflict (base, day, source) do nothing
  )
  select t.fresh, t.fresh_rbn, t.rbn_exact into v_fresh, v_fresh_rbn, v_exact from total t;

  v_spots := case when v_exact then v_fresh else v_fresh - v_fresh_rbn + v_ref_rbn end;

  update callsign_rollup_days r
  set days_filled_at = now(),
      spots          = coalesce(r.spots, v_spots),
      -- A day rolled up with (day, true) before without_rbn existed.
      without_rbn    = r.without_rbn or (v_ref_rbn = 0 and public.rbn_day_archived_rows(p_day) > 0)
  where r.day = p_day;
  delete from callsign_rollup_failures f where f.day = p_day;

  spots := v_spots;
  exact := v_exact;
  return next;
end;
$$;

-- Fills callsign_days for rolled-up days without it, oldest first, until
-- p_max_days are filled (all when null). One row per day attempted: its spot
-- count and whether its RBN row is exact, or the error that left it unfilled
-- (that day's changes are undone, the error is recorded in
-- callsign_rollup_failures, and the next run tries it again). A run attempts
-- at most twice p_max_days days, so failures cannot turn one run into a pass
-- over every unfilled day, and fills at most p_max_days. A day another caller
-- filled meanwhile is skipped without a row.
create function public.backfill_callsign_days(p_max_days int default null)
returns table (fill_day date, spots bigint, exact boolean, error text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day      date;
  v_filled   int := 0;
  v_attempts int := 0;
begin
  for v_day in
    select r.day from callsign_rollup_days r where r.days_filled_at is null order by r.day
  loop
    exit when v_filled >= p_max_days or v_attempts >= 2 * p_max_days;
    v_attempts := v_attempts + 1;
    fill_day := v_day;
    begin
      select f.spots, f.exact into spots, exact from public.fill_callsign_days(v_day) f;
      if not found then
        continue;
      end if;
      error := null;
      v_filled := v_filled + 1;
    exception when others then
      spots := null;
      exact := null;
      error := sqlerrm;
      perform public.record_callsign_rollup_failure(v_day, 'callsign_days fill: ' || sqlerrm);
      raise warning 'callsign_days fill of % failed: %', v_day, sqlerrm;
    end;
    return next;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Compaction waits for the fill
-- ---------------------------------------------------------------------------

-- As in 20261012000040, except a day whose callsign_days rows are not filled
-- yet keeps its day rows: the fill reads them when the day's RBN spots are
-- gone.
create or replace function public.compact_callsign_rollups()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cutoff date := (now() at time zone 'utc')::date - 35;
begin
  with moved as (
    delete from callsign_activity a
    where a.grain = 'day' and a.period < v_cutoff
      and not exists (select 1 from callsign_rollup_days d where d.day = a.period and d.days_filled_at is null)
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
    delete from callsign_reach r
    where r.grain = 'day' and r.period < v_cutoff
      and not exists (select 1 from callsign_rollup_days d where d.day = r.period and d.days_filled_at is null)
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

-- ---------------------------------------------------------------------------
-- backfill_callsign_rollups: failures recorded, the fill before compaction,
-- and the first day from first_rollup_day()
-- ---------------------------------------------------------------------------

-- Rolls up completed UTC days since the first spot that have no marker,
-- oldest first, until p_max_days of them are rolled up (all when null); in a
-- run that rolled none, fills callsign_days for days rolled up before it
-- existed (at most p_max_days too); then compacts. A failed day does not count toward
-- p_max_days, so a day that keeps failing cannot hold the others back; it is
-- recorded in callsign_rollup_failures until it succeeds. One row per day
-- attempted: its spot count, or the error that left it unrolled (that day's
-- changes are undone; the next run tries it again).
create or replace function public.backfill_callsign_rollups(p_max_days int default null)
returns table (rollup_day date, spots bigint, error text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_first  date := public.first_rollup_day();
  v_day    date;
  v_rolled int := 0;
begin
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
      -- The handler runs after the block's subtransaction rolled back, so
      -- this write stays.
      perform public.record_callsign_rollup_failure(v_day, sqlerrm);
      raise warning 'callsign rollup of % failed: %', v_day, sqlerrm;
    end;
    return next;
  end loop;

  -- Neither the fill nor a compaction error may undo the days rolled up above.
  -- The fill runs only in an hour that rolled nothing up, so one run never
  -- scans more than p_max_days days (a statement timeout is not caught here
  -- and would undo the run).
  if v_rolled = 0 then
    begin
      perform count(*) from public.backfill_callsign_days(p_max_days);
    exception when others then
      raise warning 'callsign_days fill failed: %', sqlerrm;
    end;
  end if;
  begin
    perform public.compact_callsign_rollups();
  exception when others then
    raise warning 'callsign rollup compaction failed: %', sqlerrm;
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- maintain_rbn_spots: as in 20261012000010, plus a record of a day retired
-- without its roll-up
-- ---------------------------------------------------------------------------

-- An archived day is retired only when callsign_rollup_days has it or it is
-- older than 14 days. Retiring a day's partition without its marker leaves
-- its spots in the archive only; that is recorded in callsign_rollup_failures
-- (and the hourly job keeps refusing the day, see rollup_callsign_day), so
-- the gap is visible rather than a warning in the logs. Deleting late rows of
-- a day retired earlier records nothing: the day already read as retired.
-- A day whose rows only ever lived in the default partition is recorded like
-- any other.
create or replace function public.maintain_rbn_spots()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today     date := (now() at time zone 'utc')::date;
  v_day       date;
  v_drop      date[] := '{}'::date[];
  v_record    date[] := '{}'::date[];
begin
  for v_day in select (v_today + i) from generate_series(0, 3) as i loop
    perform public.create_rbn_spots_partition(v_day);
  end loop;

  for v_day in
    select to_date(substr(c.relname, 11), 'YYYYMMDD')
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'public.rbn_spots'::regclass and c.relname ~ '^rbn_spots_[0-9]{8}$'
    union
    select distinct (d.spot_time at time zone 'utc')::date from partitions.rbn_spots_default d
    order by 1
  loop
    continue when v_day >= v_today - 7;
    continue when not public.rbn_day_archived(v_day);
    if exists (select 1 from callsign_rollup_days r where r.day = v_day) then
      v_drop := v_drop || v_day;
    elsif v_day < v_today - 14 then
      v_drop := v_drop || v_day;
      -- Decided here, before any drop: a scan under a drop's lock would
      -- block ingest.
      if public.rbn_day_archived_rows(v_day) > 0 and not public.rbn_day_retired(v_day) then
        v_record := v_record || v_day;
      end if;
    end if;
  end loop;

  perform set_config('lock_timeout', '5s', true);
  foreach v_day in array v_drop loop
    begin
      perform public.retire_rbn_day(v_day);
      if v_day = any (v_record) then
        perform public.record_callsign_rollup_failure(v_day, 'RBN rows retired before the roll-up ran');
        raise warning 'rbn retention: % retired without its callsign rollup; its RBN spots are in the archive only', v_day;
      end if;
    exception when lock_not_available then
      raise warning 'rbn retention: % not dropped (lock timeout); retrying tomorrow', v_day;
    end;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Status
-- ---------------------------------------------------------------------------

-- One row per UTC day from the first spot (first_rollup_day) to the latest
-- day a roll-up may take. fill_failed is a rolled-up day whose callsign_days
-- fill keeps failing. rbn_retired comes before failed: such a day also gains
-- a failures row every hour from the refusal. The retired test runs only for
-- days without a marker, which are few. Service-role only.
create view callsign_rollup_status with (security_invoker = true) as
with bounds as (
  select public.first_rollup_day() as first_day,
         public.last_rollup_day()  as last_day
),
days as (
  select g.d::date as day
  from bounds, generate_series(bounds.first_day, bounds.last_day, interval '1 day') as g(d)
  where bounds.first_day is not null
)
select d.day,
       case
         when r.day is not null and r.days_filled_at is null and f.day is not null then 'fill_failed'
         when r.day is not null and r.without_rbn                                  then 'done_without_rbn'
         when r.day is not null                                                    then 'done'
         when public.rbn_day_retired(d.day)                                        then 'rbn_retired'
         when f.day is not null                                                    then 'failed'
         else 'pending'
       end as status,
       r.spots,
       r.rolled_at,
       r.days_filled_at,
       f.attempts,
       f.last_failed_at,
       f.last_error
from days d
left join callsign_rollup_days r on r.day = d.day
left join callsign_rollup_failures f on f.day = d.day;

revoke all on callsign_rollup_status from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public.record_callsign_rollup_failure(date, text) from public, anon, authenticated;
revoke all on function public.rbn_day_archived_rows(date) from public, anon, authenticated;
revoke all on function public.rbn_day_retired(date) from public, anon, authenticated;
revoke all on function public.first_rollup_day() from public, anon, authenticated;
revoke all on function public.fill_callsign_days(date) from public, anon, authenticated;
revoke all on function public.backfill_callsign_days(int) from public, anon, authenticated;
revoke all on function public.rollup_callsign_day(date, boolean) from public, anon, authenticated;
revoke all on function public.compact_callsign_rollups() from public, anon, authenticated;
revoke all on function public.backfill_callsign_rollups(int) from public, anon, authenticated;
revoke all on function public.maintain_rbn_spots() from public, anon, authenticated;
grant execute on function public.maintain_rbn_spots() to service_role;

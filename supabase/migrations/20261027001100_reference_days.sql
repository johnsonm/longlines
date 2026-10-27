-- Reference profiles, PR 3: activations per reference and day
-- (docs/superpowers/specs/2026-10-26-reference-profiles-design.md, decisions 4 to 7).
--
-- An activation is one activator spotted at a reference on one UTC day (decision 4).
-- reference_days keeps them at day grain: one row per program, reference, UTC day, activator
-- (base call) and source, with the spot count and the distinct canonical modes and bands heard,
-- sorted as callsign_days stores them. Heard role only: the activator, never the spotter. Never
-- compacted and no running totals, so a fill can always rebuild it. Every activator is stored,
-- hidden calls included; hiding them is the reader's job (decision 7, PR 4).
--
-- program is lower case (pota, sota, wwff), as reference_catalog and the /ref/<program> route
-- spell it; spot_stream says POTA, SOTA, WWFF. reference is upper case, as reference_catalog
-- stores it, so the two join. Only the POTA, SOTAwatch and WWFF sources write rows. WWBOTA is
-- left out: bunkers come later as their own source work (decision 1), and a WWBOTA spot names an
-- array of references. RBN and DX Cluster spots carry no reference and write none.
--
-- Written by rollup_callsign_day from its b stage, in the marker's transaction (decision 5), so
-- it inherits exactly-once; the marker's references_filled_at records it. Days rolled up before
-- this migration have references_filled_at null and are filled by fill_reference_days from
-- raw_spots, which is exact because raw_spots is never pruned. The fill and the roll-up write
-- the same rows for the same day (supabase/tests/reference_days.test.sql). The hourly job
-- (backfill_callsign_rollups) runs backfill_reference_days only in a run that rolled no day up
-- and filled no callsign_days, two days a run; a failed fill lands in callsign_rollup_failures
-- as "reference_days fill: ...", and callsign_rollup_status says fill_failed for it.
--
-- raw_spots_reference_time_idx serves PR 4's live read of the days not rolled up yet, by
-- reference and time (decision 6). That read goes through spot_stream like every profile read, so
-- the index is on spot_stream's reference expression exactly (WWBOTA's first bunker included):
-- `where reference = ... and spot_time >= ...` on the view then pushes down into the raw_spots arm
-- and uses it, and the RBN arm's null reference drops out (pgTAP checks the plan). Change the
-- view's expression and the index together. Hosted raw_spots was ~562k rows / 342 MB on
-- 2026-10-26, so a plain build takes seconds inside the push.
--
-- Both fills now share one rule for the day's callsign_rollup_failures row: a success deletes it
-- only when it holds that fill's own error, so fill_callsign_days is redefined here (as
-- 20261019000200, with only its delete narrowed) and a reference_days failure survives a later
-- callsign_days success.
--
-- The hourly job holds row locks on callsign_rollup_days while it runs; the alter table below
-- would otherwise queue behind it with the whole migration transaction open. A lock timeout
-- fails the push, which can simply be run again (away from :25). Transaction-scoped, as supabase
-- db push applies a migration; applied by hand with psql, wrap the file in begin/commit.
select set_config('lock_timeout', '10s', true);

-- ---------------------------------------------------------------------------
-- Tables and index
-- ---------------------------------------------------------------------------

create table reference_days (
  program   text   not null check (program in ('pota', 'sota', 'wwff')),
  reference text   not null check (reference <> '' and reference = upper(reference)),
  day       date   not null,
  -- The activator's base call (base_callsign()).
  base      text   not null,
  source    text   not null check (source in ('pota', 'sotawatch', 'wwff')),
  spots     int    not null,
  -- Distinct canonical modes heard, sorted; spots without a mode count in spots but add nothing.
  modes     text[] not null,
  -- Distinct bands heard, sorted; likewise for spots outside the band list.
  bands     text[] not null,
  primary key (program, reference, day, base, source)
);
create index reference_days_base_day_idx on reference_days (base, day);

alter table reference_days enable row level security;
revoke all on reference_days from anon, authenticated;

alter table callsign_rollup_days add column references_filled_at timestamptz;

-- spot_stream's reference column, word for word (as 20261027001000_iota defines it), so a read of
-- the view can use it.
create index if not exists raw_spots_reference_time_idx
  on raw_spots (coalesce(pota_reference, sota_summit_ref, wwff_reference, wwbota_references[1], iota_reference),
                spot_time)
  where coalesce(pota_reference, sota_summit_ref, wwff_reference, wwbota_references[1], iota_reference) is not null;

-- ---------------------------------------------------------------------------
-- The roll-up: one more data-modifying CTE over its b stage, and the marker records it
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
  -- reference_days: the activators of each POTA park, SOTA summit and WWFF
  -- reference that day, from the same heard rows (fill_reference_days writes
  -- the same rows from raw_spots). Only those three sources; WWBOTA, RBN and
  -- DX Cluster rows write none. A row already there wins, as for callsign_days.
  refdays as (
    insert into reference_days (program, reference, day, base, source, spots, modes, bands)
    select lower(program), upper(reference), p_day, base, source, sum(n)::int,
           coalesce(array_agg(distinct mode order by mode) filter (where mode is not null), '{}'),
           coalesce(array_agg(distinct band order by band) filter (where band is not null), '{}')
    from b
    where source in ('pota', 'sotawatch', 'wwff') and program in ('POTA', 'SOTA', 'WWFF')
      and reference <> ''
    group by lower(program), upper(reference), base, source
    on conflict (program, reference, day, base, source) do nothing
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
      days_filled_at = now(),
      references_filled_at = now()
  where day = p_day;

  return v_spots;
end;
$$;

-- ---------------------------------------------------------------------------
-- Filling days rolled up before reference_days existed
-- ---------------------------------------------------------------------------

-- One marked day from raw_spots: the rows rollup_callsign_day would have written (the same
-- program and reference, base call, sorted modes and bands, and spot count, since every source
-- but RBN reaches spot_stream as raw_spots stores it). Locks the marker row, so two fills cannot
-- both insert. Returns the spots counted, or null for a day without a marker or already filled.
-- Success removes a failures row this fill left, never another fill's or roll-up's.
create or replace function public.fill_reference_days(p_day date)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from   timestamptz := p_day::timestamp at time zone 'utc';
  v_to     timestamptz := (p_day + 1)::timestamp at time zone 'utc';
  v_filled timestamptz;
  v_spots  bigint;
begin
  select r.references_filled_at into v_filled
  from callsign_rollup_days r where r.day = p_day
  for update;
  if not found or v_filled is not null then
    return null;
  end if;

  with d as materialized (
    select case when s.pota_reference is not null then 'pota'
                when s.sota_summit_ref is not null then 'sota'
                else 'wwff' end                                     as program,
           upper(coalesce(s.pota_reference, s.sota_summit_ref, s.wwff_reference)) as reference,
           s.base_callsign                                           as base,
           s.source,
           count(*)::int                                             as spots,
           coalesce(array_agg(distinct s.mode order by s.mode) filter (where s.mode is not null), '{}') as modes,
           coalesce(array_agg(distinct s.band order by s.band) filter (where s.band is not null), '{}') as bands
    from raw_spots s
    where s.spot_time >= v_from and s.spot_time < v_to
      and s.source in ('pota', 'sotawatch', 'wwff')
      and coalesce(s.pota_reference, s.sota_summit_ref, s.wwff_reference) <> ''
    group by 1, 2, 3, 4
  ),
  ins as (
    insert into reference_days (program, reference, day, base, source, spots, modes, bands)
    select program, reference, p_day, base, source, spots, modes, bands from d
    on conflict (program, reference, day, base, source) do nothing
  )
  select coalesce(sum(spots), 0) into v_spots from d;

  update callsign_rollup_days set references_filled_at = now() where day = p_day;
  delete from callsign_rollup_failures f
  where f.day = p_day and f.last_error like 'reference_days fill: %';
  return v_spots;
end;
$$;

-- The callsign_days fill, as 20261019000200 with one change: a success deletes the day's failures
-- row only when it holds a callsign_days fill error, as fill_reference_days does for its own, so a
-- reference_days fill failure recorded since stays (and the status view keeps saying fill_failed).
create or replace function public.fill_callsign_days(p_day date)
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
  delete from callsign_rollup_failures f
  where f.day = p_day and f.last_error like 'callsign_days fill: %';

  spots := v_spots;
  exact := v_exact;
  return next;
end;
$$;

-- At most p_max_days filled days and twice that many attempts a run (null: every unfilled
-- day), each day in its own subtransaction. Oldest first, days that failed before last (as
-- backfill_callsign_days, so a day that keeps failing cannot hold the rest back).
create or replace function public.backfill_reference_days(p_max_days int default null)
returns table (fill_day date, spots bigint, error text)
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
    select r.day
    from callsign_rollup_days r
    left join callsign_rollup_failures f on f.day = r.day
    where r.references_filled_at is null
    order by f.attempts nulls first, r.day
  loop
    exit when v_filled >= p_max_days or v_attempts >= 2 * p_max_days;
    v_attempts := v_attempts + 1;
    fill_day := v_day;
    begin
      spots := public.fill_reference_days(v_day);
      if spots is null then
        continue;
      end if;
      error := null;
      v_filled := v_filled + 1;
    exception when others then
      spots := null;
      error := sqlerrm;
      perform public.record_callsign_rollup_failure(v_day, 'reference_days fill: ' || sqlerrm);
      raise warning 'reference_days fill of % failed: %', v_day, sqlerrm;
    end;
    return next;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- The hourly job: the reference fill in a run that rolled nothing up and filled no callsign_days
-- ---------------------------------------------------------------------------

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
  v_filled bigint;
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

  -- Neither a fill nor a compaction error may undo the days rolled up above.
  -- The callsign_days fill runs only in an hour that rolled nothing up, and
  -- the reference_days fill only in one that also filled no callsign_days, so
  -- one run never scans more than p_max_days days of the firehose (a
  -- statement timeout is not caught here and would undo the run). A
  -- reference_days pass reads only one day's POTA, SOTA and WWFF raw_spots.
  -- Counting filled days, not attempts, keeps a callsign_days day that is
  -- refused every hour from holding the reference fill back for good.
  if v_rolled = 0 then
    begin
      select count(*) filter (where f.error is null) into v_filled
      from public.backfill_callsign_days(p_max_days) f;
    exception when others then
      v_filled := null;
      raise warning 'callsign_days fill failed: %', sqlerrm;
    end;
    if v_filled = 0 then
      begin
        perform count(*) from public.backfill_reference_days(p_max_days);
      exception when others then
        raise warning 'reference_days fill failed: %', sqlerrm;
      end;
    end if;
  end if;
  begin
    perform public.compact_callsign_rollups();
  exception when others then
    raise warning 'callsign rollup compaction failed: %', sqlerrm;
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Status: fill_failed now covers either fill
-- ---------------------------------------------------------------------------

-- As 20261019000200, with references_filled_at added last. fill_failed is a rolled-up day with a
-- failures row and a fill still to do, callsign_days or reference_days; last_error's prefix says
-- which. The order of the statuses is unchanged.
create or replace view callsign_rollup_status with (security_invoker = true) as
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
         when r.day is not null and (r.days_filled_at is null or r.references_filled_at is null)
              and f.day is not null                                                then 'fill_failed'
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
       f.last_error,
       r.references_filled_at
from days d
left join callsign_rollup_days r on r.day = d.day
left join callsign_rollup_failures f on f.day = d.day;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on callsign_rollup_status from anon, authenticated;
revoke all on function public.fill_reference_days(date) from public, anon, authenticated;
revoke all on function public.fill_callsign_days(date) from public, anon, authenticated;
revoke all on function public.backfill_reference_days(int) from public, anon, authenticated;
revoke all on function public.rollup_callsign_day(date, boolean) from public, anon, authenticated;
revoke all on function public.backfill_callsign_rollups(int) from public, anon, authenticated;

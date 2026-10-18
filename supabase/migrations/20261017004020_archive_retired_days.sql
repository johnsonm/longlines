-- Retention after a late row on a retired day. A line whose time falls on a day
-- already archived and retired lands in the default partition. rbn_day_archived
-- (20261011000005) then deleted every log row whose count differed from the
-- database's, which was the whole day (its rows are gone), so the archive logged
-- the day again as empty and overwrote the late row's slice with a one-row file.
-- Now:
-- - a day with no partition and a logged slice holding more rows than the
--   database is retired: nothing but retirement removes rows, so the late rows
--   are deleted (by retire_*_day, as the day is reported archived) instead of
--   archived again;
-- - otherwise only slices with more rows in the database than in the log lose
--   their log row. A logged slice the database has fewer rows of keeps its row
--   and its object: rows can only have been retired, and writing the slice again
--   would replace the file with fewer rows.
-- The same for aprs_day_archived (20261014000010). rbn_day_slices reads the slice
-- length from archive_slice_minutes, as aprs_day_slices does.

create or replace function public.rbn_day_slices(p_day date)
returns table (slice_start timestamptz, db_rows int, archived_rows int)
language sql
stable
security definer
set search_path = public
as $$
  with bounds as (
    select p_day::timestamp at time zone 'utc' as day_from,
           (p_day + 1)::timestamp at time zone 'utc' as day_to,
           make_interval(mins => public.archive_slice_minutes('rbn')) as step
  ),
  counts as (
    select date_bin(b.step, r.spot_time, timestamptz '2000-01-01 00:00+00') as s,
           count(*)::int as n
    from rbn_spots r, bounds b
    where r.spot_time >= b.day_from and r.spot_time < b.day_to
    group by 1
  )
  select g.s, coalesce(c.n, 0), l.row_count
  from bounds b,
       generate_series(b.day_from, b.day_to - b.step, b.step) as g(s)
  left join counts c on c.s = g.s
  left join archive_log l on l.source = 'rbn' and l.slice_start = g.s
  order by g.s;
$$;

create or replace function public.rbn_day_archived(p_day date)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_retired boolean;
  v_bad     int;
  v_reset   int;
begin
  with s as (select * from public.rbn_day_slices(p_day)),
  retired as (
    select to_regclass(format('partitions.%I', 'rbn_spots_' || to_char(p_day, 'YYYYMMDD'))) is null
           and exists (select 1 from s where s.archived_rows > s.db_rows) as yes
  ),
  reset as (
    delete from archive_log l
    using s, retired
    where not retired.yes
      and l.source = 'rbn' and l.slice_start = s.slice_start and l.row_count < s.db_rows
    returning 1
  )
  select retired.yes,
         (select count(*) from s where s.archived_rows is distinct from s.db_rows),
         (select count(*) from reset)
    into v_retired, v_bad, v_reset
  from retired;
  if v_retired then
    raise warning 'rbn retention: % was retired; deleting its late rows', p_day;
    return true;
  end if;
  return v_bad = 0;
end;
$$;

create or replace function public.aprs_day_archived(p_day date)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_retired boolean;
  v_bad     int;
  v_reset   int;
begin
  with s as (select * from public.aprs_day_slices(p_day)),
  retired as (
    select to_regclass(format('partitions.%I', 'aprs_packets_' || to_char(p_day, 'YYYYMMDD'))) is null
           and exists (select 1 from s where s.archived_rows > s.db_rows) as yes
  ),
  reset as (
    delete from archive_log l
    using s, retired
    where not retired.yes
      and l.source = 'aprs' and l.slice_start = s.slice_start and l.row_count < s.db_rows
    returning 1
  )
  select retired.yes,
         (select count(*) from s where s.archived_rows is distinct from s.db_rows),
         (select count(*) from reset)
    into v_retired, v_bad, v_reset
  from retired;
  if v_retired then
    raise warning 'aprs retention: % was retired; deleting its late rows', p_day;
    return true;
  end if;
  return v_bad = 0;
end;
$$;

revoke all on function public.rbn_day_slices(date) from public, anon, authenticated;
revoke all on function public.rbn_day_archived(date) from public, anon, authenticated;
revoke all on function public.aprs_day_archived(date) from public, anon, authenticated;

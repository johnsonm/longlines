-- rbn_spots retention (spec "Retention", steps 2 and 3, with 10-minute slices
-- from the "Amendment after measurement"). maintain_rbn_spots() now also
-- retires days that ended more than seven days ago: a day is dropped only when
-- every one of its 144 slices is in archive_log with the database's row count.
-- A slice whose count differs loses its log row, so the next archive run writes
-- it again; the day is checked again the next night.

-- The day's 10-minute slices with the database count and the archived count
-- (null when the slice is not logged).
create function public.rbn_day_slices(p_day date)
returns table (slice_start timestamptz, db_rows int, archived_rows int)
language sql
stable
security definer
set search_path = public
as $$
  with bounds as (
    select p_day::timestamp at time zone 'utc' as day_from,
           (p_day + 1)::timestamp at time zone 'utc' as day_to
  ),
  counts as (
    select date_bin(interval '10 minutes', r.spot_time, timestamptz '2000-01-01 00:00+00') as s,
           count(*)::int as n
    from rbn_spots r, bounds b
    where r.spot_time >= b.day_from and r.spot_time < b.day_to
    group by 1
  )
  select g.s, coalesce(c.n, 0), l.row_count
  from bounds b,
       generate_series(b.day_from, b.day_to - interval '10 minutes', interval '10 minutes') as g(s)
  left join counts c on c.s = g.s
  left join archive_log l on l.source = 'rbn' and l.slice_start = g.s
  order by g.s;
$$;

-- Drops one day if it is fully archived; otherwise clears the log rows of its
-- mismatched slices. Returns true when the day was dropped.
create function public.retire_rbn_day(p_day date)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from timestamptz := p_day::timestamp at time zone 'utc';
  v_to   timestamptz := (p_day + 1)::timestamp at time zone 'utc';
  v_bad  int;
begin
  delete from archive_log l
  using public.rbn_day_slices(p_day) s
  where l.source = 'rbn' and l.slice_start = s.slice_start and l.row_count <> s.db_rows;

  select count(*) into v_bad
  from public.rbn_day_slices(p_day) s
  where s.archived_rows is distinct from s.db_rows;
  if v_bad > 0 then
    return false;
  end if;

  execute format('drop table if exists partitions.%I', 'rbn_spots_' || to_char(p_day, 'YYYYMMDD'));
  delete from partitions.rbn_spots_default where spot_time >= v_from and spot_time < v_to;
  return true;
end;
$$;

-- Daily at 03:30 UTC (cron from 20261011000003): partitions ahead, then retention.
create or replace function public.maintain_rbn_spots()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'utc')::date;
  v_day   date;
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
    perform public.retire_rbn_day(v_day);
  end loop;
end;
$$;

revoke all on function public.rbn_day_slices(date) from public, anon, authenticated;
revoke all on function public.retire_rbn_day(date) from public, anon, authenticated;
revoke all on function public.maintain_rbn_spots() from public, anon, authenticated;
grant execute on function public.maintain_rbn_spots() to service_role;

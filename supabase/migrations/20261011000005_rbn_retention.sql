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

-- Whether every slice of the day is logged with the database's count. Clears the
-- log rows of mismatched slices so the next archive run writes them again. One
-- scan of the day: the reset and the check read the same slice counts.
create function public.rbn_day_archived(p_day date)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bad   int;
  v_reset int;
begin
  with s as (select * from public.rbn_day_slices(p_day)),
  reset as (
    delete from archive_log l
    using s
    where l.source = 'rbn' and l.slice_start = s.slice_start and l.row_count <> s.db_rows
    returning 1
  )
  select (select count(*) from s where s.archived_rows is distinct from s.db_rows),
         (select count(*) from reset)
    into v_bad, v_reset;
  return v_bad = 0;
end;
$$;

-- Removes one day: its partition, and any of its rows in the default partition.
-- Callers check rbn_day_archived first.
create function public.retire_rbn_day(p_day date)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  execute format('drop table if exists partitions.%I', 'rbn_spots_' || to_char(p_day, 'YYYYMMDD'));
  delete from partitions.rbn_spots_default
  where spot_time >= p_day::timestamp at time zone 'utc'
    and spot_time < (p_day + 1)::timestamp at time zone 'utc';
end;
$$;

-- Daily at 03:35 UTC: partitions ahead, then retention. Every eligible day is
-- checked first and the drops come last: dropping a partition takes an ACCESS
-- EXCLUSIVE lock on rbn_spots until commit, which would otherwise block ingest
-- while later days are counted. lock_timeout makes a drop give up (and retry
-- the next night) instead of queueing inserts behind a long-running query.
create or replace function public.maintain_rbn_spots()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'utc')::date;
  v_day   date;
  v_drop  date[] := '{}';
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
    if public.rbn_day_archived(v_day) then
      v_drop := v_drop || v_day;
    end if;
  end loop;

  perform set_config('lock_timeout', '5s', true);
  foreach v_day in array v_drop loop
    begin
      perform public.retire_rbn_day(v_day);
    exception when lock_not_available then
      raise warning 'rbn retention: % not dropped (lock timeout); retrying tomorrow', v_day;
    end;
  end loop;
end;
$$;

revoke all on function public.rbn_day_slices(date) from public, anon, authenticated;
revoke all on function public.rbn_day_archived(date) from public, anon, authenticated;
revoke all on function public.retire_rbn_day(date) from public, anon, authenticated;
revoke all on function public.maintain_rbn_spots() from public, anon, authenticated;
grant execute on function public.maintain_rbn_spots() to service_role;

-- Off the archive job's */10 grid, so the two never start in the same second.
select cron.schedule('maintain-rbn-spots', '35 3 * * *', $$ select public.maintain_rbn_spots(); $$);

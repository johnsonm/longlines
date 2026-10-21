-- Review fixes for the callsign_days fill and the nightly partition
-- maintenance (REVIEW.md, "Database: ingest, retention, ...", #1 and #2).
--
-- 1. backfill_callsign_days took unfilled days oldest first, so days that
--    always fail (an RBN day retired and compacted before callsign_days
--    existed raises every time) used up a run's 2 * p_max_days attempts and
--    newer days never filled. Days are now taken by their failure count
--    (never failed first), then oldest first: a failing day goes behind every
--    day that has not failed yet, and failing days take turns.
-- 2. maintain_rbn_spots and maintain_aprs_packets created the upcoming
--    partitions first, without a lock timeout, so the default partition's
--    EXCLUSIVE lock and ATTACH's ACCESS EXCLUSIVE lock were held through the
--    archived checks (scans of whole days). Creation now runs after those
--    checks, just before the drops, under the same 5 s lock_timeout, and a
--    lock timeout skips that day's partition with a warning: today+1..+3
--    already exist from earlier nights, so a skipped night costs nothing, and
--    rows for a day without its partition wait in the default partition until
--    create_*_partition moves them.

-- As in 20261019000200, except the order: the fewest recorded failures first
-- (none first), then the oldest day.
create or replace function public.backfill_callsign_days(p_max_days int default null)
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
    select r.day
    from callsign_rollup_days r
    left join callsign_rollup_failures f on f.day = r.day
    where r.days_filled_at is null
    order by f.attempts nulls first, r.day
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

-- As in 20261019000200, except that the partitions for today and the next
-- three days are created after the archived checks, under the drops'
-- lock_timeout, each skipped on a lock timeout.
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
  -- Creation takes the default partition's locks until the transaction ends,
  -- so it comes after every scan above.
  for v_day in select (v_today + i) from generate_series(0, 3) as i loop
    begin
      perform public.create_rbn_spots_partition(v_day);
    exception when lock_not_available then
      raise warning 'rbn partitions: % not created (lock timeout); retrying tomorrow', v_day;
    end;
  end loop;

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

-- As in 20261014000030, with the same reordering as maintain_rbn_spots.
create or replace function public.maintain_aprs_packets()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'utc')::date;
  v_day   date;
  v_drop  date[] := '{}'::date[];
begin
  for v_day in
    select to_date(substr(c.relname, 14), 'YYYYMMDD')
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'public.aprs_packets'::regclass and c.relname ~ '^aprs_packets_[0-9]{8}$'
    union
    select distinct (d.received_at at time zone 'utc')::date from partitions.aprs_packets_default d
    order by 1
  loop
    continue when v_day > v_today - 2;
    if public.aprs_day_archived(v_day) then
      if v_day < v_today - 7
         or exists (select 1 from aprs_rollup_days r
                    where r.day = v_day
                      and r.rolled_at >= (v_day + 1)::timestamp at time zone 'utc' + interval '1 hour') then
        v_drop := v_drop || v_day;
      else
        raise warning 'aprs retention: % kept until the Stats rollup has it', v_day;
      end if;
    end if;
  end loop;

  perform set_config('lock_timeout', '5s', true);
  for v_day in select (v_today + i) from generate_series(0, 3) as i loop
    begin
      perform public.create_aprs_packets_partition(v_day);
    exception when lock_not_available then
      raise warning 'aprs partitions: % not created (lock timeout); retrying tomorrow', v_day;
    end;
  end loop;

  foreach v_day in array v_drop loop
    begin
      perform public.retire_aprs_day(v_day);
    exception when lock_not_available then
      raise warning 'aprs retention: % not dropped (lock timeout); retrying tomorrow', v_day;
    end;
  end loop;
end;
$$;

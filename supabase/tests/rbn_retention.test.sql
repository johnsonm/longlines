-- pgTAP: rbn_spots retention (20261011000005). A day older than seven is
-- dropped only when every 10-minute slice is archived with the database's count.
begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

create or replace function pg_temp.d(p_offset int) returns date language sql as $$
  select (now() at time zone 'utc')::date + p_offset;
$$;
create or replace function pg_temp.at(p_offset int, p_hm text) returns timestamptz language sql as $$
  select ((pg_temp.d(p_offset))::text || ' ' || p_hm || '+00')::timestamptz;
$$;
create or replace function pg_temp.spot(p_time timestamptz, p_call text) returns jsonb language sql as $$
  select jsonb_build_object(
    'spot_time', p_time, 'received_at', p_time, 'spotter', 'W3LPL', 'callsign', p_call,
    'frequency_khz', 14035.1, 'band', '20m', 'mode', 'cw', 'mode_family', 'cw', 'snr', 12,
    'speed', 22, 'speed_unit', 'WPM', 'spot_type', 'CQ', 'line', 'x');
$$;
-- Logs every 10-minute slice of a day with the database's current count.
create or replace function pg_temp.archive_day(p_offset int) returns void language sql as $$
  select log_archive('rbn', s.slice_start, s.slice_start + interval '10 minutes', s.db_rows,
                     case when s.db_rows > 0 then 100 end,
                     case when s.db_rows > 0 then 'rbn/test' end)
  from rbn_day_slices(pg_temp.d(p_offset)) s;
$$;
create or replace function pg_temp.partition(p_offset int) returns regclass language sql as $$
  select to_regclass('partitions.rbn_spots_' || to_char(pg_temp.d(p_offset), 'YYYYMMDD'));
$$;

delete from rbn_spots;
delete from archive_log;

-- Day -9: archived with matching counts.          -> dropped
-- Day -10: one slice logged with the wrong count.  -> kept, that log row deleted
-- Day -11: never archived.                         -> kept
-- Day -12: rows only in the default partition, archived -> rows deleted
-- Day -3: archived but recent.                     -> kept
select create_rbn_spots_partition(pg_temp.d(-9));
select create_rbn_spots_partition(pg_temp.d(-10));
select create_rbn_spots_partition(pg_temp.d(-11));
select create_rbn_spots_partition(pg_temp.d(-3));
select ingest_rbn_spots(jsonb_build_array(
  pg_temp.spot(pg_temp.at(-9, '10:01'), 'A1'), pg_temp.spot(pg_temp.at(-9, '10:02'), 'A2'),
  pg_temp.spot(pg_temp.at(-10, '11:05'), 'B1'), pg_temp.spot(pg_temp.at(-10, '11:06'), 'B2'),
  pg_temp.spot(pg_temp.at(-11, '12:00'), 'C1'),
  pg_temp.spot(pg_temp.at(-12, '13:00'), 'D1'),
  pg_temp.spot(pg_temp.at(-3, '14:00'), 'E1')));
select pg_temp.archive_day(-9);
select pg_temp.archive_day(-10);
select log_archive('rbn', pg_temp.at(-10, '11:00'), pg_temp.at(-10, '11:10'), 1, 100, 'rbn/test');
select pg_temp.archive_day(-12);
select pg_temp.archive_day(-3);

select is((select count(*) from rbn_day_slices(pg_temp.d(-9)))::int, 144, 'a day has 144 ten-minute slices');
select is((select db_rows from rbn_day_slices(pg_temp.d(-10)) where slice_start = pg_temp.at(-10, '11:00')), 2,
  'rbn_day_slices counts the database rows per slice');

select lives_ok('select maintain_rbn_spots()', 'maintain_rbn_spots runs the retention step');

select ok(pg_temp.partition(-9) is null, 'an archived day older than seven is dropped');
select is((select count(*) from rbn_spots where callsign like 'A%')::int, 0, 'its rows are gone');
select ok(pg_temp.partition(-10) is not null, 'a mismatched slice keeps the partition');
select ok(not exists (select 1 from archive_log where source = 'rbn' and slice_start = pg_temp.at(-10, '11:00')),
  'a mismatched slice keeps the partition and loses its log row, so it is re-archived');
select is((select count(*) from archive_log where source = 'rbn' and slice_start >= pg_temp.at(-10, '00:00')
           and slice_start < pg_temp.at(-9, '00:00'))::int, 143, 'the day''s matching slices keep their log rows');
select ok(pg_temp.partition(-11) is not null, 'a day never archived is kept');
select is((select count(*) from rbn_spots where callsign = 'D1')::int, 0, 'default-partition rows of an archived day are deleted');
select ok(pg_temp.partition(-3) is not null, 'a recent day is kept even when archived');
select ok(not has_function_privilege('authenticated', 'public.retire_rbn_day(date)', 'execute')
          and not has_function_privilege('authenticated', 'public.rbn_day_slices(date)', 'execute'),
  'retention functions are not callable by clients');

select * from finish();
rollback;

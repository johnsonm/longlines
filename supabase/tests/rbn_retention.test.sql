-- pgTAP: rbn_spots retention (20261011000005, 20261012000010). A day older
-- than seven is dropped only when every 10-minute slice is archived with the
-- database's count and the callsign rollups have recorded it, or it is older
-- than 14 days.
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

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
delete from callsign_rollup_days;

-- Day -9: archived with matching counts.          -> dropped
-- Day -10: one slice logged with the wrong count.  -> kept, that log row deleted
-- Day -11: never archived.                         -> kept
-- Day -12: rows only in the default partition, archived -> rows deleted
-- Day -3: archived but recent.                     -> kept
-- Day -13: archived, not rolled up.                -> kept
-- Day -14: not rolled up, one slice logged with the wrong count -> kept, that log row deleted
-- Day -15: archived, not rolled up, past 14 days.  -> dropped
-- Days -3 and -9 to -12 are marked as rolled up.
select create_rbn_spots_partition(pg_temp.d(-15));
select create_rbn_spots_partition(pg_temp.d(-14));
select create_rbn_spots_partition(pg_temp.d(-13));
select create_rbn_spots_partition(pg_temp.d(-9));
select create_rbn_spots_partition(pg_temp.d(-10));
select create_rbn_spots_partition(pg_temp.d(-11));
select create_rbn_spots_partition(pg_temp.d(-3));
select ingest_rbn_spots(jsonb_build_array(
  pg_temp.spot(pg_temp.at(-9, '10:01'), 'A1'), pg_temp.spot(pg_temp.at(-9, '10:02'), 'A2'),
  pg_temp.spot(pg_temp.at(-10, '11:05'), 'B1'), pg_temp.spot(pg_temp.at(-10, '11:06'), 'B2'),
  pg_temp.spot(pg_temp.at(-11, '12:00'), 'C1'),
  pg_temp.spot(pg_temp.at(-12, '13:00'), 'D1'),
  pg_temp.spot(pg_temp.at(-3, '14:00'), 'E1'),
  pg_temp.spot(pg_temp.at(-13, '15:00'), 'G1'),
  pg_temp.spot(pg_temp.at(-14, '15:00'), 'H1'),
  pg_temp.spot(pg_temp.at(-15, '15:00'), 'J1')));
insert into callsign_rollup_days (day, rolled_at)
select pg_temp.d(o), now() from unnest(array[-3, -9, -10, -11, -12]) as o;
select pg_temp.archive_day(-13);
select pg_temp.archive_day(-15);
select log_archive('rbn', pg_temp.at(-14, '15:00'), pg_temp.at(-14, '15:10'), 2, 100, 'rbn/test');
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
select ok(pg_temp.partition(-13) is not null, 'an archived day the callsign rollups have not recorded is kept');
select ok(not exists (select 1 from archive_log where source = 'rbn' and slice_start = pg_temp.at(-14, '15:00')),
  'a mismatched slice of a day not rolled up still loses its log row');
select ok(pg_temp.partition(-15) is null, 'an archived day older than 14 days is dropped without a rollup');
select is((select count(*) from rbn_spots where callsign = 'J1')::int, 0, 'its rows are gone');
select ok(not has_function_privilege('authenticated', 'public.retire_rbn_day(date)', 'execute')
          and not has_function_privilege('authenticated', 'public.rbn_day_archived(date)', 'execute')
          and not has_function_privilege('authenticated', 'public.rbn_day_slices(date)', 'execute'),
  'retention functions are not callable by clients');

-- The real archiver logs only what archive_pending_slices offers. A first day whose first spot is
-- mid-morning must still be retired: its leading empty slices have to be offered and logged too.
delete from rbn_spots;
delete from archive_log;
select create_rbn_spots_partition(pg_temp.d(-9));
select ingest_rbn_spots(jsonb_build_array(pg_temp.spot(pg_temp.at(-9, '10:03'), 'F1')));
insert into callsign_rollup_days (day, rolled_at) values (pg_temp.d(-9), now()) on conflict do nothing;
select log_archive('rbn', p.slice_start, p.slice_end, n.row_count,
                   case when n.row_count > 0 then 100 end, case when n.row_count > 0 then 'rbn/test' end)
from archive_pending_slices('rbn', now() - interval '2 hours', 100000) p,
     lateral archive_ndjson('rbn', p.slice_start, p.slice_end) n;
select maintain_rbn_spots();
select ok(pg_temp.partition(-9) is null, 'a first day archived only through archive_pending_slices is retired');

select * from finish();
rollback;

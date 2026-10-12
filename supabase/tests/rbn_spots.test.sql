-- pgTAP: rbn_spots (20261011000003): partitions by UTC day, the default
-- partition hand-off, dedup, the bulk-insert RPC, grants and the cron job.
begin;
create extension if not exists pgtap with schema extensions;
select plan(23);

-- Start from an empty table: supabase/seed.sql fills the default partition on a
-- local reset and on preview branches. The test rolls back, so the seed survives.
delete from rbn_spots;

create or replace function pg_temp.day_name(p_offset int) returns text language sql as $$
  select 'partitions.rbn_spots_' || to_char((now() at time zone 'utc')::date + p_offset, 'YYYYMMDD');
$$;
create or replace function pg_temp.day_start(p_offset int) returns timestamptz language sql as $$
  select ((now() at time zone 'utc')::date + p_offset)::timestamp at time zone 'utc';
$$;
create or replace function pg_temp.spot(p_time timestamptz, p_call text) returns jsonb language sql as $$
  select jsonb_build_object(
    'spot_time', p_time, 'received_at', p_time, 'spotter', 'W3LPL', 'callsign', p_call,
    'frequency_khz', 14035.1, 'band', '20m', 'mode', 'cw', 'mode_family', 'cw', 'snr', 12,
    'speed', 22, 'speed_unit', 'WPM', 'spot_type', 'CQ',
    'line', 'DX de W3LPL-#:  14035.1  ' || p_call || '  CW  12 dB  22 WPM  CQ  1200Z');
$$;

-- Partitions: the job is idempotent and keeps today through three days ahead.
select lives_ok('select maintain_rbn_spots()', 'maintain_rbn_spots runs');
select lives_ok('select maintain_rbn_spots()', 'maintain_rbn_spots is idempotent');
select ok(to_regclass(pg_temp.day_name(0)) is not null, 'today has a partition');
select ok(to_regclass(pg_temp.day_name(3)) is not null, 'three days ahead has a partition');
select ok(to_regclass(pg_temp.day_name(4)) is null, 'four days ahead is not created yet');
select ok(to_regclass('partitions.rbn_spots_default') is not null, 'the default partition exists');
-- Partitions live outside public so PostgREST and the generated web types never see one table per day.
select is((select count(*) from pg_tables where schemaname = 'public' and tablename like 'rbn_spots_%')::int, 0,
  'no rbn_spots partition is in the public schema');

-- Bulk insert and dedup.
select is(ingest_rbn_spots(jsonb_build_array(
  pg_temp.spot(pg_temp.day_start(0) + interval '1 hour', 'K1TODAY'),
  pg_temp.spot(pg_temp.day_start(0) + interval '2 hours', 'K2TODAY'))), 2, 'ingest_rbn_spots returns rows inserted');
select is(ingest_rbn_spots(jsonb_build_array(
  pg_temp.spot(pg_temp.day_start(0) + interval '1 hour', 'K1TODAY'),
  pg_temp.spot(pg_temp.day_start(0) + interval '2 hours', 'K2TODAY'))), 0, 'a retried batch inserts nothing');
select is(ingest_rbn_spots(jsonb_build_array(
  pg_temp.spot(pg_temp.day_start(0) + interval '3 hours', 'K3TWICE'),
  pg_temp.spot(pg_temp.day_start(0) + interval '3 hours', 'K3TWICE'))), 1, 'the same spot twice in one batch is stored once');
select is((select tableoid::regclass::text from rbn_spots where callsign = 'K1TODAY'), pg_temp.day_name(0),
  'a row is routed to its UTC day''s partition');

-- A day with no partition lands in the default partition, and creating that
-- day's partition later moves the rows instead of failing.
select is(ingest_rbn_spots(jsonb_build_array(pg_temp.spot(pg_temp.day_start(-10) + interval '23 hours 59 minutes', 'K4LATE'))), 1,
  'a row for a day without a partition is accepted');
select is((select tableoid::regclass::text from rbn_spots where callsign = 'K4LATE'), 'partitions.rbn_spots_default',
  'it is held in the default partition');
select lives_ok(format('select create_rbn_spots_partition(%L::date)', (now() at time zone 'utc')::date - 10),
  'creating that day''s partition succeeds with rows waiting in the default partition');
select is((select tableoid::regclass::text from rbn_spots where callsign = 'K4LATE'), pg_temp.day_name(-10),
  'rows waiting in the default partition move into the new partition');
select is((select count(*) from partitions.rbn_spots_default)::int, 0, 'the default partition is empty afterwards');

-- Access: service role only, including partitions created later.
select ok((select relrowsecurity from pg_class where oid = to_regclass(pg_temp.day_name(-10))), 'a created partition has RLS on');
select ok(not has_table_privilege('anon', pg_temp.day_name(-10), 'select'), 'anon cannot read a created partition');
select ok(not has_table_privilege('authenticated', 'public.rbn_spots', 'select'), 'authenticated cannot read rbn_spots');
select ok(not has_function_privilege('authenticated', 'public.ingest_rbn_spots(jsonb)', 'execute'), 'clients cannot call ingest_rbn_spots');
select ok(has_function_privilege('service_role', 'public.ingest_rbn_spots(jsonb)', 'execute'), 'service_role can call ingest_rbn_spots');

select throws_ok(
  format('select ingest_rbn_spots(%L::jsonb)', jsonb_build_array(pg_temp.spot(now(), 'K5BAD') || '{"speed_unit":"FPS"}')),
  '23514', null, 'speed_unit must be WPM or BPS');
select ok(exists (select 1 from cron.job where jobname = 'maintain-rbn-spots' and schedule = '35 3 * * *'),
  'maintain-rbn-spots runs daily at 03:35 UTC (moved off the archive grid by 20261011000005)');

select * from finish();
rollback;

-- pgTAP: the spot archive (20261011000004): slice lengths, pending slices,
-- NDJSON shape and boundaries, the log, the status view, grants, cron, bucket.
begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

-- Yesterday at hh:mm UTC.
create or replace function pg_temp.y(p_hm text) returns timestamptz language sql as $$
  select (((now() at time zone 'utc')::date - 1)::text || ' ' || p_hm || '+00')::timestamptz;
$$;
create or replace function pg_temp.rbn(p_time timestamptz, p_call text) returns jsonb language sql as $$
  select jsonb_build_object(
    'spot_time', p_time, 'received_at', p_time, 'spotter', 'W3LPL', 'callsign', p_call,
    'frequency_khz', 14035.1, 'band', '20m', 'mode', 'cw', 'mode_family', 'cw', 'snr', 12,
    'speed', 22, 'speed_unit', 'WPM', 'spot_type', 'CQ', 'line', 'DX de W3LPL-#: ' || p_call);
$$;

delete from rbn_spots;
delete from archive_log;

-- Slice lengths.
select is(archive_slice_minutes('rbn'), 10, 'RBN slices are 10 minutes');
select is(archive_slice_minutes('pota'), 60, 'POTA slices are an hour');
select is(archive_slice_minutes('sotawatch'), 60, 'SOTAwatch slices are an hour');

-- Pending slices: none without data.
select is((select count(*) from archive_pending_slices('rbn', now(), 100))::int, 0, 'no RBN data, no pending slices');

select ingest_rbn_spots(jsonb_build_array(
  pg_temp.rbn(pg_temp.y('10:03'), 'K1AAA'),
  pg_temp.rbn(pg_temp.y('10:09:59'), 'K1BBB'),
  pg_temp.rbn(pg_temp.y('10:10:00'), 'K1CCC'),
  pg_temp.rbn(pg_temp.y('10:27'), 'K1DDD')));

select is((select count(*) from archive_pending_slices('rbn', pg_temp.y('11:00'), 1000))::int, 66,
  'every 10-minute slice from midnight UTC of the first spot''s day up to the cutoff is pending, empty ones included');
select is((select slice_start from archive_pending_slices('rbn', pg_temp.y('11:00'), 1000) limit 1), pg_temp.y('00:00'),
  'pending slices start at midnight UTC so retention can see the whole first day archived');
select is((select slice_end from archive_pending_slices('rbn', pg_temp.y('11:00'), 1000) where slice_start = pg_temp.y('10:00')),
  pg_temp.y('10:10'), 'a slice ends 10 minutes after it starts');
select is((select count(*) from archive_pending_slices('rbn', pg_temp.y('11:00'), 2))::int, 2, 'the limit caps the slices returned');
select is((select max(slice_start) from archive_pending_slices('rbn', pg_temp.y('10:15'), 1000)), pg_temp.y('10:00'),
  'a slice is pending only once it has ended before the cutoff');

-- NDJSON: half-open boundaries, shape, order.
select is((select row_count from archive_ndjson('rbn', pg_temp.y('10:00'), pg_temp.y('10:10'))), 2,
  'a spot on the boundary is in exactly one slice (10:09:59 in, 10:10:00 out)');
select is((select row_count from archive_ndjson('rbn', pg_temp.y('10:10'), pg_temp.y('10:20'))), 1,
  'the 10:10:00 spot is in the next slice');
select is((select split_part(ndjson, E'\n', 1)::jsonb ->> 'callsign' from archive_ndjson('rbn', pg_temp.y('10:00'), pg_temp.y('10:10'))),
  'K1AAA', 'lines are ordered by spot_time');
select is((select array(select k from jsonb_object_keys(split_part(ndjson, E'\n', 1)::jsonb) as k order by k collate "C")
           from archive_ndjson('rbn', pg_temp.y('10:00'), pg_temp.y('10:10'))),
  array['band','callsign','frequency_khz','line','mode','mode_family','received_at','snr','speed','speed_unit','spot_time','spot_type','spotter'],
  'an RBN line carries exactly the specified fields');
select is((select ndjson from archive_ndjson('rbn', pg_temp.y('10:40'), pg_temp.y('10:50'))), '',
  'an empty slice has an empty body');

insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, frequency_khz, comment, pota_reference, raw_payload)
values ('pota', 'arch-1', 'h', pg_temp.y('09:30'), 'W1AW', 14062, '', 'US-0001', '{"upstream":true}');
select ok(exists (select 1 from archive_pending_slices('pota', pg_temp.y('11:00'), 1000) where slice_start = pg_temp.y('09:00')
                  and slice_end = pg_temp.y('10:00')), 'POTA slices are hourly');
select ok((select (split_part(ndjson, E'\n', 1)::jsonb ? 'raw_payload') and not (split_part(ndjson, E'\n', 1)::jsonb ? 'id')
           from archive_ndjson('pota', pg_temp.y('09:00'), pg_temp.y('10:00'))),
  'a POTA line carries raw_payload and not the internal id');
select throws_ok($$ select * from archive_ndjson('dxcluster', now(), now()) $$, 'P0001', 'unknown archive source: dxcluster',
  'an unknown source is rejected');

-- The log.
select lives_ok(format('select log_archive(%L, %L, %L, 2, 120, %L)', 'rbn', pg_temp.y('10:00'), pg_temp.y('10:10'), 'rbn/x/1000.ndjson.gz'),
  'log_archive records a slice');
select ok(not exists (select 1 from archive_pending_slices('rbn', pg_temp.y('11:00'), 1000) where slice_start = pg_temp.y('10:00')),
  'a logged slice is no longer pending');
select lives_ok(format('select log_archive(%L, %L, %L, 3, 150, %L)', 'rbn', pg_temp.y('10:00'), pg_temp.y('10:10'), 'rbn/x/1000.ndjson.gz'),
  'log_archive overwrites on re-archive');
select is((select row_count from archive_log where source = 'rbn' and slice_start = pg_temp.y('10:00')), 3, 'the newer count wins');
select throws_ok(format('select log_archive(%L, %L, %L, 5, 10, null)', 'rbn', pg_temp.y('10:20'), pg_temp.y('10:30')),
  '23514', null, 'a slice with rows must name its object');

-- Status, grants, cron.
select is((select count(*) from archive_status)::int, 3, 'archive_status has one row per source');
select ok(not has_function_privilege('authenticated', 'public.archive_ndjson(text, timestamptz, timestamptz)', 'execute')
          and not has_function_privilege('authenticated', 'public.log_archive(text, timestamptz, timestamptz, int, int, text)', 'execute')
          and not has_function_privilege('authenticated', 'public.archive_pending_slices(text, timestamptz, int)', 'execute')
          and not has_table_privilege('authenticated', 'public.archive_log', 'select')
          and not has_table_privilege('anon', 'public.archive_status', 'select')
          and has_function_privilege('service_role', 'public.archive_ndjson(text, timestamptz, timestamptz)', 'execute'),
  'the archive objects are service-role only');

select * from finish();
rollback;

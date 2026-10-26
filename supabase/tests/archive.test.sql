-- pgTAP: the spot archive (20261011000004): slice lengths, pending slices,
-- column shape and boundaries, the log, the status view, grants, cron, bucket.
begin;
create extension if not exists pgtap with schema extensions;
select plan(27);

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

-- Columns: half-open boundaries, shape, order.
select is((select row_count from archive_columns('rbn', pg_temp.y('10:00'), pg_temp.y('10:10'))), 2,
  'a spot on the boundary is in exactly one slice (10:09:59 in, 10:10:00 out)');
select is((select row_count from archive_columns('rbn', pg_temp.y('10:10'), pg_temp.y('10:20'))), 1,
  'the 10:10:00 spot is in the next slice');
select is((select columns::jsonb -> 'callsign' from archive_columns('rbn', pg_temp.y('10:00'), pg_temp.y('10:10'))),
  '["K1AAA", "K1BBB"]'::jsonb, 'columns are in spot_time order');
select is((select (columns::jsonb -> 'spot_time' ->> 0)::bigint from archive_columns('rbn', pg_temp.y('10:00'), pg_temp.y('10:10'))),
  (extract(epoch from pg_temp.y('10:03')) * 1000)::bigint, 'timestamps are epoch milliseconds');
select is((select array(select k from json_object_keys(columns) as k)
           from archive_columns('rbn', pg_temp.y('10:00'), pg_temp.y('10:10'))),
  array['spot_time','received_at','spotter','callsign','frequency_khz','band','mode','mode_family','snr','speed','speed_unit','spot_type','line'],
  'an RBN slice carries exactly the specified columns, in file order');
select is((select row(row_count, columns::text) from archive_columns('rbn', pg_temp.y('10:40'), pg_temp.y('10:50'))),
  row(0, null::text), 'an empty slice has no columns');

insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, frequency_khz, comment, pota_reference, raw_payload)
values ('pota', 'arch-1', 'h', pg_temp.y('09:30'), 'W1AW', 14062, '', 'US-0001', '{"upstream":true}');
select ok(exists (select 1 from archive_pending_slices('pota', pg_temp.y('11:00'), 1000) where slice_start = pg_temp.y('09:00')
                  and slice_end = pg_temp.y('10:00')), 'POTA slices are hourly');
select ok('{"upstream": true}' in (select json_array_elements_text(columns -> 'raw_payload')
                                   from archive_columns('pota', pg_temp.y('09:00'), pg_temp.y('10:00'))),
  'a POTA slice carries raw_payload as JSON text');
select ok((select not (columns::jsonb ? 'id') from archive_columns('pota', pg_temp.y('09:00'), pg_temp.y('10:00'))),
  'a POTA slice leaves out the internal id');
select throws_ok($$ select * from archive_columns('pskreporter', now(), now()) $$, 'P0001', 'unknown archive source: pskreporter',
  'an unknown source is rejected');

-- The log.
select lives_ok(format('select log_archive(%L, %L, %L, 2, 120, %L)', 'rbn', pg_temp.y('10:00'), pg_temp.y('10:10'), 'rbn/x/1000.parquet'),
  'log_archive records a slice');
select ok(not exists (select 1 from archive_pending_slices('rbn', pg_temp.y('11:00'), 1000) where slice_start = pg_temp.y('10:00')),
  'a logged slice is no longer pending');
select lives_ok(format('select log_archive(%L, %L, %L, 3, 150, %L)', 'rbn', pg_temp.y('10:00'), pg_temp.y('10:10'), 'rbn/x/1000.parquet'),
  'log_archive overwrites on re-archive');
select is((select row_count from archive_log where source = 'rbn' and slice_start = pg_temp.y('10:00')), 3, 'the newer count wins');
select throws_ok(format('select log_archive(%L, %L, %L, 5, 10, null)', 'rbn', pg_temp.y('10:20'), pg_temp.y('10:30')),
  '23514', null, 'a slice with rows must name its object');

-- Status, grants, cron.
select is((select count(*) from archive_status)::int, 7, 'archive_status has one row per source');
select ok(not has_function_privilege('authenticated', 'public.archive_columns(text, timestamptz, timestamptz)', 'execute')
          and not has_function_privilege('authenticated', 'public.log_archive(text, timestamptz, timestamptz, int, int, text)', 'execute')
          and not has_function_privilege('authenticated', 'public.archive_pending_slices(text, timestamptz, int)', 'execute')
          and not has_table_privilege('authenticated', 'public.archive_log', 'select')
          and not has_table_privilege('anon', 'public.archive_status', 'select')
          and has_function_privilege('service_role', 'public.archive_columns(text, timestamptz, timestamptz)', 'execute'),
  'the archive objects are service-role only');
select hasnt_function('public', 'archive_ndjson', array['text', 'timestamptz', 'timestamptz'],
  'archive_ndjson is gone');

select * from finish();
rollback;

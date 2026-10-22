-- pgTAP: the one-off NDJSON-to-Parquet conversion's RPCs (20261021000700):
-- the oldest-first listing with its cursor, the guarded repoint, grants, and
-- that retention (rbn_day_archived, aprs_day_archived) is unaffected by a
-- repointed path.
begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

create or replace function pg_temp.d(p_offset int) returns date language sql as $$
  select (now() at time zone 'utc')::date + p_offset;
$$;
create or replace function pg_temp.at(p_offset int, p_hm text) returns timestamptz language sql as $$
  select ((pg_temp.d(p_offset))::text || ' ' || p_hm || '+00')::timestamptz;
$$;
-- The old NDJSON key and the live Parquet key of a slice.
create or replace function pg_temp.ndjson(p_source text, p_start timestamptz) returns text language sql as $$
  select p_source || to_char(p_start at time zone 'utc', '"/"YYYY"/"MM"/"DD"/"HH24MI".ndjson.gz"');
$$;
create or replace function pg_temp.parquet(p_source text, p_start timestamptz) returns text language sql as $$
  select p_source || to_char(p_start at time zone 'utc', '"/year="YYYY"/month="MM"/day="DD"/"HH24MI".parquet"');
$$;
create or replace function pg_temp.spot(p_time timestamptz, p_call text) returns jsonb language sql as $$
  select jsonb_build_object(
    'spot_time', p_time, 'received_at', p_time, 'spotter', 'W3LPL', 'callsign', p_call,
    'frequency_khz', 14035.1, 'band', '20m', 'mode', 'cw', 'mode_family', 'cw', 'snr', 12,
    'speed', 22, 'speed_unit', 'WPM', 'spot_type', 'CQ', 'line', 'x');
$$;
create or replace function pg_temp.pkt(p_time timestamptz, p_call text) returns jsonb language sql as $$
  select jsonb_build_object(
    'received_at', p_time, 'source_call', p_call, 'destination', 'APRS', 'path', 'WIDE1-1',
    'q_construct', 'qAR', 'igate', 'W1ABC-10', 'packet_type', 'status',
    'line', p_call || '>APRS,WIDE1-1,qAR,W1ABC-10:>hi');
$$;
-- Logs every slice of a day with the database's count, objects at the old NDJSON keys.
create or replace function pg_temp.archive_rbn_day(p_offset int) returns void language sql as $$
  select log_archive('rbn', s.slice_start, s.slice_start + interval '10 minutes', s.db_rows,
                     case when s.db_rows > 0 then 100 end,
                     case when s.db_rows > 0 then pg_temp.ndjson('rbn', s.slice_start) end)
  from rbn_day_slices(pg_temp.d(p_offset)) s;
$$;
create or replace function pg_temp.archive_aprs_day(p_offset int) returns void language sql as $$
  select log_archive('aprs', s.slice_start, s.slice_start + interval '5 minutes', s.db_rows,
                     case when s.db_rows > 0 then 100 end,
                     case when s.db_rows > 0 then pg_temp.ndjson('aprs', s.slice_start) end)
  from aprs_day_slices(pg_temp.d(p_offset)) s;
$$;
-- Repoints a slice as the function does after verifying it.
create or replace function pg_temp.repoint(p_source text, p_start timestamptz, p_rows int, p_bytes int default 4096)
returns boolean language sql as $$
  select archive_repoint_slice(p_source, p_start, pg_temp.ndjson(p_source, p_start),
                               pg_temp.parquet(p_source, p_start), p_rows, p_bytes);
$$;

delete from rbn_spots;
delete from aprs_packets;
delete from archive_log;

-- The listing.
select log_archive('pota', pg_temp.at(-12, '09:00'), pg_temp.at(-12, '10:00'), 3, 300, pg_temp.ndjson('pota', pg_temp.at(-12, '09:00')));
select log_archive('rbn', pg_temp.at(-12, '09:00'), pg_temp.at(-12, '09:10'), 5, 500, pg_temp.ndjson('rbn', pg_temp.at(-12, '09:00')));
select log_archive('rbn', pg_temp.at(-13, '23:50'), pg_temp.at(-12, '00:00'), 2, 200, pg_temp.ndjson('rbn', pg_temp.at(-13, '23:50')));
select log_archive('rbn', pg_temp.at(-12, '09:10'), pg_temp.at(-12, '09:20'), 0, null, null);
select log_archive('rbn', pg_temp.at(-11, '09:00'), pg_temp.at(-11, '09:10'), 4, 400, pg_temp.parquet('rbn', pg_temp.at(-11, '09:00')));

select results_eq(
  $$select source, slice_start from archive_ndjson_slices(null, null, 10)$$,
  format($$values ('rbn'::text, %L::timestamptz), ('pota', %L), ('rbn', %L)$$,
         pg_temp.at(-13, '23:50'), pg_temp.at(-12, '09:00'), pg_temp.at(-12, '09:00')),
  'the listing has only NDJSON rows, oldest first, then by source');
select is((select row(row_count, object_path, slice_end)::text from archive_ndjson_slices(null, null, 1)),
  row(2, pg_temp.ndjson('rbn', pg_temp.at(-13, '23:50')), pg_temp.at(-12, '00:00'))::text,
  'a listed row carries its count, NDJSON path and end');
select is((select count(*) from archive_ndjson_slices(null, null, 2))::int, 2, 'the limit caps the rows');
select is((select count(*) from archive_ndjson_slices(null, null, -1))::int, 0, 'a negative limit returns nothing');
select results_eq(
  format($$select source from archive_ndjson_slices(%L, 'pota', 10)$$, pg_temp.at(-12, '09:00')),
  $$values ('rbn'::text)$$,
  'the cursor resumes after the slice it names, ties broken by source');
select is((select count(*) from archive_ndjson_slices(pg_temp.at(-12, '09:00'), 'rbn', 10))::int, 0,
  'nothing is left after the last slice');

-- The repoint.
select is(archive_repoint_slice('rbn', pg_temp.at(-12, '09:00'), 'rbn/other.ndjson.gz',
                                pg_temp.parquet('rbn', pg_temp.at(-12, '09:00')), 5, 4096), false,
  'a row naming another object is left alone');
select is(pg_temp.repoint('rbn', pg_temp.at(-12, '09:00'), 4), false,
  'a row count that differs from the log is refused');
select is(archive_repoint_slice('rbn', pg_temp.at(-12, '09:00'), pg_temp.ndjson('rbn', pg_temp.at(-12, '09:00')),
                                'rbn/year=2026/elsewhere.parquet', 5, 4096), false,
  'a path other than the live layout''s is refused');
select is(pg_temp.repoint('rbn', pg_temp.at(-12, '09:00'), 5, 0), false, 'a Parquet object of no bytes is refused');
select is((select object_path from archive_log where source = 'rbn' and slice_start = pg_temp.at(-12, '09:00')),
  pg_temp.ndjson('rbn', pg_temp.at(-12, '09:00')), 'refusals change nothing');

update archive_log set archived_at = '2026-10-01 00:00+00' where source = 'rbn' and slice_start = pg_temp.at(-12, '09:00');
select is(pg_temp.repoint('rbn', pg_temp.at(-12, '09:00'), 5), true, 'a verified slice is repointed');
select is((select row(object_path, bytes, row_count, archived_at)::text from archive_log
           where source = 'rbn' and slice_start = pg_temp.at(-12, '09:00')),
  row(pg_temp.parquet('rbn', pg_temp.at(-12, '09:00')), 4096, 5, '2026-10-01 00:00+00'::timestamptz)::text,
  'the row takes the Parquet path and size and keeps its count and archived_at');
select is(pg_temp.repoint('rbn', pg_temp.at(-12, '09:00'), 5), false, 'a second repoint changes nothing');
select ok(not exists (select 1 from archive_ndjson_slices(null, null, 10) where source = 'rbn' and slice_start = pg_temp.at(-12, '09:00')),
  'a repointed slice is no longer listed');
select ok(not exists (select 1 from archive_pending_slices('rbn', pg_temp.at(-12, '12:00'), 100000) where slice_start = pg_temp.at(-12, '09:00')),
  'nor offered to the archive again');

-- Retention reads counts only: repointing a day's slices changes nothing.
delete from archive_log;
select create_rbn_spots_partition(pg_temp.d(-9));
select ingest_rbn_spots(jsonb_build_array(
  pg_temp.spot(pg_temp.at(-9, '10:01'), 'R1'), pg_temp.spot(pg_temp.at(-9, '10:02'), 'R2'),
  pg_temp.spot(pg_temp.at(-9, '15:00'), 'R3')));
select pg_temp.archive_rbn_day(-9);
select is(rbn_day_archived(pg_temp.d(-9)), true, 'an RBN day logged on NDJSON is archived');
select is((select count(*) from archive_log where source = 'rbn' and object_path is not null
           and pg_temp.repoint(source, slice_start, row_count))::int, 2,
  'both of its slices with rows repoint');
select is(rbn_day_archived(pg_temp.d(-9)), true, 'and the day is still archived');
select is((select sum(archived_rows)::int from rbn_day_slices(pg_temp.d(-9))), 3, 'with the same archived rows');

select create_aprs_packets_partition(pg_temp.d(-9));
select ingest_aprs_packets(jsonb_build_array(
  pg_temp.pkt(pg_temp.at(-9, '08:00'), 'A1'), pg_temp.pkt(pg_temp.at(-9, '08:01'), 'A2')));
select pg_temp.archive_aprs_day(-9);
select is(aprs_day_archived(pg_temp.d(-9)), true, 'an APRS-IS day logged on NDJSON is archived');
select is((select count(*) from archive_log where source = 'aprs' and object_path is not null
           and pg_temp.repoint(source, slice_start, row_count))::int, 1, 'its slice repoints');
select is(aprs_day_archived(pg_temp.d(-9)), true, 'and the day is still archived');

-- Grants.
select ok(not has_function_privilege('anon', 'public.archive_ndjson_slices(timestamptz, text, int)', 'execute')
          and not has_function_privilege('authenticated', 'public.archive_ndjson_slices(timestamptz, text, int)', 'execute')
          and not has_function_privilege('anon', 'public.archive_repoint_slice(text, timestamptz, text, text, int, int)', 'execute')
          and not has_function_privilege('authenticated', 'public.archive_repoint_slice(text, timestamptz, text, text, int, int)', 'execute')
          and has_function_privilege('service_role', 'public.archive_repoint_slice(text, timestamptz, text, text, int, int)', 'execute'),
  'the conversion RPCs are service-role only');

select * from finish();
rollback;

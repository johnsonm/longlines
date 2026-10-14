-- pgTAP: APRS-IS (20261014000010). aprs_packets partitions and dedup, the
-- bulk-insert RPC and its hourly counts, the Sources page row, five-minute
-- archive slices, the Stats rollup and its retention guard (20261014000030),
-- retention after two days, grants and the cron jobs.
begin;
create extension if not exists pgtap with schema extensions;
select plan(55);

delete from aprs_packets;
delete from aprs_packet_hours;
delete from archive_log where source = 'aprs';
delete from aprs_daily_stations;
delete from aprs_daily_igates;
delete from aprs_daily_types;
delete from aprs_rollup_days;

create or replace function pg_temp.d(p_offset int) returns date language sql as $$
  select (now() at time zone 'utc')::date + p_offset;
$$;
create or replace function pg_temp.at(p_offset int, p_hm text) returns timestamptz language sql as $$
  select ((pg_temp.d(p_offset))::text || ' ' || p_hm || '+00')::timestamptz;
$$;
create or replace function pg_temp.pkt(p_time timestamptz, p_call text, p_info text default '>hi')
returns jsonb language sql as $$
  select jsonb_build_object(
    'received_at', p_time, 'source_call', p_call, 'destination', 'APRS', 'path', 'WIDE1-1',
    'q_construct', 'qAR', 'igate', 'W1ABC-10', 'packet_type', 'status',
    'line', p_call || '>APRS,WIDE1-1,qAR,W1ABC-10:' || p_info);
$$;
-- A packet of a given type through a given igate (null: no q-construct, no igate).
create or replace function pg_temp.typed(p_time timestamptz, p_call text, p_type text, p_igate text)
returns jsonb language sql as $$
  select pg_temp.pkt(p_time, p_call) || jsonb_build_object('packet_type', p_type, 'igate', p_igate);
$$;
create or replace function pg_temp.partition(p_offset int) returns regclass language sql as $$
  select to_regclass('partitions.aprs_packets_' || to_char(pg_temp.d(p_offset), 'YYYYMMDD'));
$$;
-- Logs every five-minute slice of a day with the database's current count.
create or replace function pg_temp.archive_day(p_offset int) returns void language sql as $$
  select log_archive('aprs', s.slice_start, s.slice_start + interval '5 minutes', s.db_rows,
                     case when s.db_rows > 0 then 100 end,
                     case when s.db_rows > 0 then 'aprs/test' end)
  from aprs_day_slices(pg_temp.d(p_offset)) s;
$$;

-- Partitions.
select lives_ok('select maintain_aprs_packets()', 'maintain_aprs_packets runs');
select lives_ok('select maintain_aprs_packets()', 'maintain_aprs_packets is idempotent');
select ok(pg_temp.partition(0) is not null and pg_temp.partition(3) is not null,
  'today through three days ahead have partitions');
select ok(pg_temp.partition(4) is null, 'four days ahead is not created yet');
select is((select count(*) from pg_tables where schemaname = 'public' and tablename like 'aprs_packets_%')::int, 0,
  'no aprs_packets partition is in the public schema');

-- Bulk insert, dedup and the hourly counts.
select is(ingest_aprs_packets(jsonb_build_array(
  pg_temp.pkt(pg_temp.at(0, '00:01'), 'N0CALL-1'),
  pg_temp.pkt(pg_temp.at(0, '00:02'), 'N0CALL-2'),
  pg_temp.pkt(pg_temp.at(0, '01:00'), 'N0CALL-3'))), 3, 'ingest_aprs_packets returns rows inserted');
select is(ingest_aprs_packets(jsonb_build_array(
  pg_temp.pkt(pg_temp.at(0, '00:01'), 'N0CALL-1'),
  pg_temp.pkt(pg_temp.at(0, '00:02'), 'N0CALL-2'))), 0, 'a retried batch inserts nothing');
select is(ingest_aprs_packets(jsonb_build_array(
  pg_temp.pkt(pg_temp.at(0, '00:03'), 'N0CALL-4'),
  pg_temp.pkt(pg_temp.at(0, '00:03'), 'N0CALL-4'))), 1, 'the same packet twice in one batch is stored once');
select is(ingest_aprs_packets(jsonb_build_array(
  pg_temp.pkt(pg_temp.at(0, '00:03'), 'N0CALL-4', '>another'))), 1,
  'a different packet from the same station at the same instant is stored');
select is((select line_md5 from aprs_packets where source_call = 'N0CALL-1'),
  md5('N0CALL-1>APRS,WIDE1-1,qAR,W1ABC-10:>hi')::uuid, 'line_md5 is the md5 of the line');
select is((select tableoid::regclass::text from aprs_packets where source_call = 'N0CALL-1'),
  pg_temp.partition(0)::text, 'a packet is routed to its UTC day''s partition');
select results_eq(
  'select hour_start, packets from aprs_packet_hours order by 1',
  format('values (%L::timestamptz, 4::bigint), (%L::timestamptz, 1::bigint)',
         pg_temp.at(0, '00:00'), pg_temp.at(0, '01:00')),
  'the hourly counts grow by the rows inserted, not the rows sent');
select throws_ok(
  format('select ingest_aprs_packets(%L)', jsonb_build_array(
    pg_temp.pkt(now(), 'N0CALL') || '{"packet_type": "position report"}')),
  '23514', null, 'an unknown packet type is rejected');

-- A day with no partition lands in the default partition and moves out when it is created.
select is(ingest_aprs_packets(jsonb_build_array(pg_temp.pkt(pg_temp.at(-5, '23:59'), 'N0LATE'))), 1,
  'a packet for a day without a partition is accepted');
select is((select tableoid::regclass::text from aprs_packets where source_call = 'N0LATE'),
  'partitions.aprs_packets_default', 'it is held in the default partition');
select lives_ok(format('select create_aprs_packets_partition(%L::date)', pg_temp.d(-5)),
  'creating that day''s partition succeeds with rows waiting in the default partition');
select is((select tableoid::regclass::text from aprs_packets where source_call = 'N0LATE'),
  pg_temp.partition(-5)::text, 'the waiting rows move into the new partition');
select ok(exists (select 1 from pg_indexes where schemaname = 'partitions'
                  and tablename = 'aprs_packets_' || to_char(pg_temp.d(-5), 'YYYYMMDD')
                  and indexdef like '%(source_call, received_at)%'),
  'a new partition gets the source_call index');

-- Sources page.
delete from aprs_packets;
delete from aprs_packet_hours;
select ingest_aprs_packets(jsonb_build_array(
  pg_temp.pkt(now() - interval '10 minutes', 'N0RECENT'),
  pg_temp.pkt(now() - interval '3 hours', 'N0EARLIER')));
select record_ingest_success('aprs', 2, null);
select results_eq(
  'select spots_last_hour, spots_last_24h from ingest_health where source = ''aprs''',
  'values (1::bigint, 2::bigint)',
  'ingest_health counts the last hour from aprs_packets and the day from aprs_packet_hours');
select is((select total_spots_ingested from ingest_health where source = 'aprs'), 2::bigint,
  'record_ingest_success updates the aprs ingest_state row');

-- Archive.
select is(archive_slice_minutes('aprs'), 5, 'APRS-IS is archived in five-minute slices');
delete from aprs_packets;
select ingest_aprs_packets(jsonb_build_array(
  pg_temp.pkt(pg_temp.at(-1, '10:02'), 'N0B', '>b'),
  pg_temp.pkt(pg_temp.at(-1, '10:01'), 'N0A', '>a'),
  pg_temp.pkt(pg_temp.at(-1, '10:05'), 'N0C', '>c')));
select results_eq(
  format('select slice_start, slice_end from archive_pending_slices(''aprs'', %L, 2)', pg_temp.at(0, '00:00')),
  format('values (%L::timestamptz, %L::timestamptz), (%L::timestamptz, %L::timestamptz)',
         pg_temp.at(-1, '00:00'), pg_temp.at(-1, '00:05'), pg_temp.at(-1, '00:05'), pg_temp.at(-1, '00:10')),
  'pending APRS slices are five minutes long and start at the first packet''s UTC day');
select is((select row_count from archive_columns('aprs', pg_temp.at(-1, '10:00'), pg_temp.at(-1, '10:05'))), 2,
  'archive_columns counts the slice''s packets, end exclusive');
select is(
  (select n.columns::jsonb -> 'source_call'
   from archive_columns('aprs', pg_temp.at(-1, '10:00'), pg_temp.at(-1, '10:05')) n),
  '["N0A", "N0B"]'::jsonb, 'packets are in received_at order');
select is(
  (select array(select k from json_object_keys(n.columns) k)
   from archive_columns('aprs', pg_temp.at(-1, '10:00'), pg_temp.at(-1, '10:05')) n),
  array['received_at', 'source_call', 'destination', 'path', 'q_construct', 'igate', 'packet_type', 'line'],
  'an archived slice carries every column but line_md5');
select ok((select source = 'aprs' from archive_status where source = 'aprs'), 'archive_status lists aprs');

-- Stats rollup (20261014000030).
delete from aprs_packets;
delete from aprs_packet_hours;
select ingest_aprs_packets(jsonb_build_array(
  pg_temp.typed(pg_temp.at(-1, '10:00'), 'K4ABC-9', 'position', 'W1ABC-10'),
  pg_temp.typed(pg_temp.at(-1, '10:01'), 'K4ABC-7', 'position', 'W1ABC-10'),
  pg_temp.typed(pg_temp.at(-1, '10:02'), 'k4abc-5', 'mic_e', 'W2DEF'),
  pg_temp.typed(pg_temp.at(-1, '10:03'), 'N0XYZ', 'message', 'W2DEF'),
  pg_temp.typed(pg_temp.at(-1, '10:04'), 'MYANET', 'status', null),
  pg_temp.typed(pg_temp.at(-1, '11:04'), 'MYANET', 'status', null)));
select is(rollup_aprs_day(pg_temp.d(-1)), true, 'rollup_aprs_day rolls up a whole day');
select results_eq(
  format('select base from aprs_daily_stations where day = %L order by 1', pg_temp.d(-1)),
  $$values ('K4ABC'), ('MYANET'), ('N0XYZ')$$,
  'stations are base calls: SSIDs and lower case fold into one');
select results_eq(
  format('select igate from aprs_daily_igates where day = %L order by 1', pg_temp.d(-1)),
  $$values ('W1ABC-10'), ('W2DEF')$$,
  'igates are counted as sent; a packet without one adds none');
select results_eq(
  format('select packet_type, packets from aprs_daily_types where day = %L order by 1', pg_temp.d(-1)),
  $$values ('message', 1::bigint), ('mic_e', 1::bigint), ('position', 2::bigint), ('status', 2::bigint)$$,
  'packets are counted per type');
select ok((select rolled_at = now() from aprs_rollup_days where day = pg_temp.d(-1)), 'the rolled day gets a marker');

-- A late packet: rolling up again adds it without duplicating anything.
select ingest_aprs_packets(jsonb_build_array(pg_temp.typed(pg_temp.at(-1, '23:59'), 'W9NEW', 'position', 'W1ABC-10')));
select is(rollup_aprs_day(pg_temp.d(-1)), true, 'a day can be rolled up again');
select is((select count(*) from aprs_daily_stations where day = pg_temp.d(-1))::int, 4, 'the late station joins');
select results_eq(
  format('select count(*)::int, sum(packets) filter (where packet_type = ''position'')::int from aprs_daily_types where day = %L', pg_temp.d(-1)),
  'values (4, 3)', 'a re-roll replaces the type counts');

-- A day missing packets that its hourly counts have (retired, say) is refused and left alone.
select ingest_aprs_packets(jsonb_build_array(
  pg_temp.typed(pg_temp.at(-2, '10:00'), 'A9', 'position', 'W1ABC-10'),
  pg_temp.typed(pg_temp.at(-2, '11:00'), 'B9', 'position', 'W1ABC-10')));
delete from aprs_packets where source_call = 'B9';
select is(rollup_aprs_day(pg_temp.d(-2)), false, 'rollup_aprs_day refuses a day missing packets');
select ok(not exists (select 1 from aprs_rollup_days where day = pg_temp.d(-2))
          and not exists (select 1 from aprs_daily_stations where day = pg_temp.d(-2)),
  'a refused day gets no marker and no rows');
-- Its own statement: the marker is not visible to the statement that wrote it.
select rollup_aprs_day(pg_temp.d(-9));
select ok(exists (select 1 from aprs_rollup_days where day = pg_temp.d(-9)), 'a day without packets rolls up as empty');

-- Retention.
delete from aprs_packets;
delete from aprs_packet_hours;
delete from aprs_rollup_days;
delete from archive_log where source = 'aprs';
-- Day -2: archived with matching counts, rolled up.               -> dropped
-- Day -3: one slice logged with the wrong count.                  -> kept, that log row deleted
-- Day -4: never archived.                                         -> kept
-- Day -5: archived, rolled up within an hour of its end.          -> kept
-- Day -6: rows only in the default partition, archived, rolled up -> rows deleted
-- Day -7: archived, never rolled up for Stats.                    -> kept
-- Day -9: archived, never rolled up, older than the Stats window  -> dropped
-- Day -1: archived but recent.                                    -> kept
select create_aprs_packets_partition(pg_temp.d(o)) from unnest(array[-9, -7, -5, -4, -3, -2, -1]) as o;
select ingest_aprs_packets(jsonb_build_array(
  pg_temp.pkt(pg_temp.at(-2, '10:01'), 'A1'), pg_temp.pkt(pg_temp.at(-2, '10:02'), 'A2'),
  pg_temp.pkt(pg_temp.at(-3, '11:01'), 'B1'), pg_temp.pkt(pg_temp.at(-3, '11:02'), 'B2'),
  pg_temp.pkt(pg_temp.at(-4, '12:00'), 'C1'),
  pg_temp.pkt(pg_temp.at(-5, '09:00'), 'F1'),
  pg_temp.pkt(pg_temp.at(-6, '13:00'), 'D1'),
  pg_temp.pkt(pg_temp.at(-7, '08:00'), 'G1'),
  pg_temp.pkt(pg_temp.at(-9, '08:00'), 'H1'),
  pg_temp.pkt(pg_temp.at(-1, '14:00'), 'E1')));
select pg_temp.archive_day(o) from unnest(array[-1, -2, -3, -5, -6, -7, -9]) as o;
select log_archive('aprs', pg_temp.at(-3, '11:00'), pg_temp.at(-3, '11:05'), 1, 100, 'aprs/test');
select rollup_aprs_day(pg_temp.d(o)) from unnest(array[-2, -3, -5, -6]) as o;
update aprs_rollup_days set rolled_at = pg_temp.at(-4, '00:30') where day = pg_temp.d(-5);

select is((select count(*) from aprs_day_slices(pg_temp.d(-2)))::int, 288, 'a day has 288 five-minute slices');
select lives_ok('select maintain_aprs_packets()', 'maintain_aprs_packets runs the retention step');
select ok(pg_temp.partition(-2) is null, 'an archived day two days old is dropped');
select is((select count(*) from aprs_packets where source_call like 'A%')::int, 0, 'its rows are gone');
select ok(pg_temp.partition(-3) is not null, 'a mismatched slice keeps the partition');
select ok(not exists (select 1 from archive_log where source = 'aprs' and slice_start = pg_temp.at(-3, '11:00')),
  'the mismatched slice loses its log row, so it is re-archived');
select ok(pg_temp.partition(-4) is not null, 'a day never archived is kept');
select is((select count(*) from aprs_packets where source_call = 'D1')::int, 0,
  'default-partition rows of an archived day are deleted');
select ok(pg_temp.partition(-1) is not null, 'yesterday is kept even when archived');
select ok(pg_temp.partition(-5) is not null, 'a day rolled up within an hour of its end is kept');
select ok(pg_temp.partition(-7) is not null, 'a day the Stats rollup never saw is kept');
select ok(pg_temp.partition(-9) is null, 'a day older than the Stats window is dropped without a rollup');

-- Grants and jobs.
select ok(not has_table_privilege('authenticated', 'aprs_packets', 'select')
          and not has_table_privilege('anon', 'aprs_packets', 'select')
          and not has_table_privilege('authenticated', 'aprs_packet_hours', 'select'),
  'clients cannot read aprs_packets or aprs_packet_hours');
select ok(not has_function_privilege('authenticated', 'public.ingest_aprs_packets(jsonb)', 'execute')
          and not has_function_privilege('authenticated', 'public.maintain_aprs_packets()', 'execute')
          and not has_function_privilege('authenticated', 'public.create_aprs_packets_partition(date)', 'execute')
          and not has_function_privilege('authenticated', 'public.retire_aprs_day(date)', 'execute')
          and not has_function_privilege('authenticated', 'public.aprs_day_archived(date)', 'execute')
          and not has_function_privilege('authenticated', 'public.aprs_day_slices(date)', 'execute'),
  'APRS functions are not callable by clients');
select ok(not has_table_privilege('authenticated', 'aprs_daily_stations', 'select')
          and not has_table_privilege('authenticated', 'aprs_daily_igates', 'select')
          and not has_table_privilege('authenticated', 'aprs_daily_types', 'select')
          and not has_table_privilege('authenticated', 'aprs_rollup_days', 'select')
          and not has_table_privilege('anon', 'aprs_daily_stations', 'select'),
  'clients cannot read the APRS Stats rollups');
select ok(not has_function_privilege('authenticated', 'public.rollup_aprs_day(date)', 'execute')
          and not has_function_privilege('anon', 'public.rollup_aprs_day(date)', 'execute'),
  'clients cannot run the APRS Stats rollup');
select results_eq(
  'select jobname::text, schedule::text from cron.job where jobname in (''archive-aprs'', ''maintain-aprs-packets'') order by 1',
  $$values ('archive-aprs', '2-59/5 * * * *'), ('maintain-aprs-packets', '45 3 * * *')$$,
  'the APRS archive and maintenance jobs are scheduled');
select ok((select command like '%"sources": ["aprs"]%' from cron.job where jobname = 'archive-aprs'),
  'archive-aprs names only the aprs source');

select * from finish();
rollback;

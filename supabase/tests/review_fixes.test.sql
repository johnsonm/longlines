-- pgTAP: review fixes (20261019000500 to 20261019000540). The callsign_days
-- fill takes failing days last, nightly maintenance still creates the coming
-- partitions, ingest_failures keeps one row per bad item, a webhook host with
-- a non-ASCII character is refused, resuming an auto-paused webhook drops
-- its queue, Send test is limited per destination and per account, and
-- housekeeping prunes cron.job_run_details.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(33);

-- ---------------------------------------------------------------------------
-- backfill_callsign_days: failing days go last
-- ---------------------------------------------------------------------------
delete from callsign_rollup_days;
delete from callsign_rollup_failures;
-- Two January days retired and compacted (the fill refuses them every time)
-- and two March days with nothing to count (the fill goes through).
insert into callsign_rollup_days (day, rolled_at) values
  ('2025-01-01', now()), ('2025-01-02', now()), ('2025-03-01', now()), ('2025-03-02', now());
select log_archive('rbn', '2025-01-01 10:00+00', '2025-01-01 10:10+00', 7, 100, 'rbn/test');
select log_archive('rbn', '2025-01-02 10:00+00', '2025-01-02 10:10+00', 7, 100, 'rbn/test');
insert into callsign_activity (period, grain, base, role, source, band, mode_bucket, spots, hours)
values ('2025-01-01', 'month', 'K1PACKED', 'heard', 'rbn', '20m', 'CW', 14,
        array_fill(0, array[10]) || 14 || array_fill(0, array[13]));

select is((select array_agg((fill_day, error is not null)::text order by fill_day) from backfill_callsign_days(1)),
  array['(2025-01-01,t)', '(2025-01-02,t)'],
  'the first run tries the oldest days, which fail, and stops at twice p_max_days attempts');
select is((select array_agg((fill_day, error is not null)::text order by fill_day) from backfill_callsign_days(1)),
  array['(2025-03-01,f)'], 'the next run takes a day that never failed before the failing ones');
select is((select array_agg((fill_day, error is not null)::text order by fill_day) from backfill_callsign_days(2)),
  array['(2025-01-01,t)', '(2025-01-02,t)', '(2025-03-02,f)'],
  'failing days come after every day without failures');
select is((select array_agg(attempts order by day) from callsign_rollup_failures), array[2, 2],
  'and keep their failure count');

-- ---------------------------------------------------------------------------
-- Maintenance still creates today and the next three days
-- ---------------------------------------------------------------------------
select lives_ok('select maintain_rbn_spots()', 'maintain_rbn_spots runs');
select lives_ok('select maintain_aprs_packets()', 'maintain_aprs_packets runs');
select is((select count(*)::int from generate_series(0, 3) i
           where to_regclass('partitions.rbn_spots_' || to_char((now() at time zone 'utc')::date + i, 'YYYYMMDD')) is not null
             and to_regclass('partitions.aprs_packets_' || to_char((now() at time zone 'utc')::date + i, 'YYYYMMDD')) is not null),
  4, 'both tables have partitions for today and the next three days');
select is(current_setting('lock_timeout'), '5s', 'creation runs under the drops'' lock_timeout');
reset lock_timeout;

-- ---------------------------------------------------------------------------
-- ingest_failures: one row per bad item
-- ---------------------------------------------------------------------------
delete from ingest_failures;
insert into ingest_failures (source, error, raw_payload) values ('wwff', 'bad time', '{"id": 1}');
insert into ingest_failures (source, error, raw_payload) values ('wwff', 'bad time again', '{"id": 1}');
select is((select count(*)::int from ingest_failures), 1, 'the same item from the same source adds no second row');
select is((select (occurrences, error, last_seen_at >= occurred_at)::text from ingest_failures), '(2,"bad time again",t)',
  'it counts the occurrence and keeps the latest error');
insert into ingest_failures (source, error, raw_payload) values
  ('pota', 'x', '{"id": 1}'), ('pota', 'y', '{"id": 2}'), ('pota', 'z', '{"id": 2}');
select is((select array_agg((source, raw_payload ->> 'id', occurrences)::text order by source, id) from ingest_failures),
  array['(pota,1,1)', '(pota,2,2)', '(wwff,1,2)'],
  'another source is another row, and duplicates within one insert fold too');
-- An old first failure that keeps failing is not pruned; one last seen long ago is.
update ingest_failures set occurred_at = now() - interval '40 days', last_seen_at = now() - interval '1 day'
where source = 'wwff';
update ingest_failures set occurred_at = now() - interval '40 days', last_seen_at = now() - interval '31 days'
where source = 'pota' and raw_payload ->> 'id' = '1';

-- ---------------------------------------------------------------------------
-- Webhook hosts must be ASCII
-- ---------------------------------------------------------------------------
select throws_ok($$ select validate_destination_url('webhook', 'https://１２７.０.０.１/hook') $$,
  'P0001', 'That address is not allowed.', 'fullwidth digits are refused');
select throws_ok($$ select validate_destination_url('webhook', 'https://127。0。0。1/hook') $$,
  'P0001', 'That address is not allowed.', 'ideographic full stops are refused');
select throws_ok($$ select validate_destination_url('webhook', 'https://ｌｏｃａｌｈｏｓｔ/hook') $$,
  'P0001', 'That address is not allowed.', 'a fullwidth localhost is refused');
select throws_ok($$ select validate_destination_url('webhook', 'https://foo.ｉｎｔｅｒｎａｌ/hook') $$,
  'P0001', 'That address is not allowed.', 'a fullwidth .internal is refused');
select throws_ok($$ select validate_destination_url('webhook', 'https://bücher.example/hook') $$,
  'P0001', 'That address is not allowed.', 'an IDN host must be entered as punycode');
select lives_ok($$ select validate_destination_url('webhook', 'https://xn--bcher-kva.example/hook') $$,
  'the punycode form is accepted');

-- ---------------------------------------------------------------------------
-- Resuming an auto-paused webhook drops what is still queued
-- ---------------------------------------------------------------------------
select pgmq.purge_queue('spot_events');
select pgmq.purge_queue('deliveries_queue');
delete from deliveries;
delete from raw_spots;
-- The owner's claims without the role, so the temp tables stay the runner's.
set local request.jwt.claims = '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';
create temp table hook as select id from create_destination('webhook', 'Paused hook', 'https://hooks.example.com/in');
select save_subscription(jsonb_build_object('name', 'Everything', 'quiet_minutes', 0,
  'destinations', array[(select id from hook)]));
select count(*) from ingest_spots((select jsonb_agg(jsonb_build_object(
  'source', 'pota', 'source_spot_id', 'rf' || g, 'content_hash', 'h', 'spot_time', now(), 'callsign', 'KK4PWJ',
  'frequency_khz', 14062, 'band', '20m', 'mode', 'cw', 'comment', '', 'pota_reference', 'US-2763', 'raw_payload', '{}'::jsonb))
  from generate_series(1, 3) g));
select match_pending_spots();
create temp table hook_q as
select d.id as delivery_id, q.msg_id from deliveries d
join pgmq.q_deliveries_queue q on (q.message ->> 'delivery_id')::bigint = d.id
where d.destination_id = (select id from hook);
select is((select count(*)::int from hook_q), 3, 'three spots are queued for the webhook');
-- The pause turned it off; the claim's sweep has not reached its rows yet.
update destinations set enabled = false, auto_disabled_at = now(), pause_failures = 3
where id = (select id from hook);
select update_destination((select id from hook), null, null, true);
select results_eq($$ select status, dropped_at, count(*)::int from deliveries
                     where id in (select delivery_id from hook_q) group by 1, 2 $$,
  $$ values ('dropped'::text, now(), 3) $$, 'the resume drops the queued rows with dropped_at');
select is((select count(*)::int from pgmq.q_deliveries_queue where msg_id in (select msg_id from hook_q)), 0,
  'and archives their queue messages');
select is((select count(*)::int from pgmq.a_deliveries_queue where msg_id in (select msg_id from hook_q)), 3,
  'which are in the archive');
select results_eq($$ select enabled, auto_disabled_at from destinations where id = (select id from hook) $$,
  $$ values (true, null::timestamptz) $$, 'and the destination is on again');
-- A plain enable of a destination that was not paused drops nothing.
select count(*) from ingest_spots(jsonb_build_array(jsonb_build_object(
  'source', 'pota', 'source_spot_id', 'rf-late', 'content_hash', 'h', 'spot_time', now(), 'callsign', 'KK4PWJ',
  'frequency_khz', 14062, 'band', '20m', 'mode', 'cw', 'comment', '', 'pota_reference', 'US-2763', 'raw_payload', '{}'::jsonb)));
select match_pending_spots();
select update_destination((select id from hook), null, null, true);
select is((select count(*)::int from deliveries where destination_id = (select id from hook) and status = 'pending'), 1,
  'turning on a destination that was not paused keeps its queue');

-- ---------------------------------------------------------------------------
-- Send test limit
-- ---------------------------------------------------------------------------
create temp table test_dests as
select c.id, g
from generate_series(1, 4) g,
     lateral create_destination('discord', 'Test ' || g, 'https://discord.com/api/webhooks/9/t' || g) c;
select is((select array_agg(record_send_test('11111111-1111-1111-1111-111111111111', (select id from test_dests where g = 1)))
           from generate_series(1, 11)),
  array[true, true, true, true, true, true, true, true, true, true, false],
  'ten tests a minute per destination, the eleventh refused');
select is(record_send_test('22222222-2222-2222-2222-222222222222', (select id from test_dests where g = 1)), null,
  'another account''s destination answers null and records nothing');
select is((select sum(tests)::int from send_test_limits where user_id = '22222222-2222-2222-2222-222222222222'), null,
  'nothing recorded for it');
select is((select array_agg(record_send_test('11111111-1111-1111-1111-111111111111', (select id from test_dests where g = 2 + (n - 1) / 10)))
           from generate_series(1, 19) n), array_fill(true, array[19]),
  'other destinations have their own minute');
select is(record_send_test('11111111-1111-1111-1111-111111111111', (select id from test_dests where g = 4)), false,
  'but the account has thirty a minute across them');
select ok(not has_function_privilege('authenticated', 'public.record_send_test(uuid, uuid)', 'execute')
          and has_function_privilege('service_role', 'public.record_send_test(uuid, uuid)', 'execute'),
  'record_send_test is service role only');
update send_test_limits set window_start = window_start - interval '2 hours'
where destination_id = (select id from test_dests where g = 1);

-- ---------------------------------------------------------------------------
-- Housekeeping
-- ---------------------------------------------------------------------------
insert into cron.job_run_details (jobid, runid, username, command, status, start_time, end_time) values
  (-1, -1, 'postgres', 'select 1', 'succeeded', now() - interval '8 days', now() - interval '8 days'),
  (-1, -2, 'postgres', 'select 1', 'succeeded', now() - interval '6 days', now() - interval '6 days');
select lives_ok('select run_housekeeping()', 'run_housekeeping runs');
select is((select array_agg(runid order by runid) from cron.job_run_details where jobid = -1), array[-2::bigint],
  'cron.job_run_details older than 7 days is deleted');
select is((select array_agg((source, raw_payload ->> 'id')::text order by source, id) from ingest_failures),
  array['(pota,2)', '(wwff,1)'], 'ingest_failures are pruned by when they were last seen');
select is((select count(*)::int from send_test_limits where destination_id = (select id from test_dests where g = 1)), 0,
  'old Send test windows are deleted');

select * from finish();
rollback;

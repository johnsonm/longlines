-- pgTAP: the Health page (20261021000100_health). Pins the payload shape
-- (HealthPayload in web/src/health/types.ts), every check's threshold (the
-- page's rule copy), the per-destination oldest ready delivery, job outcomes
-- from cron_http_requests, the series buckets, the sampler, heartbeats, the
-- failure trigger, the 30-second cache and access.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(44);

create function pg_temp.checks() returns jsonb
language sql as $$ select public.health_snapshot('1h') -> 'checks' $$;
create function pg_temp.ago(p_seconds int) returns timestamptz
language sql as $$ select now() - make_interval(secs => p_seconds) $$;

delete from health_samples;
delete from worker_heartbeats;
delete from cron_http_requests;
delete from health_cache;
delete from archive_log;
select pgmq.purge_queue('spot_events');
select pgmq.purge_queue('deliveries_queue');
delete from deliveries;
delete from raw_spots;

-- Shape.
select set_eq($$ select jsonb_object_keys(public.health_snapshot('24h')) $$,
  array['range', 'start', 'bucket_seconds', 'checks', 'limits', 'series', 'jobs'], 'payload keys');
select set_eq($$ select jsonb_object_keys(pg_temp.checks()) $$,
  array['pulled', 'relay', 'match_queue', 'delivery_queue', 'sender', 'database', 'jobs', 'archive'], 'check keys');
select set_eq($$ select jsonb_object_keys(public.health_snapshot('24h') -> 'series') $$,
  array['match_waiting', 'delivery_waiting', 'oldest_ready_seconds', 'connections', 'failed', 'expired',
        'latency_p50', 'latency_p95', 'spots', 'sender_memory', 'relay_memory'], 'series keys');
select set_eq($$ select jsonb_object_keys(public.health_snapshot('24h') -> 'series' -> 'spots') $$,
  array['pota', 'sotawatch', 'wwff', 'dxcluster'], 'spots series: the four sources that are not firehoses');
select results_eq(
  $$ select r, (p ->> 'bucket_seconds')::int, jsonb_array_length(p -> 'series' -> 'match_waiting'),
            jsonb_array_length(p -> 'series' -> 'spots' -> 'pota')
     from unnest(array['1h', '24h', '7d']) r, lateral (select public.health_snapshot(r) as p) x $$,
  $$ values ('1h', 60, 60, 60), ('24h', 1800, 48, 48), ('7d', 10800, 56, 56) $$,
  '60 one-minute, 48 half-hour or 56 three-hour buckets');
select ok((select (p ->> 'start')::timestamptz + make_interval(secs => (p ->> 'bucket_seconds')::int * 48) > now()
                  and (p ->> 'start')::timestamptz + make_interval(secs => (p ->> 'bucket_seconds')::int * 47) <= now()
           from (select public.health_snapshot('24h') p) x), 'the last bucket holds now');
select is(public.health_snapshot('24h') -> 'limits',
  jsonb_build_object('match_batch', 500, 'oldest_ready_seconds', 120,
                     'max_connections', current_setting('max_connections')::int,
                     'worker_memory_bytes', 268435456), 'limits');
select throws_ok($$ select public.health_snapshot('2d') $$, '22023', 'Unknown range.', 'an unknown range is refused');

-- Pulled sources: Delayed after 3 minutes without a success, or never.
update ingest_state set last_success_at = pg_temp.ago(60) where source in ('pota', 'sotawatch', 'wwff');
select is(pg_temp.checks() -> 'pulled' ->> 'status', 'healthy', 'pulled: healthy within 3 minutes');
select is(pg_temp.checks() -> 'pulled' -> 'sources',
  '[{"source": "pota", "seconds": 60}, {"source": "sotawatch", "seconds": 60}, {"source": "wwff", "seconds": 60}]'::jsonb,
  'pulled: seconds since each success');
update ingest_state set last_success_at = pg_temp.ago(181) where source = 'wwff';
select is(pg_temp.checks() -> 'pulled' ->> 'status', 'delayed', 'pulled: delayed after 180 seconds');
update ingest_state set last_success_at = null where source = 'wwff';
select is(pg_temp.checks() -> 'pulled' ->> 'status', 'delayed', 'pulled: delayed when a source never succeeded');

-- Relay feeds: the relay's own list; Delayed after 3 minutes without a push.
update ingest_state set last_success_at = pg_temp.ago(30) where source in ('rbn', 'dxcluster');
update ingest_state set last_success_at = null where source = 'aprs';
insert into worker_heartbeats (worker, received_at, started_at, rss_bytes, reconnects, feeds) values
  -- A process started before the window: only its reconnects inside it count (7 - 6).
  ('relay', pg_temp.ago(25 * 3600), pg_temp.ago(30 * 3600), 1, 5, '[]'),
  ('relay', pg_temp.ago(23 * 3600), pg_temp.ago(30 * 3600), 1, 6, '[]'),
  ('relay', pg_temp.ago(20 * 3600), pg_temp.ago(30 * 3600), 1, 7, '[]'),
  -- One started inside it: all of them (2).
  ('relay', pg_temp.ago(9 * 3600), pg_temp.ago(10 * 3600), 1, 0, '[]'),
  ('relay', pg_temp.ago(60), pg_temp.ago(10 * 3600), 20000000, 2,
   '[{"id": "dxcluster", "connected": true}, {"id": "rbn", "connected": true}]');
select is(pg_temp.checks() -> 'relay',
  '{"status": "healthy", "reconnects_24h": 3,
    "feeds": [{"source": "dxcluster", "seconds": 30}, {"source": "rbn", "seconds": 30}]}'::jsonb,
  'relay: the heartbeat''s feeds, and reconnects inside 24 hours');
update ingest_state set last_success_at = pg_temp.ago(181) where source = 'dxcluster';
select is(pg_temp.checks() -> 'relay' ->> 'status', 'delayed', 'relay: delayed after 180 seconds without a push');
-- Without a recent heartbeat: the relay sources that succeeded in 7 days.
update worker_heartbeats set received_at = received_at - interval '11 minutes' where worker = 'relay';
update ingest_state set last_success_at = pg_temp.ago(8 * 86400) where source = 'dxcluster';
select is(pg_temp.checks() -> 'relay' -> 'feeds', '[{"source": "rbn", "seconds": 30}]'::jsonb,
  'relay: with no heartbeat in 10 minutes, the sources heard from in 7 days');

-- Match queue: Delayed when the oldest waits over 2 minutes.
insert into pgmq.q_spot_events (message, enqueued_at, vt) values ('{}', pg_temp.ago(100), now());
select is(pg_temp.checks() -> 'match_queue',
  '{"status": "healthy", "waiting": 1, "oldest_seconds": 100}'::jsonb, 'match queue: healthy at 100 seconds');
update pgmq.q_spot_events set enqueued_at = pg_temp.ago(121);
select is(pg_temp.checks() -> 'match_queue' ->> 'status', 'delayed', 'match queue: delayed over 120 seconds');
select pgmq.purge_queue('spot_events');

-- Delivery queue: per destination, the age of its newest ready row.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table busy as select id from create_destination('webhook', 'Busy', 'https://busy.example.com/spots');
create temp table held as select id from create_destination('webhook', 'Held', 'https://held.example.com/spots');
select save_subscription(jsonb_build_object('name', 'all', 'quiet_minutes', 0,
  'destinations', array[(select id from busy), (select id from held)]));
reset role;
select count(*) from ingest_spots((
  select jsonb_agg(jsonb_build_object('source', 'pota', 'source_spot_id', 'h' || i, 'content_hash', 'h' || i,
    'spot_time', now(), 'callsign', 'KK4PWJ', 'frequency_khz', 14062, 'band', '20m', 'mode', 'cw', 'comment', '',
    'pota_reference', 'US-2763', 'pota_location', 'US-NC', 'raw_payload', '{}'::jsonb))
  from generate_series(1, 4) i));
select pgmq.purge_queue('spot_events');
create temp table spots as select id, row_number() over (order by id) as n from raw_spots;
-- Busy: rows 10 minutes and 100 seconds old (newest first, so 100 seconds is its wait).
-- Held: a 20-minute-old row, but throttled, so not ready.
with ins as (
  insert into deliveries (subscription_id, destination_id, spot_id, created_at)
  select (select id from subscriptions), case when s.n <= 2 then (select id from busy) else (select id from held) end,
         s.id, case s.n when 1 then pg_temp.ago(600) when 2 then pg_temp.ago(100) else pg_temp.ago(1200) end
  from spots s where s.n <= 3
  returning id
)
select pgmq.send_batch('deliveries_queue', (select array_agg(jsonb_build_object('delivery_id', ins.id)) from ins));
update destinations set throttled_until = now() + interval '1 minute' where id = (select id from held);
-- pgmq stamps vt with the wall clock, after this transaction's now().
update pgmq.q_deliveries_queue set vt = now();
select is(pg_temp.checks() -> 'delivery_queue',
  '{"status": "healthy", "waiting": 3, "oldest_ready_seconds": 100, "throttled": 1}'::jsonb,
  'delivery queue: the newest ready row per destination; a throttled destination is not ready');
update deliveries set created_at = pg_temp.ago(121)
where id = (select max(id) from deliveries where destination_id = (select id from busy));
select is(pg_temp.checks() -> 'delivery_queue' ->> 'status', 'delayed', 'delivery queue: delayed over 120 seconds');

-- Failed deliveries get a time when attempts go up with status failed.
update deliveries set status = 'failed' where destination_id = (select id from held);
select ok((select last_failed_at is null from deliveries where destination_id = (select id from held)),
  'no failure time without an attempt');
update deliveries set status = 'failed', attempts = attempts + 1 where destination_id = (select id from held);
select is((select last_failed_at from deliveries where destination_id = (select id from held)), now(),
  'a failed attempt sets last_failed_at');
select is((select (public.health_snapshot('1h') -> 'series' -> 'failed' ->> 59)::int), 1,
  'and counts in its bucket');

-- Sender: no heartbeat is unknown; Failing after 2 minutes without progress.
select is(pg_temp.checks() -> 'sender',
  '{"status": "unknown", "progress_seconds": null, "restarts_24h": null, "memory_bytes": null}'::jsonb,
  'sender: unknown with no heartbeat');
insert into worker_heartbeats (worker, received_at, started_at, rss_bytes, last_progress_at) values
  ('sender', pg_temp.ago(20 * 3600), pg_temp.ago(30 * 3600), 70000000, pg_temp.ago(20 * 3600)),
  ('sender', pg_temp.ago(60), pg_temp.ago(3600), 92000000, pg_temp.ago(65));
select is(pg_temp.checks() -> 'sender',
  '{"status": "healthy", "progress_seconds": 65, "restarts_24h": 1, "memory_bytes": 92000000}'::jsonb,
  'sender: progress, restarts in 24 hours and memory');
update worker_heartbeats set last_progress_at = pg_temp.ago(121) where worker = 'sender' and rss_bytes = 92000000;
select is(pg_temp.checks() -> 'sender' ->> 'status', 'failing', 'sender: failing after 120 seconds');

-- Archive: Delayed after 2 hours, or never.
select is(pg_temp.checks() -> 'archive' ->> 'status', 'delayed', 'archive: delayed with nothing written');
insert into archive_log (source, slice_start, slice_end, row_count, bytes, object_path, archived_at)
values ('pota', '2026-10-01', '2026-10-01 01:00', 0, 0, null, pg_temp.ago(7199));
select is(pg_temp.checks() -> 'archive', '{"status": "healthy", "seconds": 7199}'::jsonb, 'archive: healthy within 2 hours');
update archive_log set archived_at = pg_temp.ago(7201);
select is(pg_temp.checks() -> 'archive' ->> 'status', 'delayed', 'archive: delayed after 2 hours');

-- Jobs: a cron_call_function job's runs are its HTTP responses.
select cron.schedule('health-test-job', '*/5 * * * *', $$ select public.cron_call_function('health-test-job', 'x'); $$);
insert into cron_http_requests (request_id, job, sent_at, status_code, timed_out, answered_at) values
  (-1, 'health-test-job', pg_temp.ago(900), 500, false, pg_temp.ago(899)),
  (-2, 'health-test-job', pg_temp.ago(600), null, true, pg_temp.ago(570)),
  (-3, 'health-test-job', pg_temp.ago(300), 502, false, pg_temp.ago(299)),
  (-4, 'health-test-job', pg_temp.ago(5), null, null, null);
create function pg_temp.job() returns jsonb
language sql as $$ select j from jsonb_array_elements(public.health_snapshot('1h') -> 'jobs') j where j ->> 'name' = 'health-test-job' $$;
select is(pg_temp.job(),
  jsonb_build_object('name', 'health-test-job', 'schedule', '*/5 * * * *', 'last_run_at', pg_temp.ago(5),
    'result', '{"ok": false, "http_status": 502, "timed_out": false, "seconds": 1.0}'::jsonb,
    'status', 'failing', 'failed_24h', 3, 'failed_1h', 3),
  'jobs: three failed responses in a row is failing; an unanswered request is only the last run');
select is(pg_temp.checks() -> 'jobs' ->> 'status', 'failing', 'jobs: failing when any job is');
update cron_http_requests set status_code = 200 where request_id = -1;
update cron_http_requests set sent_at = pg_temp.ago(1000), answered_at = pg_temp.ago(999) where request_id = -1;
update cron_http_requests set status_code = 200, answered_at = pg_temp.ago(4) where request_id = -4;
select is(pg_temp.job() ->> 'status', 'healthy', 'jobs: a 2xx last run is healthy');
update cron_http_requests set status_code = 200, timed_out = true where request_id = -4;
select is(pg_temp.job() ->> 'status', 'failing', 'jobs: a timed-out request failed, whatever its status');
update cron_http_requests set status_code = null, timed_out = false where request_id = -4;
select is(pg_temp.job() ->> 'status', 'failing', 'jobs: no status and no time-out (a connection error) failed');

-- Spots per bucket are the differences of the running totals.
insert into health_samples (sampled_at, match_waiting, delivery_waiting, throttled_destinations, db_connections, db_bytes, spots_total)
select date_trunc('minute', now()) - make_interval(mins => m), 0, 0, 0, 10, 1, jsonb_build_object('pota', t, 'rbn', t * 100)
from (values (3, 100), (2, 110), (1, 130), (0, 130)) v(m, t);
select is((select array_agg(x::int) filter (where x <> 'null')
           from jsonb_array_elements_text(public.health_snapshot('1h') -> 'series' -> 'spots' -> 'pota') x),
  array[10, 20, 0], 'spots: the difference from the previous sample, per bucket');

-- The sampler: one row a minute, response statuses copied, 8 days kept.
delete from health_samples;
insert into health_samples (sampled_at, match_waiting, delivery_waiting, throttled_destinations, db_connections, db_bytes, spots_total)
values (now() - interval '9 days', 0, 0, 0, 0, 0, '{}');
insert into cron_http_requests (request_id, job) values (-5, 'health-test-job');
insert into net._http_response (id, status_code, timed_out, created) values (-5, 204, null, now());
select public.record_health_sample();
select public.record_health_sample();
select is((select array_agg(sampled_at) from health_samples), array[date_trunc('minute', now())],
  'the sampler writes one row a minute and prunes rows over 8 days old');
select is((select (status_code, timed_out, answered_at)::text from cron_http_requests where request_id = -5),
  (204, false, now())::text, 'the sampler copies the response status');

-- Heartbeats: checked, and at most one a worker per 30 seconds.
delete from worker_heartbeats;
select public.record_sender_heartbeat(pg_temp.ago(60), now(), 1000);
select public.record_sender_heartbeat(pg_temp.ago(60), now(), 2000);
select is((select array_agg(rss_bytes) from worker_heartbeats where worker = 'sender'), array[1000::bigint],
  'a second sender heartbeat within 30 seconds is dropped');
select throws_ok($$ select public.record_sender_heartbeat(null, now(), 1) $$, '22023', null,
  'a sender heartbeat needs a start time');
select public.record_relay_heartbeat(pg_temp.ago(60), 5000, 2,
  '[{"id": "rbn", "connected": true}, {"id": "bogus", "connected": true}, {"id": "aprs"}]');
select is((select feeds from worker_heartbeats where worker = 'relay'),
  '[{"id": "aprs", "connected": false}, {"id": "rbn", "connected": true}]'::jsonb,
  'relay feeds keep only known ids');
select throws_ok($$ select public.record_relay_heartbeat(now(), 1, 0, '{}') $$, '22023', null,
  'relay feeds must be an array');

-- The cache serves a range for 30 seconds.
select is((select public.cached_health('1h') ->> 'generated_at'), (select public.cached_health('1h') ->> 'generated_at'),
  'a second request is served from the cache');
select throws_ok($$ select public.cached_health('nope') $$, '22023', 'Unknown range.', 'the cache refuses an unknown range');

-- Access: only service_role reads it; the sender may only report in.
select ok(not has_function_privilege('anon', 'public.cached_health(text)', 'execute')
          and not has_function_privilege('authenticated', 'public.cached_health(text)', 'execute')
          and has_function_privilege('service_role', 'public.cached_health(text)', 'execute'),
  'cached_health is service_role only');
select ok(has_function_privilege('delivery_sender', 'public.record_sender_heartbeat(timestamptz, timestamptz, bigint)', 'execute')
          and not has_function_privilege('delivery_sender', 'public.record_relay_heartbeat(timestamptz, bigint, int, jsonb)', 'execute'),
  'the sender role may record its own heartbeat only');

select * from finish();
rollback;

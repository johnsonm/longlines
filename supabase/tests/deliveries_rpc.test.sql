-- pgTAP: the RPCs the sender uses to claim, complete, retry and throttle
-- deliveries, and the sweeps that drop them (20261006000010 delivery_rpcs,
-- 20261015000400 rate_aware_claim, 20261015001400 sender_cleanup,
-- 20261016000100 claim_drops_unwanted, 20261016000300 throttle_cap,
-- 20261016000400 push_destinations_v2 for the enabled sweep).
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(92);
select pgmq.purge_queue('spot_events');
select pgmq.purge_queue('deliveries_queue');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table dw as select * from create_destination('webhook', 'Shack', 'https://shack.example.com/spots');
select save_subscription(jsonb_build_object('name','all','quiet_minutes',0,'destinations',array[(select id from dw)]));
reset role;
create temp table sub as select id from subscriptions;

-- A destination starts with an empty bucket that refills from its creation,
-- which in a transaction is now(): a minute ago fills every bucket.
create function pg_temp.fill_buckets() returns void language sql as $$
  update destinations set claim_tokens = 0, claim_tokens_at = now() - interval '1 minute';
$$;

select count(*) from ingest_spots(jsonb_build_array(
  jsonb_build_object('source','pota','source_spot_id','s1','content_hash','h1','spot_time',now(),'callsign','KK4PWJ','frequency_khz',14062,'band','20m','mode','cw','comment','','pota_reference','US-2763','pota_location','US-NC','raw_payload','{"secret":1}'::jsonb)));
select is(match_pending_spots(), 1, 'one delivery queued');

-- claim_deliveries returns everything the worker needs in one call. The bucket
-- refills from claim_tokens_at by the wall clock, so stamp it now rather than
-- at the transaction's start, which the prelude above can leave 60 ms behind.
update destinations set claim_tokens_at = clock_timestamp();
select is((select count(*) from claim_deliveries(200, 60)), 0::bigint, 'a new destination has no tokens yet');
select pg_temp.fill_buckets();
create temp table claimed as select * from claim_deliveries(200, 60);
select is((select count(*) from claimed), 1::bigint, 'claim returns the queued delivery');
select is((select destination ->> 'url' from claimed), 'https://shack.example.com/spots', 'claim includes the destination url');
select matches((select destination ->> 'signing_secret' from claimed), '^whsec_', 'claim includes the signing secret');
select is((select spot ->> 'callsign' from claimed), 'KK4PWJ', 'claim includes the normalized spot');
select is((select spot ? 'raw_payload' from claimed), false, 'claim does not include raw_payload');
select is((select count(*) from claim_deliveries(200, 60)), 0::bigint, 'a claimed message is invisible until its timeout');
select is((select claim_tokens from destinations), 999::numeric, 'the claim debits one token per spot');

-- Failure: attempts, error, destination counters, message delayed.
select mark_deliveries_failed(array[(select delivery_id from claimed)], array[(select msg_id from claimed)], 'HTTP 500', 300);
select is((select attempts from deliveries), 1, 'failure increments attempts');
select is((select last_error from deliveries), 'HTTP 500', 'failure records the error');
select is((select status from deliveries), 'failed', 'failure marks the delivery failed');
select is((select consecutive_failures from destinations), 1, 'failure increments destination failures');
select is((select health from destinations), 'ok', 'one failure does not mark the destination failing');
select ok((select vt > now() + interval '200 seconds' from pgmq.q_deliveries_queue), 'message is delayed by the backoff');

select mark_deliveries_failed(array[(select delivery_id from claimed)], array[(select msg_id from claimed)], 'HTTP 500', 30) from generate_series(1, 4);
select is((select consecutive_failures from destinations), 5, 'five failures counted');
select is((select health from destinations), 'failing', 'fifth consecutive failure marks the destination failing');

-- The Edge worker's rate-limit delay and drop RPCs went with it (20261015001400);
-- a 429 is throttle_destination below and a drop is the claim's expiry sweep.
select hasnt_function('public', 'delay_deliveries', 'delay_deliveries is gone');
select hasnt_function('public', 'mark_deliveries_dropped', 'mark_deliveries_dropped is gone');

-- Success: sent, archived, destination healthy again.
select mark_deliveries_sent(array[(select delivery_id from claimed)], array[(select msg_id from claimed)]);
select is((select status from deliveries), 'sent', 'success marks the delivery sent');
select ok((select sent_at is not null from deliveries), 'success records sent_at');
select is((select queue_length from pgmq.metrics('deliveries_queue')), 0::bigint, 'success archives the message');
select is((select health || ':' || consecutive_failures from destinations), 'ok:0', 'success resets destination health');

-- ---------------------------------------------------------------------------
-- Knobs, columns and grants (20261015000400)
-- ---------------------------------------------------------------------------
select results_eq($$ select rate_per_minute, burst from destination_budget('discord') $$,
  $$ values (300::numeric, 300::numeric) $$, 'discord budget: 300 spots a minute, burst equal to the rate');
select results_eq($$ select rate_per_minute, burst from destination_budget('push') $$,
  $$ values (3::numeric, 3::numeric) $$, 'push budget: 3 spots a minute');
select results_eq($$ select rate_per_minute, burst from destination_budget('webhook') $$,
  $$ values (1000::numeric, 1000::numeric) $$, 'webhook budget: 1000 spots a minute');
select is((select array_agg(destination_throttle_seconds(l) order by l) from generate_series(0, 6) l),
  array[60, 60, 120, 240, 480, 900, 900], 'throttle hold: 60 s at level 1, doubling to a 900 s ceiling');
select is(destination_max_age('push'), interval '15 minutes', 'push deliveries expire after 15 minutes');
select is(destination_max_age('webhook'), interval '24 hours', 'webhook deliveries expire after 24 hours');
select is(destination_max_age('discord'), interval '24 hours', 'discord deliveries expire after 24 hours');
select has_index('deliveries', 'deliveries_destination_dropped_at_idx', array['destination_id', 'dropped_at'],
  'dropped_at is indexed per destination');
select ok(not has_column_privilege('authenticated', 'public.destinations', 'throttled_until', 'select')
          and not has_column_privilege('authenticated', 'public.destinations', 'throttle_level', 'select')
          and not has_column_privilege('authenticated', 'public.destinations', 'claim_tokens', 'select')
          and not has_column_privilege('authenticated', 'public.destinations', 'claim_tokens_at', 'select')
          and has_column_privilege('authenticated', 'public.destinations', 'health', 'select'),
  'the throttle columns are not in the client column grant');
select ok(not has_function_privilege('authenticated', 'public.throttle_destination(uuid, bigint[], int)', 'execute')
          and not has_function_privilege('authenticated', 'public.delivery_queue_stats()', 'execute')
          and not has_function_privilege('authenticated', 'public.destination_budget(text)', 'execute'),
  'the new RPCs and knobs are not callable by clients');

-- Queue p_n deliveries of fresh spots for p_dest, newest at p_newest and a
-- minute apart, straight into deliveries and the queue (the matcher's path is
-- covered above). Returns the delivery ids, newest spot first.
create function pg_temp.queue(p_dest uuid, p_prefix text, p_n int, p_newest timestamptz)
returns bigint[] language plpgsql as $$
declare
  v_ids bigint[];
begin
  perform ingest_spots((
    select jsonb_agg(jsonb_build_object(
      'source', 'pota', 'source_spot_id', p_prefix || i, 'content_hash', 'h',
      'spot_time', p_newest - make_interval(mins => i - 1), 'callsign', 'KK4PWJ',
      'frequency_khz', 14062, 'band', '20m', 'mode', 'cw', 'comment', '',
      'pota_reference', 'US-2763', 'pota_location', 'US-NC', 'raw_payload', '{}'::jsonb))
    from generate_series(1, p_n) i));
  with ins as (
    insert into deliveries (subscription_id, destination_id, spot_id)
    select (select id from sub), p_dest, r.id
    from raw_spots r
    where r.source = 'pota' and r.source_spot_id like p_prefix || '%'
    order by r.spot_time desc
    returning id
  )
  select array_agg(ins.id order by ins.id) into v_ids from ins;
  perform pgmq.send_batch('deliveries_queue',
    (select array_agg(jsonb_build_object('delivery_id', d)) from unnest(v_ids) as d));
  return v_ids;
end $$;

create function pg_temp.reset_queue() returns void language sql as $$
  select pgmq.purge_queue('deliveries_queue');
  delete from deliveries;
  update destinations set health = 'ok', consecutive_failures = 0, throttled_until = null, throttle_level = 0;
  select pg_temp.fill_buckets();
$$;

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table dd as select * from create_destination('discord', 'Chat', 'https://discord.com/api/webhooks/1/a');
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
create temp table dp as select * from create_destination('push', 'Phone', null);
reset role;
-- pg_temp.queue files every delivery under the one subscription, and the claim
-- sends only what a subscription still links to (20261016000100).
insert into subscription_destinations (subscription_id, destination_id)
select (select id from sub), id from dd union all select (select id from sub), id from dp;

-- ---------------------------------------------------------------------------
-- Newest first, round-robin by rank
-- ---------------------------------------------------------------------------
select pg_temp.reset_queue();
-- Chat is busier; Shack's newest spot is older than all of Chat's.
select pg_temp.queue((select id from dd), 'fair-a-', 5, now());
select pg_temp.queue((select id from dw), 'fair-b-', 2, now() - interval '10 minutes');
create temp table fair as select * from claim_deliveries(3, 60) with ordinality;
select results_eq(
  $$ select destination ->> 'name', (spot ->> 'spot_time')::timestamptz from fair order by ordinality $$,
  $$ values ('Chat', now()), ('Shack', now() - interval '10 minutes'), ('Chat', now() - interval '1 minute') $$,
  'every destination gets its newest spot before any gets its second, newest first within one');
select is((select count(*) from pgmq.q_deliveries_queue where vt <= clock_timestamp()), 4::bigint,
  'messages beyond p_limit stay visible');
select is((select claim_tokens from destinations where id = (select id from dd)), 298::numeric, 'Chat paid two tokens');
select is((select claim_tokens from destinations where id = (select id from dw)), 999::numeric, 'Shack paid one');
create temp table fair2 as select * from claim_deliveries(200, 60) with ordinality;
select results_eq(
  $$ select destination ->> 'name', (spot ->> 'spot_time')::timestamptz from fair2 order by ordinality $$,
  $$ values ('Chat', now() - interval '2 minutes'), ('Shack', now() - interval '11 minutes'),
            ('Chat', now() - interval '3 minutes'), ('Chat', now() - interval '4 minutes') $$,
  'the next claim continues in the same order');
select is((select count(*) from pgmq.q_deliveries_queue where vt <= clock_timestamp()), 0::bigint, 'everything is claimed');

-- ---------------------------------------------------------------------------
-- Per-destination budget
-- ---------------------------------------------------------------------------
select pg_temp.reset_queue();
select pg_temp.queue((select id from dd), 'budget-', 400, now());
create temp table big as select * from claim_deliveries(1000, 60) with ordinality;
select is((select count(*) from big), 300::bigint, '400 queued for a Discord webhook: 300 claimed');
select is((select count(*) from pgmq.q_deliveries_queue where vt <= clock_timestamp()), 100::bigint, 'the other 100 stay visible');
select is((select claim_tokens from destinations where id = (select id from dd)), 0::numeric, 'the bucket is empty');
select is((select min((spot ->> 'spot_time')::timestamptz) from big), now() - interval '299 minutes',
  'the 100 left behind are the oldest');
select is((select (spot ->> 'spot_time')::timestamptz from big where ordinality = 1), now(), 'the newest comes first');
select is((select count(*) from claim_deliveries(5, 60) c), 0::bigint, 'an empty bucket claims nothing');
select is((select array_agg(k order by k) from big b, jsonb_object_keys(to_jsonb(b)) k where b.ordinality = 1),
  array['attempts', 'created_at', 'delivery_id', 'destination', 'msg_id', 'ordinality', 'spot', 'subscription_id'],
  'the result columns are unchanged');

-- ---------------------------------------------------------------------------
-- Refill
-- ---------------------------------------------------------------------------
select pg_temp.reset_queue();
select pg_temp.queue((select id from dp), 'push-', 5, now());
select is((select count(*) from claim_deliveries(200, 60)), 3::bigint, 'push: three spots a minute');
select is((select count(*) from claim_deliveries(200, 60)), 0::bigint, 'then nothing until the bucket refills');
update destinations set claim_tokens_at = now() - interval '30 seconds' where id = (select id from dp);
select is((select count(*) from claim_deliveries(200, 60)), 1::bigint, 'half a minute refills one of the three');
update destinations set claim_tokens_at = now() - interval '1 minute' where id = (select id from dp);
select is((select count(*) from claim_deliveries(200, 60)), 1::bigint, 'a minute refills the bucket; the last spot goes');
update destinations set claim_tokens_at = now() - interval '1 hour' where id = (select id from dp);
select pg_temp.queue((select id from dp), 'push2-', 5, now());
select is((select count(*) from claim_deliveries(200, 60)), 3::bigint, 'the bucket never banks more than the burst');

-- ---------------------------------------------------------------------------
-- Paused and throttled destinations
-- ---------------------------------------------------------------------------
select pg_temp.reset_queue();
select pg_temp.queue((select id from dd), 'thr-', 2, now());
update destinations set health = 'paused' where id = (select id from dd);
select is((select count(*) from claim_deliveries(200, 60)), 0::bigint, 'a paused destination is not claimed');
select is((select count(*) from pgmq.q_deliveries_queue where vt <= clock_timestamp()), 2::bigint, 'its messages stay visible');
update destinations set health = 'ok', throttled_until = now() + interval '1 minute' where id = (select id from dd);
select is((select count(*) from claim_deliveries(200, 60)), 0::bigint, 'a throttled destination is not claimed');
update destinations set throttled_until = now() - interval '1 second' where id = (select id from dd);
create temp table thr as select * from claim_deliveries(200, 60);
select is((select count(*) from thr), 2::bigint, 'claimable once the throttle has passed');

-- throttle_destination: a 429 (or the Discord cap) hides the destination and
-- its messages without touching health.
select is(throttle_destination((select id from dd), array(select msg_id from thr), null), 60,
  'without Retry-After the hold is destination_throttle_seconds at the new level');
select is((select throttle_level from destinations where id = (select id from dd)), 1, 'the first 429 moves to level 1');
select is((select throttled_until from destinations where id = (select id from dd)), now() + interval '60 seconds',
  'throttled_until is now plus the hold');
select ok((select bool_and(q.vt > now() + interval '59 seconds')
           from pgmq.q_deliveries_queue q join thr on thr.msg_id = q.msg_id), 'the messages are hidden for the hold');
select is((select consecutive_failures || ':' || health from destinations where id = (select id from dd)), '0:ok',
  'a throttle never counts toward health');
select is(throttle_destination((select id from dd), array[]::bigint[], null), 120, 'the next 429 doubles the hold');
select is(throttle_destination((select id from dd), array(select msg_id from thr), 7), 7, 'Retry-After wins over the level');
select is(throttle_destination((select id from dd), array[]::bigint[], 0), 1, 'a zero Retry-After holds for a second');
select is(throttle_destination((select id from dd), array[]::bigint[], 2147483647), 86400,
  'a huge Retry-After is capped at a day');
select is((select throttled_until from destinations where id = (select id from dd)), now() + interval '1 day',
  'and so is throttled_until');
select is((select throttle_level from destinations where id = (select id from dd)), 5, 'every 429 raises the level');
select throws_ok($$ select throttle_destination('00000000-0000-0000-0000-000000000000', array[]::bigint[], null) $$,
  'P0001', 'Destination not found.', 'an unknown destination is an error');

-- A successful cycle clears the hold and steps the level down by one.
select mark_deliveries_sent(array(select delivery_id from thr), array(select msg_id from thr));
select results_eq($$ select throttle_level, throttled_until from destinations where id = (select id from dd) $$,
  $$ values (4, null::timestamptz) $$, 'success clears throttled_until and decays the level by one, not to zero');
select mark_deliveries_sent(array[]::bigint[], array[]::bigint[]);
select is((select throttle_level from destinations where id = (select id from dd)), 4, 'an empty ack touches nothing');

-- ---------------------------------------------------------------------------
-- Expiry and delivery_queue_stats
-- ---------------------------------------------------------------------------
select pg_temp.reset_queue();
select results_eq($$ select * from delivery_queue_stats() $$, $$ values (0::bigint, 0::bigint) $$, 'stats on an empty queue');
create temp table expw as select id, n from unnest(pg_temp.queue((select id from dw), 'exp-w-', 2, now())) with ordinality as t(id, n);
create temp table expp as select id, n from unnest(pg_temp.queue((select id from dp), 'exp-p-', 2, now())) with ordinality as t(id, n);
update deliveries set created_at = now() - interval '25 hours' where id = (select id from expw where n = 1);
update deliveries set created_at = now() - interval '23 hours' where id = (select id from expw where n = 2);
-- A push destination's own "drop if the device is offline for" (30 minutes by default) replaces
-- destination_max_age for it (20261016000400); push_destinations.test.sql covers the other values.
update deliveries set created_at = now() - interval '31 minutes' where id = (select id from expp where n = 1);
update deliveries set created_at = now() - interval '29 minutes' where id = (select id from expp where n = 2);
-- Nothing is claimable, so the sweep is the only thing the call does.
update destinations set health = 'paused';
select is((select count(*) from claim_deliveries(200, 60)), 0::bigint, 'nothing claimed while every destination is paused');
select results_eq(
  $$ select d.status, d.dropped_at is not null from deliveries d
     where d.id in ((select id from expw where n = 1), (select id from expp where n = 1)) $$,
  $$ values ('dropped', true), ('dropped', true) $$,
  'a 25 h old webhook row and a 31 min old push row are dropped with dropped_at set');
select results_eq(
  $$ select d.status, d.dropped_at from deliveries d
     where d.id in ((select id from expw where n = 2), (select id from expp where n = 2)) $$,
  $$ values ('pending', null::timestamptz), ('pending', null::timestamptz) $$,
  'a 23 h old webhook row and a 29 min old push row wait');
select is((select count(*) from pgmq.q_deliveries_queue), 2::bigint, 'the dropped messages left the queue');
select is((select count(*) from pgmq.a_deliveries_queue
           where (message ->> 'delivery_id')::bigint in ((select id from expw where n = 1), (select id from expp where n = 1))),
  2::bigint, 'they were archived');
select results_eq($$ select * from delivery_queue_stats() $$, $$ values (2::bigint, 2::bigint) $$,
  'stats: two queued, two expired in the last hour');
update deliveries set dropped_at = now() - interval '2 hours' where id = (select id from expw where n = 1);
select results_eq($$ select * from delivery_queue_stats() $$, $$ values (2::bigint, 1::bigint) $$,
  'an older drop is outside the window');

-- An in-flight message (vt ahead) is left to its ack even when its row is old.
update deliveries set created_at = now() - interval '25 hours' where id = (select id from expw where n = 2);
update pgmq.q_deliveries_queue set vt = clock_timestamp() + interval '1 minute'
  where (message ->> 'delivery_id')::bigint = (select id from expw where n = 2);
select count(*) from claim_deliveries(200, 60);
select is((select status from deliveries where id = (select id from expw where n = 2)), 'pending', 'an in-flight message is not swept');
update pgmq.q_deliveries_queue set vt = clock_timestamp() where (message ->> 'delivery_id')::bigint = (select id from expw where n = 2);
select count(*) from claim_deliveries(200, 60);
select is((select status from deliveries where id = (select id from expw where n = 2)), 'dropped', 'once visible again it is swept');

-- A message whose delivery row is gone is archived.
select pgmq.send('deliveries_queue', '{"delivery_id": 999999999}'::jsonb);
select count(*) from claim_deliveries(200, 60);
select is((select count(*) from pgmq.q_deliveries_queue where (message ->> 'delivery_id')::bigint = 999999999), 0::bigint,
  'a message without a delivery row is archived');

-- The sweep is the only source of drops: the 29 min old push row is still queued,
-- and the two drops inside the hour are the 31 min old push row and the swept webhook row.
select results_eq($$ select * from delivery_queue_stats() $$, $$ values (1::bigint, 2::bigint) $$,
  'stats count the sweep drops only');

-- ---------------------------------------------------------------------------
-- Disabled subscriptions and unlinked destinations (20261016000100)
-- ---------------------------------------------------------------------------
select pg_temp.reset_queue();
-- A second subscription of the same user, linked to Shack, stays enabled throughout.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table sub2 as
  select save_subscription(jsonb_build_object('name','other','quiet_minutes',0,'destinations',array[(select id from dw)])) as id;
reset role;
create temp table unw as
  select id, n from unnest(pg_temp.queue((select id from dw), 'unw-', 2, now())) with ordinality as t(id, n);
update deliveries set subscription_id = (select id from sub2) where id = (select id from unw where n = 2);
update subscriptions set enabled = false where id = (select id from sub);
create temp table unw_claim as select * from claim_deliveries(200, 60);
select results_eq($$ select delivery_id from unw_claim $$, $$ select id from unw where n = 2 $$,
  'a disabled subscription''s delivery is not claimed; an enabled one beside it is');
select results_eq($$ select status, dropped_at from deliveries where id = (select id from unw where n = 1) $$,
  $$ values ('dropped', null::timestamptz) $$, 'it is dropped without dropped_at');
select is((select count(*) from pgmq.q_deliveries_queue where (message ->> 'delivery_id')::bigint = (select id from unw where n = 1)),
  0::bigint, 'and its message is archived');
select results_eq($$ select * from delivery_queue_stats() $$, $$ values (1::bigint, 0::bigint) $$,
  'an unwanted drop is not counted as expired');
update subscriptions set enabled = true where id = (select id from sub);

-- Unlinked: Chat's delivery under sub goes once sub no longer sends to Chat;
-- Shack, still linked, is claimed.
select pg_temp.reset_queue();
create temp table unl_c as select unnest(pg_temp.queue((select id from dd), 'unl-c-', 1, now())) as id;
create temp table unl_s as select unnest(pg_temp.queue((select id from dw), 'unl-s-', 1, now())) as id;
delete from subscription_destinations where subscription_id = (select id from sub) and destination_id = (select id from dd);
create temp table unl_claim as select * from claim_deliveries(200, 60);
select results_eq($$ select delivery_id from unl_claim $$, $$ select id from unl_s $$,
  'an unlinked destination''s delivery is not claimed; the linked one is');
select results_eq($$ select status, dropped_at from deliveries where id = (select id from unl_c) $$,
  $$ values ('dropped', null::timestamptz) $$, 'the unlinked delivery is dropped without dropped_at');
select is((select count(*) from pgmq.q_deliveries_queue where (message ->> 'delivery_id')::bigint = (select id from unl_c)),
  0::bigint, 'and its message is archived');
insert into subscription_destinations (subscription_id, destination_id) values ((select id from sub), (select id from dd));

-- Disabled destination (20261016000400): its queued rows go the same way; the others are claimed.
select pg_temp.reset_queue();
create temp table dis_c as select unnest(pg_temp.queue((select id from dd), 'dis-c-', 1, now())) as id;
create temp table dis_s as select unnest(pg_temp.queue((select id from dw), 'dis-s-', 1, now())) as id;
update destinations set enabled = false where id = (select id from dd);
create temp table dis_claim as select * from claim_deliveries(200, 60);
select results_eq($$ select delivery_id from dis_claim $$, $$ select id from dis_s $$,
  'a disabled destination''s delivery is not claimed; an enabled one is');
select results_eq($$ select status, dropped_at from deliveries where id = (select id from dis_c) $$,
  $$ values ('dropped', null::timestamptz) $$, 'the disabled destination''s delivery is dropped without dropped_at');
select is((select count(*) from pgmq.q_deliveries_queue where (message ->> 'delivery_id')::bigint = (select id from dis_c)),
  0::bigint, 'and its message is archived');
update destinations set enabled = true where id = (select id from dd);
select is((select count(*) from pg_temp.queue((select id from dd), 'dis-c2-', 1, now())), 1::bigint, 'enabled again: a new delivery queues');

select * from finish();
rollback;

-- pgTAP: the RPCs the sender uses to claim, complete, retry and throttle
-- deliveries, and the sweeps that drop them (20261006000010 delivery_rpcs,
-- 20261015000400 rate_aware_claim, 20261015001400 sender_cleanup,
-- 20261016000100 claim_drops_unwanted, 20261016000300 throttle_cap,
-- 20261016000400 push_destinations_v2 for the enabled sweep, 20261018000100
-- discord_destinations for the batch hold, 20261018000300 webhook_destinations
-- for the webhook hold, per-claim cap and retry policies).
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(133);
select pgmq.purge_queue('spot_events');
select pgmq.purge_queue('deliveries_queue');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table dw as select * from create_destination('webhook', 'Shack', 'https://shack.example.com/spots');
select save_subscription(jsonb_build_object('name','all','quiet_minutes',0,'destinations',array[(select id from dw)]));
reset role;
create temp table sub as select id from subscriptions;

-- A destination starts with an empty bucket that refills from its creation,
-- which in a transaction is now(): a minute ago fills every bucket. It also
-- clears Discord's claim schedule (claim_due_at, 20261018000100).
create function pg_temp.fill_buckets() returns void language sql as $$
  update destinations set claim_tokens = 0, claim_tokens_at = now() - interval '1 minute', claim_due_at = '-infinity';
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
-- A webhook's delay is its retry policy's (20261018000300; a new webhook
-- retries up to 3 times over 10 minutes, 60 s after the first failure), not
-- the 300 the sender passed; Discord's p_delay_seconds is pinned below.
select ok((select vt between now() + interval '55 seconds' and clock_timestamp() + interval '60 seconds'
           from pgmq.q_deliveries_queue), 'a webhook message is delayed by its retry policy, not p_delay_seconds');

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
  $$ values (300::numeric, 100::numeric) $$, 'discord budget: 300 spots a minute, banking two claims of 50 (20261018000100)');
select is(array[destination_claim_interval('discord'), destination_claim_interval('push'), destination_claim_interval('webhook')],
  array[interval '10 seconds', interval '0', interval '0'],
  'a Discord destination is claimed on average every 10 seconds (6 claims of 5 messages a minute); other types have no interval');
select is(array[destination_claim_max('discord'), destination_claim_max('push'), destination_claim_max('webhook')],
  array[50::numeric, null, null], 'a Discord claim takes at most 50 spots (5 messages of 10); other types only their tokens');
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
          and not has_column_privilege('authenticated', 'public.destinations', 'claim_due_at', 'select')
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
select is((select claim_tokens from destinations where id = (select id from dd)), 98::numeric, 'Chat paid two tokens');
select is((select claim_tokens from destinations where id = (select id from dw)), 999::numeric, 'Shack paid one');
-- Chat due its next claim (20261018000100); Shack, a webhook, has no interval.
update destinations set claim_due_at = clock_timestamp() where id = (select id from dd);
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
select is((select count(*) from big), 50::bigint, '400 queued for a Discord webhook: one claim''s 50 claimed');
select is((select count(*) from pgmq.q_deliveries_queue where vt <= clock_timestamp()), 350::bigint, 'the other 350 stay visible');
select is((select claim_tokens from destinations where id = (select id from dd)), 50::numeric,
  'the bucket keeps the other 50 of its 100 for the next claim');
select is((select min((spot ->> 'spot_time')::timestamptz) from big), now() - interval '49 minutes',
  'the 350 left behind are the oldest');
select is((select (spot ->> 'spot_time')::timestamptz from big where ordinality = 1), now(), 'the newest comes first');
-- An empty bucket on a destination due its next claim, so the bucket alone
-- decides. The bucket refills from the call's start, and rendering Discord
-- spots (20261018000100) takes long enough to refill a token on a slow
-- machine: stamp the empty bucket now.
update destinations set claim_tokens = 0, claim_tokens_at = clock_timestamp(), claim_due_at = '-infinity'
  where id = (select id from dd);
select is((select count(*) from claim_deliveries(5, 60) c), 0::bigint, 'an empty bucket claims nothing, even when due');

-- ---------------------------------------------------------------------------
-- Claim interval (20261018000100): Discord on average every 10 seconds, on
-- a schedule (claim_due_at) a claim may run half an interval ahead of
-- ---------------------------------------------------------------------------
select pg_temp.reset_queue();
select pg_temp.queue((select id from dd), 'iv-', 3, now());
select is((select count(*) from claim_deliveries(200, 60)), 3::bigint, 'a Discord destination not claimed lately goes at once');
select ok((select claim_due_at between clock_timestamp() + interval '9 seconds' and clock_timestamp() + interval '10 seconds'
           from destinations where id = (select id from dd)), 'the claim makes the next one due in 10 seconds');
select pg_temp.queue((select id from dd), 'iv2-', 2, now());
create temp table iv_tokens as select claim_tokens, claim_tokens_at, claim_due_at from destinations where id = (select id from dd);
select is((select count(*) from claim_deliveries(200, 60)), 0::bigint, 'claimed a moment ago, it waits for the interval');
select results_eq($$ select claim_tokens, claim_tokens_at, claim_due_at from destinations where id = (select id from dd) $$,
  $$ select claim_tokens, claim_tokens_at, claim_due_at from iv_tokens $$, 'a waiting destination is not debited or rescheduled');
-- 4 seconds on (due in 6): still more than half an interval early.
update destinations set claim_due_at = clock_timestamp() + interval '6 seconds' where id = (select id from dd);
select is((select count(*) from claim_deliveries(200, 60)), 0::bigint, 'four seconds after a claim is too early');
-- The sender polls 5 s after a cycle, so the next poll comes about 6 s after
-- the claim (due in 4): within half an interval, so it goes, and the schedule
-- moves on from the due time, not from now.
update destinations set claim_due_at = clock_timestamp() + interval '4 seconds' where id = (select id from dd);
select is((select count(*) from claim_deliveries(200, 60)), 2::bigint, 'the poll six seconds after a claim takes the next spots');
select ok((select claim_due_at between clock_timestamp() + interval '13 seconds' and clock_timestamp() + interval '14 seconds'
           from destinations where id = (select id from dd)),
  'the next claim is due 10 seconds after the last was due, so poll-aligned claims average one per 10 seconds');
-- Polls 6 s apart for a minute (0 to 60 s) with a backlog throughout. A plain
-- 10 s gap would take every other poll (12 s apart, 250 a minute); the
-- schedule takes polls 0, 6, 18, 30, 36, 48 and 60.
select pg_temp.reset_queue();
select pg_temp.queue((select id from dd), 'ivr-', 400, now());
create temp table iv_run (poll int, n bigint); -- poll: seconds after the first
do $$
declare
  i int;
  v_n bigint;
  v_shift interval;
  v_at timestamptz;
begin
  for i in 0..10 loop
    -- Each poll is 6 s after the last: shift the clock-dependent columns back
    -- by 6 s less the real time since the last poll, so a slow machine does
    -- not change the simulated gaps.
    if i > 0 then
      v_shift := interval '6 seconds' - (clock_timestamp() - v_at);
      update destinations set claim_due_at = claim_due_at - v_shift,
                              claim_tokens_at = claim_tokens_at - v_shift
        where id = (select id from dd);
    end if;
    v_at := clock_timestamp();
    select count(*) into v_n from claim_deliveries(200, 60);
    insert into iv_run values (i * 6, v_n);
  end loop;
end $$;
select is((select array_agg(poll order by poll) from iv_run where n > 0), array[0, 6, 18, 30, 36, 48, 60],
  'claimed at polls 0, 6, 18, 30, 36, 48 and 60: one per 10 s on average, never closer than 5 s');
select is((select array_agg(distinct n) from iv_run where n > 0), array[50::bigint],
  'every claim is a full 50, so the destination keeps up 300 spots a minute (no refill lost to the cap)');

-- A claim p_limit cut short keeps its tokens: the bucket banks them past one
-- claim's 50, so the next claim is a full one and the rest stays banked.
select pg_temp.reset_queue();
select pg_temp.queue((select id from dd), 'ivp-', 200, now());
update destinations set claim_tokens = 50, claim_tokens_at = clock_timestamp() where id = (select id from dd);
select is((select count(*) from claim_deliveries(10, 60)), 10::bigint, 'p_limit cuts a Discord claim to 10');
select is((select floor(claim_tokens) from destinations where id = (select id from dd)), 40::numeric, 'it paid only for the 10');
update destinations set claim_due_at = clock_timestamp(), claim_tokens_at = clock_timestamp() - interval '10 seconds'
  where id = (select id from dd);
select is((select count(*) from claim_deliveries(200, 60)), 50::bigint, 'the next claim is a full 50');
select ok((select claim_tokens between 40 and 41 from destinations where id = (select id from dd)),
  'and the 40 left over from the short claim stay banked (40 + 50 refilled - 50)');
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
-- Batch hold (20261018000100): a Discord destination with a window waits
-- until its oldest ready row is that old or ten are ready
-- ---------------------------------------------------------------------------
select pg_temp.reset_queue();
update discord_destination_settings set batch_seconds = 30 where destination_id = (select id from dd);
create temp table hold as select unnest(pg_temp.queue((select id from dd), 'hold-', 3, now())) as id;
select pg_temp.queue((select id from dw), 'hold-w-', 2, now());
create temp table hold_vt as select q.msg_id, q.vt from pgmq.q_deliveries_queue q;
create temp table hold1 as select * from claim_deliveries(200, 60);
select is((select count(*) from hold1 where destination ->> 'id' = (select id::text from dd)), 0::bigint,
  'a 30-second window holds three fresh spots');
select is((select count(*) from hold1 where destination ->> 'id' = (select id::text from dw)), 2::bigint,
  'the other destination is claimed in the same call');
select ok((select bool_and(q.vt = h.vt) from pgmq.q_deliveries_queue q join hold_vt h on h.msg_id = q.msg_id
           where (q.message ->> 'delivery_id')::bigint in (select id from hold)), 'held messages keep their vt');
select results_eq($$ select claim_tokens, claim_tokens_at from destinations where id = (select id from dd) $$,
  $$ values (0::numeric, now() - interval '1 minute') $$, 'a held destination is not debited');
select is((select count(*) from deliveries where id in (select id from hold) and status = 'pending' and dropped_at is null), 3::bigint,
  'held rows stay pending');
select mark_deliveries_sent(array(select delivery_id from hold1), array(select msg_id from hold1));
select pg_temp.queue((select id from dw), 'hold-w2-', 2, now());
select is((select count(*) from claim_deliveries(2, 60) c where c.destination ->> 'id' = (select id::text from dw)), 2::bigint,
  'held rows take no share of p_limit');
update deliveries set created_at = now() - interval '31 seconds' where id = (select min(id) from hold);
create temp table hold2 as select * from claim_deliveries(200, 60) with ordinality;
select results_eq($$ select (spot ->> 'spot_time')::timestamptz from hold2 order by ordinality $$,
  $$ values (now()), (now() - interval '1 minute'), (now() - interval '2 minutes') $$,
  'once the oldest is older than the window all three go, newest first');

select pg_temp.reset_queue();
select pg_temp.queue((select id from dd), 'hold10-', 10, now());
select is((select count(*) from claim_deliveries(200, 60)), 10::bigint, 'ten fresh spots go at once');
select pg_temp.reset_queue();
select pg_temp.queue((select id from dd), 'hold9-', 10, now());
update pgmq.q_deliveries_queue set vt = clock_timestamp() + interval '1 minute'
  where msg_id = (select min(msg_id) from pgmq.q_deliveries_queue);
select is((select count(*) from claim_deliveries(200, 60)), 0::bigint, 'a row in flight does not count toward the ten');

select pg_temp.reset_queue();
select pg_temp.queue((select id from dd), 'holdt-', 3, now());
update deliveries set created_at = now() - interval '31 seconds';
update destinations set throttled_until = now() + interval '1 minute' where id = (select id from dd);
select is((select count(*) from claim_deliveries(200, 60)), 0::bigint, 'a throttle holds rows older than the window');
update destinations set throttled_until = now() - interval '1 second' where id = (select id from dd);
select is((select count(*) from claim_deliveries(200, 60)), 3::bigint, 'and when it lifts they go at once');

select pg_temp.reset_queue();
update discord_destination_settings set batch_seconds = 0 where destination_id = (select id from dd);
select pg_temp.queue((select id from dd), 'hold0-', 3, now());
select is((select count(*) from claim_deliveries(200, 60)), 3::bigint, 'without a window every spot goes at once');

-- ---------------------------------------------------------------------------
-- Paused and throttled destinations
-- ---------------------------------------------------------------------------
select pg_temp.reset_queue();
select pg_temp.queue((select id from dd), 'thr-', 2, now());
update destinations set health = 'paused' where id = (select id from dd);
select is((select count(*) from claim_deliveries(200, 60)), 0::bigint, 'a paused destination is not claimed');
-- Nothing sets 'paused' but an operator; its rows go as unwanted (20261017001010).
select results_eq($$ select status, dropped_at, count(*) from deliveries group by 1, 2 $$,
  $$ values ('dropped', null::timestamptz, 2::bigint) $$, 'its rows are dropped as unwanted, not as a loss');
select pg_temp.reset_queue();
select pg_temp.queue((select id from dd), 'thr2-', 2, now());
update destinations set throttled_until = now() + interval '1 minute' where id = (select id from dd);
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
update destinations set throttled_until = now() + interval '1 hour';
select is((select count(*) from claim_deliveries(200, 60)), 0::bigint, 'nothing claimed while every destination is throttled');
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

-- ---------------------------------------------------------------------------
-- Webhooks (20261018000300): the batch hold, the per-claim cap, no claim
-- interval, and the retry policies in mark_deliveries_failed
-- ---------------------------------------------------------------------------
-- Seconds until p_id's queued message is visible again, rounded; fail marks it failed and returns that.
create function pg_temp.vt_secs(p_id bigint) returns numeric language sql as $$
  select round(extract(epoch from q.vt - clock_timestamp())) from pgmq.q_deliveries_queue q
  where (q.message ->> 'delivery_id')::bigint = p_id;
$$;
create function pg_temp.fail(p_id bigint, p_delay int) returns numeric language sql as $$
  select mark_deliveries_failed(array[p_id], array(select q.msg_id from pgmq.q_deliveries_queue q
                                                   where (q.message ->> 'delivery_id')::bigint = p_id), 'HTTP 500', p_delay);
  select pg_temp.vt_secs(p_id);
$$;
update webhook_destination_settings set pause_after_failures = null where destination_id = (select id from dw);

select pg_temp.reset_queue();
update webhook_destination_settings set batch_seconds = 10 where destination_id = (select id from dw);
create temp table wh as select unnest(pg_temp.queue((select id from dw), 'wh-', 3, now())) as id;
update deliveries set created_at = clock_timestamp() - interval '3 seconds' where id in (select id from wh);
select is((select count(*) from claim_deliveries(200, 60)), 0::bigint, 'a webhook with a 10-second window holds spots 3 seconds old');
update deliveries set created_at = clock_timestamp() - interval '12 seconds' where id = (select min(id) from wh);
select is((select count(*) from claim_deliveries(200, 60)), 3::bigint, 'once the oldest is 12 seconds old all three go');
select pg_temp.reset_queue();
select pg_temp.queue((select id from dw), 'wh49-', 49, now());
update deliveries set created_at = clock_timestamp();
select is((select count(*) from claim_deliveries(200, 60)), 0::bigint, '49 fresh spots are held');
select pg_temp.queue((select id from dw), 'wh50-', 1, now());
update deliveries set created_at = clock_timestamp();
select is((select count(*) from claim_deliveries(200, 60)), 50::bigint,
  '50 fresh spots, one full request, go at once (destination_batch_full)');

select pg_temp.reset_queue();
update webhook_destination_settings set batch_seconds = 0 where destination_id = (select id from dw);
select pg_temp.queue((select id from dw), 'cap-', 12, now());
select is((select count(*) from claim_deliveries(200, 60)), 5::bigint, 'one request per spot: five of twelve ready a claim');
select is((select count(*) from claim_deliveries(200, 60)), 5::bigint, 'and no claim interval: the next claim at once takes five more');
select pg_temp.reset_queue();
update webhook_destination_settings set batch_seconds = 30 where destination_id = (select id from dw);
select pg_temp.queue((select id from dw), 'cap30-', 12, now());
update deliveries set created_at = clock_timestamp() - interval '31 seconds';
select is((select count(*) from claim_deliveries(200, 60)), 12::bigint, 'grouped: every ready spot, up to the bucket');

select pg_temp.reset_queue();
update webhook_destination_settings set batch_seconds = 0, retry_policy = 'three_10m' where destination_id = (select id from dw);
create temp table rt as select unnest(pg_temp.queue((select id from dw), 'rt-', 1, now())) as id;
select is((select array_agg(pg_temp.fail((select id from rt), 999) order by n) from generate_series(1, 4) n),
  array[60, 180, 360, 0]::numeric[], 'three_10m: 60, 180 and 360 seconds whatever the sender asks, then visible at once');
select count(*) from claim_deliveries(200, 60);
select results_eq($$ select status, attempts, dropped_at is not null from deliveries where id = (select id from rt) $$,
  $$ values ('dropped'::text, 4, true) $$, 'after the fourth failure the next claim''s sweep drops it with dropped_at');

select pg_temp.reset_queue();
update webhook_destination_settings set retry_policy = 'none' where destination_id = (select id from dw);
create temp table rn as select unnest(pg_temp.queue((select id from dw), 'rn-', 1, now())) as id;
select pg_temp.fail((select id from rn), 999);
select count(*) from claim_deliveries(200, 60);
select results_eq($$ select status, attempts, dropped_at is not null from deliveries where id = (select id from rn) $$,
  $$ values ('dropped'::text, 1, true) $$, 'none: dropped by the next claim after one failure');

select pg_temp.reset_queue();
update webhook_destination_settings set retry_policy = 'day' where destination_id = (select id from dw);
create temp table rd as select unnest(pg_temp.queue((select id from dw), 'rd-', 1, now())) as id;
select is((select array_agg(pg_temp.fail((select id from rd), 999) order by n) from generate_series(1, 7) n),
  array[30, 60, 120, 300, 900, 1800, 1800]::numeric[], 'day: 30 s, 1, 2, 5 and 15 minutes, then every 30 minutes');

select pg_temp.reset_queue();
create temp table rdd as select unnest(pg_temp.queue((select id from dd), 'rdd-', 1, now())) as id;
create temp table rdp as select unnest(pg_temp.queue((select id from dp), 'rdp-', 1, now())) as id;
select is(array[pg_temp.fail((select id from rdd), 300), pg_temp.fail((select id from rdp), 45)], array[300, 45]::numeric[],
  'Discord and push rows still wait p_delay_seconds');

-- Only the rows that were in a request count an attempt (decision 14): the
-- sender marks failed the first of five one-spot requests; the other four
-- come back when the claim's p_vt lapses and are claimed again.
select pg_temp.reset_queue();
update webhook_destination_settings set retry_policy = 'none' where destination_id = (select id from dw);
select pg_temp.queue((select id from dw), 'att-', 5, now());
create temp table att as select * from claim_deliveries(200, 60);
select mark_deliveries_failed(array(select delivery_id from att order by delivery_id limit 1),
                              array(select msg_id from att order by delivery_id limit 1), 'HTTP 500', 30);
update pgmq.q_deliveries_queue set vt = clock_timestamp() - interval '1 second';
update destinations set claim_tokens = 0, claim_tokens_at = clock_timestamp() - interval '1 minute' where id = (select id from dw);
select is((select count(*) from claim_deliveries(200, 60)), 4::bigint, 'the four unattempted rows are claimed again');
select results_eq($$ select status, dropped_at is not null, count(*) from deliveries group by 1, 2 order by 1 $$,
  $$ values ('dropped'::text, true, 1::bigint), ('pending', false, 4) $$, 'and only the attempted one is dropped');

select * from finish();
rollback;

-- pgTAP: claim_deliveries never hands out an expired row, even past the
-- expiry sweep's 500 a call, and drops a destination paused by hand as
-- unwanted (20261017001010_claim_skips_expired), and never hands out a webhook
-- row whose retry policy's attempts are used up (20261018000300).
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(13);
select pgmq.purge_queue('spot_events');
select pgmq.purge_queue('deliveries_queue');
delete from deliveries;
delete from raw_spots;

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table hook as select id from create_destination('webhook', 'Shack', 'https://shack.example.com/spots');
create temp table held as select id from create_destination('webhook', 'Held', 'https://held.example.com/spots');
select save_subscription(jsonb_build_object('name', 'all', 'quiet_minutes', 0,
  'destinations', array[(select id from hook), (select id from held)]));
reset role;

-- 606 spots at the same time, so the claim ranks deliveries by id alone.
select count(*) from ingest_spots((
  select jsonb_agg(jsonb_build_object('source', 'pota', 'source_spot_id', 'x' || i, 'content_hash', 'h' || i,
    'spot_time', now(), 'callsign', 'KK4PWJ', 'frequency_khz', 14062, 'band', '20m', 'mode', 'cw', 'comment', '',
    'pota_reference', 'US-2763', 'pota_location', 'US-NC', 'raw_payload', '{}'::jsonb))
  from generate_series(1, 606) i));
select pgmq.purge_queue('spot_events');

-- Five fresh rows first, then 600 two days old (past the webhook's 24 hours),
-- so every expired row ranks ahead of the fresh ones; one fresh row for Held.
create temp table spots as select id, row_number() over (order by id) as n from raw_spots;
with ins as (
  insert into deliveries (subscription_id, destination_id, spot_id, created_at)
  select (select id from subscriptions), (select id from hook), s.id,
         case when s.n <= 5 then now() else now() - interval '2 days' end
  from spots s where s.n <= 605 order by s.n
  returning id
)
select pgmq.send_batch('deliveries_queue', (select array_agg(jsonb_build_object('delivery_id', ins.id) order by ins.id) from ins));
with ins as (
  insert into deliveries (subscription_id, destination_id, spot_id)
  select (select id from subscriptions), (select id from held), s.id from spots s where s.n = 606
  returning id
)
select pgmq.send_batch('deliveries_queue', (select array_agg(jsonb_build_object('delivery_id', ins.id)) from ins));

update destinations set health = 'paused' where id = (select id from held);
update destinations set claim_tokens = 0, claim_tokens_at = now() - interval '1 minute';

create temp table claimed as select * from claim_deliveries(200, 60);
select is((select count(*) from claimed), 5::bigint, 'the claim hands out only the five fresh rows');
select is((select count(*) from claimed where created_at < now() - interval '1 day'), 0::bigint,
  'no expired row is claimed, although 100 are still queued past the sweep''s 500');
select results_eq($$ select status, dropped_at is not null, count(*) from deliveries
                     where destination_id = (select id from hook) and created_at < now() - interval '1 day'
                     group by 1, 2 order by 1 $$,
  $$ values ('dropped', true, 500::bigint), ('pending', false, 100::bigint) $$,
  'the sweep dropped 500 and left 100 for the next call');
select is((select claim_tokens from destinations where id = (select id from hook)), 995::numeric,
  'only the claimed rows are debited');

select is((select count(*) from claim_deliveries(200, 60)), 0::bigint, 'the next call claims nothing');
select is((select count(*) from deliveries where destination_id = (select id from hook) and status = 'pending'
             and created_at < now() - interval '1 day'), 0::bigint, 'and its sweep drops the remaining 100');
select is((select count(*) from pgmq.q_deliveries_queue), 5::bigint, 'only the claimed messages stay queued');

-- A destination paused by hand: its rows are dropped as unwanted, not a loss.
select results_eq($$ select status, dropped_at from deliveries where destination_id = (select id from held) $$,
  $$ values ('dropped', null::timestamptz) $$, 'a paused destination''s rows are dropped as unwanted');
select is((select count(*) from pgmq.q_deliveries_queue q
           join deliveries d on d.id = (q.message ->> 'delivery_id')::bigint
           where d.destination_id = (select id from held)), 0::bigint, 'and their messages archived');

-- A webhook row whose retry policy's attempts are used up (20261018000300) is
-- swept with dropped_at, and `ready` leaves out the ones past the sweep's 500.
create temp table tried as select id from create_destination('webhook', 'Tried', 'https://tried.example.com/spots');
reset role;
update webhook_destination_settings set retry_policy = 'none' where destination_id = (select id from tried);
insert into subscription_destinations (subscription_id, destination_id) values ((select id from subscriptions), (select id from tried));
-- Five untried rows, then 600 tried once, all fresh; the tried rows have the
-- higher ids, so they rank first.
with ins as (
  insert into deliveries (subscription_id, destination_id, spot_id, attempts, status)
  select (select id from subscriptions), (select id from tried), s.id,
         case when s.n <= 5 then 0 else 1 end, case when s.n <= 5 then 'pending' else 'failed' end
  from spots s where s.n <= 605 order by s.n
  returning id
)
select pgmq.send_batch('deliveries_queue', (select array_agg(jsonb_build_object('delivery_id', ins.id) order by ins.id) from ins));
update destinations set claim_tokens = 0, claim_tokens_at = now() - interval '1 minute' where id = (select id from tried);
create temp table tried_claim as select * from claim_deliveries(200, 60);
select results_eq($$ select attempts, count(*) from tried_claim group by 1 $$, $$ values (0, 5::bigint) $$,
  'only the five untried rows are claimed, although 100 used-up rows are still queued past the sweep''s 500');
select results_eq($$ select status, dropped_at is not null, count(*) from deliveries
                     where destination_id = (select id from tried) and attempts = 1 group by 1, 2 order by 1 $$,
  $$ values ('dropped', true, 500::bigint), ('failed', false, 100::bigint) $$,
  'the sweep dropped 500 used-up rows as a loss and left 100 for the next call');
select is((select count(*) from claim_deliveries(200, 60)), 0::bigint, 'the next call claims nothing');
select is((select count(*) from deliveries where destination_id = (select id from tried) and status = 'dropped'), 600::bigint,
  'and its sweep drops the remaining 100');

select * from finish();
rollback;

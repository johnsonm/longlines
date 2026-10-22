-- pgTAP: subscriptions, save/delete RPCs, destination links, RLS.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(25);

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table da as select * from create_destination('discord', 'A discord', 'https://discord.com/api/webhooks/1/a');
create temp table db as select * from create_destination('webhook', 'A hook', 'https://hooks.example.com/a');

select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
create temp table dz as select * from create_destination('discord', 'B discord', 'https://discord.com/api/webhooks/2/b');

-- Create.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table s1 as select save_subscription(jsonb_build_object(
  'name', 'NC parks', 'sources', array['pota'],
  'rules', '[[{"field":"mode","op":"is","values":["CW","ssb"]},
              {"field":"callsign","op":"is","values":[" kk4pwj ","w1aw"]},
              {"field":"reference","op":"contains","values":["us-nc"]}]]'::jsonb,
  'quiet_minutes', 10,
  'destinations', array[(select id from da), (select id from db)])) as id;

select is((select count(*) from subscriptions), 1::bigint, 'subscription created');
select is((select rules -> 0 -> 0 -> 'values' from subscriptions), '["cw", "ssb"]'::jsonb, 'modes are lowercased');
select is((select rules -> 0 -> 1 -> 'values' from subscriptions), '["KK4PWJ", "W1AW"]'::jsonb, 'callsigns are uppercased and trimmed');
select is((select rules -> 0 -> 2 -> 'values' from subscriptions), '["us-nc"]'::jsonb, 'reference stored as typed');
select is((select count(*) from subscription_destinations where subscription_id = (select id from s1)), 2::bigint, 'both destinations linked');

-- Update replaces the links and keeps the id.
select is(save_subscription(jsonb_build_object('id', (select id from s1), 'name', 'NC parks v2', 'enabled', false,
  'sources', '{}'::text[], 'rules', '[[{"field":"band","op":"is","values":["20m"]}]]'::jsonb,
  'quiet_minutes', 0, 'destinations', array[(select id from db)])), (select id from s1), 'update returns the same id');
select is((select name from subscriptions), 'NC parks v2', 'update changed the name');
select is((select enabled from subscriptions), false, 'update changed enabled');
select is((select rules from subscriptions), '[[{"op": "is", "field": "band", "values": ["20m"]}]]'::jsonb, 'update replaced the rules');
select is((select array_agg(destination_id) from subscription_destinations), array[(select id from db)], 'update replaced the links');

-- Validation.
select throws_ok(format($f$ select save_subscription('{"name":"x","destinations":["%s"]}') $f$, (select id from dz)),
  'P0001', 'Destination not found.', 'cannot link another user''s destination');
select ok((select save_subscription('{"name":"No destinations yet","destinations":[]}')) is not null, 'saves with no destinations');
select throws_ok(format($f$ select save_subscription('{"name":" ","destinations":["%s"]}') $f$, (select id from db)),
  'P0001', 'Give the connection a name.', 'needs a name');
select throws_ok(format($f$ select save_subscription('{"name":"x","quiet_minutes":7,"destinations":["%s"]}') $f$, (select id from db)),
  'P0001', 'quiet_minutes must be 0, 5, 10, 30 or 60.', 'quiet_minutes must be one of the allowed values');
select throws_ok(format($f$ select save_subscription('{"name":"x","quiet_minutes":"%s"}') $f$, repeat('9', 140000)),
  'P0001', 'quiet_minutes must be 0, 5, 10, 30 or 60.', 'a long numeric string gets the message, not an overflow');
select throws_ok($f$ select save_subscription('{"name":"x","quiet_minutes":1e-400}') $f$,
  'P0001', 'quiet_minutes must be 0, 5, 10, 30 or 60.', 'a tiny number is not read as 0');
select ok((select save_subscription('{"name":"Quiet string","quiet_minutes":"30"}')) is not null, 'a short numeric string still saves');
select throws_ok($f$ select save_subscription('{"name":"x","destinations":["nope"]}') $f$,
  'P0001', 'Not a destination id: nope.', 'a destination id that is not a UUID gets a message');
select throws_ok($f$ select save_subscription('{"name":"x","destinations":"nope"}') $f$,
  'P0001', 'destinations must be a list.', 'destinations must be a list');
select ok((select save_subscription('{"name":"Null destinations","destinations":null}')) is not null, 'a null destinations list saves as empty');

-- A destination in use cannot be deleted.
select throws_ok(format('delete from destinations where id = %L', (select id from db)), '23503', null, 'destination in use is protected');
select lives_ok(format('delete from destinations where id = %L', (select id from da)), 'unused destination can be deleted');

-- Other user sees nothing and cannot delete.
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select is((select count(*) from subscriptions), 0::bigint, 'other user sees no subscriptions');
select throws_ok(format('select delete_subscription(%L)', (select id from s1)), 'P0001', 'Connection not found.', 'other user cannot delete');

-- The helper is service-role only.
reset role;
select is(pg_get_constraintdef((select oid from pg_constraint where conname = 'subscriptions_quiet_minutes_check')),
  format('CHECK ((quiet_minutes = ANY (ARRAY[%s])))', array_to_string(subscription_quiet_minutes(), ', ')),
  'subscription_quiet_minutes() is the check constraint''s set');

select * from finish();
rollback;

-- pgTAP: deleting an auth user removes everything they own, even with a
-- subscription still linked to a destination (the restrict FK must not block
-- the cascade), using a callsign group, holding an API token and a push device.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(8);

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table d as select * from create_destination('discord', 'A discord', 'https://discord.com/api/webhooks/1/a');
create temp table g as select save_callsign_group('{"name":"Club","callsigns":["W1AW"]}') as id;
select save_subscription(jsonb_build_object('name', 'all', 'rules', jsonb_build_array(jsonb_build_array(jsonb_build_object('field', 'group', 'op', 'is', 'values', jsonb_build_array((select id from g))))), 'destinations', array[(select id from d)]));
select id from create_api_token('Sync', 'write', null);
select register_push_device('https://fcm.googleapis.com/fcm/send/a',
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg', 'Phone');
reset role;

select lives_ok($$ delete from auth.users where id = '11111111-1111-1111-1111-111111111111' $$, 'user with a linked subscription can be deleted');
select is((select count(*) from profiles where id = '11111111-1111-1111-1111-111111111111'), 0::bigint, 'profile removed');
select is((select count(*) from subscriptions where user_id = '11111111-1111-1111-1111-111111111111'), 0::bigint, 'subscriptions removed');
select is((select count(*) from destinations where user_id = '11111111-1111-1111-1111-111111111111'), 0::bigint, 'destinations removed');
select is((select count(*) from callsign_groups where user_id = '11111111-1111-1111-1111-111111111111'), 0::bigint, 'callsign groups removed');
select is((select count(*) from callsign_group_members where group_id = (select id from g)), 0::bigint, 'group members removed');
select is((select count(*) from api_tokens where user_id = '11111111-1111-1111-1111-111111111111'), 0::bigint, 'API tokens removed');
select is((select count(*) from push_devices where user_id = '11111111-1111-1111-1111-111111111111'), 0::bigint, 'push devices removed');

select * from finish();
rollback;

-- pgTAP: register_push_device following a rotated endpoint
-- (20261017002000_push_device_rotation). The caller's own device takes the
-- new endpoint in place, keeping its id, name and destinations; another
-- account's endpoint is never claimed.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(11);

\set p256dh '''BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'''
\set auth '''BTBZMqHH6r4Tts7J_aSIgg'''

-- A's phone, in one of A's push destinations; B's phone.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table a_phone as select register_push_device('https://fcm.googleapis.com/fcm/send/a-old', :p256dh, :auth, 'Phone', 'Chrome on Android', true) as id;
grant all on a_phone to authenticated;
create temp table a_dest as select save_push_destination(null, 'Phone alerts', true, null, array[(select id from a_phone)]) as id;
grant all on a_dest to authenticated;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
create temp table b_phone as select register_push_device('https://web.push.apple.com/b-phone', :p256dh, :auth, 'iPhone', 'Safari on iPhone', true) as id;
grant all on b_phone to authenticated;
reset role;
update push_devices set blocked_at = now(), last_error = 'Push HTTP 500', last_error_at = now() where id = (select id from a_phone);

-- The refresh after a rotation: keys only, with the endpoint the browser remembers.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table a_rotated as select register_push_device('https://fcm.googleapis.com/fcm/send/a-new', :p256dh, :auth, null, null, null,
  'https://fcm.googleapis.com/fcm/send/a-old') as id;
reset role;
select is((select id from a_rotated), (select id from a_phone), 'a rotated endpoint keeps the device id');
select results_eq($$ select endpoint, label, agent, standalone, blocked_at, last_error from push_devices where id = (select id from a_phone) $$,
  $$ values ('https://fcm.googleapis.com/fcm/send/a-new'::text, 'Phone'::text, 'Chrome on Android'::text, true, null::timestamptz, null::text) $$,
  'the device takes the new endpoint and keeps its name and descriptor, with its status cleared');
select is((select count(*) from push_devices where user_id = '11111111-1111-1111-1111-111111111111'), 1::bigint, 'no second device');
select results_eq($$ select device_id from push_destination_devices where destination_id = (select id from a_dest) $$,
  $$ select id from a_phone $$, 'the device stays in its destinations');

-- B names A's endpoint as its previous one: B gets a device of its own, A's is untouched.
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
create temp table b_probe as select register_push_device('https://web.push.apple.com/b-probe', :p256dh, :auth, null, null, null,
  'https://fcm.googleapis.com/fcm/send/a-new') as id;
reset role;
select isnt((select id from b_probe), (select id from a_phone), 'another account''s endpoint is never claimed');
select results_eq($$ select user_id, endpoint from push_devices where id = (select id from a_phone) $$,
  $$ values ('11111111-1111-1111-1111-111111111111'::uuid, 'https://fcm.googleapis.com/fcm/send/a-new'::text) $$,
  'A''s device keeps its owner and endpoint');
select is((select user_id from push_devices where id = (select id from b_probe)), '22222222-2222-2222-2222-222222222222'::uuid,
  'the probe registered as B''s own new device');

-- A previous endpoint that is already gone, or a new endpoint already registered, is an ordinary registration.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table a_gone as select register_push_device('https://fcm.googleapis.com/fcm/send/a-other', :p256dh, :auth, null, null, null,
  'https://fcm.googleapis.com/fcm/send/never') as id;
create temp table a_existing as select register_push_device('https://fcm.googleapis.com/fcm/send/a-new', :p256dh, :auth, null, null, null,
  'https://fcm.googleapis.com/fcm/send/a-other') as id;
reset role;
select isnt((select id from a_gone), (select id from a_phone), 'an unknown previous endpoint registers a new device');
select is((select id from a_existing), (select id from a_phone), 'a new endpoint already registered is refreshed, not merged');
select is((select count(*) from push_devices where endpoint = 'https://fcm.googleapis.com/fcm/send/a-other'), 1::bigint,
  'and the previous device is left alone');

-- At the cap a rotation still works: the device count does not change.
insert into push_devices (user_id, endpoint, p256dh, auth, label)
select '11111111-1111-1111-1111-111111111111', 'https://fcm.googleapis.com/fcm/send/cap' || i, 'k', 'a', 'Cap ' || i
from generate_series(1, 18) i;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select lives_ok($$ select register_push_device('https://fcm.googleapis.com/fcm/send/a-newer',
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg', null, null, null,
  'https://fcm.googleapis.com/fcm/send/a-new') $$, 'a rotation at the cap is not refused');
reset role;

select * from finish();
rollback;

-- pgTAP: push destinations and devices (20261013000400_push_destinations).
-- Endpoint allowlist, one push destination per account, device registration,
-- the client RPCs, service-role-only storage, and what claim_deliveries hands
-- the worker.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(61);
select pgmq.purge_queue('spot_events');
select pgmq.purge_queue('deliveries_queue');

-- ---------------------------------------------------------------------------
-- Endpoint allowlist
-- ---------------------------------------------------------------------------
select lives_ok($$ select validate_push_endpoint('https://fcm.googleapis.com/fcm/send/abc:APA91b') $$, 'FCM accepted');
select lives_ok($$ select validate_push_endpoint('https://updates.push.services.mozilla.com/wpush/v2/gAAAA') $$, 'Mozilla accepted');
select lives_ok($$ select validate_push_endpoint('https://web.push.apple.com/QGuQyavXutnMH') $$, 'Apple subdomain accepted');
select lives_ok($$ select validate_push_endpoint('https://wns2-par02p.notify.windows.com/w/?token=BQYAAA') $$, 'Windows subdomain accepted');
select throws_ok($$ select validate_push_endpoint('http://fcm.googleapis.com/fcm/send/abc') $$, 'P0001', 'Use a browser push service.', 'http rejected');
select throws_ok($$ select validate_push_endpoint('https://evilpush.apple.com/x') $$, 'P0001', 'Use a browser push service.', 'push.apple.com look-alike rejected');
select throws_ok($$ select validate_push_endpoint('https://push.apple.com/x') $$, 'P0001', 'Use a browser push service.', 'bare suffix host rejected');
select throws_ok($$ select validate_push_endpoint('https://fcm.googleapis.com.evil.com/x') $$, 'P0001', 'Use a browser push service.', 'allowlisted host as a prefix rejected');
select throws_ok($$ select validate_push_endpoint('https://142.250.80.10/fcm/send/abc') $$, 'P0001', 'Use a browser push service.', 'IP literal rejected');
select throws_ok($$ select validate_push_endpoint('https://localhost/x') $$, 'P0001', 'Use a browser push service.', 'localhost rejected');
select throws_ok($$ select validate_push_endpoint('https://fcm.googleapis.com:8443/fcm/send/abc') $$, 'P0001', 'Use a browser push service.', 'explicit port rejected');
select throws_ok($$ select validate_push_endpoint('https://a.push.apple.com@evil.com/x') $$, 'P0001', 'Use a browser push service.', 'credentials rejected');
select throws_ok($$ select validate_push_endpoint(null) $$, 'P0001', 'Use a browser push service.', 'null rejected');

-- ---------------------------------------------------------------------------
-- Push destinations
-- ---------------------------------------------------------------------------
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table pa as select * from create_destination('push', 'Push notifications', null);
select is((select url_display from pa), 'Your devices', 'a push destination shows "Your devices"');
select is((select signing_secret from pa), null, 'a push destination gets no signing secret');
select throws_ok($$ select create_destination('push', 'Again', null) $$, 'P0001', 'You already have push notifications.', 'one push destination per account');
reset role; -- update_destination is the API's (api_call runs it); A's claims stay set
select throws_ok(format('select update_destination(%L, null, %L)', (select id from pa), 'https://example.com/x'),
  'P0001', 'Push notifications don''t use a URL.', 'a push destination cannot gain a URL');
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table wa as select * from create_destination('webhook', 'Shack', 'https://shack.example.com/spots');

select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select throws_ok($$ select create_destination('push', 'x', 'https://fcm.googleapis.com/fcm/send/abc') $$,
  'P0001', 'Push notifications don''t use a URL.', 'push with a URL rejected');
reset role;

select throws_ok($$ insert into destinations (user_id, type, name, url, url_display)
  values ('22222222-2222-2222-2222-222222222222', 'push', 'x', 'https://e.com', 'e') $$, '23514', null, 'check: push has no url');
select throws_ok($$ insert into destinations (user_id, type, name, url, url_display)
  values ('22222222-2222-2222-2222-222222222222', 'webhook', 'x', null, 'e') $$, '23514', null, 'check: other types need a url');

-- ---------------------------------------------------------------------------
-- register_push_device
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '';
select throws_ok($$ select register_push_device('https://fcm.googleapis.com/fcm/send/x',
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg', 'x') $$,
  'P0001', 'Not signed in.', 'register needs a session');
select throws_ok($$ select unregister_push_device('https://fcm.googleapis.com/fcm/send/x') $$, 'P0001', 'Not signed in.', 'unregister needs a session');
select throws_ok($$ select * from list_push_devices() $$, 'P0001', 'Not signed in.', 'list needs a session');
select throws_ok(format('select delete_push_device(%L)', gen_random_uuid()), 'P0001', 'Not signed in.', 'delete needs a session');

-- B has no push destination: the first device creates it, named from p_name.
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
create temp table rb1 as select register_push_device('https://fcm.googleapis.com/fcm/send/b1',
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg',
  '  Chrome on Android  ', 'My devices') as id;
create temp table rb2 as select register_push_device('https://web.push.apple.com/b2',
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg',
  'Safari on iPhone', 'Ignored') as id;
select is((select id from rb2), (select id from rb1), 'a second device reuses the push destination');
select results_eq($$ select name, url_display from destinations where type = 'push' $$,
  $$ values ('My devices'::text, 'Your devices'::text) $$, 'register created exactly one destination, named from p_name');
select throws_ok($$ select register_push_device('https://fcm.googleapis.com/fcm/send/b3', 'AAAA', 'BTBZMqHH6r4Tts7J_aSIgg', 'x') $$,
  'P0001', 'That browser sent an invalid subscription.', 'short p256dh rejected');
select throws_ok($$ select register_push_device('https://fcm.googleapis.com/fcm/send/b3',
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'not+base64url!!!!!!!!!', 'x') $$,
  'P0001', 'That browser sent an invalid subscription.', 'auth outside base64url rejected');
select throws_ok($$ select register_push_device('https://fcm.googleapis.com/fcm/send/b3',
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSI', 'x') $$,
  'P0001', 'That browser sent an invalid subscription.', 'auth of the wrong length rejected');
select throws_ok($$ select register_push_device('https://evil.example.com/b3',
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg', 'x') $$,
  'P0001', 'Use a browser push service.', 'register checks the allowlist');

-- A already has a push destination from create_destination.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is(register_push_device('https://updates.push.services.mozilla.com/wpush/v2/a1',
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg',
  '   ' || repeat('x', 80)), (select id from pa), 'register returns the existing push destination');
reset role;
select is((select label from push_devices where endpoint like '%/a1'), repeat('x', 60), 'label trimmed and capped at 60');
select is((select label from push_devices where endpoint like '%/b1'), 'Chrome on Android', 'label trimmed');
select is((select count(*) from destinations where type = 'push'), 2::bigint, 'no extra push destinations');

-- An endpoint that moves to another account is reassigned with its status cleared.
select record_push_results(array['https://fcm.googleapis.com/fcm/send/b1'], '{}'::jsonb);
select record_push_results(array[]::text[], '{"https://fcm.googleapis.com/fcm/send/b1": "Push HTTP 500"}'::jsonb);
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select register_push_device('https://fcm.googleapis.com/fcm/send/b1',
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg', 'Moved', null);
reset role;
select results_eq($$ select user_id, label, last_success_at, last_error, last_error_at from push_devices where endpoint like '%/b1' $$,
  $$ values ('11111111-1111-1111-1111-111111111111'::uuid, 'Moved'::text, null::timestamptz, null::text, null::timestamptz) $$,
  'a moved endpoint belongs to the caller with its status cleared');

-- Device cap: 20 per account; re-registering one of them still works.
insert into push_devices (user_id, endpoint, p256dh, auth, label)
select '22222222-2222-2222-2222-222222222222', 'https://fcm.googleapis.com/fcm/send/cap' || i, 'k', 'a', 'Cap ' || i
from generate_series(1, 19) i;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select throws_ok($$ select register_push_device('https://fcm.googleapis.com/fcm/send/b21',
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg', 'x') $$,
  'P0001', 'You can turn on notifications on up to 20 devices. Remove one first.', 'the 21st device is refused');
select lives_ok($$ select register_push_device('https://web.push.apple.com/b2',
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg', 'Safari on iPhone') $$,
  'a registered device can refresh at the cap');
reset role;
delete from push_devices where endpoint like '%/cap%';

-- ---------------------------------------------------------------------------
-- Client reads and deletes
-- ---------------------------------------------------------------------------
-- Everything here shares the transaction's now(); age one device so the order shows.
update push_devices set created_at = now() - interval '1 hour' where endpoint like '%/a1';
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is((select array_agg(k order by k) from list_push_devices() l, jsonb_object_keys(to_jsonb(l)) k where l.label = 'Moved'),
  array['created_at', 'id', 'is_current', 'label', 'last_error', 'last_error_at', 'last_success_at'],
  'list_push_devices returns labels and status, never the endpoint or keys');
select results_eq($$ select label, is_current from list_push_devices('https://fcm.googleapis.com/fcm/send/b1') $$,
  $$ values ('Moved'::text, true), (repeat('x', 60), false) $$, 'newest first, with the current device flagged');
select is((select count(*) from list_push_devices() where not is_current), 2::bigint, 'no endpoint: nothing is current');
select throws_ok($$ select * from push_devices $$, '42501', null, 'clients cannot read push_devices');
select throws_ok($$ insert into push_devices (user_id, endpoint, p256dh, auth, label)
  values (auth.uid(), 'https://fcm.googleapis.com/x', 'k', 'a', 'x') $$, '42501', null, 'clients cannot insert into push_devices');
select throws_ok($$ update push_devices set label = 'x' $$, '42501', null, 'clients cannot update push_devices');
select throws_ok($$ delete from push_devices $$, '42501', null, 'clients cannot delete from push_devices');

select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select is((select count(*) from list_push_devices()), 1::bigint, 'B lists only B''s devices');
reset role;
select id as b2_id from push_devices where endpoint = 'https://web.push.apple.com/b2' \gset
select id as a1_id from push_devices where endpoint like '%/a1' \gset
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select throws_ok(format('select delete_push_device(%L)', :'b2_id'), 'P0001', 'Device not found.', 'another account''s device cannot be deleted');
select throws_ok(format('select delete_push_device(%L)', gen_random_uuid()), 'P0001', 'Device not found.', 'an unknown id is not found');
select unregister_push_device('https://web.push.apple.com/b2'); -- B's: silently ignored
select lives_ok(format('select delete_push_device(%L)', :'a1_id'), 'the owner deletes a device');
reset role;
select is((select count(*) from push_devices where endpoint = 'https://web.push.apple.com/b2'), 1::bigint, 'unregister leaves another account''s device');
select is((select count(*) from push_devices where endpoint like '%/a1'), 0::bigint, 'delete removed the device');
-- Put it back for the claim below.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select register_push_device('https://updates.push.services.mozilla.com/wpush/v2/a1',
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg', 'Firefox on Linux');
reset role;

-- ---------------------------------------------------------------------------
-- claim_deliveries
-- ---------------------------------------------------------------------------
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select save_subscription(jsonb_build_object('name', 'all', 'quiet_minutes', 0,
  'destinations', array[(select id from pa), (select id from wa)]));
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select unregister_push_device('https://web.push.apple.com/b2');
select save_subscription(jsonb_build_object('name', 'all', 'quiet_minutes', 0, 'destinations', array[(select id from rb1)]));
reset role;

select count(*) from ingest_spots(jsonb_build_array(
  jsonb_build_object('source','pota','source_spot_id','s1','content_hash','h1','spot_time',now(),'callsign','KK4PWJ/P',
    'frequency_khz',14062,'band','20m','mode','cw','comment','','pota_reference','US-2763','pota_location','US-NC','raw_payload','{}'::jsonb)));
select is(match_pending_spots(), 3, 'three deliveries queued');
create temp table claimed as
  select c.*, dest.type from claim_deliveries(200, 60) c join destinations dest on dest.id = (c.destination ->> 'id')::uuid;
select is((select jsonb_agg(d order by d ->> 'endpoint') from claimed, jsonb_array_elements(destination -> 'devices') d
           where destination ->> 'id' = (select id::text from pa)),
  (select jsonb_agg(jsonb_build_object('endpoint', endpoint, 'p256dh', p256dh, 'auth', auth) order by endpoint)
   from push_devices where user_id = '11111111-1111-1111-1111-111111111111'),
  'a push destination carries its owner''s devices and keys');
select is((select destination -> 'devices' from claimed where destination ->> 'id' = (select id::text from rb1)), '[]'::jsonb,
  'a push destination with no devices gets an empty list');
select is((select destination ? 'devices' from claimed where type = 'webhook'), false, 'other destinations carry no devices');
select is((select destination ->> 'url' from claimed where destination ->> 'id' = (select id::text from pa)), null, 'push has no url');
select is((select array_agg(distinct spot ->> 'base_callsign') from claimed), array['KK4PWJ'], 'every spot carries base_callsign from SQL');

-- ---------------------------------------------------------------------------
-- Worker RPCs and the cascade
-- ---------------------------------------------------------------------------
select record_push_results(array['https://fcm.googleapis.com/fcm/send/b1'],
  jsonb_build_object('https://updates.push.services.mozilla.com/wpush/v2/a1', 'Push HTTP 500'));
select ok((select last_success_at is not null and last_error is null from push_devices where endpoint like '%/b1'), 'record stamps a success');
select results_eq($$ select last_error, last_error_at is not null from push_devices where endpoint like '%/a1' $$,
  $$ values ('Push HTTP 500'::text, true) $$, 'record stamps an error');
select is(prune_push_devices(array['https://fcm.googleapis.com/fcm/send/b1', 'https://fcm.googleapis.com/fcm/send/nope']), 1, 'prune deletes the gone endpoints it finds');
select ok(not has_function_privilege('authenticated', 'public.prune_push_devices(text[])', 'execute')
          and not has_function_privilege('authenticated', 'public.record_push_results(text[], jsonb)', 'execute')
          and not has_function_privilege('authenticated', 'public.validate_push_endpoint(text)', 'execute'),
  'the worker RPCs and the allowlist are not callable by clients');

delete from auth.users where id = '11111111-1111-1111-1111-111111111111';
select is((select count(*) from push_devices where user_id = '11111111-1111-1111-1111-111111111111'), 0::bigint, 'devices go with their account');

select * from finish();
rollback;

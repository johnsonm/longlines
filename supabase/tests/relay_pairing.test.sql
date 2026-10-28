-- pgTAP: Long Lines Relay pairing and relay tokens (20261028000400): codes, start, poll (pending,
-- slow_down with its jitter allowance, denied, approved once, expired), the approval page's lookup
-- and answer (normalized codes, the callsign rule, the 10-relay cap), token authentication, the
-- per-token contact window, GET /me's account, pruning, and access.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(77);

-- A user with no profile (a Google sign-up that has not given a callsign yet).
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('33333333-3333-3333-3333-333333333333', '00000000-0000-0000-0000-000000000000', 'authenticated',
  'authenticated', 'c@example.com', 'x', now(), '{"provider":"google","providers":["google"]}', '{}', now(), now());

create function pg_temp.sha(p_text text) returns text language sql as $$
  select encode(extensions.digest(p_text, 'sha256'), 'hex');
$$;
-- A started pairing's device code, by the name it was started with.
create temp table started (name text primary key, body jsonb);
create function pg_temp.start(p_name text) returns jsonb language sql as $$
  insert into started values (p_name, start_relay_pairing(p_name, '0.1.0')) returning body;
$$;
create function pg_temp.code(p_name text) returns text language sql as $$
  select body ->> 'user_code' from started where name = p_name;
$$;
create function pg_temp.poll(p_name text) returns jsonb language sql as $$
  select poll_relay_pairing(pg_temp.sha((select body ->> 'device_code' from started where name = p_name)));
$$;
-- Polls as a relay that waited its interval: the previous poll moved back 5 seconds first.
create function pg_temp.poll_later(p_name text) returns jsonb language sql as $$
  update relay_pairings set last_polled_at = last_polled_at - interval '5 seconds'
  where user_code = pg_temp.code(p_name) and last_polled_at is not null;
  select pg_temp.poll(p_name);
$$;
grant all on started to authenticated;
grant execute on function pg_temp.code(text) to authenticated;

-- Codes ---------------------------------------------------------------------

select is(relay_user_code('kq7m x4pd'), 'KQ7M-X4PD', 'a typed code is upper-cased and spaces dropped');
select is(relay_user_code('KQ7MX4PD'), 'KQ7M-X4PD', 'a code without its hyphen gets one');
select is(relay_user_code(' kq7m-x4po '), 'KQ7M-X4P0', 'O reads as 0');
select is(relay_user_code('KQ7M-X4PI'), 'KQ7M-X4P1', 'I reads as 1');
select is(relay_user_code('KQ7M-X4PL'), 'KQ7M-X4P1', 'L reads as 1');
select is(relay_user_code('KQ7M-A4PD'), null, 'a vowel is not in the alphabet');
select is(relay_user_code('KQ7M-X4P'), null, 'seven characters are not a code');
select is(relay_user_code(null), null, 'null is not a code');
select ok((select bool_and(new_relay_user_code() ~ '^[0-9BCDFGHJKMNPQRSTVWXYZ]{4}-[0-9BCDFGHJKMNPQRSTVWXYZ]{4}$')
           from generate_series(1, 200)), 'user codes are XXXX-XXXX from the alphabet');
select ok(new_relay_token() ~ '^ll_relay_[a-z2-7]{52}$', 'relay tokens are ll_relay_ and 52 base32 characters');

-- Start -----------------------------------------------------------------------

select is((select array_agg(k order by k) from jsonb_object_keys(pg_temp.start('SHACK-PC')) as k),
  array['device_code', 'expires_in', 'interval', 'user_code', 'verification_uri', 'verification_uri_complete'],
  'start returns the contract''s fields');
select ok((select body ->> 'device_code' ~ '^[0-9a-f]{64}$' from started where name = 'SHACK-PC'),
  'the device code is 64 hex characters');
select is((select (body ->> 'expires_in')::int from started where name = 'SHACK-PC'), 600, 'pairings last 10 minutes');
select is((select (body ->> 'interval')::int from started where name = 'SHACK-PC'), 5, 'the poll interval is 5 seconds');
select is((select body ->> 'verification_uri' from started where name = 'SHACK-PC'),
  'https://longlines.io/relay/approve', 'the verification URI is the approval page');
select is((select body ->> 'verification_uri_complete' from started where name = 'SHACK-PC'),
  'https://longlines.io/relay/approve?code=' || pg_temp.code('SHACK-PC'), 'the complete URI carries the code');
select ok((select p.device_code_hash = pg_temp.sha(s.body ->> 'device_code')
                  and to_jsonb(p)::text not like '%' || (s.body ->> 'device_code') || '%'
           from relay_pairings p join started s on p.user_code = s.body ->> 'user_code'
           where s.name = 'SHACK-PC'),
  'only the device code''s hash is stored');
select is((select device_name || ' ' || client_version || ' ' || status from relay_pairings
           where user_code = pg_temp.code('SHACK-PC')), 'SHACK-PC 0.1.0 pending', 'the pairing is pending');
select pg_temp.start('  Laptop  ');
select is((select device_name from relay_pairings where user_code = pg_temp.code('  Laptop  ')),
  'Laptop', 'the device name is trimmed');
select throws_ok($$ select start_relay_pairing('  ', '0.1.0') $$, '22023', null, 'a blank device name is refused');
select throws_ok($$ select start_relay_pairing(repeat('x', 65), '0.1.0') $$, '22023', null,
  'a device name over 64 characters is refused');
select throws_ok($$ select start_relay_pairing('PC', '') $$, '22023', null, 'a blank version is refused');

-- Poll while pending ----------------------------------------------------------

select is(poll_relay_pairing(pg_temp.sha('no such code')), '{"status": "expired_token"}', 'an unknown device code is expired');
select is(pg_temp.poll('SHACK-PC'), '{"status": "authorization_pending"}', 'a pending pairing polls pending');
select is(pg_temp.poll('SHACK-PC'), '{"status": "slow_down"}', 'a poll right after another is slow_down');
select is(pg_temp.poll_later('SHACK-PC'), '{"status": "authorization_pending"}', 'a poll an interval later is pending');
update relay_pairings set last_polled_at = now() - interval '4.5 seconds' where user_code = pg_temp.code('SHACK-PC');
select is(pg_temp.poll('SHACK-PC'), '{"status": "authorization_pending"}', 'half a second early is network jitter, not slow_down');
update relay_pairings set last_polled_at = now() - interval '3 seconds' where user_code = pg_temp.code('SHACK-PC');
select is(pg_temp.poll('SHACK-PC'), '{"status": "slow_down"}', 'two seconds early is slow_down');

-- The approval page -------------------------------------------------------------

select pg_temp.start('DENY-ME');
select pg_temp.start('LATE');
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is(lookup_relay_pairing(lower(replace(pg_temp.code('SHACK-PC'), '-', ''))) - 'expires_at',
  jsonb_build_object('status', 'pending', 'code', pg_temp.code('SHACK-PC'), 'device_name', 'SHACK-PC',
                     'scopes', jsonb_build_array('contacts:write')),
  'lookup shows a pending pairing by its code as typed');
select is(lookup_relay_pairing('BCDF-GHJK'), '{"status": "unknown", "code": "BCDF-GHJK"}', 'lookup of a code no one has is unknown');
select is(lookup_relay_pairing('hello'), '{"status": "unknown", "code": null}', 'lookup of a malformed code is unknown');
select is(answer_relay_pairing('BCDF-GHJK', true), '{"status": "unknown"}', 'answering an unknown code is unknown');
select throws_ok(format('select answer_relay_pairing(%L, null)', pg_temp.code('SHACK-PC')), 'Choose Allow or Deny.');
reset role;
update relay_pairings set expires_at = now() - interval '1 second' where user_code = pg_temp.code('LATE');
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select is(answer_relay_pairing(pg_temp.code('DENY-ME'), false), '{"status": "denied"}', 'Deny denies');
select is(lookup_relay_pairing(pg_temp.code('DENY-ME')), jsonb_build_object('status', 'expired', 'code', pg_temp.code('DENY-ME')),
  'an answered pairing looks expired, whoever answered it');
select is(lookup_relay_pairing(pg_temp.code('LATE')), jsonb_build_object('status', 'expired', 'code', pg_temp.code('LATE')),
  'a pairing past its 10 minutes looks expired');
select is(answer_relay_pairing(pg_temp.code('LATE'), true), '{"status": "expired"}', 'an expired pairing cannot be allowed');
reset role;
select is((select status || ' ' || user_id::text from relay_pairings where user_code = pg_temp.code('DENY-ME')),
  'denied 22222222-2222-2222-2222-222222222222', 'the denial records who answered');
select is(pg_temp.poll('DENY-ME'), '{"status": "access_denied"}', 'a denied pairing polls access_denied');
select is(pg_temp.poll('LATE'), '{"status": "expired_token"}', 'an expired pairing polls expired_token');
select is((select status from relay_pairings where user_code = pg_temp.code('LATE')), 'expired', 'and is marked expired');

-- Allow, then the token ---------------------------------------------------------

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is(answer_relay_pairing(pg_temp.code('SHACK-PC'), true), '{"status": "approved"}', 'Allow approves');
select is(answer_relay_pairing(pg_temp.code('SHACK-PC'), true), '{"status": "expired"}', 'a second answer finds it answered');
reset role;
create temp table tok as select pg_temp.poll_later('SHACK-PC') as body;
select is((select body ->> 'status' from tok), 'ok', 'an approved pairing hands out its token');
select ok((select body ->> 'access_token' ~ '^ll_relay_[a-z2-7]{52}$' from tok), 'the token has the contract''s shape');
select is((select body -> 'scopes' from tok), '["contacts:write"]', 'with scope contacts:write');
select is((select user_id::text || ' ' || device_name || ' ' || client_version || ' ' || token_prefix
           from relay_tokens where token_hash = pg_temp.sha((select body ->> 'access_token' from tok))),
  '11111111-1111-1111-1111-111111111111 SHACK-PC 0.1.0 ' || left((select body ->> 'access_token' from tok), 13),
  'the token row stores the hash, owner, device and a prefix');
select is((select status from relay_pairings where user_code = pg_temp.code('SHACK-PC')), 'claimed', 'the pairing is claimed');
select is(pg_temp.poll_later('SHACK-PC'), '{"status": "expired_token"}', 'the token is handed out once');

-- Allow needs a callsign and room ------------------------------------------------

select pg_temp.start('NO-CALL');
select pg_temp.start('FULL');
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select throws_ok(format('select answer_relay_pairing(%L, true)', pg_temp.code('NO-CALL')),
  'Add your callsign to your account first.');
reset role;
insert into relay_tokens (user_id, token_hash, token_prefix, device_name, client_version, scopes)
select '22222222-2222-2222-2222-222222222222', pg_temp.sha('t' || i), 'll_relay_abcd', 'PC ' || i, '0.1.0',
       array['contacts:write']
from generate_series(1, 9) as i;
select pg_temp.start('NINTH');
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select is(answer_relay_pairing(pg_temp.code('NINTH'), true), '{"status": "approved"}', 'a tenth relay may be allowed');
select throws_ok(format('select answer_relay_pairing(%L, true)', pg_temp.code('FULL')),
  'You can connect up to 10 relays. Disconnect one in API tokens first.',
  'an eleventh is refused, counting the approved pairing not yet claimed');
select is(answer_relay_pairing(pg_temp.code('FULL'), false), '{"status": "denied"}', 'Deny needs no room');
reset role;

-- Authenticated routes ------------------------------------------------------------

select is((select count(*) from authenticate_relay_token(pg_temp.sha('ll_relay_unknown'))), 0::bigint,
  'an unknown token authenticates as no one');
update relay_tokens set last_used_at = null;
select is((select user_id::text || ' ' || scopes::text
           from authenticate_relay_token(pg_temp.sha((select body ->> 'access_token' from tok)))),
  '11111111-1111-1111-1111-111111111111 {contacts:write}', 'a token authenticates as its owner with its scopes');
select ok((select last_used_at is not null from relay_tokens
           where token_hash = pg_temp.sha((select body ->> 'access_token' from tok))), 'and touches last_used_at');

create temp table me as select id from relay_tokens where token_hash = pg_temp.sha((select body ->> 'access_token' from tok));
select is(record_relay_contacts((select id from me), 100), 0, '100 contacts fit the minute');
select is(record_relay_contacts((select id from me), 20), 0, '20 more make 120');
select ok(record_relay_contacts((select id from me), 1) between 1 and 60, 'the 121st waits for the next minute');
select is((select contacts_window_count from relay_tokens where id = (select id from me)), 120, 'a refused request counts nothing');
update relay_tokens set contacts_window_start = contacts_window_start - interval '1 minute' where id = (select id from me);
select is(record_relay_contacts((select id from me), 100), 0, 'a new minute starts a new window');
select throws_ok($$ select record_relay_contacts(gen_random_uuid(), 1) $$, '22023', null, 'an unknown token id is refused');

select is(relay_account('11111111-1111-1111-1111-111111111111'), '{"callsign": "KK4PWJ", "email": "a@example.com"}',
  'the account is its callsign and email');
select is(relay_account('33333333-3333-3333-3333-333333333333'), null, 'an account without a profile has none');

-- Access ---------------------------------------------------------------------------

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is((select array_agg(device_name) from relay_tokens), array['SHACK-PC'], 'users see only their own relay tokens');
select throws_ok($$ select token_hash from relay_tokens $$, '42501', null, 'clients cannot read token hashes');
select throws_ok($$ select device_name from relay_pairings $$, '42501', null, 'clients cannot read pairings');
select throws_ok($$ update relay_tokens set device_name = 'x' $$, '42501', null, 'clients cannot change relay tokens');
select throws_ok($$ select start_relay_pairing('PC', '0.1.0') $$, '42501', null, 'clients cannot start pairings');
select throws_ok($$ select poll_relay_pairing('x') $$, '42501', null, 'clients cannot poll');
select throws_ok($$ select relay_account(auth.uid()) $$, '42501', null, 'clients cannot read relay_account');
delete from relay_tokens where user_id = '22222222-2222-2222-2222-222222222222';
delete from relay_tokens;
reset role;
select is((select count(*) from relay_tokens where user_id = '22222222-2222-2222-2222-222222222222'), 9::bigint,
  'a user cannot revoke another user''s relay');
select is((select count(*) from relay_tokens where user_id = '11111111-1111-1111-1111-111111111111'), 0::bigint,
  'a user revokes their own relay with a delete');
select is((select count(*) from authenticate_relay_token(pg_temp.sha((select body ->> 'access_token' from tok)))), 0::bigint,
  'a revoked token authenticates as no one');

set local role anon;
select throws_ok($$ select lookup_relay_pairing('BCDF-GHJK') $$, '42501', null, 'signed-out visitors cannot look codes up');
reset role;

-- Pruning ----------------------------------------------------------------------------

update relay_pairings set created_at = now() - interval '25 hours' where user_code = pg_temp.code('DENY-ME');
select lives_ok('select prune_callsign_lookups()', 'the hourly prune runs');
select is((select count(*) from relay_pairings where user_code = pg_temp.code('DENY-ME')), 0::bigint,
  'pairings a day old are pruned');

select * from finish();
rollback;

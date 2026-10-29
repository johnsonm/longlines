-- pgTAP: profiles, sign-up trigger, callsign_available, complete_profile, RLS.
begin;
create extension if not exists pgtap with schema extensions;
select plan(30);

-- Two users signing up with metadata, as Supabase Auth would insert them.
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'a@example.com', 'x', now(), '{"provider":"email","providers":["email"]}', '{"callsign":" kk4pwj ","name":"Brad"}', now(), now()),
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'b@example.com', 'x', now(), '{"provider":"email","providers":["email"]}', '{"callsign":"W1AW"}', now(), now());

select is((select callsign from profiles where id = '11111111-1111-1111-1111-111111111111'), 'KK4PWJ',
  'trigger creates profile with uppercased, trimmed callsign');
select is((select name from profiles where id = '11111111-1111-1111-1111-111111111111'), 'Brad', 'trigger copies name');
select is((select name from profiles where id = '22222222-2222-2222-2222-222222222222'), '', 'missing name defaults to empty');

select throws_ok($$
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values ('33333333-3333-3333-3333-333333333333', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    'c@example.com', 'x', '{}', '{"callsign":"NOTACALL"}', now(), now())
$$, 'P0001', 'Enter a valid amateur callsign.', 'invalid callsign in metadata rejects the sign-up');

select throws_ok($$
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values ('44444444-4444-4444-4444-444444444444', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    'd@example.com', 'x', '{}', '{"callsign":"kk4pwj"}', now(), now())
$$, 'P0001', 'That callsign is already taken.', 'duplicate callsign rejects the sign-up');

-- callsign_available is callable anonymously and case-insensitive.
set local role anon;
select is(callsign_available('kk4pwj'), false, 'taken callsign is not available');
select is(callsign_available('N0CALL'), true, 'free callsign is available');
select is(callsign_available('bad!'), false, 'invalid callsign is reported unavailable');
select throws_ok('select * from profiles', '42501', null, 'anon cannot read profiles');
reset role;

-- RLS: user A sees and edits only their own row.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is((select count(*) from profiles), 1::bigint, 'authenticated user sees exactly their own profile');
update profiles set name = 'Changed' where id = '11111111-1111-1111-1111-111111111111';
select is((select name from profiles where id = '11111111-1111-1111-1111-111111111111'), 'Changed', 'user can update own profile');
update profiles set name = 'Hacked' where id = '22222222-2222-2222-2222-222222222222';
reset role;
select is((select name from profiles where id = '22222222-2222-2222-2222-222222222222'), '', 'user cannot update another profile');
select throws_ok($$ insert into profiles (id, callsign) values ('22222222-2222-2222-2222-222222222222', 'K1ABC') $$,
  '23505', null, 'profiles.id is unique per user');

-- A Google sign-up has no callsign: no profile until complete_profile.
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('55555555-5555-5555-5555-555555555555', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'e@example.com', '', now(), '{"provider":"google","providers":["google"]}', '{"full_name":"Ellen"}', now(), now());
select is((select count(*) from profiles where id = '55555555-5555-5555-5555-555555555555'), 0::bigint,
  'a Google sign-up without a callsign gets no profile');

select throws_ok($$
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values ('66666666-6666-6666-6666-666666666666', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    'f@example.com', 'x', '{"provider":"email","providers":["email"]}', '{}', now(), now())
$$, 'P0001', 'Enter a valid amateur callsign.', 'an email sign-up without a callsign is still rejected');

set local role authenticated;
set local request.jwt.claims = '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}';
select throws_ok($$ select complete_profile('NOTACALL', '') $$, 'P0001', 'Enter a valid amateur callsign.',
  'complete_profile rejects a bad callsign');
select throws_ok($$ select complete_profile('w1aw', '') $$, 'P0001', 'That callsign is already taken.',
  'complete_profile rejects a taken callsign');
select lives_ok($$ select complete_profile(' n0call ', ' Ellen ') $$, 'complete_profile creates the profile');
select is((select callsign || '|' || name from profiles), 'N0CALL|Ellen', 'with the normalized callsign and trimmed name');
select throws_ok($$ select complete_profile('K1ABC', '') $$, 'P0001', 'Your account is already set up.',
  'complete_profile refuses a second profile');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select throws_ok($$ select complete_profile('K1ABC', '') $$, 'P0001', 'Your account is already set up.',
  'complete_profile refuses a user who signed up with a callsign');
reset role;

set local role anon;
select throws_ok($$ select complete_profile('K1ABC', '') $$, '42501', null, 'anon cannot call complete_profile');
reset role;

-- One base call per profile (20261029000300): W1AW is taken, so W1AW/P, W1AW/7 and W1AW/QRP are
-- too, on every path, with the duplicate's message.
select throws_ok($$
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values ('88888888-8888-8888-8888-888888888888', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    'h@example.com', 'x', '{}', '{"callsign":"w1aw/p"}', now(), now())
$$, '23505', 'That callsign is already taken.', 'a sign-up with a taken base call is rejected');
set local role anon;
select is(callsign_available('w1aw/7'), false, 'a call whose base is taken is not available');
select is(callsign_available('K1ABC/P'), true, 'a free base call with a suffix is available');
reset role;
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('99999999-9999-9999-9999-999999999999', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'i@example.com', '', now(), '{"provider":"google","providers":["google"]}', '{}', now(), now());
set local role authenticated;
set local request.jwt.claims = '{"sub":"99999999-9999-9999-9999-999999999999","role":"authenticated"}';
select throws_ok($$ select complete_profile('W1AW/QRP', '') $$, 'P0001', 'That callsign is already taken.',
  'complete_profile rejects a taken base call');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select throws_ok($$ update profiles set callsign = 'w1aw/p' where id = '11111111-1111-1111-1111-111111111111' $$,
  '23505', 'That callsign is already taken.', 'a profile cannot change to a taken base call');
select lives_ok($$ update profiles set callsign = 'KK4PWJ/P' where id = '11111111-1111-1111-1111-111111111111' $$,
  'a profile can add a suffix to its own call');
reset role;
-- A pair made before the trigger (hosted data may hold one) can still save.
alter table profiles disable trigger profiles_unique_base_callsign;
update profiles set callsign = 'W1AW/7' where id = '55555555-5555-5555-5555-555555555555';
alter table profiles enable trigger profiles_unique_base_callsign;
set local role authenticated;
set local request.jwt.claims = '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}';
select lives_ok($$ update profiles set callsign = 'W1AW/7', name = 'Ellen B' where id = '55555555-5555-5555-5555-555555555555' $$,
  'an existing pair saves its profile when the base call does not change');
select throws_ok($$ update profiles set callsign = 'KK4PWJ' where id = '55555555-5555-5555-5555-555555555555' $$,
  '23505', 'That callsign is already taken.', 'but cannot move to another taken base call');
reset role;

select * from finish();
rollback;

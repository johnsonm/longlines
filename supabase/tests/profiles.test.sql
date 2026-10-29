-- pgTAP: profiles, sign-up trigger, complete_profile, RLS.
begin;
create extension if not exists pgtap with schema extensions;
select plan(26);

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

-- Accounts may share a callsign (20261029000600).
select lives_ok($$
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values ('44444444-4444-4444-4444-444444444444', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    'd@example.com', 'x', '{}', '{"callsign":"kk4pwj"}', now(), now())
$$, 'a sign-up with a callsign another account holds succeeds');
select is((select count(*) from profiles where callsign = 'KK4PWJ'), 2::bigint, 'and both accounts hold it');

set local role anon;
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

-- A base call another profile holds is fine on every path: W1AW is held, so W1AW/P, W1AW/QRP and
-- W1AW itself can be taken by sign-up, complete_profile and the profile update.
select lives_ok($$
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values ('88888888-8888-8888-8888-888888888888', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    'h@example.com', 'x', '{}', '{"callsign":"w1aw/p"}', now(), now())
$$, 'a sign-up with a held base call succeeds');
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('99999999-9999-9999-9999-999999999999', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'i@example.com', '', now(), '{"provider":"google","providers":["google"]}', '{}', now(), now());
set local role authenticated;
set local request.jwt.claims = '{"sub":"99999999-9999-9999-9999-999999999999","role":"authenticated"}';
select lives_ok($$ select complete_profile('W1AW', '') $$, 'complete_profile takes a held callsign');
reset role;

-- callsign_since: kept while the base call stays, reset when it changes. Clients cannot set it.
update profiles set callsign_since = now() - interval '1 day' where id = '11111111-1111-1111-1111-111111111111';
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select lives_ok($$ update profiles set callsign = 'KK4PWJ/P', name = 'Brad' where id = '11111111-1111-1111-1111-111111111111' $$,
  'a profile can add a suffix to its own call');
select is((select callsign_since from profiles), now() - interval '1 day', 'which keeps callsign_since');
select lives_ok($$ update profiles set callsign = 'w1aw/7' where id = '11111111-1111-1111-1111-111111111111' $$,
  'a profile can change to a held base call');
select is((select callsign_since from profiles), now(), 'which resets callsign_since');
select throws_ok($$ update profiles set callsign_since = now() - interval '1 year' $$, '42501', null,
  'a client cannot set callsign_since');
reset role;

select * from finish();
rollback;

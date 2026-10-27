-- pgTAP: home_flow() (20261027001300_home_flow, 20261027001400_home_flow_sources), the
-- Home page's counts and each connection's sources. Pins the payload shape (HomeFlow in
-- web/src/home/types.ts), the 24-hour windows (matched by created_at, delivered by sent_at),
-- distinct spots, the matcher's source rules, per-user isolation and access.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(13);

create function pg_temp.ago(p_hours int) returns timestamptz
language sql as $$ select now() - make_interval(hours => p_hours) $$;

-- A: Chat and Shack; Parks (POTA) to both, DX to Shack, Nowhere to none. B: Phone and Mine.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table dc as select * from create_destination('discord', 'Chat', 'https://discord.com/api/webhooks/1/a');
create temp table dw as select * from create_destination('webhook', 'Shack', 'https://shack.example.com/spots');
create temp table subs as
select save_subscription(jsonb_build_object('name', 'Parks', 'sources', array['pota'],
         'destinations', array[(select id from dc), (select id from dw)])) as parks,
       save_subscription(jsonb_build_object('name', 'DX', 'sources', array['dxcluster'],
         'rules', '[[{"field":"callsign","op":"is","values":["VP8PJ"]}]]'::jsonb, 'destinations', array[(select id from dw)])) as dx,
       save_subscription(jsonb_build_object('name', 'Nowhere', 'destinations', '[]'::jsonb)) as nowhere,
       save_subscription(jsonb_build_object('name', 'Any call',
         'rules', '[[{"field":"callsign","op":"is","values":["KK4PWJ"]}]]'::jsonb, 'destinations', '[]'::jsonb)) as anycall,
       save_subscription(jsonb_build_object('name', 'Either',
         'rules', '[[{"field":"callsign","op":"is","values":["KK4PWJ"]}], [{"field":"band","op":"is","values":["20m"]}]]'::jsonb,
         'destinations', '[]'::jsonb)) as either,
       save_subscription(jsonb_build_object('name', 'Everything', 'sources', array['pota', 'sotawatch', 'wwff', 'wwbota', 'rbn', 'dxcluster'],
         'rules', '[[{"field":"callsign","op":"is","values":["KK4PWJ"]}]]'::jsonb, 'destinations', '[]'::jsonb)) as everything;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
create temp table dp as select * from create_destination('push', 'Phone', null);
create temp table bsub as
select save_subscription(jsonb_build_object('name', 'Mine', 'destinations', array[(select id from dp)])) as id;
reset role;

create temp table spots as
with ins as (
  insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, frequency_khz, comment, raw_payload)
  values ('pota', 'h1', 'h1', now(), 'KK4PWJ', 14062, '', '{}'),
         ('pota', 'h2', 'h2', now(), 'W4ABC', 7032, '', '{}'),
         ('dxcluster', 'h3', 'h3', now(), 'VP8PJ', 14025, '', '{}'),
         ('pota', 'h4', 'h4', pg_temp.ago(30), 'N4OLD', 14062, '', '{}'),
         ('pota', 'h5', 'h5', pg_temp.ago(25), 'N4LATE', 14062, '', '{}')
  returning id, source_spot_id
)
select source_spot_id as k, id from ins;
create function pg_temp.spot(p_k text) returns bigint language sql as $$ select id from spots where k = p_k $$;

insert into deliveries (subscription_id, destination_id, spot_id, status, created_at, sent_at)
values
  -- h1 matched once by Parks, sent to both of its destinations.
  ((select parks from subs), (select id from dc), pg_temp.spot('h1'), 'sent', pg_temp.ago(1), pg_temp.ago(1)),
  ((select parks from subs), (select id from dw), pg_temp.spot('h1'), 'sent', pg_temp.ago(1), pg_temp.ago(1)),
  -- h2 matched, still pending.
  ((select parks from subs), (select id from dc), pg_temp.spot('h2'), 'pending', pg_temp.ago(2), null),
  ((select dx from subs), (select id from dw), pg_temp.spot('h3'), 'sent', pg_temp.ago(3), pg_temp.ago(3)),
  -- Matched and sent 30 hours ago: in neither window.
  ((select parks from subs), (select id from dc), pg_temp.spot('h4'), 'sent', pg_temp.ago(30), pg_temp.ago(30)),
  -- Matched 25 hours ago, sent an hour ago: delivered, not matched.
  ((select parks from subs), (select id from dw), pg_temp.spot('h5'), 'sent', pg_temp.ago(25), pg_temp.ago(1)),
  -- B's.
  ((select id from bsub), (select id from dp), pg_temp.spot('h1'), 'sent', pg_temp.ago(1), pg_temp.ago(1));

-- Access.
select ok(not has_function_privilege('anon', 'public.home_flow()', 'execute'), 'anon cannot call home_flow');
select ok(has_function_privilege('authenticated', 'public.home_flow()', 'execute'), 'authenticated can call home_flow');
-- reset role keeps the last as_user's claims; clear them for a caller with no user.
set local request.jwt.claims = '';
select is(public.home_flow(), null, 'without a user there is no payload');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table a as select public.home_flow() as p;

select set_eq($$ select jsonb_object_keys(p) from a $$,
  array['matched', 'delivered', 'sources', 'subscriptions', 'links', 'subscription_sources'], 'payload keys');
select is((select (p ->> 'matched')::int from a), 3, 'matched counts distinct spots created in the last 24 hours');
select is((select (p ->> 'delivered')::int from a), 4, 'delivered counts rows sent in the last 24 hours, one per destination');
select is((select p -> 'sources' from a),
  '[{"source": "dxcluster", "matched": 1}, {"source": "pota", "matched": 2}]'::jsonb,
  'sources: distinct matched spots per spot source');
select set_eq(
  $$ select (e ->> 'subscription_id')::uuid, e ->> 'source', (e ->> 'matched')::int from a, jsonb_array_elements(p -> 'subscriptions') e $$,
  $$ values ((select parks from subs), 'pota', 2), ((select dx from subs), 'dxcluster', 1) $$,
  'subscriptions: matched per connection and spot source; a connection without a destination has no row');
select set_eq(
  $$ select (e ->> 'subscription_id')::uuid as sub, (e ->> 'destination_id')::uuid as dest, (e ->> 'delivered')::int from a, jsonb_array_elements(p -> 'links') e $$,
  $$ values ((select parks from subs), (select id from dc), 1), ((select parks from subs), (select id from dw), 2),
            ((select dx from subs), (select id from dw), 1) $$,
  'links: delivered per connection and destination');
select set_eq(
  $$ select (e ->> 'subscription_id')::uuid, e ->> 'source' from a, jsonb_array_elements(p -> 'subscription_sources') e $$,
  $$ select x.id, x.source from (values
       ((select parks from subs), 'pota'),
       ((select dx from subs), 'dxcluster'),
       ((select nowhere from subs), 'pota'), ((select nowhere from subs), 'sotawatch'),
       ((select anycall from subs), 'pota'), ((select anycall from subs), 'sotawatch'), ((select anycall from subs), 'rbn'),
       ((select either from subs), 'pota'), ((select either from subs), 'sotawatch'), ((select either from subs), 'rbn')
     ) x(id, source)
     union all
     select (select everything from subs), unnest(array['pota', 'sotawatch', 'wwff', 'wwbota', 'rbn', 'dxcluster']) $$,
  'subscription_sources: every connection, traffic or not, with the sources the matcher lets through');
select ok(not exists (
    select 1 from a, jsonb_array_elements(p -> 'subscription_sources') e
    where (e ->> 'subscription_id')::uuid = (select id from bsub)),
  'subscription_sources holds only the caller''s connections');
reset role;

select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select is(public.home_flow(),
  jsonb_build_object('matched', 1, 'delivered', 1,
    'sources', '[{"source": "pota", "matched": 1}]'::jsonb,
    'subscriptions', jsonb_build_array(jsonb_build_object('subscription_id', (select id from bsub), 'source', 'pota', 'matched', 1)),
    'links', jsonb_build_array(jsonb_build_object('subscription_id', (select id from bsub), 'destination_id', (select id from dp), 'delivered', 1)),
    'subscription_sources', jsonb_build_array(
      jsonb_build_object('subscription_id', (select id from bsub), 'source', 'pota'),
      jsonb_build_object('subscription_id', (select id from bsub), 'source', 'sotawatch'))),
  'another user sees only their own deliveries');
reset role;

-- No deliveries at all: zeros and empty lists, not nulls.
delete from deliveries where destination_id in (select id from dp);
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select is(public.home_flow() - 'subscription_sources',
  '{"matched": 0, "delivered": 0, "sources": [], "subscriptions": [], "links": []}'::jsonb,
  'an account with nothing in 24 hours gets zeros and empty lists');
reset role;

select * from finish();
rollback;

-- pgTAP: RBN as a source (0011 rbn_source): the source checks, the ingest_state
-- row, the watchlist (watched_among), the matcher guard and the RBN-needs-a-callsign rule.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(17);

select pgmq.purge_queue('spot_events');
select pgmq.purge_queue('deliveries_queue');

select ok(exists (select 1 from ingest_state where source = 'rbn'), 'ingest_state has an rbn row');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table d as select * from create_destination('webhook', 'Hook', 'https://hooks.example.com/a');
create temp table subs as
select save_subscription(jsonb_build_object('name','Me on RBN','sources',array['rbn'],'callsigns',array['kk4pwj'],'quiet_minutes',0,'destinations',array[(select id from d)])) as mine,
       save_subscription(jsonb_build_object('name','Anything on 20m CW','bands',array['20m'],'modes',array['cw'],'quiet_minutes',0,'destinations',array[(select id from d)])) as any_source,
       save_subscription(jsonb_build_object('name','W1AW anywhere','callsigns',array['W1AW'],'quiet_minutes',0,'destinations',array[(select id from d)])) as any_source_call,
       save_subscription(jsonb_build_object('name','POTA only','sources',array['pota'],'callsigns',array['N4DXX'],'quiet_minutes',0,'destinations',array[(select id from d)])) as pota_only,
       save_subscription(jsonb_build_object('name','Paused','sources',array['rbn'],'callsigns',array['K9OFF'],'enabled',false,'quiet_minutes',0,'destinations',array[(select id from d)])) as paused;

select throws_ok(
  format($$select save_subscription(jsonb_build_object('name','Bad','sources',array['rbn'],'destinations',array[%L]))$$, (select id from d)),
  'P0001', 'RBN reports stations by callsign. Add at least one callsign.',
  'an RBN-only subscription needs a callsign');
select lives_ok(
  format($$select save_subscription(jsonb_build_object('name','Mixed','sources',array['rbn','pota'],'destinations',array[%L]))$$, (select id from d)),
  'RBN alongside another source may leave callsigns empty');
select throws_ok($$select watched_among('rbn', array['KK4PWJ'])$$, '42501', null,
  'authenticated users cannot call watched_among');
reset role;

select is(
  array(select watched_among('rbn', array['W1AW', 'KK4PWJ', 'N4DXX', 'K9OFF', 'KK4PWJ'])),
  array['KK4PWJ', 'W1AW'],
  'watchlist: stations named by enabled subscriptions that accept rbn, distinct and sorted');
select is(array(select watched_among('pota', array['KK4PWJ', 'W1AW', 'N4DXX'])), array['N4DXX', 'W1AW'],
  'the watchlist follows each subscription''s sources');

select ok(has_function_privilege('service_role', 'public.watched_among(text, text[])', 'execute'), 'service_role may call watched_among');
select ok(not has_function_privilege('anon', 'public.watched_among(text, text[])', 'execute'), 'anon may not call watched_among');
select ok(not has_function_privilege('authenticated', 'public.watched_among(text, text[])', 'execute'), 'authenticated may not call watched_among');

-- Matcher: an RBN spot reaches only subscriptions that name callsigns.
select is((select count(*) from ingest_spots(jsonb_build_array(
  jsonb_build_object('source','rbn','source_spot_id','r1','content_hash','h1','spot_time',now(),'callsign','KK4PWJ','spotter','W3LPL','frequency_khz',14035.1,'band','20m','mode','cw','mode_family','cw','comment','12 dB 22 WPM CQ','raw_payload','{}'::jsonb),
  jsonb_build_object('source','rbn','source_spot_id','r2','content_hash','h2','spot_time',now(),'callsign','W1AW','spotter','W3LPL','frequency_khz',14040,'band','20m','mode','cw','mode_family','cw','comment','20 dB 18 WPM CQ','raw_payload','{}'::jsonb)
))), 2::bigint, 'ingest_spots accepts rbn rows');

select match_pending_spots();
select is((select count(*) from deliveries where subscription_id = (select mine from subs)), 1::bigint, 'the RBN subscription gets its own callsign');
select is((select count(*) from deliveries where subscription_id = (select any_source_call from subs)), 1::bigint, 'an any-source subscription naming W1AW gets W1AW');
select is((select count(*) from deliveries where subscription_id = (select any_source from subs)), 0::bigint, 'an any-source subscription without callsigns gets no RBN spots');
select is((select count(*) from deliveries where subscription_id = (select pota_only from subs)), 0::bigint, 'a POTA-only subscription gets no RBN spots');

-- Same guard through the predicate directly, and non-RBN spots are unaffected.
select ok(not spot_matches(
  (select s from subscriptions s where s.id = (select any_source from subs)),
  (select r from raw_spots r where r.source_spot_id = 'r1')), 'spot_matches: rbn spot vs subscription without callsigns');
select ok(spot_matches(
  (select s from subscriptions s where s.id = (select any_source from subs)),
  (0, 'pota', 'x', 'x', now(), now(), 'N4DXX', null, 14062, '20m', 'cw', '', null, null, null, null, '{}'::jsonb, 'cw', 'N4DXX')::raw_spots),
  'spot_matches: other sources still match without callsigns');

select throws_ok(
  $$insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, frequency_khz, comment, raw_payload)
    values ('dxcluster', 'x', 'x', now(), 'W1AW', 14000, '', '{}')$$,
  '23514', null, 'raw_spots still rejects unknown sources');

select * from finish();
rollback;

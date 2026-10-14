-- pgTAP: spot_matches predicate, match_pending_spots, quiet window,
-- cross-subscription dedup, preview_subscription, callsign groups.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(50);

-- Drain anything already queued so counts below are exact.
select pgmq.purge_queue('spot_events');
select pgmq.purge_queue('deliveries_queue');

-- Start from empty tables so the counts below are exact: supabase/seed.sql fills
-- them on a local reset and on preview branches. The test rolls back, so the
-- seed data survives. deliveries references raw_spots without cascade.
delete from deliveries;
delete from raw_spots;

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table da as select * from create_destination('discord', 'A discord', 'https://discord.com/api/webhooks/1/a');
create temp table db as select * from create_destination('webhook', 'A hook', 'https://hooks.example.com/a');
reset role;

-- Helper to build a subscription row for predicate tests without inserting.
create or replace function pg_temp.sub(p_sources text[], p_bands text[], p_modes text[], p_calls text[], p_ref text)
returns subscriptions language sql as $$
  select (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 'x', true, p_sources, p_bands, p_modes, p_calls, p_ref, 0, now(), now(), '{}'::uuid[])::subscriptions;
$$;
create or replace function pg_temp.spot(p_source text, p_call text, p_band text, p_mode text, p_ref text, p_loc text, p_summit text, p_family text default null)
returns raw_spots language sql as $$
  select (0, p_source, 'x', 'x', now(), now(), p_call, null, 14062, p_band, p_mode, '', p_ref, null, p_loc, p_summit, '{}'::jsonb, p_family, public.base_callsign(p_call))::raw_spots;
$$;

-- spot_matches rules.
select ok(spot_matches(pg_temp.sub('{}','{}','{}','{}',''), pg_temp.spot('pota','KK4PWJ','20m','cw','US-2763','US-NC',null)), 'empty filters match anything');
select ok(spot_matches(pg_temp.sub('{pota}','{}','{}','{}',''), pg_temp.spot('pota','KK4PWJ','20m','cw','US-2763','US-NC',null)), 'source matches');
select ok(not spot_matches(pg_temp.sub('{sotawatch}','{}','{}','{}',''), pg_temp.spot('pota','KK4PWJ','20m','cw','US-2763','US-NC',null)), 'source mismatch');
select ok(spot_matches(pg_temp.sub('{}','{20m,40m}','{}','{}',''), pg_temp.spot('pota','KK4PWJ','20m','cw',null,null,null)), 'band matches');
select ok(not spot_matches(pg_temp.sub('{}','{40m}','{}','{}',''), pg_temp.spot('pota','KK4PWJ','20m','cw',null,null,null)), 'band mismatch');
select ok(not spot_matches(pg_temp.sub('{}','{20m}','{}','{}',''), pg_temp.spot('pota','KK4PWJ',null,'cw',null,null,null)), 'null band never matches a band filter');
select ok(spot_matches(pg_temp.sub('{}','{}','{cw}','{}',''), pg_temp.spot('pota','KK4PWJ','20m','cw',null,null,null)), 'mode matches');
select ok(not spot_matches(pg_temp.sub('{}','{}','{ssb}','{}',''), pg_temp.spot('pota','KK4PWJ','20m','cw',null,null,null)), 'mode mismatch');
select ok(spot_matches(pg_temp.sub('{}','{}','{digital}','{}',''), pg_temp.spot('pota','KK4PWJ','20m','ft8',null,null,null,'digital')), 'family filter matches a specific digital mode');
select ok(spot_matches(pg_temp.sub('{}','{}','{digital}','{}',''), pg_temp.spot('sotawatch','W7JZ','20m','data',null,null,null,'digital')), 'family filter matches SOTAwatch DATA');
select ok(not spot_matches(pg_temp.sub('{}','{}','{ft8}','{}',''), pg_temp.spot('sotawatch','W7JZ','20m','data',null,null,null,'digital')), 'specific mode filter does not match generic DATA');
select ok(not spot_matches(pg_temp.sub('{}','{}','{cw}','{}',''), pg_temp.spot('pota','KK4PWJ','20m',null,null,null,null)), 'null mode never matches a mode filter');
select ok(spot_matches(pg_temp.sub('{}','{}','{}','{KK4PWJ}',''), pg_temp.spot('pota','KK4PWJ','20m','cw',null,null,null)), 'callsign exact match');
select ok(spot_matches(pg_temp.sub('{}','{}','{}','{KK4PWJ}',''), pg_temp.spot('pota','KK4PWJ/P','20m','cw',null,null,null)), 'a base-call subscription matches a portable spot');
select ok(spot_matches(pg_temp.sub('{}','{}','{}','{G4OBK}',''), pg_temp.spot('sotawatch','W4/G4OBK','20m','cw',null,null,null)), 'a base-call subscription matches a prefixed spot');
select ok(not spot_matches(pg_temp.sub('{}','{}','{}','{KK4PWJ/P}',''), pg_temp.spot('pota','KK4PWJ','20m','cw',null,null,null)), 'a /P subscription does not match the home call');
select ok(not spot_matches(pg_temp.sub('{}','{}','{}','{KK4PW}',''), pg_temp.spot('pota','KK4PWJ','20m','cw',null,null,null)), 'callsign is not a prefix match');
select ok(spot_matches(pg_temp.sub('{}','{}','{}','{}','us-nc'), pg_temp.spot('pota','KK4PWJ','20m','cw','US-2763','US-NC,US-VA',null)), 'reference matches location, case-insensitive');
select ok(spot_matches(pg_temp.sub('{}','{}','{}','{}','W4C/'), pg_temp.spot('sotawatch','W4/G4OBK','20m','ssb',null,null,'W4C/CM-001')), 'reference matches summit code');
select ok(not spot_matches(pg_temp.sub('{}','{}','{}','{}','W4C/'), pg_temp.spot('pota','KK4PWJ','20m','cw','US-2763','US-NC',null)), 'reference mismatch');

-- match_pending_spots end to end.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table subs as
select save_subscription(jsonb_build_object('name','NC parks','sources',array['pota'],'reference','US-NC','quiet_minutes',10,'destinations',array[(select id from da)])) as nc,
       save_subscription(jsonb_build_object('name','CW anywhere','modes',array['cw'],'quiet_minutes',0,'destinations',array[(select id from da),(select id from db)])) as cw,
       save_subscription(jsonb_build_object('name','Paused','quiet_minutes',0,'enabled',false,'destinations',array[(select id from db)])) as paused;

reset role;

-- Four spots in one batch. KK4PWJ appears twice so the quiet window applies.
select count(*) from ingest_spots(jsonb_build_array(
  jsonb_build_object('source','pota','source_spot_id','s1','content_hash','h1','spot_time',now() - interval '4 minutes','callsign','KK4PWJ','frequency_khz',14062,'band','20m','mode','cw','comment','','pota_reference','US-2763','pota_location','US-NC','raw_payload','{}'::jsonb),
  jsonb_build_object('source','pota','source_spot_id','s2','content_hash','h2','spot_time',now() - interval '3 minutes','callsign','N4DXX','frequency_khz',7185,'band','40m','mode','ssb','comment','','pota_reference','US-0817','pota_location','US-NC','raw_payload','{}'::jsonb),
  jsonb_build_object('source','sotawatch','source_spot_id','s3','content_hash','h3','spot_time',now() - interval '2 minutes','callsign','W7JZ','frequency_khz',7032,'band','40m','mode','cw','comment','','sota_summit_ref','W7A/MN-010','raw_payload','{}'::jsonb),
  jsonb_build_object('source','pota','source_spot_id','s4','content_hash','h4','spot_time',now() - interval '1 minute','callsign','KK4PWJ','frequency_khz',14062,'band','20m','mode','cw','comment','','pota_reference','US-2763','pota_location','US-NC','raw_payload','{}'::jsonb)
));

select is(match_pending_spots(), 7, 'first batch creates 7 deliveries (quiet window and shared-destination dedup applied)');
select is((select count(*) from deliveries), 7::bigint, 'deliveries table has 7 rows');
select is((select count(*) from deliveries where destination_id = (select id from da)), 4::bigint, 'discord destination gets s1, s2, s3, s4');
select is((select count(*) from deliveries where destination_id = (select id from db)), 3::bigint, 'webhook destination gets s1, s3, s4');
select is((select count(*) from deliveries where subscription_id = (select paused from subs)), 0::bigint, 'disabled subscription creates nothing');
select is((select queue_length from pgmq.metrics('deliveries_queue')), 7::bigint, 'one queue message per delivery');
select is((select queue_length from pgmq.metrics('spot_events')), 0::bigint, 'processed spot_events are archived');
select ok(exists (select 1 from subscription_quiet where subscription_id = (select nc from subs) and callsign = 'KK4PWJ'), 'quiet window recorded for the 10-minute subscription');
select ok(not exists (select 1 from subscription_quiet where subscription_id = (select cw from subs)), 'no quiet rows for a subscription that sends every spot');

-- Inside the window: the 10-minute subscription stays quiet, the other sends.
select count(*) from ingest_spots(jsonb_build_array(
  jsonb_build_object('source','pota','source_spot_id','s5','content_hash','h5','spot_time',now(),'callsign','KK4PWJ','frequency_khz',14062,'band','20m','mode','cw','comment','','pota_reference','US-2763','pota_location','US-NC','raw_payload','{}'::jsonb)));
select is(match_pending_spots(), 2, 'inside the quiet window only the always-send subscription delivers');

-- After the window passes, the quiet subscription sends again.
update subscription_quiet set last_sent_at = now() - interval '11 minutes';
select count(*) from ingest_spots(jsonb_build_array(
  jsonb_build_object('source','pota','source_spot_id','s6','content_hash','h6','spot_time',now(),'callsign','KK4PWJ','frequency_khz',14062,'band','20m','mode','cw','comment','','pota_reference','US-2763','pota_location','US-NC','raw_payload','{}'::jsonb)));
select is(match_pending_spots(), 2, 'after the window both subscriptions match, deduped per destination');

-- Preview uses the same predicate over recent spots.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is((select count from preview_subscription('{"sources":["pota"],"reference":"us-nc"}')), 5::bigint, 'preview counts matching recent spots');
select is((select jsonb_array_length(spots) from preview_subscription('{"sources":["pota"],"reference":"us-nc"}')), 5, 'preview returns the matching spots');
select is((select window_size from preview_subscription('{"sources":["pota"]}')), 5::bigint, 'preview samples only the filter''s sources');
select is((select window_size from preview_subscription('{"sources":["sotawatch"]}')), 1::bigint, 'a SOTA preview is not sampled from POTA spots');
select is((select window_size from preview_subscription('{}')), 6::bigint, 'no sources samples every recent spot');

-- Callsign groups. Members are base calls; groups merge without duplicates, an
-- empty group matches nothing, and preview ignores another user's groups.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table dg as select * from create_destination('webhook', 'Groups hook', 'https://hooks.example.com/g');
create temp table grp as
select save_callsign_group('{"name":"Club","callsigns":["KK4PWJ","N4GRP"]}') as club,
       save_callsign_group('{"name":"Friends","callsigns":["N4GRP","K4MIX"]}') as friends,
       save_callsign_group('{"name":"Empty","callsigns":[]}') as empty;
reset role;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
create temp table other_grp as select save_callsign_group('{"name":"Other","callsigns":["W9OTH"]}') as id;
reset role;

create or replace function pg_temp.gsub(p_calls text[], p_groups uuid[], p_sources text[] default '{}')
returns subscriptions language sql as $$
  select (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 'x', true, p_sources, '{}'::text[], '{}'::text[], p_calls, '', 0, now(), now(), p_groups)::subscriptions;
$$;

select ok(spot_matches(pg_temp.gsub('{}', array[(select club from grp)]), pg_temp.spot('pota','N4GRP','20m','ssb',null,null,null)), 'a group member matches');
select ok(spot_matches(pg_temp.gsub('{}', array[(select club from grp)]), pg_temp.spot('pota','KK4PWJ/P','20m','ssb',null,null,null)), 'a KK4PWJ/P spot matches a KK4PWJ member');
select ok(not spot_matches(pg_temp.gsub('{}', array[(select club from grp)]), pg_temp.spot('pota','W1AW','20m','ssb',null,null,null)), 'a non-member does not match');
select ok(not spot_matches(pg_temp.gsub('{}', array[(select empty from grp)]), pg_temp.spot('pota','W1AW','20m','ssb',null,null,null)), 'an empty group with no typed calls matches nothing');
select ok(spot_matches(pg_temp.gsub('{W1AW}', array[(select club from grp)]), pg_temp.spot('pota','W1AW','20m','ssb',null,null,null))
          and spot_matches(pg_temp.gsub('{W1AW}', array[(select club from grp)]), pg_temp.spot('pota','N4GRP','20m','ssb',null,null,null))
          and not spot_matches(pg_temp.gsub('{W1AW}', array[(select club from grp)]), pg_temp.spot('pota','N0NE','20m','ssb',null,null,null)),
  'typed calls and groups together match their union');
select ok(spot_matches(pg_temp.gsub('{}', array[(select club from grp)], '{rbn}'), pg_temp.spot('rbn','N4GRP','20m','cw',null,null,null,'cw')),
  'an RBN spot matches a subscription that names its station through a group');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table gsubs as
select save_subscription(jsonb_build_object('name','Two groups','sources',array['pota'],'quiet_minutes',0,
         'group_ids',array[(select club from grp),(select friends from grp)],'destinations',array[(select id from dg)])) as two,
       save_subscription(jsonb_build_object('name','Empty group','sources',array['pota'],'quiet_minutes',0,
         'group_ids',array[(select empty from grp)],'destinations',array[(select id from dg)])) as empty;
reset role;

select count(*) from ingest_spots(jsonb_build_array(
  jsonb_build_object('source','pota','source_spot_id','g1','content_hash','g1','spot_time',now(),'callsign','N4GRP','frequency_khz',18140,'band','17m','mode','ssb','comment','','raw_payload','{}'::jsonb),
  jsonb_build_object('source','pota','source_spot_id','g2','content_hash','g2','spot_time',now(),'callsign','KK4PWJ/P','frequency_khz',18140,'band','17m','mode','ssb','comment','','raw_payload','{}'::jsonb),
  jsonb_build_object('source','pota','source_spot_id','g3','content_hash','g3','spot_time',now(),'callsign','W9OTH','frequency_khz',18140,'band','17m','mode','ssb','comment','','raw_payload','{}'::jsonb)));
select match_pending_spots();
select is((select array_agg(r.callsign order by r.callsign) from deliveries d join raw_spots r on r.id = d.spot_id
           where d.subscription_id = (select two from gsubs)), array['KK4PWJ/P', 'N4GRP'],
  'two groups merge: N4GRP, in both, is delivered once, and KK4PWJ/P comes through the KK4PWJ member');
select is((select count(*) from raw_spots r join subscriptions s on s.id = (select two from gsubs) and spot_matches(s, r)
           where r.source_spot_id = 'g1'), 1::bigint, 'a call in two groups gives the matcher one candidate row');
select is((select count(*) from deliveries where subscription_id = (select empty from gsubs)), 0::bigint,
  'a subscription whose only group is empty gets nothing');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is((select array(select distinct x ->> 'callsign' from jsonb_array_elements(p.spots) x order by 1)
           from preview_subscription(jsonb_build_object('group_ids', array[(select club from grp), (select friends from grp)])) p),
  array['KK4PWJ', 'KK4PWJ/P', 'N4GRP'], 'preview matches through groups');
select is((select array(select distinct x ->> 'callsign' from jsonb_array_elements(p.spots) x order by 1)
           from preview_subscription(jsonb_build_object('callsigns', array['N4DXX'], 'group_ids', array[(select id from other_grp)])) p),
  array['N4DXX'], 'preview ignores another user''s group id');
select is((select station_count from preview_subscription(jsonb_build_object('callsigns', array['KK4PWJ/P', 'w1aw'],
             'group_ids', array[(select club from grp), (select friends from grp), (select id from other_grp)]))),
  4::bigint, 'station_count: distinct base calls across typed calls and own groups, not another user''s');
select is((select station_count from preview_subscription('{}')), 0::bigint, 'station_count is 0 with no calls or groups');
select is((select station_count from preview_subscription('{"group_ids":["not-a-uuid"]}')), 0::bigint,
  'a malformed group id is ignored like another user''s');
reset role;

select * from finish();
rollback;

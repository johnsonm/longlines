-- pgTAP: IOTA as a tag on DX Cluster spots (20261027001000): the island list and its
-- load, the cron job, the name looked up at ingest, the island rule (validation and
-- matching), the reference rule, rendering, the read models, spot_stream and the archive.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(33);

select pgmq.purge_queue('spot_events');
select pgmq.purge_queue('deliveries_queue');

-- The list: service-role only.
select ok((select relrowsecurity from pg_class where oid = 'iota_groups'::regclass)
          and (select relrowsecurity from pg_class where oid = 'iota_load'::regclass), 'RLS is on for the list and its load');
select ok(not has_table_privilege('authenticated', 'iota_groups', 'select')
          and not has_table_privilege('anon', 'iota_groups', 'select'), 'clients cannot read the list');
select ok(not has_function_privilege('authenticated', 'load_iota_groups(jsonb)', 'execute'),
  'clients cannot load the list');
select ok(exists (select 1 from cron.job where jobname = 'import-iota' and schedule = '25 4 1 * *'
                  and command like '%cron_call_function(''import-iota'', ''import-iota''%'),
  'import-iota runs monthly through cron_call_function');

select is(load_iota_groups('[{"refno":"EU-001","name":"Old"}]'), 1, 'a load returns how many groups it stored');
select is(load_iota_groups('[{"refno":"EU-005","name":"Great Britain"},{"refno":"AN-010","name":"South Shetland Islands"},
                             {"refno":"NA-112","name":"Some Island Group"}]'), 3, 'a second load replaces the first');
select is((select array_agg(refno order by refno) from iota_groups), array['AN-010', 'EU-005', 'NA-112'], 'only the new list is left');
select is((select groups from iota_load), 3, 'the load is recorded');
select throws_ok($$ select load_iota_groups('[{"refno":"EU-5","name":"Bad"}]') $$, '23514', null,
  'a malformed reference is refused');
select is((select count(*) from iota_groups), 3::bigint, 'and the list stays as it was');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table d as select * from create_destination('webhook', 'Hook', 'https://hooks.example.com/a');
create temp table d2 as select * from create_destination('webhook', 'Hook 2', 'https://hooks.example.com/b');
create temp table d3 as select * from create_destination('webhook', 'Hook 3', 'https://hooks.example.com/c');
create temp table d4 as select * from create_destination('webhook', 'Hook 4', 'https://hooks.example.com/d');
create temp table d5 as select * from create_destination('webhook', 'Hook 5', 'https://hooks.example.com/e');
create temp table subs as
select save_subscription(jsonb_build_object('name','European islands','sources',array['dxcluster'],'rules','[[{"field":"island","op":"is","values":["eu"]}]]'::jsonb,'quiet_minutes',0,'destinations',array[(select id from d)])) as europe,
       save_subscription(jsonb_build_object('name','Arctowski','sources',array['dxcluster'],'rules','[[{"field":"island","op":"is","values":["AN-010"]}]]'::jsonb,'quiet_minutes',0,'destinations',array[(select id from d2)])) as one_island,
       save_subscription(jsonb_build_object('name','Not Europe','sources',array['dxcluster'],'rules','[[{"field":"island","op":"is_not","values":["EU"]}]]'::jsonb,'quiet_minutes',0,'destinations',array[(select id from d3)])) as not_europe,
       save_subscription(jsonb_build_object('name','Any source','rules','[[{"field":"island","op":"is","values":["EU"]}]]'::jsonb,'quiet_minutes',0,'destinations',array[(select id from d4)])) as any_source,
       save_subscription(jsonb_build_object('name','By reference','sources',array['dxcluster'],'rules','[[{"field":"reference","op":"contains","values":["an-010"]}]]'::jsonb,'quiet_minutes',0,'destinations',array[(select id from d5)])) as by_reference;
reset role;

select is((select rules from subscriptions where id = (select europe from subs)), '[[{"op": "is", "field": "island", "values": ["EU"]}]]'::jsonb,
  'island values are stored uppercase');
select throws_ok($$ select normalize_subscription_rules('[[{"field":"island","op":"is","values":["EU5"]}]]', null, false) $$,
  'P0001', 'An IOTA island rule takes references such as EU-005 or continents such as EU.', 'an island value must be a reference or a continent');
select throws_ok($$ select normalize_subscription_rules('[[{"field":"island","op":"contains","values":["EU"]}]]', null, false) $$,
  'P0001', 'An IOTA island rule can''t use contains.', 'the island rule takes is and is_not only');
select throws_ok($$ select normalize_subscription_rules('[[{"field":"island","op":"is","values":[" "]}]]', null, false) $$,
  'P0001', 'Give the IOTA island rule a value.', 'and needs a value');
select throws_ok($$ select normalize_subscription_rules('[[{"field":"band","op":"contains","values":["20m"]}]]', null, false) $$,
  'P0001', 'A band rule can''t use contains.', 'the other fields keep their messages');

select is((select count(*) from ingest_spots(jsonb_build_array(
  jsonb_build_object('source','dxcluster','source_spot_id','x1','content_hash','h1','spot_time',now(),'callsign','HF0POL','spotter','K1ABC','frequency_khz',14025,'band','20m','mode','cw','mode_family','cw','comment','CQ from Arctowski (AN-010)-UP','iota_reference','AN-010','raw_payload','{}'::jsonb),
  jsonb_build_object('source','dxcluster','source_spot_id','x2','content_hash','h2','spot_time',now(),'callsign','GB2XX','spotter','K1ABC','frequency_khz',14260,'band','20m','mode','ssb','mode_family','phone','comment','IOTA EU-005','iota_reference','EU-005','raw_payload','{}'::jsonb),
  jsonb_build_object('source','dxcluster','source_spot_id','x3','content_hash','h3','spot_time',now(),'callsign','JA1ABC','spotter','K1ABC','frequency_khz',21074,'band','15m','mode','ft8','mode_family','digital','comment','up 2','raw_payload','{}'::jsonb),
  jsonb_build_object('source','dxcluster','source_spot_id','x4','content_hash','h4','spot_time',now(),'callsign','OH0XX','spotter','K1ABC','frequency_khz',7025,'band','40m','mode','cw','mode_family','cw','comment','EU-999','iota_reference','EU-999','raw_payload','{}'::jsonb)
))), 4::bigint, 'ingest_spots accepts island spots');
select is((select iota_reference || ' ' || iota_reference_name from raw_spots where content_hash = 'h1'), 'AN-010 South Shetland Islands',
  'ingest_spots names the island from the list');
select is((select iota_reference_name from raw_spots where content_hash = 'h4'), null, 'a reference the list lacks has no name');
select is((select iota_reference from raw_spots where content_hash = 'h3'), null, 'a spot that names no island has no reference');

select match_pending_spots();
create temp table got as
select s.name, array_agg(r.content_hash order by r.content_hash) as hashes
from deliveries d join raw_spots r on r.id = d.spot_id join subscriptions s on s.id = d.subscription_id
group by s.name;
select is((select hashes from got where name = 'European islands'), array['h2', 'h4'], 'island is EU takes every European island');
select is((select hashes from got where name = 'Arctowski'), array['h1'], 'island is AN-010 takes that island only');
select is((select hashes from got where name = 'Not Europe'), array['h1', 'h3'], 'island is_not EU takes the rest, spots without an island included');
select is((select hashes from got where name = 'Any source'), null, 'an any-source connection never gets DX Cluster spots');
select is((select hashes from got where name = 'By reference'), array['h1'], 'the reference rule finds the island too');

-- A new destination's token bucket starts empty (20261015000400); a minute ago fills it.
update destinations set claim_tokens = 0, claim_tokens_at = now() - interval '1 minute';
select is((select spot ->> 'iota_reference_name' from claim_deliveries() where subscription_id = (select one_island from subs)),
  'South Shetland Islands', 'claim_deliveries puts the island in the spot');

-- Rendering, shared by push, Discord and webhooks.
create temp table h1 as select delivery_spot_json(r) as j from raw_spots r where r.content_hash = 'h1';
select is(render_push_field('reference', (select j from h1)), 'AN-010', 'reference: the IOTA reference');
select is(render_push_field('place_name', (select j from h1)), 'South Shetland Islands', 'place name: the island');
select is(webhook_field_value('place_name', (select j from h1), 'iso_utc', 'khz'), '"South Shetland Islands"'::jsonb,
  'the webhook place name is the same text');

-- Read models.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is((select array_agg(callsign order by callsign) from list_recent_spots('iota', 50) where spot_time > now() - interval '1 minute'),
  array['GB2XX', 'HF0POL', 'OH0XX'], 'list_recent_spots(iota) returns the DX Cluster spots that name an island');
select is((select count(*) from list_recent_spots('rbn', 10) where iota_reference is not null), 0::bigint,
  'the RBN branch of list_recent_spots still lines up with recent_spots');
select is((select spots -> 0 ->> 'iota_reference'
           from preview_subscription('{"sources":["dxcluster"],"rules":[[{"field":"island","op":"is","values":["AN-010"]}]]}'::jsonb)),
          'AN-010', 'preview_subscription matches and shows the island');
reset role;

select is((select program || ' ' || reference || ' ' || reference_name from spot_stream where callsign = 'HF0POL'),
  'IOTA AN-010 South Shetland Islands', 'spot_stream names the IOTA program, reference and island');

select is((select (columns -> 'iota_reference')::jsonb from archive_columns('dxcluster', now() - interval '1 minute', now() + interval '1 minute')),
  '["AN-010", "EU-005", null, "EU-999"]'::jsonb, 'archive_columns carries the IOTA reference');

select * from finish();
rollback;

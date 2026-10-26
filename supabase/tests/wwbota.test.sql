-- pgTAP: WWBOTA as a source (20261026000100): the source checks, the
-- ingest_state row and cron job, every bunker through ingest, opt-in
-- matching, the reference rule on a later bunker of an n-fer, rendering, the
-- read models and spot_stream, and hourly archiving from raw_spots.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(28);

select pgmq.purge_queue('spot_events');
select pgmq.purge_queue('deliveries_queue');

select ok(exists (select 1 from ingest_state where source = 'wwbota'), 'ingest_state has a wwbota row');
select ok(exists (select 1 from cron.job where jobname = 'ingest-wwbota' and schedule = '* * * * *'
                  and command like '%cron_call_function(''ingest-wwbota'', ''ingest-wwbota''%'),
  'ingest-wwbota runs every minute through cron_call_function');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table d as select * from create_destination('webhook', 'Hook', 'https://hooks.example.com/a');
create temp table d2 as select * from create_destination('webhook', 'Hook 2', 'https://hooks.example.com/b');
create temp table d3 as select * from create_destination('webhook', 'Hook 3', 'https://hooks.example.com/c');
create temp table subs as
select save_subscription(jsonb_build_object('name','WWBOTA on 40m','sources',array['wwbota'],'rules','[[{"field":"band","op":"is","values":["40m"]}]]'::jsonb,'quiet_minutes',0,'destinations',array[(select id from d)])) as wwbota_only,
       save_subscription(jsonb_build_object('name','Anything on 40m','rules','[[{"field":"band","op":"is","values":["40m"]}]]'::jsonb,'quiet_minutes',0,'destinations',array[(select id from d)])) as any_source,
       save_subscription(jsonb_build_object('name','One Spanish bunker','sources',array['pota','wwbota'],'rules','[[{"field":"reference","op":"contains","values":["b/ea-0105"]}]]'::jsonb,'quiet_minutes',0,'destinations',array[(select id from d2)])) as by_reference,
       save_subscription(jsonb_build_object('name','Not UK','sources',array['wwbota'],'rules','[[{"field":"reference","op":"not_contains","values":["B/G-"]}]]'::jsonb,'quiet_minutes',0,'destinations',array[(select id from d3)])) as not_uk;
reset role;

select is((select count(*) from ingest_spots(jsonb_build_array(
  jsonb_build_object('source','wwbota','source_spot_id','2026-10-26T17:23:08.479344Z','content_hash','h1','spot_time',now(),'callsign','EA4IYL','spotter','EA4IYL','frequency_khz',7138,'band','40m','mode','ssb','mode_family','phone','comment','B/EA-0105,0104,0103','wwbota_references',jsonb_build_array('B/EA-0103','B/EA-0104','B/EA-0105'),'wwbota_reference_name','Búnker 1','raw_payload','{}'::jsonb),
  jsonb_build_object('source','wwbota','source_spot_id','2026-10-26T18:52:16.952139Z','content_hash','h2','spot_time',now(),'callsign','G0KAO','spotter','G0KAO','frequency_khz',3537,'band','80m','mode','ft8','mode_family','digital','comment','B/G-2386','wwbota_references',jsonb_build_array('B/G-2386'),'wwbota_reference_name','Horbury','raw_payload','{}'::jsonb),
  jsonb_build_object('source','pota','source_spot_id','p1','content_hash','h3','spot_time',now(),'callsign','N4DXX','spotter','W1AW','frequency_khz',7062,'band','40m','mode','cw','mode_family','cw','comment','','pota_reference','US-0001','raw_payload','{}'::jsonb)
))), 3::bigint, 'ingest_spots accepts wwbota rows');
select is((select wwbota_references from raw_spots where content_hash = 'h1'), array['B/EA-0103', 'B/EA-0104', 'B/EA-0105'],
  'ingest_spots stores every bunker in order');
select is((select wwbota_reference_name from raw_spots where content_hash = 'h1'), 'Búnker 1', 'and the first bunker''s name');
select is((select wwbota_references from raw_spots where content_hash = 'h3'), null, 'a POTA spot has no WWBOTA references');

select match_pending_spots();
select is((select count(*) from deliveries where subscription_id = (select wwbota_only from subs)), 1::bigint,
  'a connection listing wwbota gets the WWBOTA spot on its band');
select is((select r.content_hash from deliveries d join raw_spots r on r.id = d.spot_id
           where d.subscription_id = (select any_source from subs)), 'h3',
  'an any-source connection gets the POTA spot only, not the WWBOTA spot');
select is((select r.content_hash from deliveries d join raw_spots r on r.id = d.spot_id
           where d.subscription_id = (select by_reference from subs)), 'h1',
  'the reference rule matches the third bunker of an n-fer, ignoring case');
select is((select r.content_hash from deliveries d join raw_spots r on r.id = d.spot_id
           where d.subscription_id = (select not_uk from subs)), 'h1',
  'a negative reference rule leaves out the UK bunker');

select ok(not source_matches('{}', 'wwbota'), 'source_matches: empty sources leave out wwbota');
select ok(source_matches('{wwbota}', 'wwbota'), 'source_matches: sources {wwbota} take wwbota');
select is(normalize_subscription_sources('["WWBOTA"]'), array['wwbota'], 'a connection may pick wwbota');

-- The delivered spot carries the WWBOTA columns.
-- A new destination's token bucket starts empty (20261015000400); a minute ago fills it.
update destinations set claim_tokens = 0, claim_tokens_at = now() - interval '1 minute';
select is((select spot -> 'wwbota_references' from claim_deliveries() where subscription_id = (select wwbota_only from subs)),
  '["B/EA-0103", "B/EA-0104", "B/EA-0105"]'::jsonb, 'claim_deliveries puts every bunker in the spot');

-- Rendering, shared by push, Discord and webhooks.
create temp table h1 as select delivery_spot_json(r) as j from raw_spots r where r.content_hash = 'h1';
select is(render_push_field('reference', (select j from h1)), 'B/EA-0103, B/EA-0104, B/EA-0105', 'reference: every bunker');
select is(render_push_field('place_name', (select j from h1)), 'Búnker 1', 'place name: the first bunker''s name');
select is(render_push_field('source', (select j from h1)), 'WWBOTA', 'source: WWBOTA');
select is(webhook_field_value('reference', (select j from h1), 'iso_utc', 'khz'), '"B/EA-0103, B/EA-0104, B/EA-0105"'::jsonb,
  'the webhook reference is the same text');
select is(spot_source_url((select j from h1)), null, 'no source page: WWBOTA has none per bunker');

-- Read models.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is((select wwbota_reference_name from list_recent_spots('wwbota', 10) where callsign = 'G0KAO'), 'Horbury',
  'list_recent_spots returns WWBOTA spots with their columns');
select is((select count(*) from list_recent_spots('rbn', 10) where wwbota_references is not null), 0::bigint,
  'the RBN branch of list_recent_spots still lines up with recent_spots');
select is((select spots -> 0 -> 'wwbota_references'
           from preview_subscription('{"sources":["wwbota"],"rules":[[{"field":"reference","op":"contains","values":["B/G-2386"]}]]}'::jsonb)),
          '["B/G-2386"]'::jsonb, 'preview_subscription shows the bunkers');
reset role;

select is((select program || ' ' || reference || ' ' || reference_name from spot_stream where callsign = 'EA4IYL'),
  'WWBOTA B/EA-0103 Búnker 1', 'spot_stream credits an n-fer''s first bunker');
select is((select program from spot_stream where callsign = 'N4DXX' and source = 'pota'), 'POTA', 'spot_stream keeps POTA as before');

-- Archive: hourly slices from raw_spots; the references go as one string.
select is(archive_slice_minutes('wwbota'), 60, 'WWBOTA slices are an hour');
select is((select (columns -> 'wwbota_references')::jsonb from archive_columns('wwbota', now() - interval '1 minute', now() + interval '1 minute')),
  '["B/EA-0103,B/EA-0104,B/EA-0105", "B/G-2386"]'::jsonb, 'archive_columns reads WWBOTA spots and joins their bunkers');
select ok(exists (select 1 from archive_status where source = 'wwbota'), 'archive_status lists wwbota');
select lives_ok(format('select log_archive(%L, %L, %L, 0, null, null)', 'wwbota',
  date_trunc('hour', now()) - interval '3 hours', date_trunc('hour', now()) - interval '2 hours'),
  'archive_log accepts wwbota');

select * from finish();
rollback;

-- pgTAP: DX Cluster as a source (20261012000020): the source checks, the
-- ingest_state row, opt-in matching (source_matches) and hourly archiving from
-- raw_spots.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(13);

select pgmq.purge_queue('spot_events');
select pgmq.purge_queue('deliveries_queue');

select ok(exists (select 1 from ingest_state where source = 'dxcluster'), 'ingest_state has a dxcluster row');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table d as select * from create_destination('webhook', 'Hook', 'https://hooks.example.com/a');
-- Deliveries are one per destination and spot, so subscriptions whose DX
-- delivery is under test get destinations of their own.
create temp table d2 as select * from create_destination('webhook', 'Hook 2', 'https://hooks.example.com/b');
create temp table d3 as select * from create_destination('webhook', 'Hook 3', 'https://hooks.example.com/c');
create temp table subs as
select save_subscription(jsonb_build_object('name','DX on 20m','sources',array['dxcluster'],'rules','[[{"field":"band","op":"is","values":["20m"]}]]'::jsonb,'quiet_minutes',0,'destinations',array[(select id from d)])) as dx_only,
       save_subscription(jsonb_build_object('name','Anything on 20m','rules','[[{"field":"band","op":"is","values":["20m"]}]]'::jsonb,'quiet_minutes',0,'destinations',array[(select id from d)])) as any_source,
       save_subscription(jsonb_build_object('name','SV8/DJ0MY anywhere','rules','[[{"field":"callsign","op":"is","values":["SV8/DJ0MY"]}]]'::jsonb,'quiet_minutes',0,'destinations',array[(select id from d3)])) as any_source_call,
       save_subscription(jsonb_build_object('name','DX and POTA','sources',array['pota','dxcluster'],'rules','[[{"field":"mode","op":"is","values":["ssb"]}]]'::jsonb,'quiet_minutes',0,'destinations',array[(select id from d2)])) as mixed;
reset role;

select is((select count(*) from ingest_spots(jsonb_build_array(
  jsonb_build_object('source','dxcluster','source_spot_id','2026-10-12T13:18:00.000Z|EA1FIC|SV8/DJ0MY|14305.0','content_hash','h1','spot_time',now(),'callsign','SV8/DJ0MY','spotter','EA1FIC','frequency_khz',14305,'band','20m','mode','ssb','mode_family','phone','comment','SSB [POTA] GR-0131 cq cq','raw_payload','{}'::jsonb),
  jsonb_build_object('source','pota','source_spot_id','p1','content_hash','h2','spot_time',now(),'callsign','N4DXX','spotter','W1AW','frequency_khz',14062,'band','20m','mode','cw','mode_family','cw','comment','','raw_payload','{}'::jsonb)
))), 2::bigint, 'ingest_spots accepts dxcluster rows');

select match_pending_spots();
select is((select count(*) from deliveries where subscription_id = (select dx_only from subs)), 1::bigint,
  'a subscription listing dxcluster gets the DX spot');
select is((select count(*) from deliveries where subscription_id = (select mixed from subs)), 1::bigint,
  'dxcluster alongside another source still gets the DX spot');
select is((select count(*) from deliveries where subscription_id = (select any_source from subs)), 1::bigint,
  'an any-source subscription gets the POTA spot only, not the DX spot');
select is((select count(*) from deliveries where subscription_id = (select any_source_call from subs)), 0::bigint,
  'an any-source subscription naming the DX station still gets no DX spots');

-- The same guard through the predicate directly.
select ok(not spot_matches(
  (select s from subscriptions s where s.id = (select any_source from subs)),
  (select r from raw_spots r where r.content_hash = 'h1')), 'spot_matches: dx spot vs empty sources');
select ok(spot_matches(
  (select s from subscriptions s where s.id = (select dx_only from subs)),
  (select r from raw_spots r where r.content_hash = 'h1')), 'spot_matches: dx spot vs sources {dxcluster}');
select ok(spot_matches(
  (select s from subscriptions s where s.id = (select any_source from subs)),
  (select r from raw_spots r where r.content_hash = 'h2')), 'spot_matches: POTA still matches empty sources');

-- Archive: hourly slices from raw_spots.
select is(archive_slice_minutes('dxcluster'), 60, 'DX Cluster slices are an hour');
select is((select row_count from archive_columns('dxcluster', now() - interval '1 minute', now() + interval '1 minute')), 1,
  'archive_columns reads DX Cluster spots from raw_spots');
select ok(exists (select 1 from archive_status where source = 'dxcluster'), 'archive_status lists dxcluster');
select lives_ok(format('select log_archive(%L, %L, %L, 0, null, null)', 'dxcluster',
  date_trunc('hour', now()) - interval '3 hours', date_trunc('hour', now()) - interval '2 hours'),
  'archive_log accepts dxcluster');

select * from finish();
rollback;

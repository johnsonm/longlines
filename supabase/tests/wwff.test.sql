-- pgTAP: WWFF as a source (20261015001000): the source checks, the
-- ingest_state row and cron job, the two WWFF columns through ingest, opt-in
-- matching, the reference rule, the read models and spot_stream, and hourly
-- archiving from raw_spots.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(22);

select pgmq.purge_queue('spot_events');
select pgmq.purge_queue('deliveries_queue');

select ok(exists (select 1 from ingest_state where source = 'wwff'), 'ingest_state has a wwff row');
select ok(exists (select 1 from cron.job where jobname = 'ingest-wwff' and schedule = '* * * * *'), 'ingest-wwff runs every minute');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table d as select * from create_destination('webhook', 'Hook', 'https://hooks.example.com/a');
create temp table d2 as select * from create_destination('webhook', 'Hook 2', 'https://hooks.example.com/b');
create temp table d3 as select * from create_destination('webhook', 'Hook 3', 'https://hooks.example.com/c');
create temp table subs as
select save_subscription(jsonb_build_object('name','WWFF on 20m','sources',array['wwff'],'rules','[[{"field":"band","op":"is","values":["20m"]}]]'::jsonb,'quiet_minutes',0,'destinations',array[(select id from d)])) as wwff_only,
       save_subscription(jsonb_build_object('name','Anything on 20m','rules','[[{"field":"band","op":"is","values":["20m"]}]]'::jsonb,'quiet_minutes',0,'destinations',array[(select id from d)])) as any_source,
       save_subscription(jsonb_build_object('name','Belgian references','sources',array['pota','wwff'],'rules','[[{"field":"reference","op":"contains","values":["onff-"]}]]'::jsonb,'quiet_minutes',0,'destinations',array[(select id from d2)])) as by_reference,
       save_subscription(jsonb_build_object('name','Not KFF','sources',array['wwff'],'rules','[[{"field":"reference","op":"not_contains","values":["KFF-"]}]]'::jsonb,'quiet_minutes',0,'destinations',array[(select id from d3)])) as not_kff;
reset role;

select is((select count(*) from ingest_spots(jsonb_build_array(
  jsonb_build_object('source','wwff','source_spot_id','157368','content_hash','h1','spot_time',now(),'callsign','ON4ABC/P','spotter','DL1XX','frequency_khz',14244,'band','20m','mode','ssb','mode_family','phone','comment','','wwff_reference','ONFF-0123','wwff_reference_name','Hoge Kempen','raw_payload','{}'::jsonb),
  jsonb_build_object('source','wwff','source_spot_id','157369','content_hash','h2','spot_time',now(),'callsign','K2CAF','spotter','K2CAF','frequency_khz',18130,'band','17m','mode','ssb','mode_family','phone','comment','','wwff_reference','KFF-5268','wwff_reference_name','T.M. Goodwin','raw_payload','{}'::jsonb),
  jsonb_build_object('source','pota','source_spot_id','p1','content_hash','h3','spot_time',now(),'callsign','N4DXX','spotter','W1AW','frequency_khz',14062,'band','20m','mode','cw','mode_family','cw','comment','','pota_reference','US-0001','raw_payload','{}'::jsonb)
))), 3::bigint, 'ingest_spots accepts wwff rows');
select is((select wwff_reference || ' ' || wwff_reference_name from raw_spots where content_hash = 'h1'), 'ONFF-0123 Hoge Kempen',
  'ingest_spots stores the WWFF reference and its name');
select is((select wwff_reference from raw_spots where content_hash = 'h3'), null, 'a POTA spot has no WWFF reference');

select match_pending_spots();
select is((select count(*) from deliveries where subscription_id = (select wwff_only from subs)), 1::bigint,
  'a subscription listing wwff gets the WWFF spot on its band');
select is((select count(*) from deliveries where subscription_id = (select any_source from subs)), 1::bigint,
  'an any-source subscription gets the POTA spot only, not the WWFF spot');
select is((select count(*) from deliveries d join raw_spots r on r.id = d.spot_id
           where d.subscription_id = (select by_reference from subs) and r.content_hash = 'h1'), 1::bigint,
  'the reference rule matches the WWFF reference, ignoring case');
select is((select count(*) from deliveries where subscription_id = (select by_reference from subs)), 1::bigint,
  'the reference rule leaves out the other spots');
select is((select r.content_hash from deliveries d join raw_spots r on r.id = d.spot_id
           where d.subscription_id = (select not_kff from subs)), 'h1',
  'a negative reference rule leaves out the KFF spot');

select ok(not source_matches('{}', 'wwff'), 'source_matches: empty sources leave out wwff');
select ok(source_matches('{wwff}', 'wwff'), 'source_matches: sources {wwff} take wwff');

-- The delivered spot carries the WWFF columns.
-- A new destination's token bucket starts empty (20261015000400); a minute ago fills it.
update destinations set claim_tokens = 0, claim_tokens_at = now() - interval '1 minute';
select is((select spot ->> 'wwff_reference' from claim_deliveries() where subscription_id = (select wwff_only from subs)), 'ONFF-0123',
  'claim_deliveries puts wwff_reference in the spot');

-- Read models.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is((select wwff_reference_name from list_recent_spots('wwff', 10) where callsign = 'K2CAF'), 'T.M. Goodwin',
  'list_recent_spots returns WWFF spots with their columns');
select is((select count(*) from list_recent_spots('rbn', 10) where wwff_reference is not null), 0::bigint,
  'the RBN branch of list_recent_spots still lines up with recent_spots');
select is((select spots -> 0 ->> 'wwff_reference'
           from preview_subscription('{"sources":["wwff"],"rules":[[{"field":"reference","op":"contains","values":["KFF-5268"]}]]}'::jsonb)),
          'KFF-5268', 'preview_subscription shows the WWFF reference');
reset role;

select is((select program || ' ' || reference || ' ' || reference_name from spot_stream where callsign = 'K2CAF'),
  'WWFF KFF-5268 T.M. Goodwin', 'spot_stream names the WWFF program, reference and name');
select is((select program from spot_stream where callsign = 'N4DXX' and source = 'pota'), 'POTA', 'spot_stream keeps POTA as before');

-- Archive: hourly slices from raw_spots, with the WWFF columns.
select is(archive_slice_minutes('wwff'), 60, 'WWFF slices are an hour');
select is((select (columns -> 'wwff_reference')::jsonb from archive_columns('wwff', now() - interval '1 minute', now() + interval '1 minute')),
  '["ONFF-0123", "KFF-5268"]'::jsonb, 'archive_columns reads WWFF spots and their references from raw_spots');
select ok(exists (select 1 from archive_status where source = 'wwff'), 'archive_status lists wwff');
select lives_ok(format('select log_archive(%L, %L, %L, 0, null, null)', 'wwff',
  date_trunc('hour', now()) - interval '3 hours', date_trunc('hour', now()) - interval '2 hours'),
  'archive_log accepts wwff');

select * from finish();
rollback;

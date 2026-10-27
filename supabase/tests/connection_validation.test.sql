-- pgTAP: connection validation (20261017003000). Unknown sources are refused by save, preview and
-- the API; band values are stored lowercase; a rule takes at most 1,000 values; preview's recent
-- window leaves DX Cluster and WWFF out of "any source" as the matcher does.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(19);

delete from deliveries;
delete from raw_spots;
delete from subscriptions;

-- ---------------------------------------------------------------------------
-- Sources
-- ---------------------------------------------------------------------------

select is(normalize_subscription_sources('[" POTA ", "wwff", "pota"]'), array['pota', 'wwff'],
  'sources are trimmed, lowercased and de-duplicated');
select is(normalize_subscription_sources(null), '{}'::text[], 'no sources means any');
select is(normalize_subscription_sources('["pota", "sotawatch", "wwff", "wwbota", "rbn", "dxcluster"]'),
  array['dxcluster', 'pota', 'rbn', 'sotawatch', 'wwbota', 'wwff'], 'every followable source is accepted');
select throws_ok($$ select normalize_subscription_sources('["aprs"]') $$,
  'P0001', 'Unknown source: aprs.', 'aprs is not a source a connection can follow');
select throws_ok($$ select normalize_subscription_sources('"pota"') $$,
  'P0001', 'sources must be a list.', 'sources must be a list');
select ok(not has_function_privilege('authenticated', 'public.normalize_subscription_sources(jsonb)', 'execute')
          and not has_function_privilege('anon', 'public.normalize_subscription_sources(jsonb)', 'execute'),
  'clients cannot call the sources helper');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select throws_ok($$ select save_subscription('{"name":"x","sources":["pota","sota"]}') $$,
  'P0001', 'Unknown source: sota.', 'save refuses an unknown source');
create temp table s1 as select save_subscription('{"name":"Parks","sources":["POTA"]}') as id;
select is((select sources from subscriptions where id = (select id from s1)), array['pota'],
  'save stores known sources lowercase');
select throws_ok($$ select * from preview_subscription('{"sources":["sota"]}') $$,
  'P0001', 'Unknown source: sota.', 'preview refuses an unknown source');

create temp table tok as select * from create_api_token('Sync', 'write', null);
grant all on tok to authenticated;
reset role;
select throws_ok(format('select api_call(%L, %L, %L)', (select id from tok), 'create_subscription',
    '{"body": {"name": "x", "sources": ["sota"]}}'),
  'P0001', 'Unknown source: sota.', 'the API refuses an unknown source on create');
select throws_ok(format('select api_call(%L, %L, %L)', (select id from tok), 'patch_subscription',
    jsonb_build_object('id', (select id from s1), 'body', '{"sources": ["sota"]}'::jsonb)),
  'P0001', 'Unknown source: sota.', 'the API refuses an unknown source on patch');

-- ---------------------------------------------------------------------------
-- Rules: band case and the value cap
-- ---------------------------------------------------------------------------

select is(normalize_subscription_rules('[[{"field":"band","op":"is","values":["20M"," 40m "]}]]', null, false),
  '[[{"field":"band","op":"is","values":["20m","40m"]}]]'::jsonb, 'band values are stored lowercase');
select ok(spot_matches(
    jsonb_populate_record(null::subscriptions, jsonb_build_object('id', gen_random_uuid(), 'user_id',
      '11111111-1111-1111-1111-111111111111', 'name', 'x', 'enabled', true, 'sources', '{}'::text[],
      'rules', normalize_subscription_rules('[[{"field":"band","op":"is","values":["20M"]}]]', null, false),
      'quiet_minutes', 0, 'created_at', now(), 'updated_at', now(), 'group_ids', '{}'::uuid[])),
    (0, 'pota', 'x', 'x', now(), now(), 'W1AW', null, 14062, '20m', 'cw', '', null, null, null, null,
     '{}'::jsonb, 'cw', 'W1AW', null, null, null, null, null, null)::raw_spots),
  'a band typed as 20M matches a 20m spot');
select lives_ok(format('select normalize_subscription_rules(%L, null, false)', jsonb_build_array(jsonb_build_array(
    jsonb_build_object('field', 'callsign', 'op', 'is',
      'values', (select jsonb_agg('K' || i) from generate_series(1, 1000) as i))))),
  'a rule can have 1,000 values');
select throws_ok(format('select normalize_subscription_rules(%L, null, false)', jsonb_build_array(jsonb_build_array(
    jsonb_build_object('field', 'callsign', 'op', 'is',
      'values', (select jsonb_agg('K' || i) from generate_series(1, 1001) as i))))),
  'P0001', 'A rule can have at most 1,000 values.', 'a rule with 1,001 values is refused');

-- The migration's rewrite of stored rules, run again over a row saved before it.
insert into subscriptions (user_id, name, sources, rules)
values ('11111111-1111-1111-1111-111111111111', 'Old', '{}',
        '[[{"field":"band","op":"is_not","values":["20M"]},{"field":"mode","op":"is","values":["cw"]}],
          [{"field":"reference","op":"contains","values":["US-NC"]}]]');
update subscriptions s
set rules = (
  select coalesce(jsonb_agg((
    select coalesce(jsonb_agg(case when r ->> 'field' = 'band'
                                   then jsonb_set(r, '{values}', to_jsonb(public.jsonb_text_array(r -> 'values', 'lower')))
                                   else r end order by ri), '[]'::jsonb)
    from jsonb_array_elements(g) with ordinality as x(r, ri)
  ) order by gi), '[]'::jsonb)
  from jsonb_array_elements(s.rules) with ordinality as y(g, gi)
)
where s.name = 'Old';
select is((select rules from subscriptions where name = 'Old'),
  '[[{"field":"band","op":"is_not","values":["20m"]},{"field":"mode","op":"is","values":["cw"]}],
    [{"field":"reference","op":"contains","values":["US-NC"]}]]'::jsonb,
  'the rewrite lowercases band values and keeps every other rule and the order');

-- ---------------------------------------------------------------------------
-- preview_subscription's recent window
-- ---------------------------------------------------------------------------

select ingest_spots(jsonb_build_array(
  jsonb_build_object('source','pota','source_spot_id','p1','content_hash','h1','spot_time',now() - interval '1 hour','callsign','KK4PWJ','frequency_khz',14062,'band','20m','mode','cw','mode_family','cw','comment','','raw_payload','{}'::jsonb),
  jsonb_build_object('source','dxcluster','source_spot_id','d1','content_hash','h2','spot_time',now() - interval '1 hour','callsign','W1AW','spotter','EA1FIC','frequency_khz',14025,'band','20m','mode','cw','mode_family','cw','comment','','raw_payload','{}'::jsonb),
  jsonb_build_object('source','wwff','source_spot_id','w1','content_hash','h3','spot_time',now() - interval '1 hour','callsign','N4DXX','frequency_khz',14244,'band','20m','mode','ssb','mode_family','phone','comment','','wwff_reference','KFF-0001','raw_payload','{}'::jsonb)));

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is((select window_size from preview_subscription('{"sources":[]}')), 1::bigint,
  'any source: the window leaves out DX Cluster and WWFF, as the matcher does');
select is((select window_size from preview_subscription('{"sources":["dxcluster","wwff"]}')), 2::bigint,
  'listing DX Cluster and WWFF puts them in the window');
select is((select count from preview_subscription('{"sources":[]}')), 1::bigint,
  'any source: the count is the POTA spot');

select * from finish();
rollback;

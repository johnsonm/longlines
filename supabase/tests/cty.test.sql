-- pgTAP: cty.dat countries (20261012000030). load_cty replaces the set,
-- cty_lookup resolves calls to it, clients can touch neither, and
-- watched_callsigns is gone.
begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

-- A tiny cty.dat: the US with an exact call that has its own zones, England,
-- Canada, Anguilla and Sweden.
select lives_ok($$select load_cty('20260915',
  '[{"prefix":"K","name":"United States","continent":"NA","cq_zone":5,"itu_zone":8,"lat":37.6,"lon":-91.87},
    {"prefix":"G","name":"England","continent":"EU","cq_zone":14,"itu_zone":27,"lat":52.77,"lon":-1.47},
    {"prefix":"VE","name":"Canada","continent":"NA","cq_zone":5,"itu_zone":9,"lat":44.35,"lon":-78.75},
    {"prefix":"VP2E","name":"Anguilla","continent":"NA","cq_zone":8,"itu_zone":11,"lat":18.23,"lon":-63.0},
    {"prefix":"SM","name":"Sweden","continent":"EU","cq_zone":14,"itu_zone":18,"lat":61.2,"lon":14.57}]',
  '[{"pattern":"K","exact":false,"entity":"K","continent":"NA","cq_zone":5,"itu_zone":8},
    {"pattern":"W","exact":false,"entity":"K","continent":"NA","cq_zone":5,"itu_zone":8},
    {"pattern":"KL7","exact":false,"entity":"K","continent":"NA","cq_zone":1,"itu_zone":1},
    {"pattern":"K3PA","exact":true,"entity":"K","continent":"NA","cq_zone":4,"itu_zone":7},
    {"pattern":"G","exact":false,"entity":"G","continent":"EU","cq_zone":14,"itu_zone":27},
    {"pattern":"GB3LER/B","exact":true,"entity":"G","continent":"EU","cq_zone":14,"itu_zone":27},
    {"pattern":"VE","exact":false,"entity":"VE","continent":"NA","cq_zone":5,"itu_zone":9},
    {"pattern":"VP2E","exact":false,"entity":"VP2E","continent":"NA","cq_zone":8,"itu_zone":11},
    {"pattern":"SM","exact":false,"entity":"SM","continent":"EU","cq_zone":14,"itu_zone":18}]')$$,
  'load_cty loads entities and prefixes');
select is((select (version, entities, prefixes)::text from cty_load), '(20260915,5,9)',
  'cty_load records the version and counts');

-- Lookups.
select is((select name from cty_lookup('KK4PWJ')), 'United States', 'a plain call by its prefix');
select is((select (entity, cq_zone)::text from cty_lookup('KL7ABC')), '(K,1)', 'the longest prefix wins');
select is((select cq_zone from cty_lookup('K3PA-1')), 4::smallint,
  'an SSID is dropped and an exact entry beats the prefix');
select is((select name from cty_lookup('sm1hev-#')), 'Sweden', 'a skimmer marker is dropped, case ignored');
select is((select name from cty_lookup('W4/G4OBK')), 'United States', 'a location prefix before the call');
select is((select name from cty_lookup('KK4PWJ/VE3')), 'Canada', 'a location prefix after the call');
select is((select name from cty_lookup('VP2E/KA1A')), 'Anguilla', 'a callsign-shaped location prefix');
select is((select name from cty_lookup('G4OBK/P')), 'England', '/P does not move a station');
select is((select name from cty_lookup('G4ABC/LH')), 'England', '/LH is not a prefix');
select is((select name from cty_lookup('KK4PWJ/4')), 'United States', 'a call-area digit is ignored');
select is((select name from cty_lookup('GB3LER/B')), 'England', 'an exact entry for the whole call');
select is((select count(*) from cty_lookup('W1AW/MM')), 0::bigint, 'maritime mobile has no country');
select is((select count(*) from cty_lookup('ZZ9ZZ')), 0::bigint, 'an unknown prefix has no country');
select is((select count(*) from cty_lookup(null)), 0::bigint, 'null has no country');

-- A second load replaces the first entirely.
select lives_ok($$select load_cty(null,
  '[{"prefix":"G","name":"England","continent":"EU","cq_zone":14,"itu_zone":27,"lat":52.77,"lon":-1.47}]',
  '[{"pattern":"G","exact":false,"entity":"G","continent":"EU","cq_zone":14,"itu_zone":27}]')$$,
  'a second load succeeds');
select is((select (count(*), max(prefix))::text from cty_entities), '(1,G)', 'old entities are gone');
select is((select count(*) from cty_lookup('KK4PWJ')), 0::bigint, 'old prefixes are gone');
select throws_ok($$select load_cty('x', '[]', '[]')$$, 'P0001',
  'load_cty: entities and prefixes must be non-empty arrays', 'an empty load is refused');

-- Access.
select ok(not has_table_privilege('authenticated', 'public.cty_prefixes', 'select')
          and not has_table_privilege('anon', 'public.cty_entities', 'select')
          and not has_table_privilege('authenticated', 'public.cty_load', 'select'),
  'clients cannot read the cty tables');
select ok(has_function_privilege('service_role', 'public.load_cty(text, jsonb, jsonb)', 'execute')
          and has_function_privilege('service_role', 'public.cty_lookup(text)', 'execute')
          and not has_function_privilege('authenticated', 'public.load_cty(text, jsonb, jsonb)', 'execute')
          and not has_function_privilege('anon', 'public.cty_lookup(text)', 'execute'),
  'only the service role may load or look up');
select is((select schedule from cron.job where jobname = 'import-cty'), '20 4 * * 1',
  'import-cty runs weekly');
select hasnt_function('public', 'watched_callsigns', array['text'], 'watched_callsigns is dropped');

select * from finish();
rollback;

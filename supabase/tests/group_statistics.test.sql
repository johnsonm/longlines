-- pgTAP: group statistics and public group pages (20261019000400).
-- Pins the payload shape: GroupStatistics in web/src/groups/stats/types.ts.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(14);

-- ---------------------------------------------------------------------------
-- Sharing columns and the save keys
-- ---------------------------------------------------------------------------

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table g1 as select save_callsign_group('{"name":"Club","callsigns":["W1AW"]}') as id;
grant all on g1 to authenticated;
select is((select (public, show_callsigns, public_slug is null) from callsign_groups where id = (select id from g1)),
  (false, false, true), 'a new group is private, without callsigns, and has no code');

select save_callsign_group(jsonb_build_object('id', (select id from g1), 'name', 'Club', 'callsigns', '["W1AW"]'::jsonb,
  'public', true));
create temp table code1 as select public_slug as s from callsign_groups where id = (select id from g1);
grant all on code1 to authenticated;
select ok((select s ~ '^[a-z2-7]{10}$' from code1), 'going public makes a ten-character base32 code');
select is((select show_callsigns from callsign_groups where id = (select id from g1)), false,
  'show_callsigns left out keeps the stored value');

select save_callsign_group(jsonb_build_object('id', (select id from g1), 'name', 'Renamed', 'callsigns', '["W1AW","K4ABC"]'::jsonb));
select is((select (public, public_slug) from callsign_groups where id = (select id from g1)),
  (true, (select s from code1)), 'a save without the keys keeps the page public and its code through a rename and a member change');

select save_callsign_group(jsonb_build_object('id', (select id from g1), 'name', 'Renamed', 'callsigns', '["W1AW"]'::jsonb,
  'public', false, 'show_callsigns', true));
select is((select (public, show_callsigns, public_slug) from callsign_groups where id = (select id from g1)),
  (false, true, (select s from code1)), 'turning the page off keeps its code');
select save_callsign_group(jsonb_build_object('id', (select id from g1), 'name', 'Renamed', 'callsigns', '["W1AW"]'::jsonb,
  'public', true, 'show_callsigns', null));
select is((select (public, show_callsigns, public_slug) from callsign_groups where id = (select id from g1)),
  (true, true, (select s from code1)), 'turning it back on brings back the same code; a null key is left out');

select throws_ok($$ select save_callsign_group('{"name":"Bad","public":"yes"}') $$, 'P0001', 'Not a valid setting.',
  'a non-boolean public is refused');
select throws_ok($$ select save_callsign_group('{"name":"Bad","show_callsigns":1}') $$, 'P0001', 'Not a valid setting.',
  'a non-boolean show_callsigns is refused');

create temp table g2 as select save_callsign_group('{"name":"Shared from the start","public":true,"show_callsigns":true}') as id;
grant all on g2 to authenticated;
select is((select (public, show_callsigns, public_slug ~ '^[a-z2-7]{10}$') from callsign_groups where id = (select id from g2)),
  (true, true, true), 'a group can be created public');
select throws_ok($$ update callsign_groups set public = true $$, '42501', null, 'clients cannot write the sharing columns directly');
reset role;

select is((select count(distinct s) from (select public.new_group_slug() as s from generate_series(1, 1000)) x), 1000::bigint,
  '1,000 codes are all different');
select ok((select bool_and(public.new_group_slug() ~ '^[a-z2-7]{10}$') from generate_series(1, 200)),
  'every code is ten characters of a-z2-7');
select ok(not has_function_privilege('authenticated', 'public.new_group_slug()', 'execute'),
  'clients cannot make codes');
select table_privs_are('public', 'group_stats_cache', 'authenticated', '{}'::text[], 'clients have no access to the cache');

select * from finish();
rollback;

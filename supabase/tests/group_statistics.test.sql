-- pgTAP: group statistics and public group pages (20261019000400).
-- Pins the payload shape: GroupStatistics in web/src/groups/stats/types.ts.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(58);

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

-- ---------------------------------------------------------------------------
-- The builder
-- ---------------------------------------------------------------------------

create or replace function pg_temp.d(p_offset int) returns date language sql as $$
  select (now() at time zone 'utc')::date + p_offset;
$$;
create or replace function pg_temp.at(p_offset int, p_hms text) returns timestamptz language sql as $$
  select ((pg_temp.d(p_offset))::text || ' ' || p_hms || '+00')::timestamptz;
$$;
create or replace function pg_temp.raw(
  p_source text, p_id text, p_time timestamptz, p_call text, p_khz numeric, p_band text, p_mode text, p_family text,
  p_pota text default null, p_park text default null, p_sota text default null, p_wwff text default null,
  p_wwff_name text default null) returns void language sql as $$
  insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, spotter, frequency_khz, band,
                         mode, mode_family, comment, pota_reference, pota_park_name, sota_summit_ref, wwff_reference,
                         wwff_reference_name, raw_payload)
  values (p_source, p_id, p_id, p_time, p_call, 'W1AW', p_khz, p_band, p_mode, p_family, '', p_pota, p_park, p_sota,
          p_wwff, p_wwff_name, '{}');
$$;

delete from deliveries;
delete from raw_spots;
delete from rbn_spots;
delete from callsign_activity;
delete from callsign_reach;
delete from callsign_references;
delete from callsign_seen;
delete from callsign_variants;
delete from callsign_days;
delete from callsign_rollup_days;
delete from callsign_rollup_failures;
delete from archive_log;
delete from hidden_callsigns;
delete from group_stats_cache;

select load_cty('test',
  '[{"prefix":"K","name":"United States","continent":"NA","cq_zone":5,"itu_zone":8,"lat":37.6,"lon":-91.87}]',
  '[{"pattern":"K","exact":false,"entity":"K","continent":"NA","cq_zone":5,"itu_zone":8},
    {"pattern":"W","exact":false,"entity":"K","continent":"NA","cq_zone":5,"itu_zone":8},
    {"pattern":"N","exact":false,"entity":"K","continent":"NA","cq_zone":5,"itu_zone":8}]');

-- Members KK4PWJ, W4ABC, K4DEF (never heard) and N4GHI (hidden).
insert into hidden_callsigns (callsign) values ('N4GHI');
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table club as
  select save_callsign_group('{"name":"Piedmont","callsigns":["KK4PWJ","W4ABC","K4DEF","N4GHI"]}') as id;
grant all on club to authenticated;
reset role;

-- Day -40 (rolled up; the previous 30 days): one DX Cluster spot of KK4PWJ.
select pg_temp.raw('dxcluster', 's1', pg_temp.at(-40, '12:00:00'), 'KK4PWJ', 14025, '20m', 'cw', 'cw');
-- Day -10 (rolled up): KK4PWJ/P activates K-0817 (two spots), W4ABC a summit, hidden N4GHI on DX Cluster.
select pg_temp.raw('pota', 's2', pg_temp.at(-10, '10:00:00'), 'KK4PWJ/P', 14062, '20m', 'cw', 'cw', 'K-0817', 'Old Name');
select pg_temp.raw('pota', 's3', pg_temp.at(-10, '10:30:00'), 'KK4PWJ/P', 14062, '20m', 'cw', 'cw', 'K-0817', 'Old Name');
select pg_temp.raw('sotawatch', 's4', pg_temp.at(-10, '14:00:00'), 'W4ABC/P', 7185, '40m', 'ssb', 'phone',
                   p_sota => 'W4C/CM-001');
select pg_temp.raw('dxcluster', 's5', pg_temp.at(-10, '15:00:00'), 'N4GHI', 14030, '20m', 'cw', 'cw');
select rollup_callsign_day(pg_temp.d(-40));
select rollup_callsign_day(pg_temp.d(-10));
-- A year ago and more: outside the heat map.
insert into callsign_days (base, day, source, spots, modes, bands) values ('KK4PWJ', pg_temp.d(-400), 'pota', 50, '{cw}', '{20m}');
-- Day -2 (live): KK4PWJ back at K-0817 on FT8 under the park's new name; W4ABC at a WWFF reserve on FM.
select pg_temp.raw('pota', 's6', pg_temp.at(-2, '09:00:00'), 'KK4PWJ', 14074, '20m', 'ft8', 'digital',
                   'K-0817', 'Eno River State Park');
select pg_temp.raw('wwff', 's7', pg_temp.at(-2, '11:00:00'), 'W4ABC', 146520, '2m', 'fm', 'phone',
                   p_wwff => 'KFF-1234', p_wwff_name => 'Some Reserve');
-- Today (live): W4ABC on SSB.
select pg_temp.raw('dxcluster', 's8', now() - interval '1 minute', 'W4ABC', 7200, '40m', 'ssb', 'phone');

create temp table s30 as select group_statistics((select id from club), '30d') as p;
create temp table s7 as select group_statistics((select id from club), '7d') as p;
grant all on s30, s7 to authenticated;

select is((select array(select jsonb_object_keys(p) order by 1) from s30),
  array['bands', 'calendar', 'daily', 'generatedAt', 'kpis', 'memberCount', 'members', 'modes', 'period', 'places', 'top'],
  'the payload has its keys');
select is((select p -> 'kpis' from s30),
  '{"spots": 6, "previousSpots": 1, "membersHeard": 2,
    "activations": {"pota": 2, "sota": 1, "wwff": 1}, "places": {"parks": 2, "summits": 1}}'::jsonb,
  '30 days: rolled-up and live spots, the previous period, activations per program and places');
select is((select p -> 'kpis' from s7),
  '{"spots": 3, "previousSpots": 3, "membersHeard": 2,
    "activations": {"pota": 1, "sota": 0, "wwff": 1}, "places": {"parks": 2, "summits": 0}}'::jsonb,
  '7 days: only the last week, and the week before it');
select is((select (p ->> 'memberCount')::int from s30), 3, 'the hidden member is not counted');
select ok((select p::text not like '%N4GHI%' from s30), 'the hidden member appears nowhere');
select is((select jsonb_array_length(p -> 'daily') from s30), 30, 'daily holds every day of the period');
select is((select sum((e ->> 'spots')::int) from s30, jsonb_array_elements(p -> 'daily') e), 6::bigint,
  'daily adds up to the period''s spots');
select is((select p -> 'daily' -> 0 ->> 'day' from s30), to_char(pg_temp.d(-29), 'YYYY-MM-DD'), 'daily starts 29 days ago');
select is((select jsonb_agg(e - 'day') from s30, jsonb_array_elements(p -> 'calendar') e),
  '[{"spots": 1, "members": 1}, {"spots": 3, "members": 2}, {"spots": 2, "members": 2}, {"spots": 1, "members": 1}]'::jsonb,
  'the heat map holds the year''s days with spots, members on the air each day, and nothing older');
select is((select p -> 'top' from s30),
  '{"spots": [{"callsign": "KK4PWJ", "value": 3}, {"callsign": "W4ABC", "value": 3}],
    "days": [{"callsign": "W4ABC", "value": 3}, {"callsign": "KK4PWJ", "value": 2}],
    "cw": [{"callsign": "KK4PWJ", "value": 2}],
    "ssb": [{"callsign": "W4ABC", "value": 2}],
    "digital": [{"callsign": "KK4PWJ", "value": 1}],
    "parks": [{"callsign": "KK4PWJ", "value": 1}]}'::jsonb,
  'top lists rank by value then callsign and leave out members with none');
select is((select jsonb_agg(e - 'lastHeard') from s30, jsonb_array_elements(p -> 'members') e),
  '[{"callsign": "W4ABC", "spots": 3, "days": 3, "mainMode": "SSB"},
    {"callsign": "KK4PWJ", "spots": 3, "days": 2, "mainMode": "CW"},
    {"callsign": "K4DEF", "spots": 0, "days": 0, "mainMode": null}]'::jsonb,
  'every member, ranked by spots then days, the unheard last');
select is((select array(select e ->> 'lastHeard' from jsonb_array_elements(p -> 'members') e) from s30),
  array[to_char((now() - interval '1 minute') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        to_char(pg_temp.at(-2, '09:00:00') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        null],
  'last heard is the newest of callsign_seen and the live spots');
select is((select jsonb_object_agg(e ->> 'band', e -> 'spots') filter (where (e ->> 'spots')::int > 0)
           from s30, jsonb_array_elements(p -> 'bands') e),
  '{"20m": 3, "40m": 2, "2m": 1}'::jsonb, 'bands from day rows and live spots');
select is((select jsonb_array_length(p -> 'bands') from s30), 12, 'bands are the fixed twelve');
select is((select p -> 'modes' from s30),
  '[{"label": "CW", "spots": 2}, {"label": "SSB", "spots": 2}, {"label": "FT8/FT4", "spots": 1}, {"label": "FM", "spots": 1}]'::jsonb,
  'modes in bucket order, empty buckets left out');
select is((select p -> 'places' from s30),
  '[{"reference": "K-0817", "name": "Eno River State Park", "program": "POTA", "times": 2, "by": ["KK4PWJ"]},
    {"reference": "KFF-1234", "name": "Some Reserve", "program": "WWFF", "times": 1, "by": ["W4ABC"]},
    {"reference": "W4C/CM-001", "name": null, "program": "SOTA", "times": 1, "by": ["W4ABC"]}]'::jsonb,
  'places by activations, with the newest name and who activated them');
select throws_ok(format('select group_statistics(%L, %L)', (select id from club), '90d'), 'P0001', 'Not a valid period.',
  'only 7 and 30 days');
select is(group_statistics(gen_random_uuid(), '30d'), null, 'no group, no statistics');
select ok(not has_function_privilege('authenticated', 'public.group_statistics(uuid, text)', 'execute'),
  'clients cannot call the builder');

-- ---------------------------------------------------------------------------
-- The cache and the RPCs
-- ---------------------------------------------------------------------------

delete from group_stats_cache;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table own as select get_group_statistics((select id from club), '30d') as p;
grant all on own to authenticated;
select is((select p - 'group' from own), (select p from s30), 'the owner gets the built payload');
select is((select (p -> 'group') - 'id' from own),
  '{"name": "Piedmont", "public": false, "show_callsigns": false, "public_slug": null, "member_count": 4,
    "subscription_count": 0}'::jsonb,
  'with the group''s header; its member count includes the hidden call, as the member editor does');
reset role;
select is((select count(*) from group_stats_cache where group_id = (select id from club)), 1::bigint, 'the build is cached');
update group_stats_cache set payload = '{"cached": true}' where group_id = (select id from club);
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is(get_group_statistics((select id from club), '30d') -> 'cached', 'true'::jsonb, 'a fresh cache row is served');
reset role;
update group_stats_cache set generated_at = now() - interval '61 minutes' where group_id = (select id from club);
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select ok(not get_group_statistics((select id from club), '30d') ? 'cached', 'an hour-old row is rebuilt');

select save_callsign_group(jsonb_build_object('id', (select id from club), 'name', 'Piedmont club',
  'callsigns', '["KK4PWJ","W4ABC","K4DEF","N4GHI"]'::jsonb));
reset role;
select is((select count(*) from group_stats_cache where group_id = (select id from club)), 1::bigint,
  'a save that keeps the members keeps the cache');
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select save_callsign_group(jsonb_build_object('id', (select id from club), 'name', 'Piedmont',
  'callsigns', '["KK4PWJ","W4ABC","N4GHI"]'::jsonb));
reset role;
select is((select count(*) from group_stats_cache where group_id = (select id from club)), 0::bigint,
  'a member change clears the cache');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select throws_ok(format('select get_group_statistics(%L, %L)', (select id from club), '1y'), 'P0001', 'Not a valid period.');
select throws_ok(format('select get_group_statistics(%L, %L)', gen_random_uuid(), '30d'), 'P0001', 'Group not found.');
create temp table summaries as select * from list_group_summaries();
grant all on summaries to authenticated;
select is((select count(*) from summaries), 3::bigint, 'the cards list each of the caller''s groups');
select is((select (spots, members_heard, member_count, cardinality(daily), on_air) from summaries where id = (select id from club)),
  (6::bigint, 2, 2, 30, array['W4ABC']), 'a card holds the 30-day figures and who is on the air, hidden calls left out');
select is((select spots from summaries where id = (select id from club)),
  (select (p -> 'kpis' ->> 'spots')::bigint from s30), 'the card''s spots are the statistics page''s');
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select throws_ok(format('select get_group_statistics(%L, %L)', (select id from club), '30d'), 'P0001', 'Group not found.',
  'another user cannot read the group''s statistics');
select is((select count(*) from list_group_summaries()), 0::bigint, 'another user lists none of them');
set local request.jwt.claims = '';
select throws_ok($$ select * from list_group_summaries() $$, 'P0001', 'Not signed in.');
reset role;

-- The public page.
select is(public_group_statistics('aaaaaaaaaa', '30d'), null, 'an unknown code gets nothing');
select is(public_group_statistics('NOT-A-CODE', '30d'), null, 'a malformed code gets nothing');
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select save_callsign_group(jsonb_build_object('id', (select id from club), 'name', 'Piedmont',
  'callsigns', '["KK4PWJ","W4ABC","K4DEF","N4GHI"]'::jsonb, 'public', true));
reset role;
create temp table pub as select public_slug as s from callsign_groups where id = (select id from club);
grant all on pub to authenticated;
create temp table hidden_page as select public_group_statistics((select s from pub), '30d') as p;
select ok((select p ? 'kpis' and p ? 'calendar' and p ? 'bands' and not p ? 'top' and not p ? 'members' from hidden_page),
  'without callsigns the page keeps the totals and charts and loses the top lists and members');
select is((select p -> 'places' from hidden_page),
  '[{"reference": "K-0817", "name": "Eno River State Park", "program": "POTA", "times": 2},
    {"reference": "KFF-1234", "name": "Some Reserve", "program": "WWFF", "times": 1},
    {"reference": "W4C/CM-001", "name": null, "program": "SOTA", "times": 1}]'::jsonb,
  'places lose who activated them');
select is((select count(*) from hidden_page, jsonb_path_query(p, 'strict $.**') v
           where jsonb_typeof(v) = 'string' and v #>> '{}' in ('KK4PWJ', 'W4ABC', 'K4DEF', 'N4GHI')), 0::bigint,
  'no member''s callsign is anywhere in the page');
select is((select p -> 'group' from hidden_page), '{"name": "Piedmont", "member_count": 3, "show_callsigns": false}'::jsonb,
  'the header has the name and the member count the figures use, nothing else');
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select save_callsign_group(jsonb_build_object('id', (select id from club), 'name', 'Piedmont',
  'callsigns', '["KK4PWJ","W4ABC","K4DEF","N4GHI"]'::jsonb, 'show_callsigns', true));
reset role;
select is(public_group_statistics((select s from pub), '30d') - 'group', (select p from s30),
  'with callsigns the page is the owner''s payload');
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select save_callsign_group(jsonb_build_object('id', (select id from club), 'name', 'Piedmont',
  'callsigns', '["KK4PWJ","W4ABC","K4DEF","N4GHI"]'::jsonb, 'public', false));
reset role;
select is(public_group_statistics((select s from pub), '30d'), null, 'a page turned off gets nothing, at once');
select ok(not has_function_privilege('authenticated', 'public.public_group_statistics(text, text)', 'execute')
          and not has_function_privilege('anon', 'public.public_group_statistics(text, text)', 'execute')
          and has_function_privilege('service_role', 'public.public_group_statistics(text, text)', 'execute'),
  'only the service role reads public pages');
select ok(not has_function_privilege('authenticated', 'public.cached_group_statistics(uuid, text)', 'execute')
          and not has_function_privilege('authenticated', 'public.group_stats_redact(jsonb)', 'execute'),
  'clients cannot call the cache or the redaction');

select * from finish();
rollback;

-- pgTAP: subscription rules (20261014000500). Each op per field, AND inside a
-- group and OR between groups, the per-group RBN guard and its trigger,
-- watched_among over rules, normalize_subscription_rules, preview, and
-- save_subscription's legacy keys, kept rules and derived group_ids.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(110);

-- Start from empty tables so watched_among and preview see only these rows.
delete from deliveries;
delete from raw_spots;
delete from subscriptions;

-- A subscription row for predicate tests, without inserting.
create function pg_temp.sub(p_rules jsonb, p_sources text[] default '{}')
returns subscriptions language sql as $$
  select jsonb_populate_record(null::subscriptions, jsonb_build_object(
    'id', gen_random_uuid(), 'user_id', '11111111-1111-1111-1111-111111111111', 'name', 'x', 'enabled', true,
    'sources', p_sources, 'rules', p_rules, 'quiet_minutes', 0, 'created_at', now(), 'updated_at', now(),
    'group_ids', '{}'::uuid[]));
$$;
-- One rule as the only AND group.
create function pg_temp.one(p_field text, p_op text, p_values jsonb, p_sources text[] default '{}')
returns subscriptions language sql as $$
  select pg_temp.sub(jsonb_build_array(jsonb_build_array(
    jsonb_build_object('field', p_field, 'op', p_op, 'values', p_values))), p_sources);
$$;
create function pg_temp.spot(p_source text, p_call text, p_band text, p_mode text,
                             p_freq numeric default 14062, p_family text default null,
                             p_ref text default null, p_loc text default null, p_summit text default null)
returns raw_spots language sql as $$
  select (0, p_source, 'x', 'x', now(), now(), p_call, null, p_freq, p_band, p_mode, '', p_ref, null, p_loc, p_summit,
          '{}'::jsonb, p_family, public.base_callsign(p_call), null, null, null, null, null, null)::raw_spots;
$$;

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table grp as
select save_callsign_group('{"name":"Club","callsigns":["N4GRP","KK4PWJ"]}') as club,
       save_callsign_group('{"name":"Rivals","callsigns":["K4NEG"]}') as rivals;
create temp table dest as select * from create_destination('webhook', 'Hook', 'https://hooks.example.com/r');
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
create temp table other_grp as select save_callsign_group('{"name":"Other","callsigns":["W9OTH"]}') as id;
reset role;

-- ---------------------------------------------------------------------------
-- Each op per field
-- ---------------------------------------------------------------------------

select ok(spot_matches(pg_temp.one('callsign', 'is', '["KK4PWJ"]'), pg_temp.spot('pota', 'KK4PWJ/P', '20m', 'cw')),
  'callsign is: matches by base call');
select ok(not spot_matches(pg_temp.one('callsign', 'is_not', '["KK4PWJ"]'), pg_temp.spot('pota', 'KK4PWJ/P', '20m', 'cw')),
  'callsign is_not: excludes the station by base call');
select ok(spot_matches(pg_temp.one('callsign', 'is_not', '["KK4PWJ"]'), pg_temp.spot('pota', 'W1AW', '20m', 'cw')),
  'callsign is_not: passes every other station');

select ok(spot_matches(pg_temp.one('group', 'is', jsonb_build_array((select club from grp))), pg_temp.spot('pota', 'N4GRP', '20m', 'cw')),
  'group is: a member matches');
select ok(not spot_matches(pg_temp.one('group', 'is_not', jsonb_build_array((select club from grp))), pg_temp.spot('pota', 'KK4PWJ/P', '20m', 'cw')),
  'group is_not: a member (by base call) is excluded');
select ok(spot_matches(pg_temp.one('group', 'is_not', jsonb_build_array((select club from grp))), pg_temp.spot('pota', 'W1AW', '20m', 'cw')),
  'group is_not: a non-member passes');
select ok(not spot_matches(pg_temp.one('group', 'is', '[]'), pg_temp.spot('pota', 'W1AW', '20m', 'cw'))
          and spot_matches(pg_temp.one('group', 'is_not', '[]'), pg_temp.spot('pota', 'W1AW', '20m', 'cw')),
  'a group rule left with no ids (preview dropped them): is passes nothing, is_not everything');

select ok(spot_matches(pg_temp.one('band', 'is', '["20m","40m"]'), pg_temp.spot('pota', 'W1AW', '40m', 'cw')),
  'band is: any of the values');
select ok(not spot_matches(pg_temp.one('band', 'is_not', '["20m"]'), pg_temp.spot('pota', 'W1AW', '20m', 'cw')),
  'band is_not: excludes the band');
select ok(spot_matches(pg_temp.one('band', 'is_not', '["20m"]'), pg_temp.spot('pota', 'W1AW', '40m', 'cw')),
  'band is_not: passes another band');
select ok(spot_matches(pg_temp.one('band', 'is_not', '["20m"]'), pg_temp.spot('pota', 'W1AW', null, 'cw')),
  'band is_not: passes a spot with no band');
select ok(not spot_matches(pg_temp.one('band', 'is', '["20m"]'), pg_temp.spot('pota', 'W1AW', null, 'cw')),
  'band is: a spot with no band never matches');

select ok(spot_matches(pg_temp.one('mode', 'is', '["cw"]'), pg_temp.spot('pota', 'W1AW', '20m', 'cw')),
  'mode is: matches the mode');
select ok(not spot_matches(pg_temp.one('mode', 'is_not', '["cw"]'), pg_temp.spot('pota', 'W1AW', '20m', 'cw')),
  'mode is_not: excludes the mode');
select ok(spot_matches(pg_temp.one('mode', 'is_not', '["cw"]'), pg_temp.spot('pota', 'W1AW', '20m', null)),
  'mode is_not: passes a spot with no mode');
select ok(not spot_matches(pg_temp.one('mode', 'is_not', '["digital"]'), pg_temp.spot('pota', 'W1AW', '20m', 'ft8', 14074, 'digital')),
  'mode is_not a family excludes a mode in that family');
select ok(spot_matches(pg_temp.one('mode', 'is_not', '["digital"]'), pg_temp.spot('pota', 'W1AW', '20m', 'ssb', 14250, 'phone')),
  'mode is_not a family passes a mode outside it');

select ok(spot_matches(pg_temp.one('reference', 'contains', '["W4C/","us-nc"]'), pg_temp.spot('pota', 'W1AW', '20m', 'cw', 14062, null, 'US-2763', 'US-NC')),
  'reference contains: any of the values, case-insensitive');
select ok(not spot_matches(pg_temp.one('reference', 'not_contains', '["us-nc"]'), pg_temp.spot('pota', 'W1AW', '20m', 'cw', 14062, null, 'US-2763', 'US-NC')),
  'reference not_contains: excludes a matching location');
select ok(spot_matches(pg_temp.one('reference', 'not_contains', '["us-nc"]'), pg_temp.spot('sotawatch', 'W1AW', '20m', 'cw', 14062, null, null, null, 'W4C/CM-001')),
  'reference not_contains: passes another reference');
select ok(spot_matches(pg_temp.one('reference', 'not_contains', '["us-nc"]'), pg_temp.spot('pota', 'W1AW', '20m', 'cw')),
  'reference not_contains: passes a spot with no reference');
select ok(not spot_matches(pg_temp.one('reference', 'contains', '["us-nc"]'), pg_temp.spot('pota', 'W1AW', '20m', 'cw')),
  'reference contains: a spot with no reference never matches');

select ok(spot_matches(pg_temp.one('frequency', 'gt', '[14000]'), pg_temp.spot('pota', 'W1AW', '20m', 'cw', 14062))
          and not spot_matches(pg_temp.one('frequency', 'gt', '[14000]'), pg_temp.spot('pota', 'W1AW', '40m', 'cw', 7030))
          and not spot_matches(pg_temp.one('frequency', 'gt', '[14062]'), pg_temp.spot('pota', 'W1AW', '20m', 'cw', 14062)),
  'frequency gt: strictly above');
select ok(spot_matches(pg_temp.one('frequency', 'lt', '[14000]'), pg_temp.spot('pota', 'W1AW', '40m', 'cw', 7030))
          and not spot_matches(pg_temp.one('frequency', 'lt', '[14000]'), pg_temp.spot('pota', 'W1AW', '20m', 'cw', 14062))
          and not spot_matches(pg_temp.one('frequency', 'lt', '[14062]'), pg_temp.spot('pota', 'W1AW', '20m', 'cw', 14062)),
  'frequency lt: strictly below');
select ok(spot_matches(pg_temp.one('frequency', 'is', '[14062.5]'), pg_temp.spot('pota', 'W1AW', '20m', 'cw', 14062.5))
          and not spot_matches(pg_temp.one('frequency', 'is', '[14062]'), pg_temp.spot('pota', 'W1AW', '20m', 'cw', 14062.5)),
  'frequency is: exact');
select ok(not spot_matches(pg_temp.one('frequency', 'is_not', '[14062]'), pg_temp.spot('pota', 'W1AW', '20m', 'cw', 14062))
          and spot_matches(pg_temp.one('frequency', 'is_not', '[14062]'), pg_temp.spot('pota', 'W1AW', '40m', 'cw', 7030)),
  'frequency is_not: everything but that frequency');

-- ---------------------------------------------------------------------------
-- AND binds tighter than OR; no rules
-- ---------------------------------------------------------------------------

create temp table dnf as select pg_temp.sub('[[{"field":"band","op":"is","values":["20m"]},{"field":"mode","op":"is","values":["cw"]}],
                                              [{"field":"band","op":"is","values":["40m"]}]]') as s;
select ok(spot_matches((select s from dnf), pg_temp.spot('pota', 'W1AW', '20m', 'cw')), '20m and CW, or 40m: a 20m CW spot passes');
select ok(not spot_matches((select s from dnf), pg_temp.spot('pota', 'W1AW', '20m', 'ssb')), '20m and CW, or 40m: a 20m SSB spot fails');
select ok(spot_matches((select s from dnf), pg_temp.spot('pota', 'W1AW', '40m', 'ssb')), '20m and CW, or 40m: a 40m SSB spot passes');

select ok(spot_matches(pg_temp.sub('[]'), pg_temp.spot('pota', 'W1AW', '20m', 'cw'))
          and spot_matches(pg_temp.sub('[]'), pg_temp.spot('sotawatch', 'W1AW', null, null)),
  'no rules pass every POTA and SOTA spot');
select ok(not spot_matches(pg_temp.sub('[]'), pg_temp.spot('rbn', 'W1AW', '20m', 'cw'))
          and not spot_matches(pg_temp.sub('[]'), pg_temp.spot('dxcluster', 'W1AW', '20m', 'cw')),
  'no rules and no sources pass neither RBN nor DX Cluster spots');

-- ---------------------------------------------------------------------------
-- The RBN guard is per AND group
-- ---------------------------------------------------------------------------

create temp table either as select pg_temp.sub('[[{"field":"callsign","op":"is","values":["K1ABC"]}],
                                                 [{"field":"mode","op":"is","values":["cw"]}]]') as s;
select ok(spot_matches((select s from either), pg_temp.spot('rbn', 'K1ABC', '20m', 'cw', 14030, 'cw')),
  'callsign is K1ABC or mode is CW: K1ABC''s RBN spot passes');
select ok(not spot_matches((select s from either), pg_temp.spot('rbn', 'W1AW', '20m', 'cw', 14030, 'cw')),
  'callsign is K1ABC or mode is CW: another call''s CW RBN spot does not');
select ok(spot_matches((select s from either), pg_temp.spot('pota', 'W1AW', '20m', 'cw', 14062, 'cw')),
  'callsign is K1ABC or mode is CW: a POTA CW spot passes');
select ok(not spot_matches(pg_temp.one('callsign', 'is_not', '["K1ABC"]'), pg_temp.spot('rbn', 'W1AW', '20m', 'cw', 14030, 'cw')),
  'a negative callsign rule does not name stations for RBN');
select ok(spot_matches(pg_temp.one('group', 'is', jsonb_build_array((select club from grp)), '{rbn}'), pg_temp.spot('rbn', 'N4GRP/P', '20m', 'cw', 14030, 'cw')),
  'a positive group rule names stations for RBN');

-- The trigger: an RBN-only subscription needs stations in every AND group.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select throws_ok($$ select save_subscription('{"name":"x","sources":["rbn"],"rules":[[{"field":"mode","op":"is","values":["cw"]}]]}') $$,
  'P0001', 'RBN reports stations by callsign. Add at least one callsign.', 'one group without stations: the single-group message');
select throws_ok($$ select save_subscription('{"name":"x","sources":["rbn"],"rules":[[{"field":"callsign","op":"is_not","values":["K1ABC"]}]]}') $$,
  'P0001', 'RBN reports stations by callsign. Add at least one callsign.', 'a negative callsign rule does not satisfy the trigger');
select throws_ok($$ select save_subscription('{"name":"x","sources":["rbn"],"rules":[[{"field":"callsign","op":"is","values":["K1ABC"]}],[{"field":"mode","op":"is","values":["cw"]}]]}') $$,
  'P0001', 'RBN reports stations by callsign. Each Or needs its own callsign or group rule.', 'several groups, one without stations: the per-Or message');
select lives_ok(format('select save_subscription(%L)', jsonb_build_object('name', 'x', 'sources', array['rbn'],
  'rules', jsonb_build_array(
    jsonb_build_array(jsonb_build_object('field', 'callsign', 'op', 'is', 'values', array['K1ABC'])),
    jsonb_build_array(jsonb_build_object('field', 'group', 'op', 'is', 'values', array[(select club from grp)]),
                      jsonb_build_object('field', 'mode', 'op', 'is', 'values', array['cw']))))),
  'every group naming stations saves for RBN');
reset role;
delete from subscriptions;

-- ---------------------------------------------------------------------------
-- watched_among
-- ---------------------------------------------------------------------------

insert into subscriptions (user_id, name, enabled, sources, rules, quiet_minutes) values
  ('11111111-1111-1111-1111-111111111111', 'mixed', true, '{}',
   jsonb_build_array(
     '[{"field":"callsign","op":"is","values":["W1AW"]},{"field":"mode","op":"is","values":["cw"]}]'::jsonb,
     '[{"field":"callsign","op":"is_not","values":["K9NOT"]}]'::jsonb,
     jsonb_build_array(jsonb_build_object('field', 'group', 'op', 'is', 'values', array[(select club from grp)])),
     jsonb_build_array(jsonb_build_object('field', 'group', 'op', 'is_not', 'values', array[(select rivals from grp)]))), 0),
  ('11111111-1111-1111-1111-111111111111', 'off', false, '{rbn}', '[[{"field":"callsign","op":"is","values":["K9OFF"]}]]', 0),
  ('11111111-1111-1111-1111-111111111111', 'pota', true, '{pota}', '[[{"field":"callsign","op":"is","values":["N4POT"]}]]', 0);
insert into subscription_destinations (subscription_id, destination_id)
select s.id, (select id from dest) from subscriptions s;
select is(array(select watched_among('rbn', array['W1AW', 'K9NOT', 'K9OFF', 'N4POT', 'N4GRP/P', 'K4NEG', 'N0NE'])),
  array['N4GRP/P', 'W1AW'],
  'watched_among: only positive callsign and group rules of enabled subscriptions accepting the source');
select is(array(select watched_among('pota', array['N4POT', 'K9NOT', 'K4NEG'])), array['N4POT'],
  'watched_among: is_not rules never put a call on the watchlist');
delete from subscriptions;

-- ---------------------------------------------------------------------------
-- normalize_subscription_rules
-- ---------------------------------------------------------------------------

create function pg_temp.norm(p_rules text, p_strict boolean default true)
returns jsonb language sql as $$
  select normalize_subscription_rules(p_rules::jsonb, '11111111-1111-1111-1111-111111111111', p_strict);
$$;

select throws_ok($$ select pg_temp.norm('[[{"field":"color","op":"is","values":["red"]}]]') $$,
  'P0001', 'Unknown rule field: color.', 'an unknown field is refused');
select throws_ok($$ select pg_temp.norm('[[{"op":"is","values":["red"]}]]') $$,
  'P0001', 'Unknown rule field: none.', 'a rule without a field is refused');
select throws_ok($$ select pg_temp.norm('[[{"field":"band","op":"contains","values":["20m"]}]]') $$,
  'P0001', 'A band rule can''t use contains.', 'band takes is or is_not');
select throws_ok($$ select pg_temp.norm('[[{"field":"reference","op":"gt","values":["US-NC"]}]]') $$,
  'P0001', 'A reference rule can''t use gt.', 'reference takes is, is_not, contains or not_contains');
select throws_ok($$ select pg_temp.norm('[[{"field":"callsign","op":"gt","values":["W1AW"]}]]') $$,
  'P0001', 'A callsign rule can''t use gt.', 'gt is for frequency only');
select throws_ok($$ select pg_temp.norm('[[{"field":"mode","values":["cw"]}]]') $$,
  'P0001', 'A mode rule can''t use no op.', 'a rule without an op is refused');
select throws_ok($$ select pg_temp.norm('[[{"field":"mode","op":"is","values":"cw"}]]') $$,
  'P0001', 'A mode rule''s values must be a list.', 'values must be a list');
select throws_ok($$ select pg_temp.norm('[[{"field":"callsign","op":"is","values":[" "]}]]') $$,
  'P0001', 'Give the callsign rule a value.', 'values that are all blank are refused');
select throws_ok($$ select pg_temp.norm('[[{"field":"group","op":"is","values":[]}]]') $$,
  'P0001', 'Give the group rule a value.', 'a group rule needs an id');
select throws_ok($$ select pg_temp.norm('[[{"field":"frequency","op":"gt","values":["abc"]}]]') $$,
  'P0001', 'A frequency rule takes one number in kHz.', 'a frequency must be a number');
select throws_ok($$ select pg_temp.norm('[[{"field":"frequency","op":"gt","values":[7000, 14000]}]]') $$,
  'P0001', 'A frequency rule takes one number in kHz.', 'a frequency rule takes one value');
select throws_ok($$ select pg_temp.norm('[[{"field":"frequency","op":"lt","values":[0]}]]') $$,
  'P0001', 'A frequency rule takes one number in kHz.', 'a frequency must be above zero');
select throws_ok($$ select pg_temp.norm('[[{"field":"frequency","op":"lt","values":[-5]}]]') $$,
  'P0001', 'A frequency rule takes one number in kHz.', 'a negative frequency is refused');
select throws_ok($$ select pg_temp.norm('[[]]') $$,
  'P0001', 'Each list in rules needs at least one rule.', 'an empty AND group is refused');
select throws_ok($$ select pg_temp.norm('[{"field":"band","op":"is","values":["20m"]}]') $$,
  'P0001', 'rules must be a list of rule lists.', 'a flat list of rules is refused');
select throws_ok($$ select pg_temp.norm('{"field":"band"}') $$,
  'P0001', 'rules must be a list of rule lists.', 'rules must be a list');
select throws_ok($$ select pg_temp.norm('[["band"]]') $$,
  'P0001', 'Each rule needs a field, an op and values.', 'a rule must be an object');
select throws_ok(format('select pg_temp.norm(%L)', (
    select jsonb_build_array(jsonb_agg('{"field":"band","op":"is","values":["20m"]}'::jsonb), '[{"field":"band","op":"is","values":["20m"]}]'::jsonb)
    from generate_series(1, 50))),
  'P0001', 'A connection can have at most 50 rules.', '51 rules across groups are refused');
select lives_ok(format('select pg_temp.norm(%L)', (
    select jsonb_build_array(jsonb_agg('{"field":"band","op":"is","values":["20m"]}'::jsonb))
    from generate_series(1, 50))),
  '50 rules are allowed');
select throws_ok(format('select pg_temp.norm(%L)', jsonb_build_array(jsonb_build_array(
    jsonb_build_object('field', 'group', 'op', 'is', 'values', array[(select id from other_grp)])))),
  'P0001', 'Group not found.', 'strict: another user''s group is refused');
select throws_ok(format('select pg_temp.norm(%L)', jsonb_build_array(jsonb_build_array(
    jsonb_build_object('field', 'group', 'op', 'is', 'values', array['not-a-uuid'])))),
  'P0001', 'Group not found.', 'strict: a malformed group id is refused');
select is(pg_temp.norm(jsonb_build_array(jsonb_build_array(
    jsonb_build_object('field', 'group', 'op', 'is', 'values', array[(select club::text from grp), (select id::text from other_grp)])))::text, false),
  jsonb_build_array(jsonb_build_array(jsonb_build_object('field', 'group', 'op', 'is', 'values', array[(select club::text from grp)]))),
  'not strict: another user''s group id is dropped');

select is(pg_temp.norm('[[{"field":"callsign","op":"is","values":[" w1aw ","kk4pwj/p","W1AW"]},
                          {"field":"mode","op":"is_not","values":["CW","Digital"]}],
                         [{"field":"frequency","op":"gt","values":["14062.5"]},
                          {"field":"reference","op":"contains","values":[" US-NC "]},
                          {"field":"band","op":"is","values":["20m"]}]]'),
  '[[{"field":"callsign","op":"is","values":["KK4PWJ/P","W1AW"]},
     {"field":"mode","op":"is_not","values":["cw","digital"]}],
    [{"field":"frequency","op":"gt","values":[14062.5]},
     {"field":"reference","op":"contains","values":["US-NC"]},
     {"field":"band","op":"is","values":["20m"]}]]'::jsonb,
  'normalized: calls upper, trimmed and de-duplicated, modes lower, frequency a number, reference trimmed');
select is(jsonb_typeof(pg_temp.norm('[[{"field":"frequency","op":"is","values":[7030]}]]') -> 0 -> 0 -> 'values' -> 0), 'number',
  'a numeric frequency stays a number');
select is(pg_temp.norm(jsonb_build_array(jsonb_build_array(
    jsonb_build_object('field', 'group', 'op', 'is', 'values', array[upper((select club::text from grp))])))::text)
    -> 0 -> 0 -> 'values', jsonb_build_array((select club::text from grp)),
  'group ids are stored lowercase');
select is(pg_temp.norm(null), '[]'::jsonb, 'null rules normalize to none');

-- ---------------------------------------------------------------------------
-- The reference rule's exact ops (20261027001200)
-- ---------------------------------------------------------------------------

-- A spot with any reference columns, the rest as pg_temp.spot gives them.
create function pg_temp.refspot(p_refs jsonb)
returns raw_spots language sql as $$
  select jsonb_populate_record(null::raw_spots, jsonb_build_object(
    'id', 0, 'source', 'pota', 'source_spot_id', 'x', 'content_hash', 'x', 'ingested_at', now(), 'spot_time', now(),
    'callsign', 'W1AW', 'frequency_khz', 14062, 'band', '20m', 'mode', 'cw', 'comment', '', 'raw_payload', '{}',
    'mode_family', 'cw', 'base_callsign', 'W1AW') || p_refs);
$$;

select is(pg_temp.norm('[[{"field":"reference","op":"is","values":[" us-1000 ","US-1000","w4c/cm-001"]}],
                         [{"field":"reference","op":"is_not","values":["kff-1234"]}]]'),
  '[[{"field":"reference","op":"is","values":["US-1000","W4C/CM-001"]}],
    [{"field":"reference","op":"is_not","values":["KFF-1234"]}]]'::jsonb,
  'reference is / is_not: values trimmed, upper-cased and de-duplicated');
select is(pg_temp.norm('[[{"field":"reference","op":"contains","values":[" us-nc "]}]]') -> 0 -> 0 -> 'values',
  '["us-nc"]'::jsonb, 'reference contains keeps its values as typed, trimmed');
select throws_ok(format('select pg_temp.norm(%L)', jsonb_build_array(jsonb_build_array(
    jsonb_build_object('field', 'reference', 'op', 'is', 'values', array['US-1000', repeat('A', 65)])))),
  'P0001', 'A reference can be at most 64 characters.', 'an exact reference is at most 64 characters');
select throws_ok($$ select pg_temp.norm('[[{"field":"reference","op":"is","values":["US-1000, US-1001"]}]]') $$,
  'P0001', 'A reference takes letters, digits, / and -, such as US-2763 or W4C/CM-001.',
  'an exact reference refuses a comma-joined list, which would never match');
select throws_ok($$ select pg_temp.norm('[[{"field":"reference","op":"is_not","values":["US 1000"]}]]') $$,
  'P0001', 'A reference takes letters, digits, / and -, such as US-2763 or W4C/CM-001.',
  'is_not refuses a value outside the reference shape too');
select lives_ok(format('select pg_temp.norm(%L)', jsonb_build_array(jsonb_build_array(
    jsonb_build_object('field', 'reference', 'op', 'is_not', 'values', array[repeat('A', 64), 'ZZ-0000'])))),
  'a 64-character reference, and one in no catalog, are accepted');
select lives_ok(format('select pg_temp.norm(%L)', jsonb_build_array(jsonb_build_array(
    jsonb_build_object('field', 'reference', 'op', 'contains', 'values', array[repeat('A', 65)])))),
  'contains keeps no length limit, so stored connections still save');
select throws_ok($$ select pg_temp.norm('[[{"field":"reference","op":"is","values":[" "]}]]') $$,
  'P0001', 'Give the reference rule a value.', 'an exact reference rule needs a value');

select ok(spot_matches(pg_temp.one('reference', 'is', '["US-1000"]'), pg_temp.refspot('{"pota_reference":"US-1000"}')),
  'reference is: a park equal to the value matches');
select ok(not spot_matches(pg_temp.one('reference', 'is', '["US-1000"]'), pg_temp.refspot('{"pota_reference":"US-10000"}'))
          and spot_matches(pg_temp.one('reference', 'contains', '["US-1000"]'), pg_temp.refspot('{"pota_reference":"US-10000"}')),
  'reference is: US-1000 does not match US-10000, which contains matches');
select ok(spot_matches(pg_temp.one('reference', 'is', '["US-1000"]'), pg_temp.refspot('{"pota_reference":"us-1000"}')),
  'reference is: case-insensitive');
select ok(spot_matches(pg_temp.one('reference', 'is', '["W4C/CM-001"]'),
                       pg_temp.refspot('{"source":"sotawatch","sota_summit_ref":"W4C/CM-001"}'))
          and spot_matches(pg_temp.one('reference', 'is', '["KFF-1234"]', '{wwff}'),
                           pg_temp.refspot('{"source":"wwff","wwff_reference":"KFF-1234"}'))
          and spot_matches(pg_temp.one('reference', 'is', '["OC-001"]', '{dxcluster}'),
                           pg_temp.refspot('{"source":"dxcluster","iota_reference":"OC-001"}')),
  'reference is: a summit, a WWFF reference and an IOTA island (their sources named, as source_matches needs)');
select ok(spot_matches(pg_temp.one('reference', 'is', '["B/G-2115"]', '{wwbota}'),
                       pg_temp.refspot('{"source":"wwbota","wwbota_references":["B/G-2114","b/g-2115"]}')),
  'reference is: any of a WWBOTA spot''s bunkers, not only the first');
select ok(not spot_matches(pg_temp.one('reference', 'is', '["US-NC"]'),
                           pg_temp.refspot('{"pota_reference":"US-1000","pota_location":"US-NC"}')),
  'reference is: a park''s location is not a reference');
select ok(not spot_matches(pg_temp.one('reference', 'is_not', '["US-1000"]'), pg_temp.refspot('{"pota_reference":"US-1000"}')),
  'reference is_not: excludes the reference');
select ok(spot_matches(pg_temp.one('reference', 'is_not', '["US-1000"]'), pg_temp.refspot('{"pota_reference":"US-10000"}')),
  'reference is_not: passes another reference');
select ok(spot_matches(pg_temp.one('reference', 'is_not', '["US-1000"]'), pg_temp.refspot('{}')),
  'reference is_not: passes a spot with no reference');
select ok(not spot_matches(pg_temp.one('reference', 'is', '["US-1000"]'), pg_temp.refspot('{}')),
  'reference is: a spot with no reference never matches');

-- preview_subscription goes through the same validator and matcher.
insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, spotter, frequency_khz, band, mode,
                       mode_family, pota_reference, raw_payload)
values ('pota', 'ref-a', 'ref-a', now() - interval '1 hour', 'W1AW', 'K4SWL', 14062, '20m', 'cw', 'cw', 'US-1000', '{}'),
       ('pota', 'ref-b', 'ref-b', now() - interval '1 hour', 'K4SWL', 'W1AW', 14062, '20m', 'cw', 'cw', 'US-10000', '{}');
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is((select array[(select count from preview_subscription(
                            '{"sources":["pota"],"rules":[[{"field":"reference","op":"is","values":[" us-1000 "]}]]}')),
                        (select count from preview_subscription(
                            '{"sources":["pota"],"rules":[[{"field":"reference","op":"contains","values":["US-1000"]}]]}')),
                        (select count from preview_subscription(
                            '{"sources":["pota"],"rules":[[{"field":"reference","op":"is_not","values":["US-1000"]}]]}'))]),
  array[1, 2, 1]::bigint[], 'preview: is US-1000 finds one park, contains both, is_not the other');
select throws_ok($$ select * from preview_subscription(jsonb_build_object('rules', jsonb_build_array(jsonb_build_array(
    jsonb_build_object('field', 'reference', 'op', 'is', 'values', array[repeat('A', 65)]))))) $$,
  'P0001', 'A reference can be at most 64 characters.', 'preview checks an exact reference as save does');
reset role;
delete from raw_spots where source_spot_id in ('ref-a', 'ref-b');

-- ---------------------------------------------------------------------------
-- preview_subscription
-- ---------------------------------------------------------------------------

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is((select station_count from preview_subscription(jsonb_build_object('rules', jsonb_build_array(
    jsonb_build_array(jsonb_build_object('field', 'callsign', 'op', 'is', 'values', array['W1AW', 'w1aw/p', 'KK4PWJ'])),
    jsonb_build_array(jsonb_build_object('field', 'group', 'op', 'is', 'values', array[(select club from grp), (select id from other_grp)])),
    jsonb_build_array(jsonb_build_object('field', 'callsign', 'op', 'is_not', 'values', array['K9NOT']),
                      jsonb_build_object('field', 'group', 'op', 'is_not', 'values', array[(select rivals from grp)])))))),
  3::bigint, 'station_count: distinct base calls in positive callsign rules and own groups; is_not rules and other users'' groups do not count');
select throws_ok($$ select * from preview_subscription('{"rules":[[{"field":"band","op":"near","values":["20m"]}]]}') $$,
  'P0001', 'A band rule can''t use near.', 'preview checks the rules as save does');

-- ---------------------------------------------------------------------------
-- save_subscription
-- ---------------------------------------------------------------------------

select throws_ok($$ select save_subscription('{"name":"x","bands":["20m"]}') $$,
  'P0001', 'Filters are rules now: send rules instead of bands, modes, callsigns, reference or group_ids.', 'bands is refused');
select throws_ok($$ select save_subscription('{"name":"x","modes":[]}') $$,
  'P0001', 'Filters are rules now: send rules instead of bands, modes, callsigns, reference or group_ids.', 'modes is refused, even empty');
select throws_ok($$ select save_subscription('{"name":"x","callsigns":["W1AW"]}') $$,
  'P0001', 'Filters are rules now: send rules instead of bands, modes, callsigns, reference or group_ids.', 'callsigns is refused');
select throws_ok($$ select save_subscription('{"name":"x","reference":"US-NC"}') $$,
  'P0001', 'Filters are rules now: send rules instead of bands, modes, callsigns, reference or group_ids.', 'reference is refused');
select throws_ok($$ select save_subscription('{"name":"x","group_ids":[]}') $$,
  'P0001', 'Filters are rules now: send rules instead of bands, modes, callsigns, reference or group_ids.', 'group_ids is refused');

create temp table s1 as select save_subscription(jsonb_build_object('name', 'Rules', 'destinations', array[(select id from dest)],
  'rules', jsonb_build_array(
    jsonb_build_array(jsonb_build_object('field', 'group', 'op', 'is', 'values', array[(select club from grp)]),
                      jsonb_build_object('field', 'band', 'op', 'is', 'values', array['20m'])),
    jsonb_build_array(jsonb_build_object('field', 'group', 'op', 'is_not', 'values', array[(select rivals from grp)]),
                      jsonb_build_object('field', 'mode', 'op', 'is', 'values', array['CW']))))) as id;
select is((select rules -> 1 -> 1 -> 'values' from subscriptions where id = (select id from s1)), '["cw"]'::jsonb,
  'save stores normalized rules');
select is((select group_ids from subscriptions where id = (select id from s1)),
  (select array_agg(x order by x) from (select club as x from grp union all select rivals from grp) t),
  'group_ids is every group the rules name, positive or not');
select is(save_subscription(jsonb_build_object('id', (select id from s1), 'name', 'Rules v2', 'destinations', array[(select id from dest)])),
  (select id from s1), 'an update without rules saves');
select is((select jsonb_array_length(rules) from subscriptions where id = (select id from s1)), 2,
  'an update without rules keeps the stored rules');
select is(save_subscription(jsonb_build_object('id', (select id from s1), 'name', 'Rules v3', 'rules', null,
  'destinations', array[(select id from dest)])), (select id from s1), 'an update with null rules saves');
select is((select jsonb_array_length(rules) from subscriptions where id = (select id from s1)), 2,
  'null rules keep the stored rules too');

-- A group named only in an is_not rule still counts as in use.
select save_subscription(jsonb_build_object('id', (select id from s1), 'name', 'Not rivals', 'destinations', array[(select id from dest)],
  'rules', jsonb_build_array(jsonb_build_array(
    jsonb_build_object('field', 'group', 'op', 'is_not', 'values', array[(select rivals from grp)])))));
select is((select group_ids from subscriptions where id = (select id from s1)), array[(select rivals from grp)],
  'group_ids follows the rules on update');
select throws_ok(format('select delete_callsign_group(%L)', (select rivals from grp)), 'LL409', 'Remove it from its connections first.',
  'a group used only in an is_not rule cannot be deleted');
select lives_ok(format('select delete_callsign_group(%L)', (select club from grp)),
  'a group the rules no longer name can be deleted');
select is((select subscription_count from list_callsign_groups() where id = (select rivals from grp)), 1::bigint,
  'list_callsign_groups counts a subscription naming the group in an is_not rule');

-- patch_subscription (service role only; the API calls it as the token's owner, whose
-- claims as_user left set) leaves group_ids to save_subscription.
reset role;
select lives_ok(format('select patch_subscription(%L, %L)', (select id from s1), '{"quiet_minutes": 30}'),
  'a patch saves although the stored row has group_ids');
select is((select group_ids from subscriptions where id = (select id from s1)), array[(select rivals from grp)],
  'a patch without rules keeps group_ids');

-- Grants: the helpers are not client RPCs.
select ok(not has_function_privilege('authenticated', 'public.normalize_subscription_rules(jsonb, uuid, boolean)', 'execute')
          and not has_function_privilege('authenticated', 'public.rules_name_stations(jsonb)', 'execute')
          and not has_function_privilege('authenticated', 'public.rule_matches(jsonb, raw_spots)', 'execute')
          and not has_function_privilege('anon', 'public.normalize_subscription_rules(jsonb, uuid, boolean)', 'execute'),
  'clients cannot call the rule helpers');
select hasnt_function('public', 'edit_subscription_callsigns', array['uuid', 'jsonb', 'jsonb'], 'edit_subscription_callsigns is dropped');
select hasnt_column('public', 'subscriptions', 'callsigns', 'the callsigns column is gone');

select * from finish();
rollback;

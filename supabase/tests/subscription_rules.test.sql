-- pgTAP: subscription rules (20261014000500). Each op per field, AND inside a
-- group and OR between groups, the per-group RBN guard and its trigger,
-- watched_among over rules, normalize_subscription_rules, preview, and
-- save_subscription's legacy keys, kept rules and derived group_ids, and the goal rule
-- (20261029001200): validation, matching, the save's lock and the preview's skipped_worked.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(169);

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
          '{}'::jsonb, p_family, public.base_callsign(p_call), null, null, null, null, null, null, null)::raw_spots;
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
-- At most 5,000 values across a connection's rules (20261029000200), counted after normalising.
create temp table five_k as
  select jsonb_agg(jsonb_build_object('field', 'callsign', 'op', 'is_not', 'values',
           (select jsonb_agg('W' || (g * 1000 + i)) from generate_series(1, 1000) as i))) as rules
  from generate_series(1, 5) as g;
select lives_ok(format('select pg_temp.norm(%L)', (select jsonb_build_array(rules) from five_k)),
  '5,000 values across five rules are allowed');
select throws_ok(format('select pg_temp.norm(%L)', (select jsonb_build_array(
    rules || '[{"field":"band","op":"is","values":["20m"]}]'::jsonb) from five_k)),
  'P0001', 'A connection can have up to 5,000 values across its rules.', 'a 5,001st value is refused');
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

-- ---------------------------------------------------------------------------
-- The goal rule (20261029001200)
-- ---------------------------------------------------------------------------

-- User 1's lists. Chase: states NC, VA, GA (all), parks US-2763, US-0001 (all), bands 20m, 40m,
-- 80m (at least 2). Bands only: 20m, 40m (all). Done is complete, Ended ended yesterday, and
-- Later starts tomorrow. User 2 has a list of its own.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table nl as select
  save_goal('{"name": "Chase", "requirements": [
    {"kind": "state", "complete_when": "all", "entries": ["NC", "VA", "GA"]},
    {"kind": "park", "complete_when": "all", "entries": ["US-2763", "US-0001"]},
    {"kind": "band", "complete_when": "at_least", "at_least": 2, "entries": ["20m", "40m", "80m"]}]}') as chase,
  save_goal('{"name": "Bands only", "requirements": [
    {"kind": "band", "complete_when": "all", "entries": ["20m", "40m"]}]}') as bands,
  save_goal('{"name": "Done", "requirements": [{"kind": "band", "complete_when": "all", "entries": ["20m"]}]}') as done,
  save_goal(jsonb_build_object('name', 'Ended', 'starts_on', (now() at time zone 'utc')::date - 30,
    'ends_on', (now() at time zone 'utc')::date - 1,
    'requirements', '[{"kind": "band", "complete_when": "all", "entries": ["20m"]}]'::jsonb)) as ended,
  save_goal(jsonb_build_object('name', 'Later', 'starts_on', (now() at time zone 'utc')::date + 1,
    'ends_on', (now() at time zone 'utc')::date + 30,
    'requirements', '[{"kind": "band", "complete_when": "all", "entries": ["20m"]}]'::jsonb)) as later;
select mark_goal_entry((select id from goal_requirements where list_id = (select done from nl)), '20m', true);
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
create temp table other_nl as
  select save_goal('{"name": "Theirs", "requirements": [{"kind": "band", "complete_when": "all", "entries": ["20m"]}]}') as id;
reset role;

-- A goal rule naming p_list, and a requirement's id by kind.
create function pg_temp.nl(p_list uuid) returns subscriptions language sql as $$
  select pg_temp.one('goal', 'is', jsonb_build_array(p_list));
$$;
create function pg_temp.nreq(p_list uuid, p_kind text) returns uuid language sql as $$
  select id from goal_requirements where list_id = p_list and kind = p_kind;
$$;
create function pg_temp.potaspot(p_call text, p_band text, p_ref text, p_loc text) returns raw_spots language sql as $$
  select pg_temp.spot('pota', p_call, p_band, 'cw', 14062, null, p_ref, p_loc);
$$;
insert into callsign_licenses (callsign, authority, country, state, loaded_at)
values ('K4LIC', 'FCC', 'US', 'GA', now()), ('K5TEX', 'FCC', 'US', 'TX', now()),
       ('VE3LIC', 'ISED', 'CA', 'NC', now())
on conflict (callsign) do update set authority = excluded.authority, country = excluded.country, state = excluded.state;

-- Validation.
select throws_ok(format('select pg_temp.norm(%L)', jsonb_build_array(jsonb_build_array(
    jsonb_build_object('field', 'goal', 'op', 'is_not', 'values', array[(select chase from nl)])))),
  'P0001', 'A goal rule can''t use is_not.', 'a goal rule takes is only');
select throws_ok(format('select pg_temp.norm(%L)', jsonb_build_array(jsonb_build_array(
    jsonb_build_object('field', 'goal', 'op', 'is', 'values', array[(select chase from nl), (select bands from nl)])))),
  'P0001', 'A goal rule takes one goal.', 'a goal rule takes one list, not two');
select throws_ok($$ select pg_temp.norm('[[{"field":"goal","op":"is","values":[]}]]') $$,
  'P0001', 'A goal rule takes one goal.', 'a goal rule needs a list');
select throws_ok(format('select pg_temp.norm(%L)', jsonb_build_array(jsonb_build_array(
    jsonb_build_object('field', 'goal', 'op', 'is', 'values', array[(select id from other_nl)])))),
  'P0001', 'Goal not found.', 'strict: another user''s goal is refused');
select throws_ok($$ select pg_temp.norm('[[{"field":"goal","op":"is","values":["not-a-uuid"]}]]') $$,
  'P0001', 'Goal not found.', 'strict: a malformed goal id is refused');
select is(pg_temp.norm(jsonb_build_array(jsonb_build_array(
    jsonb_build_object('field', 'goal', 'op', 'is', 'values', array[(select id from other_nl)])))::text, false),
  '[[{"field":"goal","op":"is","values":[]}]]'::jsonb,
  'not strict: another user''s goal id is dropped');
select is(pg_temp.norm(jsonb_build_array(jsonb_build_array(
    jsonb_build_object('field', 'goal', 'op', 'is', 'values', array[' ' || upper((select chase::text from nl)) || ' '])))::text),
  jsonb_build_array(jsonb_build_array(jsonb_build_object('field', 'goal', 'op', 'is', 'values', array[(select chase::text from nl)]))),
  'a goal id is trimmed and stored lowercase');

-- Matching: still needed passes, worked drops.
select ok(spot_matches(pg_temp.nl((select chase from nl)), pg_temp.spot('sotawatch', 'W7JZ', '20m', 'cw')),
  'goal: a spot on a needed band passes');
select ok(not spot_matches(pg_temp.nl((select chase from nl)), pg_temp.spot('sotawatch', 'W7JZ', '6m', 'cw')),
  'goal: a spot on a band the list lacks, with no park or state, is kept out');
select ok(not spot_matches(pg_temp.nl((select chase from nl)), pg_temp.spot('sotawatch', 'W7JZ', null, 'cw')),
  'goal: a spot with nothing the list names is kept out');
select ok(spot_matches(pg_temp.nl((select chase from nl)), pg_temp.potaspot('W7JZ', '6m', 'us-2763', null)),
  'goal: a needed park passes, compared upper case');
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select mark_goal_entry(pg_temp.nreq((select chase from nl), 'band'), '20m', true);
select mark_goal_entry(pg_temp.nreq((select chase from nl), 'park'), 'US-2763', true);
reset role;
select ok(not spot_matches(pg_temp.nl((select chase from nl)), pg_temp.spot('sotawatch', 'W7JZ', '20m', 'cw')),
  'goal: a worked band is kept out');
select ok(not spot_matches(pg_temp.nl((select chase from nl)), pg_temp.potaspot('W7JZ', '6m', 'US-2763', null)),
  'goal: a worked park is kept out');
select ok(spot_matches(pg_temp.nl((select chase from nl)), pg_temp.potaspot('W7JZ', '20m', 'US-0001', null)),
  'goal: one needed entry is enough, though the band is worked');

-- "At least": once at_least entries are worked the requirement is complete and its other entries
-- stop passing.
select ok(spot_matches(pg_temp.nl((select chase from nl)), pg_temp.spot('sotawatch', 'W7JZ', '80m', 'cw')),
  'goal: 80m passes while the band requirement lacks one');
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select mark_goal_entry(pg_temp.nreq((select chase from nl), 'band'), '40m', true);
reset role;
select ok(not spot_matches(pg_temp.nl((select chase from nl)), pg_temp.spot('sotawatch', 'W7JZ', '80m', 'cw')),
  'goal: 2 of 3 bands worked completes the requirement, so 80m is kept out');

-- States: a POTA spot's location only; the license only for a spot without a POTA reference.
select ok(spot_matches(pg_temp.nl((select chase from nl)), pg_temp.potaspot('W7JZ', '20m', 'US-9999', 'US-NC')),
  'goal state: a POTA spot in NC passes by its location');
select ok(spot_matches(pg_temp.nl((select chase from nl)), pg_temp.potaspot('K5TEX', '20m', 'US-9998', 'US-SC,US-VA')),
  'goal state: a park on a state line passes for either state, before the license');
select ok(not spot_matches(pg_temp.nl((select chase from nl)), pg_temp.potaspot('K4LIC', '20m', 'US-9997', 'US-TX')),
  'goal state: the location wins over the license (TX, though licensed in GA)');
select ok(spot_matches(pg_temp.nl((select chase from nl)), pg_temp.spot('sotawatch', 'K4LIC/P', '20m', 'cw')),
  'goal state: a spot without a location passes by the base call''s license state (GA)');
select ok(not spot_matches(pg_temp.nl((select chase from nl)), pg_temp.potaspot('K4LIC', '6m', 'CA-0001', 'CA-ON')),
  'goal state: a park outside the US gives no state, never the license (GA), as marking does');
select is(spot_us_states(pg_temp.potaspot('K4LIC', '20m', 'CA-0001', 'CA-ON')), '{}'::text[],
  'spot_us_states: none for a park outside the US');
select is(spot_us_states(pg_temp.potaspot('K4LIC', '20m', 'US-9995', null)), '{}'::text[],
  'spot_us_states: none for a POTA spot without a location');
select is(spot_us_states(pg_temp.spot('sotawatch', 'K4LIC/P', '20m', 'cw')), array['GA'],
  'spot_us_states: the license state for a spot without a POTA reference');
select ok(not spot_matches(pg_temp.nl((select chase from nl)), pg_temp.spot('sotawatch', 'K5TEX', '20m', 'cw')),
  'goal state: a license state not on the list is kept out');
select ok(not spot_matches(pg_temp.nl((select chase from nl)), pg_temp.spot('sotawatch', 'VE3LIC', '20m', 'cw')),
  'goal state: a license from outside the US gives no state');
select is(spot_us_states(pg_temp.potaspot('W7JZ', '20m', 'US-9996', 'US-VA,US-NC,US-DC')), array['NC', 'VA'],
  'spot_us_states: the location''s states, sorted, without DC');
select ok(not spot_matches(pg_temp.nl((select bands from nl)), pg_temp.potaspot('W7JZ', '6m', 'US-2763', 'US-NC')),
  'goal: a park and a state never match a list of bands only');

-- Complete, ended and missing lists pass everything; one that has not started yet still filters.
select ok(spot_matches(pg_temp.nl((select done from nl)), pg_temp.spot('sotawatch', 'W7JZ', '20m', 'cw')),
  'goal: a complete list passes every spot');
select ok(spot_matches(pg_temp.nl((select ended from nl)), pg_temp.spot('sotawatch', 'W7JZ', '6m', 'cw')),
  'goal: an ended list passes every spot');
select ok(spot_matches(pg_temp.nl(gen_random_uuid()), pg_temp.spot('sotawatch', 'W7JZ', '6m', 'cw')),
  'goal: a missing list passes every spot');
select ok(spot_matches(pg_temp.one('goal', 'is', '[]'), pg_temp.spot('sotawatch', 'W7JZ', '6m', 'cw')),
  'goal: a rule left with no list (not strict) passes every spot');
select ok(not spot_matches(pg_temp.nl((select later from nl)), pg_temp.spot('sotawatch', 'W7JZ', '6m', 'cw')),
  'goal: a list before its start date still filters');
update goals set marking = 'hand' where id = (select bands from nl);
select ok(spot_matches(pg_temp.nl((select bands from nl)), pg_temp.spot('sotawatch', 'W7JZ', '20m', 'cw'))
          and not spot_matches(pg_temp.nl((select bands from nl)), pg_temp.spot('sotawatch', 'W7JZ', '6m', 'cw')),
  'goal: a hand-only list filters the same way');

-- It combines with the other rules: AND inside a group, OR between groups.
select ok(not spot_matches(pg_temp.sub(jsonb_build_array(jsonb_build_array(
    jsonb_build_object('field', 'goal', 'op', 'is', 'values', array[(select chase from nl)]),
    jsonb_build_object('field', 'mode', 'op', 'is', 'values', array['ssb'])))),
  pg_temp.potaspot('W7JZ', '20m', 'US-0001', null)),
  'goal AND mode: a needed park in the wrong mode is kept out');
select ok(spot_matches(pg_temp.sub(jsonb_build_array(
    jsonb_build_array(jsonb_build_object('field', 'goal', 'op', 'is', 'values', array[(select chase from nl)])),
    jsonb_build_array(jsonb_build_object('field', 'callsign', 'op', 'is', 'values', array['W7JZ'])))),
  pg_temp.spot('sotawatch', 'W7JZ', '20m', 'cw')),
  'goal OR callsign: a worked band still passes by the other group');
select ok(not spot_matches(pg_temp.one('goal', 'is', jsonb_build_array((select bands from nl)), '{rbn}'),
                           pg_temp.spot('rbn', 'W7JZ', '20m', 'cw')),
  'goal: an RBN spot needs stations named, as before');

-- save_subscription: ownership, and the delete guard through the stored rule.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select throws_ok(format('select save_subscription(%L)', jsonb_build_object('name', 'Theirs', 'rules', jsonb_build_array(jsonb_build_array(
    jsonb_build_object('field', 'goal', 'op', 'is', 'values', array[(select id from other_nl)]))))),
  'P0001', 'Goal not found.', 'save refuses another user''s goal');
create temp table nl_sub as select save_subscription(jsonb_build_object('name', 'Chasing', 'sources', array['pota'],
  'rules', jsonb_build_array(jsonb_build_array(
    jsonb_build_object('field', 'goal', 'op', 'is', 'values', array[(select chase from nl)]))))) as id;
select is((select rules from subscriptions where id = (select id from nl_sub)),
  jsonb_build_array(jsonb_build_array(jsonb_build_object('field', 'goal', 'op', 'is', 'values', array[(select chase::text from nl)]))),
  'save stores the goal rule');
select is((select group_ids from subscriptions where id = (select id from nl_sub)), '{}'::uuid[],
  'a goal is not a group');
select throws_ok(format('select delete_goal(%L)', (select chase from nl)), 'LL409', 'Remove it from its connections first.',
  'a goal a connection names cannot be deleted');
select ok(position('for key share of l' in p.prosrc) > 0
          and position('rules_goal_ids(v_rules)' in p.prosrc) > 0,
  'save_subscription takes a key-share lock on the goals it names')
from pg_proc p where p.oid = 'public.save_subscription(jsonb)'::regprocedure;

-- preview_subscription: skipped_worked counts what the goal rule kept out because of work
-- already done. Five recent POTA spots: US-0001 (needed), US-2763 (worked, on 20m and 40m, both
-- worked bands) twice, 20m in GA (a needed state), 6m at a park and in a state the list does not
-- chase (kept out, but never "already worked").
reset role;
insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, spotter, frequency_khz, band, mode,
                       mode_family, pota_reference, pota_location, raw_payload)
values ('pota', 'nl-a', 'nl-a', now() - interval '1 hour', 'W1AW', 'K4SWL', 14062, '20m', 'cw', 'cw', 'US-0001', 'US-TX', '{}'),
       ('pota', 'nl-b', 'nl-b', now() - interval '1 hour', 'N0ONE', 'K4SWL', 14062, '20m', 'cw', 'cw', 'US-2763', 'US-TX', '{}'),
       ('pota', 'nl-c', 'nl-c', now() - interval '1 hour', 'N0TWO', 'K4SWL', 7030, '40m', 'ssb', 'phone', 'US-2763', 'US-TX', '{}'),
       ('pota', 'nl-d', 'nl-d', now() - interval '1 hour', 'K4LIC', 'K4SWL', 14062, '20m', 'cw', 'cw', 'US-9999', 'US-GA', '{}'),
       ('pota', 'nl-e', 'nl-e', now() - interval '1 hour', 'N0SIX', 'K4SWL', 50313, '6m', 'cw', 'cw', 'US-9998', 'US-TX', '{}');
create function pg_temp.preview(p_rules jsonb)
returns table (count bigint, window_size bigint, skipped_worked int) language sql as $$
  select p.count, p.window_size, p.skipped_worked
  from preview_subscription(jsonb_build_object('sources', array['pota'], 'rules', p_rules)) p;
$$;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is((select row(p.*)::text from pg_temp.preview(jsonb_build_array(jsonb_build_array(
    jsonb_build_object('field', 'goal', 'op', 'is', 'values', array[(select chase from nl)])))) p),
  '(2,5,2)', 'preview: 2 of 5 pass the goal; of the 3 kept out, only the 2 at a worked park count as already worked');
select is((select row(p.*)::text from pg_temp.preview(jsonb_build_array(jsonb_build_array(
    jsonb_build_object('field', 'goal', 'op', 'is', 'values', array[(select chase from nl)]),
    jsonb_build_object('field', 'mode', 'op', 'is', 'values', array['cw'])))) p),
  '(2,5,1)', 'preview: skipped_worked counts only spots the other rules pass');
select is((select row(p.*)::text from pg_temp.preview(jsonb_build_array(
    jsonb_build_array(jsonb_build_object('field', 'goal', 'op', 'is', 'values', array[(select chase from nl)])),
    jsonb_build_array(jsonb_build_object('field', 'band', 'op', 'is', 'values', array['40m'])))) p),
  '(3,5,1)', 'preview: a spot another group passes is matched, not skipped');
select is((select row(p.*)::text from pg_temp.preview(jsonb_build_array(jsonb_build_array(
    jsonb_build_object('field', 'goal', 'op', 'is', 'values', array[(select done from nl)])))) p),
  '(5,5,0)', 'preview: a complete list skips nothing');
select is((select row(p.*)::text from pg_temp.preview('[[{"field":"band","op":"is","values":["20m"]}]]') p),
  '(3,5,)', 'preview: skipped_worked is null without a goal rule');
select is((select row(p.*)::text from pg_temp.preview(jsonb_build_array(jsonb_build_array(
    jsonb_build_object('field', 'goal', 'op', 'is', 'values', array[(select id from other_nl)])))) p),
  '(5,5,)', 'preview: another user''s list is dropped, so the rule passes everything and nothing is skipped');
select is((select row(p.*)::text from pg_temp.preview(jsonb_build_array(jsonb_build_array(
    jsonb_build_object('field', 'goal', 'op', 'is', 'values', array[(select chase from nl)]),
    jsonb_build_object('field', 'goal', 'op', 'is', 'values', array[(select later from nl)])))) p),
  '(2,5,1)', 'preview: with two lists in a group, a spot counts only when each list that rejects it does so for work done (40m at US-2763: Later does not chase 40m)');
reset role;
select ok((select goal_skips_worked((select chase from nl), r) from raw_spots r where r.source_spot_id = 'nl-b'),
  'goal_skips_worked: a spot at a worked park');
select ok((select not goal_skips_worked((select chase from nl), r) from raw_spots r where r.source_spot_id = 'nl-e'),
  'goal_skips_worked: not a spot the list does not chase');
select ok((select not goal_skips_worked((select chase from nl), r) from raw_spots r where r.source_spot_id = 'nl-a'),
  'goal_skips_worked: not a spot the list still needs');
select ok((select not goal_skips_worked((select done from nl), r) from raw_spots r where r.source_spot_id = 'nl-b')
          and not goal_skips_worked(gen_random_uuid(), pg_temp.potaspot('W7JZ', '20m', 'US-2763', null)),
  'goal_skips_worked: never for a list that is off (complete) or missing');
delete from raw_spots where source_spot_id like 'nl-_';

select ok(not has_function_privilege('authenticated', 'public.goal_matches(uuid, raw_spots)', 'execute')
          and not has_function_privilege('authenticated', 'public.spot_us_states(raw_spots)', 'execute')
          and not has_function_privilege('authenticated', 'public.goal_skips_worked(uuid, raw_spots)', 'execute')
          and not has_function_privilege('authenticated', 'public.goal_spot_values(raw_spots)', 'execute')
          and not has_function_privilege('anon', 'public.goal_matches(uuid, raw_spots)', 'execute'),
  'clients cannot call the goal matchers');

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

-- Account cap (20261029000200): 100 connections. Only a create is refused; a full account can
-- still save the connections it has.
reset role;
insert into subscriptions (user_id, name)
select '22222222-2222-2222-2222-222222222222', 'Cap ' || i
from generate_series(1, 100 - (select count(*) from subscriptions where user_id = '22222222-2222-2222-2222-222222222222')) as i;
select is((select count(*) from subscriptions where user_id = '22222222-2222-2222-2222-222222222222'), 100::bigint,
  'an account can hold 100 connections');
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select throws_ok($$ select save_subscription('{"name":"One more"}') $$,
  'P0001', 'You can have up to 100 connections.', 'save_subscription refuses a 101st connection');
select lives_ok(format('select save_subscription(%L)', jsonb_build_object('id',
    (select id from subscriptions where user_id = '22222222-2222-2222-2222-222222222222' and name = 'Cap 1'), 'name', 'Cap renamed')),
  'a connection of a full account can still be saved');
reset role;

select * from finish();
rollback;

-- pgTAP: callsign groups (20261013000100, 20261013000210). The normaliser,
-- whole-list saves (name rules, base calls, the 1,000 cap, rejections, the
-- member diff), list_callsign_groups with on_air, the base-call rewrite, the
-- delete guard, group ownership in save_subscription, RLS from another user's
-- view, and grants.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(90);

-- Grants: clients read only; every write goes through an RPC.
select table_privs_are('public', 'callsign_groups', 'authenticated', array['SELECT'], 'authenticated may only select groups');
select table_privs_are('public', 'callsign_group_members', 'authenticated', array['SELECT'], 'authenticated may only select members');
select table_privs_are('public', 'callsign_groups', 'anon', '{}'::text[], 'anon has no access to groups');
select table_privs_are('public', 'callsign_group_members', 'anon', '{}'::text[], 'anon has no access to members');

-- The per-call RPCs from 20261013000100 are replaced by the whole-list save.
select hasnt_function('public', 'create_callsign_group', array['text'], 'create_callsign_group is dropped');
select hasnt_function('public', 'rename_callsign_group', array['uuid', 'text'], 'rename_callsign_group is dropped');
select hasnt_function('public', 'add_group_callsigns', array['uuid', 'text[]'], 'add_group_callsigns is dropped');
select hasnt_function('public', 'remove_group_callsigns', array['uuid', 'text[]'], 'remove_group_callsigns is dropped');
select ok(not has_function_privilege('authenticated', 'public.rebase_callsign_group_members()', 'execute'),
  'the base-call rewrite is not callable by clients');

-- Not signed in.
set local role authenticated;
set local request.jwt.claims = '';
select throws_ok($$ select save_callsign_group('{"name":"x"}') $$, 'P0001', 'Not signed in.', 'save needs a session');
select throws_ok($$ select * from list_callsign_groups() $$, 'P0001', 'Not signed in.', 'list needs a session');
select throws_ok(format('select delete_callsign_group(%L)', gen_random_uuid()), 'P0001', 'Not signed in.', 'delete needs a session');
reset role;

-- The normaliser: trim any whitespace (trim() alone strips only spaces; pastes
-- and CSV cells bring tabs, line ends and non-breaking spaces), uppercase,
-- validate as typed, then map to base calls and de-duplicate.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table n1 as select normalize_group_callsigns(array[
  ' w1aw ', 'W1AW/P', E'\tkk4pwj\r', 'zz9zz!', 'Zz9zz!', '', E'\r\n', E' k2abc ', 'abc', 'vp2v/w1aw', 'W1AW/12345']) as r;
select is((select array(select jsonb_array_elements_text(r -> 'callsigns')) from n1), array['K2ABC', 'KK4PWJ', 'W1AW'],
  'normalised calls are trimmed, uppercased, base calls, de-duplicated and alphabetical');
select is((select array(select jsonb_array_elements_text(r -> 'rejected')) from n1), array['ZZ9ZZ!', 'ABC', 'W1AW/12345'],
  'rejected values come back uppercased, once each, in the order given, and blanks are skipped');
select is(normalize_group_callsigns(null), '{"callsigns": [], "rejected": []}'::jsonb, 'a null list normalises to nothing');

-- Create: the name is trimmed and members are stored as base calls.
create temp table g1 as select save_callsign_group(
  '{"name":"  Club roster ","callsigns":["w1aw","W1AW/P","kk4pwj","VP2V/W1AW"]}') as id;
select is((select name from callsign_groups where id = (select id from g1)), 'Club roster', 'name stored trimmed');
select is((select array_agg(callsign order by callsign) from callsign_group_members where group_id = (select id from g1)),
  array['KK4PWJ', 'W1AW'], 'members stored as base calls, once each');
create temp table g2 as select save_callsign_group('{"name":"Friends"}') as id;
select is((select count(*) from callsign_group_members where group_id = (select id from g2)), 0::bigint,
  'a save without callsigns makes an empty group');

-- Name rules.
select throws_ok($$ select save_callsign_group('{"name":"club ROSTER","callsigns":[]}') $$, 'P0001',
  'You already have a group with that name.', 'duplicate name refused regardless of case');
select throws_ok($$ select save_callsign_group('{"name":"   ","callsigns":["W1AW"]}') $$, 'P0001',
  'Give the group a name.', 'blank name refused');
select throws_ok($$ select save_callsign_group('{"callsigns":["W1AW"]}') $$, 'P0001',
  'Give the group a name.', 'missing name refused');
select throws_ok(format('select save_callsign_group(%L)', jsonb_build_object('id', (select id from g2), 'name', 'CLUB roster')),
  'P0001', 'You already have a group with that name.', 'renaming to a taken name refused');
select lives_ok(format('select save_callsign_group(%L)', jsonb_build_object('id', (select id from g2), 'name', ' Pals ')),
  'a group can be renamed');
select is((select name from callsign_groups where id = (select id from g2)), 'Pals', 'rename stored trimmed');
select lives_ok(format('select save_callsign_group(%L)', jsonb_build_object('id', (select id from g2), 'name', 'PALS')),
  'a group can change the case of its own name');
select throws_ok(format('select save_callsign_group(%L)', jsonb_build_object('id', gen_random_uuid(), 'name', 'x')),
  'P0001', 'Group not found.', 'an unknown id is refused');

-- Rejection: the first rejected value is named and nothing is written.
select throws_ok($$ select save_callsign_group('{"name":"Bad","callsigns":["W1AW","zz9zz!","abc"]}') $$, 'P0001',
  'Not a callsign: ZZ9ZZ!.', 'a save with an invalid call names the first one');
select is((select count(*) from callsign_groups where name = 'Bad'), 0::bigint, 'a rejected create writes nothing');
select throws_ok(format('select save_callsign_group(%L)', jsonb_build_object('id', (select id from g1), 'name', 'Renamed',
  'callsigns', array['N0CALL', 'abc'])), 'P0001', 'Not a callsign: ABC.', 'a rejected update is refused');
select is((select name from callsign_groups where id = (select id from g1)), 'Club roster', 'a rejected update keeps the name');
select is((select array_agg(callsign order by callsign) from callsign_group_members where group_id = (select id from g1)),
  array['KK4PWJ', 'W1AW'], 'a rejected update keeps the members');

-- Diff save: unchanged rows are not rewritten; gone ones go, new ones come.
reset role;
set local session_replication_role = replica;
update callsign_groups set updated_at = '2000-01-01' where id = (select id from g1);
set local session_replication_role = origin;
create temp table kept as select ctid::text as t from callsign_group_members where group_id = (select id from g1) and callsign = 'KK4PWJ';
grant select on kept to authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');

select is(save_callsign_group(jsonb_build_object('id', (select id from g1), 'name', 'Club roster',
  'callsigns', array['kk4pwj', 'N0CALL/P'])), (select id from g1), 'an update returns the group id');
select is((select array_agg(callsign order by callsign) from callsign_group_members where group_id = (select id from g1)),
  array['KK4PWJ', 'N0CALL'], 'the update replaces the member list');
select is((select ctid::text from callsign_group_members where group_id = (select id from g1) and callsign = 'KK4PWJ'),
  (select t from kept), 'a member that stays is not rewritten');
select is((select updated_at from callsign_groups where id = (select id from g1)), now(), 'saving bumps the group''s updated_at');

-- The cap is 1,000 calls after de-duplication.
create temp table thousand as select array(select format('W%sA', n) from generate_series(1, 1000) as n) as calls;
select lives_ok(format('select save_callsign_group(%L)', jsonb_build_object('id', (select id from g2), 'name', 'PALS',
  'callsigns', (select calls from thousand) || array['W1A/P', 'w2a'])), 'exactly 1,000 calls after de-duplication save');
select is((select count(*) from callsign_group_members where group_id = (select id from g2)), 1000::bigint, 'all 1,000 are stored');
select throws_ok(format('select save_callsign_group(%L)', jsonb_build_object('id', (select id from g2), 'name', 'PALS',
  'callsigns', (select calls from thousand) || array['K1ABC'])), 'P0001', 'A group can hold up to 1,000 callsigns.',
  '1,001 calls are refused');
select is((select count(*) from callsign_group_members where group_id = (select id from g2) and callsign = 'K1ABC'), 0::bigint,
  'a refused save adds nothing');
select throws_ok(format('select save_callsign_group(%L)', jsonb_build_object('name', 'Big',
  'callsigns', (select calls from thousand) || array['K1ABC'])), 'P0001', 'A group can hold up to 1,000 callsigns.',
  'a new group over the cap is refused');
select lives_ok(format('select save_callsign_group(%L)', jsonb_build_object('id', (select id from g2), 'name', 'PALS',
  'callsigns', '[]'::jsonb)), 'an empty list clears the group');
select is((select count(*) from callsign_group_members where group_id = (select id from g2)), 0::bigint, 'cleared group has no members');

-- The stored form: base calls in the profile callsign format, whoever writes.
reset role;
select throws_ok(format('insert into callsign_group_members (group_id, callsign) values (%L, %L)', (select id from g1), 'junk'),
  '23514', null, 'member callsigns are checked');
select throws_ok(format('insert into callsign_group_members (group_id, callsign) values (%L, %L)', (select id from g1), 'W1AW/P'),
  '23514', null, 'members must be base calls');
select throws_ok(format('insert into callsign_groups (user_id, name) values (%L, %L)', '11111111-1111-1111-1111-111111111111', ' x'),
  '23514', null, 'group names are checked trimmed');

-- The rewrite 20261013000210 ran over existing rows, and what a later
-- base_callsign() change runs again: rows become base calls, and duplicates
-- and calls whose base fails the format go.
alter table callsign_group_members drop constraint callsign_group_members_base_call;
insert into callsign_group_members (group_id, callsign) values
  ((select id from g1), 'KK4PWJ/P'), ((select id from g1), 'W1AW/P'), ((select id from g1), 'W1AW/M'),
  ((select id from g1), 'K4ABC/QRP'), ((select id from g1), 'K4XYZ/123456');
select lives_ok('select rebase_callsign_group_members()', 'the base-call rewrite runs');
select is((select array_agg(callsign order by callsign) from callsign_group_members where group_id = (select id from g1)),
  array['K4ABC', 'KK4PWJ', 'N0CALL', 'W1AW'], 'members are rewritten to base calls, once each');
select lives_ok($$ alter table callsign_group_members add constraint callsign_group_members_base_call
  check (callsign = public.base_callsign(callsign)) $$, 'every rewritten row passes the base-call check');
select lives_ok(format($f$ select save_callsign_group('{"id":"%s","name":"Club roster","callsigns":["KK4PWJ","N0CALL"]}') $f$,
  (select id from g1)), 'the rewritten group saves back');

-- Subscriptions: group rules must name the caller's groups; group_ids is derived from the rules.
create function pg_temp.group_rule(p_ids uuid[]) returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_array(jsonb_build_object('field', 'group', 'op', 'is', 'values', to_jsonb(p_ids))))
$$;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table da as select * from create_destination('discord', 'A discord', 'https://discord.com/api/webhooks/1/a');
create temp table s1 as select save_subscription(jsonb_build_object('name', 'Club', 'rules', pg_temp.group_rule(array[(select id from g1)]),
  'destinations', array[(select id from da)])) as id;
select is((select group_ids from subscriptions where id = (select id from s1)), array[(select id from g1)], 'group ids derived from the rules');
select throws_ok(format('select save_subscription(%L)', jsonb_build_object('name', 'x', 'rules', pg_temp.group_rule(array[gen_random_uuid()]),
  'destinations', array[(select id from da)])), 'P0001', 'Group not found.', 'an unknown group id is refused');
select throws_ok(format('select save_subscription(%L)', jsonb_build_object('name', 'x', 'rules', pg_temp.group_rule(array[(select id from g1), gen_random_uuid()]),
  'destinations', array[(select id from da)])), 'P0001', 'Group not found.', 'one unknown group among owned ones is refused');
select is(save_subscription(jsonb_build_object('id', (select id from s1), 'name', 'Club v2',
  'destinations', array[(select id from da)])), (select id from s1), 'an update without rules saves');
select is((select group_ids from subscriptions where id = (select id from s1)), array[(select id from g1)],
  'an update without rules keeps the groups');
select is(save_subscription(jsonb_build_object('id', (select id from s1), 'name', 'Club',
  'rules', '[]'::jsonb, 'destinations', array[(select id from da)])), (select id from s1), 'empty rules save');
select is((select group_ids from subscriptions where id = (select id from s1)), '{}'::uuid[], 'empty rules clear the groups');
select is(save_subscription(jsonb_build_object('id', (select id from s1), 'name', 'Club',
  'rules', pg_temp.group_rule(array[(select id from g1), (select id from g1)]), 'destinations', array[(select id from da)])),
  (select id from s1), 'a repeated group id saves');
select is((select group_ids from subscriptions where id = (select id from s1)), array[(select id from g1)], 'group ids are de-duplicated');

-- On the air now: members spotted in raw_spots in the last 30 minutes, by base call.
reset role;
insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, frequency_khz, band, mode, comment,
                       pota_reference, sota_summit_ref, raw_payload) values
  ('pota', 'cg1', 'cg1', now() - interval '2 minutes', 'KK4PWJ/P', 14062, '20m', 'cw', '', 'US-2763', null, '{}'),
  ('sotawatch', 'cg2', 'cg2', now() - interval '29 minutes', 'KK4PWJ', 7032, '40m', 'cw', '', null, 'W4C/CM-001', '{}'),
  ('sotawatch', 'cg3', 'cg3', now() - interval '10 minutes', 'AB4RD', 7185, '40m', 'ssb', '', null, 'W4C/WM-001', '{}'),
  ('pota', 'cg4', 'cg4', now() - interval '31 minutes', 'N4DXX', 14250, '20m', 'ssb', '', 'US-0817', null, '{}');
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table g3 as select save_callsign_group('{"name":"Field Day crew","callsigns":["KK4PWJ","N4DXX","AB4RD","KO4YUF"]}') as id;
create temp table g4 as select save_callsign_group('{"name":"Summits","callsigns":["AB4RD"]}') as id;
create temp table listed as select * from list_callsign_groups();

select is((select array_agg(name) from listed), array['Club roster', 'Field Day crew', 'PALS', 'Summits'],
  'list_callsign_groups orders by name');
select results_eq(
  $$ select name, member_count, subscription_count from listed order by lower(name) $$,
  $$ values ('Club roster', 2::bigint, 1::bigint), ('Field Day crew', 4::bigint, 0::bigint),
            ('PALS', 0::bigint, 0::bigint), ('Summits', 1::bigint, 0::bigint) $$,
  'list_callsign_groups counts members and subscriptions');
select is((select callsigns from listed where name = 'Field Day crew'), array['AB4RD', 'KK4PWJ', 'KO4YUF', 'N4DXX'],
  'callsigns lists every member alphabetically');
select is((select callsigns from listed where name = 'PALS'), '{}'::text[], 'an empty group lists no callsigns');
select is((select (on_air ->> 'count')::int from listed where name = 'Field Day crew'), 2,
  'on_air counts distinct members spotted in the last 30 minutes, not the one at 31');
select is((select on_air -> 'latest' from listed where name = 'Field Day crew'),
  jsonb_build_object('callsign', 'KK4PWJ/P', 'frequency_khz', 14062.000, 'band', '20m', 'mode', 'cw', 'source', 'pota',
                     'reference', 'US-2763', 'spot_time', now() - interval '2 minutes'),
  'latest is the newest spot, matched through its base call');
select is((select on_air -> 'latest' ->> 'reference' from listed where name = 'Summits'), 'W4C/WM-001',
  'a SOTA spot''s reference is its summit');
select is((select on_air from listed where name = 'PALS'), '{"count": 0, "latest": null}'::jsonb, 'a group off the air');
select is((select (on_air ->> 'count')::int from listed where name = 'Club roster'), 1,
  'a member spotted twice counts once');

-- RBN reports stations by callsign; a group is a list of them.
create temp table s_rbn as select save_subscription(jsonb_build_object('name', 'RBN club', 'sources', array['rbn'],
  'rules', pg_temp.group_rule(array[(select id from g1)]), 'destinations', array[(select id from da)])) as id;
select is((select group_ids from subscriptions where id = (select id from s_rbn)), array[(select id from g1)],
  'an RBN subscription can name a group instead of callsigns');
select throws_ok(format($f$ select save_subscription('{"name":"x","sources":["rbn"],"destinations":["%s"]}') $f$, (select id from da)),
  'P0001', 'RBN reports stations by callsign. Add at least one callsign.', 'an RBN subscription still needs callsigns or a group');
select lives_ok(format('select delete_subscription(%L)', (select id from s_rbn)), 'RBN subscription removed');

-- Delete guard.
select throws_ok(format('select delete_callsign_group(%L)', (select id from g1)), 'P0001', 'Remove it from its subscriptions first.',
  'a group in use cannot be deleted');
select lives_ok(format('select delete_callsign_group(%L)', (select id from g3)), 'an unused group can be deleted');
select is((select count(*) from callsign_groups where id = (select id from g3)), 0::bigint, 'deleted group is gone');
reset role;
select is((select count(*) from callsign_group_members where group_id = (select id from g3)), 0::bigint, 'its members went with it');

-- Another user sees and changes nothing.
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select is((select count(*) from callsign_groups), 0::bigint, 'other user sees no groups');
select is((select count(*) from callsign_group_members), 0::bigint, 'other user sees no members');
select is((select count(*) from list_callsign_groups()), 0::bigint, 'other user lists no groups');
select throws_ok(format('select save_callsign_group(%L)', jsonb_build_object('id', (select id from g1), 'name', 'Mine',
  'callsigns', array['K1ABC'])), 'P0001', 'Group not found.', 'other user cannot save over the group');
select throws_ok(format('select delete_callsign_group(%L)', (select id from g1)), 'P0001', 'Group not found.', 'other user cannot delete');
create temp table dz as select * from create_destination('discord', 'B discord', 'https://discord.com/api/webhooks/2/b');
select throws_ok(format('select save_subscription(%L)', jsonb_build_object('name', 'x', 'rules', pg_temp.group_rule(array[(select id from g1)]),
  'destinations', array[(select id from dz)])), 'P0001', 'Group not found.', 'other user cannot subscribe to the group');
select lives_ok($$ select save_callsign_group('{"name":"Club roster"}') $$, 'names are unique per account, not globally');
reset role;
select is((select name from callsign_groups where id = (select id from g1)), 'Club roster', 'the owner''s group is untouched');
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');

-- Direct writes are revoked.
select throws_ok(format('insert into callsign_groups (user_id, name) values (%L, %L)', '22222222-2222-2222-2222-222222222222', 'x'),
  '42501', null, 'direct group insert is not allowed');
select throws_ok($$ update callsign_groups set name = 'x' $$, '42501', null, 'direct group update is not allowed');
select throws_ok($$ delete from callsign_groups $$, '42501', null, 'direct group delete is not allowed');
select throws_ok(format('insert into callsign_group_members (group_id, callsign) values (%L, %L)', (select id from g1), 'K1ABC'),
  '42501', null, 'direct member insert is not allowed');
select throws_ok($$ update callsign_group_members set callsign = 'K1ABC' $$, '42501', null, 'direct member update is not allowed');
select throws_ok($$ delete from callsign_group_members $$, '42501', null, 'direct member delete is not allowed');

-- Once no subscription lists the group, it can be deleted.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select lives_ok(format($f$ select save_subscription('{"id":"%s","name":"Club","rules":[],"destinations":["%s"]}') $f$,
  (select id from s1), (select id from da)), 'the subscription drops the group');
select lives_ok(format('select delete_callsign_group(%L)', (select id from g1)), 'a group no longer in use can be deleted');

select * from finish();
rollback;

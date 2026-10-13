-- pgTAP: callsign groups (20261013000100). Group and member RPCs, unique
-- names, add counts and rejections, the delete guard, group ownership in
-- save_subscription, RLS from another user's view, and grants.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(57);

-- Grants: clients read only; every write goes through an RPC.
select table_privs_are('public', 'callsign_groups', 'authenticated', array['SELECT'], 'authenticated may only select groups');
select table_privs_are('public', 'callsign_group_members', 'authenticated', array['SELECT'], 'authenticated may only select members');
select table_privs_are('public', 'callsign_groups', 'anon', '{}'::text[], 'anon has no access to groups');
select table_privs_are('public', 'callsign_group_members', 'anon', '{}'::text[], 'anon has no access to members');

-- Not signed in.
set local role authenticated;
set local request.jwt.claims = '';
select throws_ok($$ select create_callsign_group('x') $$, 'P0001', 'Not signed in.', 'create needs a session');
select throws_ok($$ select * from list_callsign_groups() $$, 'P0001', 'Not signed in.', 'list needs a session');
reset role;

-- Create: trimmed names, unique per account regardless of case.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table g1 as select create_callsign_group('  Club roster ') as id;
create temp table g2 as select create_callsign_group('Friends') as id;

select is((select name from callsign_groups where id = (select id from g1)), 'Club roster', 'name stored trimmed');
select throws_ok($$ select create_callsign_group('club ROSTER') $$, 'P0001', 'You already have a group with that name.',
  'duplicate name refused regardless of case');
select throws_ok($$ select create_callsign_group('   ') $$, 'P0001', 'Give the group a name.', 'empty name refused on create');

-- Rename.
select throws_ok(format('select rename_callsign_group(%L, %L)', (select id from g2), 'CLUB roster'),
  'P0001', 'You already have a group with that name.', 'rename to a taken name refused');
select throws_ok(format('select rename_callsign_group(%L, %L)', (select id from g2), ''),
  'P0001', 'Give the group a name.', 'empty name refused on rename');
select lives_ok(format('select rename_callsign_group(%L, %L)', (select id from g2), ' Pals '), 'rename lives');
select is((select name from callsign_groups where id = (select id from g2)), 'Pals', 'rename stored trimmed');
select lives_ok(format('select rename_callsign_group(%L, %L)', (select id from g2), 'PALS'), 'a group can change the case of its own name');

-- Add: trims, uppercases, validates; invalid values come back, blanks are ignored.
reset role;
set local session_replication_role = replica;
update callsign_groups set updated_at = '2000-01-01' where id = (select id from g1);
set local session_replication_role = origin;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');

create temp table r1 as select add_group_callsigns((select id from g1),
  array[' w1aw ', 'kk4pwj', 'W1AW', 'junk!', '', 'W1AW/P', 'abc']) as r;
select is((select (r ->> 'added')::int from r1), 3, 'add counts distinct new calls');
select is((select (r ->> 'already')::int from r1), 0, 'a call repeated in one batch is not counted as already there');
select is((select array(select jsonb_array_elements_text(r -> 'rejected')) from r1), array['ABC', 'JUNK!'], 'invalid values come back rejected');
select is((select array_agg(callsign order by callsign) from callsign_group_members where group_id = (select id from g1)),
  array['KK4PWJ', 'W1AW', 'W1AW/P'], 'members stored uppercase and trimmed');
select is((select updated_at from callsign_groups where id = (select id from g1)), now(), 'adding bumps the group''s updated_at');

create temp table r2 as select add_group_callsigns((select id from g1), array['W1AW', 'n0call']) as r;
select is((select r from r2), '{"added": 1, "already": 1, "rejected": []}'::jsonb, 'calls already in the group are counted, not added');
select is(add_group_callsigns((select id from g1), null), '{"added": 0, "already": 0, "rejected": []}'::jsonb, 'a null list adds nothing');
select is(add_group_callsigns((select id from g1), array[E'W1AW\r', E'\tk1abc ', E'\r\n', E'\u00a0K2ABC\u00a0']),
  '{"added": 2, "already": 1, "rejected": []}'::jsonb, 'tabs, line ends and non-breaking spaces are trimmed; whitespace-only values are skipped');

-- Remove.
reset role;
set local session_replication_role = replica;
update callsign_groups set updated_at = '2000-01-01' where id = (select id from g1);
set local session_replication_role = origin;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');

select is(remove_group_callsigns((select id from g1), array[' n0call', E'K1ABC\t', E'k2abc\r', 'K9ZZZ']), 3,
  'remove trims, uppercases and returns rows removed');
select is((select count(*) from callsign_group_members where group_id = (select id from g1)), 3::bigint, 'removed call is gone');
select is((select updated_at from callsign_groups where id = (select id from g1)), now(), 'removing bumps the group''s updated_at');

-- The check constraint applies the profile callsign rule to any write.
reset role;
select throws_ok(format('insert into callsign_group_members (group_id, callsign) values (%L, %L)', (select id from g1), 'junk'),
  '23514', null, 'member callsigns are checked');
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');

-- Subscriptions: group ids must be the caller's.
create temp table da as select * from create_destination('discord', 'A discord', 'https://discord.com/api/webhooks/1/a');
create temp table s1 as select save_subscription(jsonb_build_object('name', 'Club', 'group_ids', array[(select id from g1)],
  'destinations', array[(select id from da)])) as id;
select is((select group_ids from subscriptions where id = (select id from s1)), array[(select id from g1)], 'group ids saved');
select throws_ok(format($f$ select save_subscription('{"name":"x","group_ids":["%s"],"destinations":["%s"]}') $f$,
  gen_random_uuid(), (select id from da)), 'P0001', 'Group not found.', 'an unknown group id is refused');
select is(save_subscription(jsonb_build_object('id', (select id from s1), 'name', 'Club v2',
  'destinations', array[(select id from da)])), (select id from s1), 'an update without group_ids saves');
select is((select group_ids from subscriptions where id = (select id from s1)), array[(select id from g1)],
  'an update without group_ids keeps the groups');
select is(save_subscription(jsonb_build_object('id', (select id from s1), 'name', 'Club',
  'group_ids', '[]'::jsonb, 'destinations', array[(select id from da)])), (select id from s1), 'an empty group_ids saves');
select is((select group_ids from subscriptions where id = (select id from s1)), '{}'::uuid[], 'an empty group_ids clears the groups');
select is(save_subscription(jsonb_build_object('id', (select id from s1), 'name', 'Club',
  'group_ids', array[(select id from g1), (select id from g1)], 'destinations', array[(select id from da)])),
  (select id from s1), 'a repeated group id saves');
select is((select group_ids from subscriptions where id = (select id from s1)), array[(select id from g1)], 'group ids are de-duplicated');

-- List: ordered by name, with member and subscription counts.
select results_eq(
  $$ select name, member_count, subscription_count from list_callsign_groups() $$,
  $$ values ('Club roster', 3::bigint, 1::bigint), ('PALS', 0::bigint, 0::bigint) $$,
  'list_callsign_groups orders by name and counts members and subscriptions');

-- RBN reports stations by callsign; a group is a list of them.
create temp table s_rbn as select save_subscription(jsonb_build_object('name', 'RBN club', 'sources', array['rbn'],
  'group_ids', array[(select id from g1)], 'destinations', array[(select id from da)])) as id;
select is((select group_ids from subscriptions where id = (select id from s_rbn)), array[(select id from g1)],
  'an RBN subscription can name a group instead of callsigns');
select throws_ok(format($f$ select save_subscription('{"name":"x","sources":["rbn"],"destinations":["%s"]}') $f$, (select id from da)),
  'P0001', 'RBN reports stations by callsign. Add at least one callsign.', 'an RBN subscription still needs callsigns or a group');
select lives_ok(format('select delete_subscription(%L)', (select id from s_rbn)), 'RBN subscription removed');

-- Delete guard.
select throws_ok(format('select delete_callsign_group(%L)', (select id from g1)), 'P0001', 'Remove it from its subscriptions first.',
  'a group in use cannot be deleted');
select is(add_group_callsigns((select id from g2), array['W1AW']) ->> 'added', '1', 'unused group gets a member');
select lives_ok(format('select delete_callsign_group(%L)', (select id from g2)), 'an unused group can be deleted');
select is((select count(*) from callsign_groups where id = (select id from g2)), 0::bigint, 'deleted group is gone');
reset role;
select is((select count(*) from callsign_group_members where group_id = (select id from g2)), 0::bigint, 'its members went with it');

-- Another user sees and changes nothing.
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select is((select count(*) from callsign_groups), 0::bigint, 'other user sees no groups');
select is((select count(*) from callsign_group_members), 0::bigint, 'other user sees no members');
select is((select count(*) from list_callsign_groups()), 0::bigint, 'other user lists no groups');
select throws_ok(format('select rename_callsign_group(%L, %L)', (select id from g1), 'Mine'), 'P0001', 'Group not found.', 'other user cannot rename');
select throws_ok(format('select add_group_callsigns(%L, %L)', (select id from g1), array['K1ABC']), 'P0001', 'Group not found.', 'other user cannot add');
select throws_ok(format('select remove_group_callsigns(%L, %L)', (select id from g1), array['W1AW']), 'P0001', 'Group not found.', 'other user cannot remove');
select throws_ok(format('select delete_callsign_group(%L)', (select id from g1)), 'P0001', 'Group not found.', 'other user cannot delete');
create temp table dz as select * from create_destination('discord', 'B discord', 'https://discord.com/api/webhooks/2/b');
select throws_ok(format($f$ select save_subscription('{"name":"x","group_ids":["%s"],"destinations":["%s"]}') $f$,
  (select id from g1), (select id from dz)), 'P0001', 'Group not found.', 'other user cannot subscribe to the group');
select lives_ok($$ select create_callsign_group('Club roster') $$, 'names are unique per account, not globally');

-- Direct writes are revoked.
select throws_ok(format('insert into callsign_groups (user_id, name) values (%L, %L)', '22222222-2222-2222-2222-222222222222', 'x'),
  '42501', null, 'direct group insert is not allowed');
select throws_ok($$ update callsign_groups set name = 'x' $$, '42501', null, 'direct group update is not allowed');
select throws_ok($$ delete from callsign_groups $$, '42501', null, 'direct group delete is not allowed');
select throws_ok(format('insert into callsign_group_members (group_id, callsign) values (%L, %L)', (select id from g1), 'K1ABC'),
  '42501', null, 'direct member insert is not allowed');
select throws_ok($$ delete from callsign_group_members $$, '42501', null, 'direct member delete is not allowed');

select * from finish();
rollback;

-- pgTAP: goals (20261029001100). Grants and RLS; save_goal's normalising, errors and
-- the worked state it keeps; marking from logged contacts by band, park (30 minutes either side
-- of the contact) and state through each layer (the contact's us_state, the matched park's
-- location, the license); Needs a look only for stations with a POTA spot that UTC day, and for
-- two parks; resolving reviews; "at least" completion; hand marks and hand_needed_at; rechecks
-- after a date change, a retraction and a changed us_state; status in UTC; the get_goal
-- shape (GoalProgress in web/src/goals/types.ts); copies; the account cap; the delete
-- guard over rules_goal_ids.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(182);

-- Today and yesterday noon in UTC. Every contact is on yesterday's UTC day, 12:00 to 20:20.
create function pg_temp.d(p_offset int) returns date language sql as $$
  select (now() at time zone 'utc')::date + p_offset;
$$;
create function pg_temp.t(p_minutes int) returns timestamptz language sql as $$
  select ((pg_temp.d(-1))::timestamp + time '12:00') at time zone 'utc' + make_interval(mins => p_minutes);
$$;
-- p_minutes after noon (UTC) p_day days from today.
create function pg_temp.at(p_day int, p_minutes int) returns timestamptz language sql as $$
  select ((pg_temp.d(p_day))::timestamp + time '12:00') at time zone 'utc' + make_interval(mins => p_minutes);
$$;
-- One upsert item for user A (KK4PWJ) as the relay-api function sends it.
create function pg_temp.up(p_ext text, p_call text, p_khz numeric, p_band text, p_mode text,
                           p_time timestamptz, p_state text) returns jsonb language sql as $$
  select jsonb_build_object(
    'op', 'upsert', 'external_id', p_ext, 'logger_app', 'N1MM', 'relay_version', '0.2.0',
    'us_state', p_state, 'gridsquare', null,
    'spot', jsonb_build_object(
      'source', 'logged', 'source_spot_id', '11111111-1111-1111-1111-111111111111|' || p_ext,
      'content_hash', md5(p_ext || p_call || p_khz::text || p_time::text),
      'spot_time', p_time, 'callsign', p_call, 'spotter', 'KK4PWJ', 'frequency_khz', p_khz,
      'band', p_band, 'mode', p_mode, 'mode_family', 'cw', 'comment', '', 'raw_payload', '{}'::jsonb));
$$;
create function pg_temp.log(variadic p_items jsonb[]) returns text[] language sql as $$
  select array(select e ->> 'status'
               from jsonb_array_elements(apply_logged_contacts('11111111-1111-1111-1111-111111111111',
                                                               to_jsonb(p_items))) with ordinality as x(e, n)
               order by n);
$$;
create function pg_temp.del(p_ext text) returns jsonb language sql as $$
  select jsonb_build_object('op', 'delete', 'external_id', p_ext, 'logger_app', null, 'relay_version', '0.2.0',
                            'spot', null);
$$;
create function pg_temp.cid(p_ext text) returns bigint language sql as $$
  select spot_id from logged_contacts where user_id = '11111111-1111-1111-1111-111111111111' and external_id = p_ext;
$$;
-- A POTA spot of p_call at p_ref.
create function pg_temp.pota(p_call text, p_ref text, p_loc text, p_time timestamptz) returns bigint language sql as $$
  insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, spotter, frequency_khz, band, mode,
                         comment, pota_reference, pota_location, raw_payload)
  values ('pota', 'needs-' || p_call || p_time::text, md5(p_call || p_ref || p_time::text), p_time, p_call, 'W9SPT',
          14062, '20m', 'cw', '', p_ref, p_loc, '{}')
  returning id;
$$;
-- The worked values of a list's requirements of one kind.
create function pg_temp.worked(p_list uuid, p_kind text) returns text[] language sql as $$
  select coalesce(array_agg(e.value order by e.value), '{}')
  from goal_entries e join goal_requirements r on r.id = e.requirement_id
  where r.list_id = p_list and r.kind = p_kind and e.worked_at is not null;
$$;
create function pg_temp.req(p_list uuid, p_kind text) returns uuid language sql as $$
  select id from goal_requirements where list_id = p_list and kind = p_kind order by position limit 1;
$$;
create function pg_temp.entry(p_list uuid, p_kind text, p_value text) returns goal_entries language sql as $$
  select e.* from goal_entries e join goal_requirements r on r.id = e.requirement_id
  where r.list_id = p_list and r.kind = p_kind and e.value = p_value;
$$;
-- L1's payload, with a window and the requirements' ids when given.
create function pg_temp.l1(p_id uuid, p_starts date, p_ends date) returns jsonb language sql as $$
  select jsonb_build_object(
    'id', p_id, 'name', '2026 chase', 'starts_on', p_starts, 'ends_on', p_ends, 'marking', 'relay',
    'requirements', jsonb_build_array(
      jsonb_build_object('id', pg_temp.req(p_id, 'state'), 'kind', 'state', 'complete_when', 'all',
                         'entries', array['NC', 'GA', 'VA', 'SC', 'TX']),
      jsonb_build_object('id', pg_temp.req(p_id, 'park'), 'kind', 'park', 'complete_when', 'all',
                         'entries', array['US-2763', 'US-2764', 'US-0001', 'US-0002', 'US-0003', 'US-0004', 'US-0005']),
      jsonb_build_object('id', pg_temp.req(p_id, 'band'), 'kind', 'band', 'complete_when', 'at_least', 'at_least', 2,
                         'entries', array['80m', '40m', '20m', '10m'])));
$$;
create function pg_temp.keys(p jsonb) returns text[] language sql as $$
  select array(select k from jsonb_object_keys(p) as k order by k);
$$;

insert into reference_catalog (program, reference, name, active, location)
values ('pota', 'US-2763', 'Hanging Rock State Park', true, 'US-NC'),
       ('pota', 'US-0003', 'Pilot Mountain State Park', true, 'US-NC')
on conflict (program, reference) do update set name = excluded.name;
delete from callsign_licenses where callsign in ('N4LIC', 'K4ABC', 'N4DEF', 'W8XYZ', 'W3OUT', 'W4DAY', 'W1EDG', 'W2EDG',
                                                'K9TRL', 'K9VAL', 'K9CAN', 'K9TWO', 'K9CAT', 'K9DC', 'K9WA', 'K9WB',
                                                'K9WC', 'K9WD');
-- W8XYZ's license state (VA) is on L1 and needed when c8 comes, so 'a contact with two parks marks
-- no state' would see a fall through to the license.
insert into callsign_licenses (callsign, authority, country, state, loaded_at)
values ('N4LIC', 'FCC', 'US', 'TX', now()), ('K4ABC', 'FCC', 'US', 'SC', now()), ('W8XYZ', 'FCC', 'US', 'VA', now()),
       ('K9TRL', 'FCC', 'US', 'TX', now()), ('K9VAL', 'FCC', 'US', 'VA', now()), ('K9CAN', 'FCC', 'US', 'OH', now()),
       ('K9TWO', 'FCC', 'US', 'MI', now()), ('K9CAT', 'FCC', 'US', 'TX', now()), ('K9DC', 'FCC', 'US', 'CA', now());

-- ---------------------------------------------------------------------------
-- Grants and helpers
-- ---------------------------------------------------------------------------

select table_privs_are('public', 'goals', 'authenticated', array['SELECT'], 'authenticated may only select goals');
select table_privs_are('public', 'goal_requirements', 'authenticated', array['SELECT'], 'authenticated may only select requirements');
select table_privs_are('public', 'goal_entries', 'authenticated', array['SELECT'], 'authenticated may only select entries');
select table_privs_are('public', 'goal_reviews', 'authenticated', array['SELECT'], 'authenticated may only select reviews');
select table_privs_are('public', 'goals', 'anon', '{}'::text[], 'anon has no access to goals');
select table_privs_are('public', 'goal_entries', 'anon', '{}'::text[], 'anon has no access to entries');
select ok(not has_function_privilege('authenticated', 'public.goal_apply_contact(uuid, bigint)', 'execute'),
  'goal_apply_contact is service role only');
select ok(not has_function_privilege('authenticated', 'public.goal_recheck(uuid)', 'execute'),
  'goal_recheck is service role only');
select is(cardinality(us_states()), 50, 'us_states: 50 states');
select ok(not ('DC' = any (us_states())), 'us_states: no DC');
select is(rules_goal_ids('{"x": 1}'), '{}'::uuid[], 'rules_goal_ids tolerates a non-array');
select is(rules_goal_ids('[[{"field": "goal", "op": "is", "values": ["nope"]}, "x"], 3]'), '{}'::uuid[],
  'rules_goal_ids skips values that are not ids and items that are not rules');
select is(rules_goal_ids('[[{"field": "group", "op": "is", "values": ["0b4b5a0e-0000-4000-8000-000000000001"]}],
                                 [{"field": "goal", "op": "is", "values": ["0b4b5a0e-0000-4000-8000-000000000002"]}]]'),
  array['0b4b5a0e-0000-4000-8000-000000000002']::uuid[], 'rules_goal_ids reads only goal rules, in any group');

set local role authenticated;
set local request.jwt.claims = '';
select throws_ok($$ select save_goal('{"name": "x"}') $$, 'P0001', 'Not signed in.', 'save needs a session');
select throws_ok($$ select list_goals() $$, 'P0001', 'Not signed in.', 'list needs a session');
select throws_ok(format('select get_goal(%L)', gen_random_uuid()), 'P0001', 'Not signed in.', 'get needs a session');
reset role;

-- ---------------------------------------------------------------------------
-- save_goal: errors and normalising
-- ---------------------------------------------------------------------------

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select throws_ok($$ select save_goal('{"name": "  ", "requirements": [{"kind": "band", "entries": ["20m"]}]}') $$,
  'P0001', 'Give the goal a name.', 'a blank name is refused');
select throws_ok($$ select save_goal('{"name": "x"}') $$, 'P0001', 'Add at least one requirement.',
  'a list without requirements is refused');
select throws_ok($$ select save_goal('{"name": "x", "requirements": []}') $$, 'P0001', 'Add at least one requirement.',
  'an empty requirement list is refused');
select throws_ok($$ select save_goal(jsonb_build_object('name', 'x', 'requirements',
                      (select jsonb_agg('{"kind": "band", "entries": ["20m"]}'::jsonb) from generate_series(1, 11)))) $$,
  'P0001', 'A goal takes at most 10 requirements.', 'at most 10 requirements');
select throws_ok($$ select save_goal('{"name": "x", "requirements": [{"kind": "grid", "entries": ["FM05"]}]}') $$,
  'P0001', 'Not a requirement kind: grid.', 'an unknown kind is refused');
select throws_ok($$ select save_goal('{"name": "x", "requirements": [{"kind": "state", "entries": ["NC", "DC"]}]}') $$,
  'P0001', 'Not a US state: DC.', 'DC is not one of the 50 states');
select throws_ok($$ select save_goal('{"name": "x", "requirements": [{"kind": "park", "entries": ["K0817"]}]}') $$,
  'P0001', 'Not a POTA reference: K0817.', 'a park must look like a POTA reference');
select throws_ok($$ select save_goal('{"name": "x", "requirements": [{"kind": "band", "entries": ["21m"]}]}') $$,
  'P0001', 'Not a band: 21m.', 'a band must be one of goal_bands()');
select throws_ok($$ select save_goal('{"name": "x", "requirements": [{"kind": "band", "entries": []}]}') $$,
  'P0001', 'Add at least one entry to each requirement.', 'a requirement needs an entry');
select throws_ok($$ select save_goal(jsonb_build_object('name', 'x', 'requirements', jsonb_build_array(
                      jsonb_build_object('kind', 'park', 'entries',
                        (select jsonb_agg('US-' || lpad(g::text, 4, '0')) from generate_series(1, 501) g))))) $$,
  'P0001', 'A requirement takes at most 500 entries.', 'at most 500 entries');
select throws_ok($$ select save_goal('{"name": "x", "requirements": [{"kind": "band", "complete_when": "at_least",
                                            "at_least": 2, "entries": ["20m", "40m"]}]}') $$,
  'P0001', '"At least" must be smaller than the number of entries.', 'at least must be below the entry count');
select throws_ok($$ select save_goal('{"name": "x", "requirements": [{"kind": "band", "complete_when": "at_least",
                                            "at_least": 0, "entries": ["20m", "40m"]}]}') $$,
  'P0001', '"At least" must be a whole number of 1 or more.', 'at least must be 1 or more');
select throws_ok($$ select save_goal('{"name": "x", "requirements": [{"kind": "band", "complete_when": "most",
                                            "entries": ["20m"]}]}') $$,
  'P0001', 'Not a "Complete when" rule: most.', 'an unknown complete_when is refused');
select throws_ok($$ select save_goal('{"name": "x", "starts_on": "2026-01-01",
                                            "requirements": [{"kind": "band", "entries": ["20m"]}]}') $$,
  'P0001', 'Give the time window a start and an end date.', 'a window needs both dates');
select throws_ok($$ select save_goal('{"name": "x", "starts_on": "2026-02-01", "ends_on": "2026-01-31",
                                            "requirements": [{"kind": "band", "entries": ["20m"]}]}') $$,
  'P0001', 'The end date can''t be before the start date.', 'the end may not come before the start');
select throws_ok($$ select save_goal('{"name": "x", "starts_on": "2026-02-30", "ends_on": "2026-03-31",
                                            "requirements": [{"kind": "band", "entries": ["20m"]}]}') $$,
  'P0001', 'Not a date: 2026-02-30.', 'a date that does not exist is refused');
select throws_ok($$ select save_goal('{"name": "x", "marking": "spots",
                                            "requirements": [{"kind": "band", "entries": ["20m"]}]}') $$,
  'P0001', 'Not a way to mark entries: spots.', 'marking is relay or hand');
select throws_ok(format('select save_goal(%L)', jsonb_build_object('id', gen_random_uuid(), 'name', 'x',
                   'requirements', '[{"kind": "band", "entries": ["20m"]}]'::jsonb)),
  'P0001', 'Goal not found.', 'saving an id the caller does not own is refused');

create temp table l1 as
select save_goal(pg_temp.l1(null, pg_temp.d(-30), pg_temp.d(30))) as id;
reset role;
select is((select (name, starts_on = pg_temp.d(-30), ends_on = pg_temp.d(30), marking, completed_at is null)::text
           from goals where id = (select id from l1)),
  '("2026 chase",t,t,relay,t)', 'save creates the list');
select is((select array_agg(kind || ':' || complete_when || ':' || coalesce(at_least::text, '-') order by position)
           from goal_requirements where list_id = (select id from l1)),
  array['state:all:-', 'park:all:-', 'band:at_least:2'], 'with its requirements in order');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table norm as
select save_goal('{"name": "Normalised", "requirements": [
  {"kind": "state", "entries": [" nc ", "NC", "ga"]},
  {"kind": "park", "entries": [" us-2763 ", "K-0817"]},
  {"kind": "band", "entries": ["20 m", "40M", "20m"]}]}') as id;
select throws_ok($$ select save_goal('{"name": "normalised", "requirements": [{"kind": "band", "entries": ["20m"]}]}') $$,
  'P0001', 'You already have a goal with that name.', 'names are unique per account ignoring case');
reset role;
select is((select array_agg(r.kind || ':' || e.value order by r.position, e.position)
           from goal_entries e join goal_requirements r on r.id = e.requirement_id
           where r.list_id = (select id from norm)),
  array['state:NC', 'state:GA', 'park:US-2763', 'park:K-0817', 'band:20m', 'band:40m'],
  'entries are trimmed, cased per kind, once each, in the order first given');

-- ---------------------------------------------------------------------------
-- Marking from logged contacts
-- ---------------------------------------------------------------------------

-- c1: K4ABC on 20 m, spotted at US-2763 (in NC) five minutes before. The park, the state from the
-- park's location (not K4ABC's license state, SC) and the band.
select pg_temp.pota('K4ABC', 'US-2763', 'US-NC', pg_temp.t(-5));
select is(pg_temp.log(pg_temp.up('c1', 'K4ABC', 14062, '20m', 'cw', pg_temp.t(0), null)), array['created'], 'c1 is stored');
select is(pg_temp.worked((select id from l1), 'park'), array['US-2763'], 'a contact marks the park of the POTA spot near it');
select is(pg_temp.worked((select id from l1), 'state'), array['NC'], 'the state comes from the matched park''s location');
select is(pg_temp.worked((select id from l1), 'band'), array['20m'], 'the band comes from the contact');
select is((select (worked_how, worked_at = pg_temp.t(0), contact_spot_id = pg_temp.cid('c1'),
                   (select spot_time from raw_spots where id = matched_spot_id) = pg_temp.t(-5))::text
           from pg_temp.entry((select id from l1), 'park', 'US-2763')),
  '(contact,t,t,t)', 'the park mark: worked at the contact time, the contact and the POTA spot as evidence');
select ok((pg_temp.entry((select id from l1), 'state', 'NC')).matched_spot_id is not null,
  'a state from a park''s location keeps the POTA spot');
select ok((pg_temp.entry((select id from l1), 'band', '20m')).matched_spot_id is null, 'a band mark has no POTA spot');

-- c2: N4DEF on 40 m saying GA, spotted at US-0001 (in VA): the contact's state wins.
select pg_temp.pota('N4DEF', 'US-0001', 'US-VA', pg_temp.t(70));
select is(pg_temp.log(pg_temp.up('c2', 'N4DEF', 7030, '40m', 'cw', pg_temp.t(60), 'GA')), array['created'], 'c2 is stored');
select is(pg_temp.worked((select id from l1), 'state'), array['GA', 'NC'], 'the contact''s own us_state comes first');
select ok((pg_temp.entry((select id from l1), 'state', 'GA')).matched_spot_id is null,
  'a state from the contact has no POTA spot');
select is(pg_temp.worked((select id from l1), 'band'), array['20m', '40m'], 'two bands: at least 2 of 4 is complete');
select ok(goal_requirement_complete(pg_temp.req((select id from l1), 'band')), 'the band requirement is complete');

-- c3: N4LIC on 80 m, no POTA spot, no state: the license state, and no band (its requirement is complete).
select is(pg_temp.log(pg_temp.up('c3', 'N4LIC', 3530, '80m', 'cw', pg_temp.t(120), null)), array['created'], 'c3 is stored');
select is(pg_temp.worked((select id from l1), 'state'), array['GA', 'NC', 'TX'], 'else the license state of the worked call');
select is(pg_temp.worked((select id from l1), 'band'), array['20m', '40m'], 'a complete "at least" requirement takes no more');

-- c4 and c5: POTA spots exactly 30 minutes after and before the contact both count.
select pg_temp.pota('W1EDG', 'US-0002', 'US-NC', pg_temp.t(210));
select pg_temp.pota('W2EDG', 'US-2764', 'US-NC', pg_temp.t(210));
select is(pg_temp.log(pg_temp.up('c4', 'W1EDG', 28030, '10m', 'cw', pg_temp.t(180), null),
                      pg_temp.up('c5', 'W2EDG', 28031, '10m', 'cw', pg_temp.t(240), null)),
  array['created', 'created'], 'c4 and c5 are stored');
select is(pg_temp.worked((select id from l1), 'park'), array['US-0001', 'US-0002', 'US-2763', 'US-2764'],
  'a POTA spot 30 minutes after the contact or 30 minutes before it matches');

-- c6: W3OUT, spotted 31 minutes after: no park, but a POTA spot that day, so it needs a look.
select pg_temp.pota('W3OUT', 'US-0005', 'US-NC', pg_temp.t(331));
-- c7: W4DAY, spotted only the day before: not a park contact, silently.
select pg_temp.pota('W4DAY', 'US-0005', 'US-NC', pg_temp.t(360) - interval '1 day');
-- c8: W8XYZ, spotted at two parks around then.
select pg_temp.pota('W8XYZ', 'US-0004', 'US-NC', pg_temp.t(425));
select pg_temp.pota('W8XYZ', 'US-0003', 'US-NC', pg_temp.t(415));
select is(pg_temp.log(pg_temp.up('c6', 'W3OUT', 14031, '20m', 'cw', pg_temp.t(300), null),
                      pg_temp.up('c7', 'W4DAY', 14032, '20m', 'cw', pg_temp.t(360), null),
                      pg_temp.up('c8', 'W8XYZ', 7185, '40m', 'ssb', pg_temp.t(420), null)),
  array['created', 'created', 'created'], 'c6, c7 and c8 are stored');
select is(pg_temp.worked((select id from l1), 'park'), array['US-0001', 'US-0002', 'US-2763', 'US-2764'],
  'none of them marks a park');
select is((select array_agg(s.callsign || ':' || v.status || ':' || array_to_string(v.candidates, ',') order by s.callsign)
           from goal_reviews v join raw_spots s on s.id = v.contact_spot_id where v.list_id = (select id from l1)),
  array['W3OUT:open:', 'W8XYZ:open:US-0003,US-0004'],
  'Needs a look: no spot within 30 minutes of a station spotted that day, and two parks; never a station not on POTA that day');
select is((select count(*) from goal_reviews v where v.contact_spot_id = pg_temp.cid('c3')), 0::bigint,
  'a station with no POTA spot is not a park contact');
select is(pg_temp.worked((select id from l1), 'state'), array['GA', 'NC', 'TX'],
  'a contact with two parks marks no state, not even the license state (VA), until a park is picked');

-- ---------------------------------------------------------------------------
-- get_goal and list_goals
-- ---------------------------------------------------------------------------

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table p1 as select get_goal((select id from l1)) as p;
reset role;
select is(pg_temp.keys((select p from p1)), array['first_contact_at', 'list', 'relay', 'requirements', 'reviews', 'used_by'],
  'get_goal: top-level keys');
select is(pg_temp.keys((select p -> 'list' from p1)),
  array['completed_at', 'connection_count', 'ends_on', 'id', 'marking', 'name', 'needed_by_kind', 'requirement_count',
        'starts_on', 'status', 'total', 'updated_at', 'worked'],
  'the card keys');
select is((select (p -> 'list') - 'id' - 'updated_at' - 'starts_on' - 'ends_on' from p1),
  '{"name": "2026 chase", "marking": "relay", "status": "active", "completed_at": null, "requirement_count": 3,
    "worked": 9, "total": 14, "needed_by_kind": {"state": 2, "park": 3, "band": 0}, "connection_count": 0}'::jsonb,
  'the card counts: each requirement up to its target, and what incomplete ones still lack by kind');
select is(pg_temp.keys((select p -> 'requirements' -> 0 from p1)),
  array['at_least', 'complete', 'complete_when', 'entries', 'id', 'kind', 'position', 'target', 'worked'],
  'requirement keys');
select is((select jsonb_agg(r - 'id' - 'entries') from p1, jsonb_array_elements(p -> 'requirements') r),
  '[{"kind": "state", "complete_when": "all", "at_least": null, "position": 1, "complete": false, "worked": 3, "target": 5},
    {"kind": "park", "complete_when": "all", "at_least": null, "position": 2, "complete": false, "worked": 4, "target": 7},
    {"kind": "band", "complete_when": "at_least", "at_least": 2, "position": 3, "complete": true, "worked": 2, "target": 2}]'::jsonb,
  'requirements in order with progress');
select is(pg_temp.keys((select p -> 'requirements' -> 1 -> 'entries' -> 0 from p1)),
  array['evidence', 'label', 'position', 'value', 'worked_at', 'worked_how'], 'entry keys');
select is((select e - 'worked_at' from p1, jsonb_array_elements(p -> 'requirements' -> 1 -> 'entries') e
           where e ->> 'value' = 'US-2763'),
  jsonb_build_object('value', 'US-2763', 'label', 'Hanging Rock State Park', 'position', 1, 'worked_how', 'contact',
    'evidence', jsonb_build_object('worked_call', 'K4ABC', 'contact_time', pg_temp.t(0), 'logger_app', 'N1MM',
                                   'matched_spot_time', pg_temp.t(-5))),
  'a worked park: its catalog name and the evidence line''s parts');
select is((select e from p1, jsonb_array_elements(p -> 'requirements' -> 1 -> 'entries') e where e ->> 'value' = 'US-0005'),
  '{"value": "US-0005", "label": null, "position": 7, "worked_at": null, "worked_how": null, "evidence": null}'::jsonb,
  'a needed park outside the catalog has no label');
select is((select e -> 'evidence' ->> 'matched_spot_time' from p1, jsonb_array_elements(p -> 'requirements' -> 0 -> 'entries') e
           where e ->> 'value' = 'TX'), null, 'a state from the license has no matched spot time');
select is((select jsonb_agg(v - 'id' order by v ->> 'worked_call') from p1, jsonb_array_elements(p -> 'reviews') v),
  jsonb_build_array(
    jsonb_build_object('worked_call', 'W3OUT', 'band', '20m', 'mode', 'cw', 'contact_time', pg_temp.t(300),
                       'candidates', '[]'::jsonb),
    jsonb_build_object('worked_call', 'W8XYZ', 'band', '40m', 'mode', 'ssb', 'contact_time', pg_temp.t(420),
                       'candidates', '[{"reference": "US-0003", "name": "Pilot Mountain State Park"},
                                       {"reference": "US-0004", "name": null}]'::jsonb)),
  'the open reviews with their candidates and names');
select is((select (p -> 'relay') - 'last_contact_at' from p1), '{"status": "recent", "logger_app": "N1MM", "relay_count": 0}'::jsonb,
  'relay: recent with a contact in the last 7 days');
select is((select p -> 'used_by' from p1), '[]'::jsonb, 'used by no connection yet');
select ok((select (p ->> 'first_contact_at')::timestamptz is not null from p1), 'first_contact_at is the account''s first contact');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is((select array_agg(c ->> 'name' order by n) from jsonb_array_elements(list_goals()) with ordinality as x(c, n)),
  array['2026 chase', 'Normalised'], 'list_goals: the caller''s cards by name');
select is((select jsonb_agg(c -> 'worked') from jsonb_array_elements(list_goals()) c), '[9, 5]'::jsonb,
  'each card carries its counts');
reset role;

-- ---------------------------------------------------------------------------
-- Reviews
-- ---------------------------------------------------------------------------

create temp table rv as
select v.id, s.callsign from goal_reviews v join raw_spots s on s.id = v.contact_spot_id where v.list_id = (select id from l1);
grant select on rv to authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select throws_ok(format('select resolve_goal_review(%L, %L)', (select id from rv where callsign = 'W8XYZ'), 'nope'),
  'P0001', 'Not a POTA reference: nope.', 'a picked park must look like a reference');
select lives_ok(format('select resolve_goal_review(%L, %L)', (select id from rv where callsign = 'W8XYZ'), 'us-0003'),
  'Choose park picks one of the candidates');
select lives_ok(format('select resolve_goal_review(%L, null)', (select id from rv where callsign = 'W3OUT')),
  'Not a park contact');
select throws_ok(format('select resolve_goal_review(%L, null)', (select id from rv where callsign = 'W3OUT')),
  'P0001', 'Review not found.', 'a resolved review cannot be resolved again');
reset role;
select is(pg_temp.worked((select id from l1), 'park'), array['US-0001', 'US-0002', 'US-0003', 'US-2763', 'US-2764'],
  'the picked park is worked');
select is((select (worked_how, contact_spot_id = pg_temp.cid('c8'), matched_spot_id is null)::text
           from pg_temp.entry((select id from l1), 'park', 'US-0003')),
  '(contact,t,t)', 'with the contact as evidence and no POTA spot');
select is((select array_agg(status || ':' || coalesce(picked_reference, '-') order by status) from goal_reviews
           where list_id = (select id from l1)),
  array['not_park:-', 'picked:US-0003'], 'both reviews are resolved');
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is(jsonb_array_length(get_goal((select id from l1)) -> 'reviews'), 0, 'no review is open');
reset role;

-- ---------------------------------------------------------------------------
-- Hand marks
-- ---------------------------------------------------------------------------

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select lives_ok(format('select mark_goal_entry(%L, %L, true)', pg_temp.req((select id from l1), 'state'), 'sc'),
  'mark an entry worked by hand');
select lives_ok(format('select mark_goal_entry(%L, %L, false)', pg_temp.req((select id from l1), 'state'), 'NC'),
  'set a contact-worked entry back to needed');
select throws_ok(format('select mark_goal_entry(%L, %L, true)', pg_temp.req((select id from l1), 'state'), 'WY'),
  'P0001', 'Not on this goal: WY.', 'only an entry of the requirement');
select throws_ok(format('select mark_goal_entry(%L, %L, true)', pg_temp.req((select id from l1), 'state'), 'XX'),
  'P0001', 'Not a US state: XX.', 'a value is checked for its kind');
select throws_ok(format('select mark_goal_entry(%L, %L, true)', gen_random_uuid(), 'NC'),
  'P0001', 'Goal not found.', 'an unknown requirement');
reset role;
select is((select (worked_how, worked_at = now(), hand_needed_at is null)::text from pg_temp.entry((select id from l1), 'state', 'SC')),
  '(hand,t,t)', 'a hand mark is worked now, by hand');
select is((select (worked_at is null, hand_needed_at = now())::text from pg_temp.entry((select id from l1), 'state', 'NC')),
  '(t,t)', 'needed by hand records when');
select is(pg_temp.worked((select id from l1), 'state'), array['GA', 'SC', 'TX'],
  'the recheck after it does not mark NC again from the earlier contact');

-- c9: a contact saying NC logged after the hand mark works NC again.
select is(pg_temp.log(pg_temp.up('c9', 'K4NEW', 14063, '20m', 'cw', now() + interval '1 minute', 'NC')), array['created'],
  'c9 is stored');
select is((select (worked_how, contact_spot_id = pg_temp.cid('c9'))::text from pg_temp.entry((select id from l1), 'state', 'NC')),
  '(contact,t)', 'a contact logged after the hand mark marks the entry');

-- ---------------------------------------------------------------------------
-- Rechecks: a date change, a retraction, a changed us_state, marking by hand
-- ---------------------------------------------------------------------------

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is(save_goal(pg_temp.l1((select id from l1), pg_temp.d(0), pg_temp.d(30))), (select id from l1),
  'save returns the list''s id');
reset role;
select is(pg_temp.worked((select id from l1), 'state'), array['NC', 'SC'],
  'moving the start past yesterday drops yesterday''s contacts; the hand mark and today''s contact stay');
select is(pg_temp.worked((select id from l1), 'park'), '{}'::text[], 'parks (the picked one too) go back to needed');
select is(pg_temp.worked((select id from l1), 'band'), array['20m'], 'only today''s contact''s band stays');
select is((select count(*) from goal_requirements where list_id = (select id from l1)), 3::bigint,
  'the requirements were kept by id');
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select lives_ok(format('select save_goal(%L)', pg_temp.l1((select id from l1), pg_temp.d(-30), pg_temp.d(30))),
  'the dates moved back');
reset role;
select is(pg_temp.worked((select id from l1), 'state'), array['GA', 'NC', 'SC', 'TX'], 'states come back');
select is(pg_temp.worked((select id from l1), 'park'), array['US-0001', 'US-0002', 'US-0003', 'US-2763', 'US-2764'],
  'parks come back, the picked one included');
select is(pg_temp.worked((select id from l1), 'band'), array['20m', '40m'], 'the two earliest bands come back');
select is((select contact_spot_id = pg_temp.cid('c9') from pg_temp.entry((select id from l1), 'state', 'NC')), true,
  'hand_needed_at still keeps NC from the contact before it');

-- Deleting c2 in the logger: GA, US-0001 and 40 m go back, and "at least" takes 80 m from c3.
select is(pg_temp.log(pg_temp.del('c2')), array['retracted'], 'c2 is retracted');
select is(pg_temp.worked((select id from l1), 'state'), array['NC', 'SC', 'TX'], 'its state goes back to needed');
select is(pg_temp.worked((select id from l1), 'park'), array['US-0002', 'US-0003', 'US-2763', 'US-2764'], 'and its park');
select is(pg_temp.worked((select id from l1), 'band'), array['20m', '80m'], 'its band too, and the next contact''s band counts');

-- c3 sent again unchanged but now saying VA: VA instead of the license's TX.
select is(pg_temp.log(pg_temp.up('c3', 'N4LIC', 3530, '80m', 'cw', pg_temp.t(120), 'VA')), array['unchanged'],
  'c3 resent with a state is unchanged');
select is(pg_temp.worked((select id from l1), 'state'), array['NC', 'SC', 'VA'], 'a new us_state re-applies the contact');

-- An edit of c1 to another frequency on 40 m: the old spot's marks go, the new one's come.
select is(pg_temp.log(pg_temp.up('c1', 'K4ABC', 7031, '40m', 'cw', pg_temp.t(0), null)), array['updated'], 'c1 is edited');
select is(pg_temp.worked((select id from l1), 'band'), array['40m', '80m'], 'the edited contact''s band replaces the old one');
select is((select contact_spot_id = pg_temp.cid('c1') from pg_temp.entry((select id from l1), 'park', 'US-2763')), true,
  'its park now points at the new spot');

-- By hand only: contact marks go, hand marks stay; back to relay restores them.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select lives_ok(format('select save_goal(%L)', pg_temp.l1((select id from l1), pg_temp.d(-30), pg_temp.d(30))
                                                       || '{"marking": "hand"}'), 'switch to by hand only');
reset role;
select is(pg_temp.worked((select id from l1), 'state') || pg_temp.worked((select id from l1), 'park'), array['SC'],
  'a hand-only list keeps only hand marks');
select is(pg_temp.log(pg_temp.up('c10', 'K4HND', 21030, '15m', 'cw', pg_temp.t(500), 'TX')), array['created'], 'c10 is stored');
select is(pg_temp.worked((select id from l1), 'state'), array['SC'], 'a contact marks nothing on a hand-only list');
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select lives_ok(format('select save_goal(%L)', pg_temp.l1((select id from l1), pg_temp.d(-30), pg_temp.d(30))),
  'back to the relay');
reset role;
select is(pg_temp.worked((select id from l1), 'state'), array['NC', 'SC', 'TX', 'VA'], 'contact marks come back');

-- ---------------------------------------------------------------------------
-- Completion and status
-- ---------------------------------------------------------------------------

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table l2 as
select save_goal(jsonb_build_object('name', 'Small', 'starts_on', pg_temp.d(-3), 'ends_on', pg_temp.d(3),
  'requirements', '[{"kind": "band", "entries": ["15m"]}]'::jsonb)) as id;
select is(get_goal((select id from l2)) -> 'list' ->> 'status', 'complete',
  'a list whose every requirement is complete when saved is complete (c10 worked 15 m)');
select lives_ok(format('select mark_goal_entry(%L, %L, false)', pg_temp.req((select id from l2), 'band'), '15m'),
  'set its one entry back to needed');
select is(get_goal((select id from l2)) -> 'list' ->> 'status', 'active', 'it is active again');
select is(get_goal((select id from l2)) -> 'list' -> 'completed_at', 'null'::jsonb, 'completed_at is cleared');
select lives_ok(format('select mark_goal_entry(%L, %L, true)', pg_temp.req((select id from l2), 'band'), '15m'),
  'mark it worked by hand');
select is(get_goal((select id from l2)) -> 'list' ->> 'status', 'complete', 'a hand mark completes it');
reset role;
select is(pg_temp.log(pg_temp.up('c11', 'K4ABC', 21031, '15m', 'cw', pg_temp.t(510), null)), array['created'],
  'c11 is stored');
select is((select (worked_how)::text from pg_temp.entry((select id from l2), 'band', '15m')), 'hand',
  'a complete list takes no contact');

-- Ended in UTC: in a time zone whose date is not UTC's, ends_on yesterday (UTC) is ended and
-- ends_on today (UTC) is active.
do $$ begin
  if extract(hour from now() at time zone 'utc') >= 12 then
    execute 'set local timezone = ''Etc/GMT-14''';
  else
    execute 'set local timezone = ''Etc/GMT+12''';
  end if;
end $$;
select isnt(current_date, pg_temp.d(0), 'the session''s date is not the UTC date');
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table l3 as
select save_goal(jsonb_build_object('name', 'Ended', 'starts_on', pg_temp.d(-10), 'ends_on', pg_temp.d(-1),
  'requirements', '[{"kind": "band", "entries": ["20m", "6m"]}]'::jsonb)) as id;
select is(get_goal((select id from l3)) -> 'list' ->> 'status', 'ended', 'a list past its end date (UTC) is ended');
select is(get_goal((select id from l3)) -> 'list' -> 'worked', '1'::jsonb,
  'an ended list still counts the contacts inside its dates');
select lives_ok(format('select save_goal(%L)', jsonb_build_object('id', (select id from l3), 'name', 'Ended',
  'starts_on', pg_temp.d(-10), 'ends_on', pg_temp.d(0),
  'requirements', jsonb_build_array(jsonb_build_object('id', pg_temp.req((select id from l3), 'band'), 'kind', 'band',
                                                        'entries', array['20m', '6m'])))),
  'change the end date to today');
select is(get_goal((select id from l3)) -> 'list' ->> 'status', 'active', 'a list ending today (UTC) is active');
reset role;
reset timezone;

-- ---------------------------------------------------------------------------
-- Copies
-- ---------------------------------------------------------------------------

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table cp as select copy_goal((select id from l1)) as id;
create temp table cp2 as select copy_goal((select id from l1)) as id;
create temp table cp3 as select copy_goal((select id from l2)) as id;
reset role;
select is((select (name, starts_on = (pg_temp.d(-30) + interval '1 year')::date, ends_on = (pg_temp.d(30) + interval '1 year')::date,
                   marking)::text from goals where id = (select id from cp)),
  '("2027 chase",t,t,relay)', 'Copy for next year: the year in the name and the dates move a year on');
select is((select name from goals where id = (select id from cp2)), '2027 chase 2', 'a number follows a name in use');
select is((select name from goals where id = (select id from cp3)), 'Small copy', 'a name without a year gets " copy"');
select is((select array_agg(r.kind || ':' || e.value || ':' || (e.worked_at is null) order by r.position, e.position)
           from goal_entries e join goal_requirements r on r.id = e.requirement_id where r.list_id = (select id from cp3)),
  array['band:15m:true'], 'the copy has the same entries, all needed');
select is((select count(*) from goal_entries e join goal_requirements r on r.id = e.requirement_id
           where r.list_id = (select id from cp)), 16::bigint, 'every entry is copied');

-- ---------------------------------------------------------------------------
-- RLS, the delete guard, the cap
-- ---------------------------------------------------------------------------

create temp table l1r as select pg_temp.req((select id from l1), 'state') as id;
grant select on l1r to authenticated;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select is((select count(*) from goals), 0::bigint, 'another user sees no lists');
select is((select count(*) from goal_entries), 0::bigint, 'nor entries');
select is((select count(*) from goal_reviews), 0::bigint, 'nor reviews');
select throws_ok(format('select get_goal(%L)', (select id from l1)), 'P0001', 'Goal not found.',
  'nor reads one through get_goal');
select throws_ok(format('select mark_goal_entry(%L, %L, true)', (select id from l1r), 'GA'),
  'P0001', 'Goal not found.', 'nor marks one');
select throws_ok(format('select delete_goal(%L)', (select id from l1)), 'P0001', 'Goal not found.',
  'nor deletes one');
select throws_ok(format('select copy_goal(%L)', (select id from l1)), 'P0001', 'Goal not found.',
  'nor copies one');
select throws_ok(format('select resolve_goal_review(%L, null)', (select id from rv where callsign = 'W8XYZ')),
  'P0001', 'Review not found.', 'nor resolves a review');
create temp table lb as
select save_goal('{"name": "Mine", "requirements": [{"kind": "band", "entries": ["20m"]}]}') as id;
select is(get_goal((select id from lb)) -> 'relay',
  '{"status": "never", "last_contact_at": null, "logger_app": null, "relay_count": 0}'::jsonb,
  'relay: never without a relay or a contact');
reset role;
update logged_contacts set updated_at = now() - interval '8 days' where user_id = '11111111-1111-1111-1111-111111111111';
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is(get_goal((select id from l1)) -> 'relay' ->> 'status', 'stale', 'relay: stale with no contact for 7 days');
reset role;

insert into subscriptions (user_id, name, sources, rules)
values ('11111111-1111-1111-1111-111111111111', 'POTA states, CW', array['pota'],
        jsonb_build_array(jsonb_build_array(
          jsonb_build_object('field', 'mode', 'op', 'is', 'values', array['cw']),
          jsonb_build_object('field', 'goal', 'op', 'is', 'values', array[(select id from l1)]))));
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select throws_ok(format('select delete_goal(%L)', (select id from l1)), 'LL409', 'Remove it from its connections first.',
  'a list a connection names cannot be deleted');
select is(get_goal((select id from l1)) -> 'list' -> 'connection_count', '1'::jsonb, 'the card counts the connection');
select is((select jsonb_agg(u - 'id') from jsonb_array_elements(get_goal((select id from l1)) -> 'used_by') u),
  '[{"name": "POTA states, CW", "sources": ["pota"], "destination_count": 0}]'::jsonb, 'used_by names it');
select lives_ok(format('select delete_goal(%L)', (select id from l2)), 'an unused list is deleted');
select is((select count(*) from goals where id = (select id from l2)), 0::bigint, 'and is gone');
select throws_ok(format('select delete_goal(%L)', (select id from l2)), 'P0001', 'Goal not found.',
  'deleting it again is refused');
reset role;

insert into goals (user_id, name)
select '22222222-2222-2222-2222-222222222222', 'Cap ' || g from generate_series(1, 49) g;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select throws_ok($$ select save_goal('{"name": "One more", "requirements": [{"kind": "band", "entries": ["20m"]}]}') $$,
  'P0001', 'You can have up to 50 goals.', 'an account holds at most 50 goals');
reset role;

-- ---------------------------------------------------------------------------
-- State layers with licensed calls (list S, 60 to 50 days ago; contacts 55 days ago)
-- ---------------------------------------------------------------------------

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table ls as
select save_goal(jsonb_build_object('name', 'State layers', 'starts_on', pg_temp.d(-60), 'ends_on', pg_temp.d(-50),
  'requirements', '[{"kind": "state", "entries": ["NC", "VA", "TX", "OH", "MI", "SC", "GA", "CA"]},
                    {"kind": "park", "entries": ["US-9999"]}]'::jsonb)) as id;
reset role;
-- s1: K9TRL (licensed TX) at a trail in NC and VA: TX is not one of the park's states, so none.
select pg_temp.pota('K9TRL', 'US-4567', 'US-NC,US-VA', pg_temp.at(-55, -5));
-- s2: K9VAL (licensed VA) at the same kind of park: VA is one of its states.
select pg_temp.pota('K9VAL', 'US-4568', 'US-NC,US-VA', pg_temp.at(-55, 55));
-- s3: K9CAN (licensed OH) at a park in Ontario: no US state, so none.
select pg_temp.pota('K9CAN', 'CA-0123', 'CA-ON', pg_temp.at(-55, 115));
-- s4: K9TWO (licensed MI) at two parks, in GA and SC: none until a park is picked.
select pg_temp.pota('K9TWO', 'US-4570', 'US-GA', pg_temp.at(-55, 175));
select pg_temp.pota('K9TWO', 'US-4571', 'US-SC', pg_temp.at(-55, 185));
-- s5: K9CAT (licensed TX) at US-2763 (a spot without a location; the list says NC) and a GA park.
select pg_temp.pota('K9CAT', 'US-2763', null, pg_temp.at(-55, 235));
select pg_temp.pota('K9CAT', 'US-4572', 'US-GA', pg_temp.at(-55, 245));
select is(pg_temp.log(pg_temp.up('s1', 'K9TRL', 14061, '20m', 'cw', pg_temp.at(-55, 0), null),
                      pg_temp.up('s2', 'K9VAL', 14062, '20m', 'cw', pg_temp.at(-55, 60), null),
                      pg_temp.up('s3', 'K9CAN', 14063, '20m', 'cw', pg_temp.at(-55, 120), null),
                      pg_temp.up('s4', 'K9TWO', 14064, '20m', 'cw', pg_temp.at(-55, 180), null),
                      pg_temp.up('s5', 'K9CAT', 14065, '20m', 'cw', pg_temp.at(-55, 240), null),
                      -- s6: K9DC (licensed CA), no POTA spot, and the relay says DC: not a state, and
                      -- no fall through to the license.
                      pg_temp.up('s6', 'K9DC', 14066, '20m', 'cw', pg_temp.at(-55, 300), 'DC')),
  array['created', 'created', 'created', 'created', 'created', 'created'], 's1 to s6 are stored');
select is(pg_temp.worked((select id from ls), 'state'), array['VA'],
  'licensed calls: a multi-state park gives the license state only when it is one of the park''s, a non-US park and two parks give none, a contact''s DC gives none');
select is((select (select pota_reference from raw_spots where id = matched_spot_id) from pg_temp.entry((select id from ls), 'state', 'VA')),
  'US-4568', 'the state from a multi-state park keeps the park''s spot as evidence');
select is((select array_agg(s.callsign order by s.callsign) from goal_reviews v join raw_spots s on s.id = v.contact_spot_id
           where v.list_id = (select id from ls) and v.status = 'open'),
  array['K9CAT', 'K9TWO'], 'the two-park contacts need a look');

create temp table rs as
select v.id, s.callsign from goal_reviews v join raw_spots s on s.id = v.contact_spot_id where v.list_id = (select id from ls);
grant select on rs to authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select lives_ok(format('select resolve_goal_review(%L, %L)', (select id from rs where callsign = 'K9TWO'), 'US-4571'),
  'pick the SC park for K9TWO');
select lives_ok(format('select resolve_goal_review(%L, %L)', (select id from rs where callsign = 'K9CAT'), 'US-2763'),
  'pick US-2763 for K9CAT');
reset role;
select is(pg_temp.worked((select id from ls), 'state'), array['NC', 'SC', 'VA'],
  'a pick marks the picked park''s state: from its spot''s location (SC), else the list''s (NC for US-2763)');
select is((select (worked_how, worked_at = pg_temp.at(-55, 180), contact_spot_id = pg_temp.cid('s4'), matched_spot_id is null)::text
           from pg_temp.entry((select id from ls), 'state', 'SC')),
  '(contact,t,t,t)', 'with the contact as evidence');
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select lives_ok(format('select save_goal(%L)', jsonb_build_object('id', (select id from ls), 'name', 'State layers',
  'starts_on', pg_temp.d(-60), 'ends_on', pg_temp.d(-50), 'requirements', jsonb_build_array(
    jsonb_build_object('id', pg_temp.req((select id from ls), 'state'), 'kind', 'state',
                       'entries', array['NC', 'VA', 'TX', 'OH', 'MI', 'SC', 'GA', 'CA']),
    jsonb_build_object('id', pg_temp.req((select id from ls), 'park'), 'kind', 'park', 'entries', array['US-9999'])))),
  'save the list unchanged: a recheck');
reset role;
select is(pg_temp.worked((select id from ls), 'state'), array['NC', 'SC', 'VA'],
  'the recheck gives the same states as the live path, picks included');
select is((select (contact_spot_id = pg_temp.cid('s5'))::text from pg_temp.entry((select id from ls), 'state', 'NC')), 'true',
  'NC still comes from the K9CAT pick');

-- ---------------------------------------------------------------------------
-- The marking RPCs share apply_logged_contacts' lock
-- ---------------------------------------------------------------------------

select is((select array_agg(p.proname::text order by p.proname) from pg_proc p
           where p.pronamespace = 'public'::regnamespace
             and p.prosrc like '%pg_advisory_xact_lock(hashtextextended(''logged_contacts:'' || v_user::text, 0))%'),
  array['copy_goal', 'delete_goal', 'mark_goal_entry', 'preview_goal_window', 'resolve_goal_review',
        'save_goal'],
  'every goal RPC that writes marks takes the account''s logged_contacts lock');
select ok((select position('pg_advisory_xact_lock' in p.prosrc) < position('for update' in p.prosrc)
           from pg_proc p where p.proname = 'mark_goal_entry'),
  'mark_goal_entry takes it before the list''s row lock');

-- ---------------------------------------------------------------------------
-- preview_goal_window (list W, 200 to 100 days ago)
-- ---------------------------------------------------------------------------

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table lw as
select save_goal(jsonb_build_object('name', 'Window', 'starts_on', pg_temp.d(-200), 'ends_on', pg_temp.d(-100),
  'requirements', '[{"kind": "band", "entries": ["17m", "12m", "60m", "30m"]}]'::jsonb)) as id;
reset role;
-- 17 m is worked by w1 (180 days ago) and again by w2 (120 days ago); 12 m only by w3 (180 days
-- ago); 60 m by w4 (110 days ago); 30 m by hand.
select is(pg_temp.log(pg_temp.up('w1', 'K9WA', 18080, '17m', 'cw', pg_temp.at(-180, 0), null),
                      pg_temp.up('w2', 'K9WB', 18081, '17m', 'cw', pg_temp.at(-120, 0), null),
                      pg_temp.up('w3', 'K9WC', 24900, '12m', 'cw', pg_temp.at(-180, 10), null),
                      pg_temp.up('w4', 'K9WD', 5354, '60m', 'cw', pg_temp.at(-110, 0), null)),
  array['created', 'created', 'created', 'created'], 'w1 to w4 are stored');
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select lives_ok(format('select mark_goal_entry(%L, %L, true)', pg_temp.req((select id from lw), 'band'), '30m'),
  'mark 30 m by hand');
reset role;
create temp table lw_before as
select (select md5(string_agg(e::text, ',' order by e.value)) from goal_entries e
        where e.requirement_id = pg_temp.req((select id from lw), 'band')) as entries,
       (select md5(l::text) from goals l where l.id = (select id from lw)) as list,
       (select count(*) from goal_reviews) as reviews;
select is(pg_temp.worked((select id from lw), 'band'), array['12m', '17m', '30m', '60m'], 'every band is worked');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table pw as
select preview_goal_window((select id from lw), pg_temp.d(-150), pg_temp.d(-100), 'relay') as start_moved,
       preview_goal_window((select id from lw), pg_temp.d(-200), pg_temp.d(-115), 'relay') as end_moved,
       preview_goal_window((select id from lw), pg_temp.d(-200), pg_temp.d(-100), 'hand') as by_hand,
       preview_goal_window((select id from lw), pg_temp.d(-200), pg_temp.d(-100), 'relay') as unchanged,
       preview_goal_window((select id from lw), null, null, 'relay') as no_window;
select throws_ok(format('select preview_goal_window(%L, %L, null, %L)', (select id from lw), pg_temp.d(-1), 'relay'),
  'P0001', 'Give the time window a start and an end date.', 'preview: a window needs both dates');
select throws_ok(format('select preview_goal_window(%L, %L, %L, %L)', (select id from lw), pg_temp.d(-1), pg_temp.d(-2), 'relay'),
  'P0001', 'The end date can''t be before the start date.', 'preview: the end may not come before the start');
select throws_ok(format('select preview_goal_window(%L, null, null, %L)', (select id from lw), 'spots'),
  'P0001', 'Not a way to mark entries: spots.', 'preview: marking is relay or hand');
reset role;
select is((select jsonb_agg(x - 'requirement_id') from pw, jsonb_array_elements(start_moved) x),
  jsonb_build_array(jsonb_build_object('kind', 'band', 'value', '12m', 'worked_at', pg_temp.at(-180, 10), 'reason', 'before_start')),
  'start moved: 12 m (worked only before it) is returned; 17 m (worked again inside it) is not');
select is((select (start_moved -> 0 ->> 'requirement_id')::uuid from pw), pg_temp.req((select id from lw), 'band'),
  'each entry names its requirement');
select is((select jsonb_agg(jsonb_build_array(x ->> 'value', x ->> 'reason')) from pw, jsonb_array_elements(end_moved) x),
  '[["60m", "after_end"]]'::jsonb, 'end moved: 60 m, worked after it');
select is((select jsonb_agg(jsonb_build_array(x ->> 'value', x ->> 'reason') order by x ->> 'value') from pw, jsonb_array_elements(by_hand) x),
  '[["12m", "by_hand"], ["17m", "by_hand"], ["60m", "by_hand"]]'::jsonb,
  'by hand only: every contact mark, never the hand mark (30 m)');
select is((select unchanged from pw), '[]'::jsonb, 'the same window undoes nothing');
select is((select no_window from pw), '[]'::jsonb, 'no window undoes nothing');
select is((select (md5(string_agg(e::text, ',' order by e.value)) = (select entries from lw_before)) from goal_entries e
           where e.requirement_id = pg_temp.req((select id from lw), 'band')), true, 'the previews changed no entry');
select is((select md5(l::text) = (select list from lw_before) from goals l where l.id = (select id from lw)), true,
  'nor the list');
select is((select count(*) = (select reviews from lw_before) from goal_reviews), true, 'nor any review');
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select throws_ok(format('select preview_goal_window(%L, null, null, %L)', (select id from lw), 'relay'),
  'P0001', 'Goal not found.', 'preview: only the owner''s list');
reset role;

select * from finish();
rollback;

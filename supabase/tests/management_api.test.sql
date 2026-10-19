-- pgTAP: API tokens and the management API's SQL (20261013000300; group sharing keys 20261019000400).
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(68);

-- ---------------------------------------------------------------------------
-- Tokens
-- ---------------------------------------------------------------------------

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table tok as select * from create_api_token(' Club sync ', 'write', 30);
create temp table ro as select * from create_api_token('Dashboard', 'read', null);
grant all on tok, ro to authenticated;

select ok((select token ~ '^ll_live_[a-z2-7]{52}$' from tok), 'a token is ll_live_ plus 52 base32 characters');
select is((select name from tok), 'Club sync', 'the name is trimmed');
select is((select token_prefix from tok), (select left(token, 12) from tok), 'the prefix is the first 12 characters');
select ok((select expires_at between now() + interval '29 days 23 hours' and now() + interval '30 days 1 hour' from tok),
  'a 30-day token expires in 30 days');
select is((select expires_at from ro), null, 'a token without a lifetime never expires');
select throws_ok($$ select * from create_api_token('', 'write', null) $$, 'Give the token a name.');
select throws_ok($$ select * from create_api_token('x', 'admin', null) $$, 'Pick what the token can do.');
select throws_ok($$ select * from create_api_token('x', 'read', 7) $$, 'Pick when the token expires.');
select throws_ok($$ select token_hash from api_tokens $$, '42501', null, 'clients cannot read token hashes');
select is((select count(*) from api_tokens), 2::bigint, 'a user sees their own tokens');

select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select is((select count(*) from api_tokens), 0::bigint, 'another user sees none of them');
select throws_ok($$ select * from rotate_api_token((select id from tok)) $$, 'Token not found.');
delete from api_tokens where id = (select id from tok);
select * from create_api_token('one', 'read', null);
select * from create_api_token('two', 'read', null);
select * from create_api_token('three', 'read', null);
select * from create_api_token('four', 'read', null);
select * from create_api_token('five', 'read', null);
select * from create_api_token('six', 'read', null);
select * from create_api_token('seven', 'read', null);
select * from create_api_token('eight', 'read', null);
select * from create_api_token('nine', 'read', null);
select * from create_api_token('ten', 'read', null);
select throws_ok($$ select * from create_api_token('eleven', 'read', null) $$,
  'You can have up to 10 tokens. Delete one first.');
reset role;
select is((select count(*) from api_tokens where id = (select id from tok)), 1::bigint,
  'another user cannot delete a token');

-- authenticate_api_request
create function pg_temp.hash(p text) returns text language sql as
  $$ select encode(extensions.digest(p, 'sha256'), 'hex') $$;

select is((select user_id from authenticate_api_request(pg_temp.hash((select token from tok)))),
  '11111111-1111-1111-1111-111111111111'::uuid, 'a token authenticates as its owner');
select is((select requests from authenticate_api_request(pg_temp.hash((select token from tok)))), 2,
  'each request counts against the minute');
select ok((select last_used_at is not null from api_tokens where id = (select id from tok)), 'last_used_at is set');
select is((select count(*) from authenticate_api_request(pg_temp.hash('ll_' || repeat('0', 64)))), 0::bigint,
  'an unknown token authenticates as nobody');

update api_tokens set expires_at = now() - interval '1 second' where id = (select id from ro);
select is((select count(*) from authenticate_api_request(pg_temp.hash((select token from ro)))), 0::bigint,
  'an expired token authenticates as nobody');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table rotated as select * from rotate_api_token((select id from ro));
grant all on rotated to authenticated;
reset role;
select is((select count(*) from authenticate_api_request(pg_temp.hash((select token from ro)))), 0::bigint,
  'the old secret stops working on rotation');
select is((select scope from authenticate_api_request(pg_temp.hash((select token from rotated)))), 'read',
  'the new secret works, with the same scope');
select is((select expires_at from rotated), null, 'rotation keeps a token without a lifetime unexpiring');

-- ---------------------------------------------------------------------------
-- api_call
-- ---------------------------------------------------------------------------

create function pg_temp.call(p_op text, p_args jsonb default '{}') returns jsonb language sql as
  $$ select api_call((select id from tok), p_op, p_args) $$;
create function pg_temp.read_call(p_op text, p_args jsonb default '{}') returns jsonb language sql as
  $$ select api_call((select id from ro), p_op, p_args) $$;

select throws_ok($$ select pg_temp.call('drop_everything') $$, 'Unknown operation.');
select throws_ok($$ select pg_temp.read_call('create_group', '{"name":"x"}') $$, 'This token is read only.');
select is(pg_temp.read_call('list_groups'), '[]'::jsonb, 'a read token can read');
select set_config('request.jwt.claims', '{"sub": "33333333-3333-3333-3333-333333333333"}', true);
select pg_temp.read_call('list_groups');
select is(auth.uid(), '33333333-3333-3333-3333-333333333333'::uuid, 'api_call puts the caller''s claims back');

create temp table dest as
  select (pg_temp.call('create_destination', '{"type":"webhook","name":"Hook","url":"https://example.com/h"}') ->> 'id')::uuid as id;
create temp table sub as
  select (pg_temp.call('create_subscription', jsonb_build_object('body', jsonb_build_object(
    'name', 'Club', 'rules', '[[{"field": "callsign", "op": "is", "values": ["w1aw"]}]]'::jsonb, 'destinations', jsonb_build_array((select id from dest))))) ->> 'id')::uuid as id;

select ok(not (pg_temp.call('list_destinations') -> 0 ?| array['url', 'signing_secret']),
  'listed destinations carry neither url nor signing_secret');
select ok((select s ? 'rules' and not s ?| array['group_ids', 'callsigns', 'bands', 'modes', 'reference']
            from (select pg_temp.call('get_subscription', jsonb_build_object('id', (select id from sub))) as s) t),
  'a subscription shows its rules, not group_ids or the old filter columns');
-- A subscription has no single callsign list any more; the per-call ops are gone.
select throws_ok(format($$ select pg_temp.call('add_subscription_callsigns', '{"id": "%s", "callsigns": ["K4ABC"]}') $$,
  (select id from sub)), 'Unknown operation.');
select throws_ok(format($$ select pg_temp.call('remove_subscription_callsigns', '{"id": "%s", "callsigns": ["W1AW"]}') $$,
  (select id from sub)), 'Unknown operation.');
create temp table grp as
  select (pg_temp.call('create_group', '{"name": "Members", "callsigns": ["w1aw"]}') ->> 'id')::uuid as id;
select is(pg_temp.call('add_group_members', jsonb_build_object('id', (select id from grp),
  'callsigns', '["kn4xyz/p", "KN4XYZ"]'::jsonb)) -> 'callsigns', '["KN4XYZ", "W1AW"]'::jsonb,
  'group members are added as base calls, once each');
select throws_ok(format($$ select pg_temp.call('add_group_members', '{"id": "%s", "callsigns": ["bogus!"]}') $$,
  (select id from grp)), 'Not a callsign: BOGUS!.');
select is(pg_temp.call('remove_group_members', jsonb_build_object('id', (select id from grp),
  'callsigns', '["w1aw/p"]'::jsonb)) -> 'callsigns', '["KN4XYZ"]'::jsonb, 'removal matches on the base call');
select is(pg_temp.call('update_group', jsonb_build_object('id', (select id from grp), 'name', 'Club')) -> 'callsigns',
  '["KN4XYZ"]'::jsonb, 'renaming a group keeps its members');
select ok((select g ? 'connection_count' and not g ? 'subscription_count'
            from pg_temp.call('get_group', jsonb_build_object('id', (select id from grp))) g),
  'a group shows connection_count, not subscription_count');
select is(pg_temp.call('patch_subscription', jsonb_build_object('id', (select id from sub),
  'body', '{"quiet_minutes": 30}'::jsonb)) -> 'rules', '[[{"field": "callsign", "op": "is", "values": ["W1AW"]}]]'::jsonb,
  'a patch keeps the fields it does not name');
-- Set a reference rule first, in its own statement, so the null patch below has something to keep.
select pg_temp.call('patch_subscription', jsonb_build_object('id', (select id from sub),
  'body', '{"rules": [[{"field": "reference", "op": "contains", "values": ["US-1234"]}]]}'::jsonb));
create temp table nulled as
  select pg_temp.call('patch_subscription', jsonb_build_object('id', (select id from sub),
    'body', '{"name": null, "rules": null, "enabled": null, "quiet_minutes": null, "sources": ["POTA"]}'::jsonb)) as s;
grant all on nulled to authenticated;
select is((select s -> 'rules' from nulled), '[[{"field": "reference", "op": "contains", "values": ["US-1234"]}]]'::jsonb,
  'null rules in a patch keep the stored ones');
select ok((select s ->> 'name' <> '' from nulled), 'a null name in a patch keeps the stored one');
select is((select s -> 'sources' from nulled), '["pota"]'::jsonb,
  'a patch that mixes nulls with a list still applies the list');
select is(pg_temp.call('replace_subscription', jsonb_build_object('id', (select id from sub),
  'body', '{"name": "Club", "sources": []}'::jsonb)) -> 'rules',
  '[[{"field": "reference", "op": "contains", "values": ["US-1234"]}]]'::jsonb,
  'a PUT without rules keeps the stored rules rather than widening to every spot');
select throws_ok(format($$ select pg_temp.call('replace_subscription', '{"id": "%s", "body": {"name": "Club", "callsigns": ["W1AW"]}}') $$,
  (select id from sub)), 'Filters are rules now: send rules instead of bands, modes, callsigns, reference or group_ids.');
create temp table renamed as
  select pg_temp.call('update_group', jsonb_build_object('id', (select id from grp), 'name', null,
    'callsigns', '["kn4xyz", "w1aw"]'::jsonb)) as g;
grant all on renamed to authenticated;
select is((select g ->> 'name' from renamed), 'Club', 'a null group name counts as left out');
select is((select g -> 'callsigns' from renamed), '["KN4XYZ", "W1AW"]'::jsonb,
  'the members in the same patch still change');
-- The API does not share group pages (20261019000400): the sharing keys are dropped.
create temp table shared as
  select (pg_temp.call('create_group', '{"name": "Shared", "public": true, "show_callsigns": true}') ->> 'id')::uuid as id;
select pg_temp.call('update_group', jsonb_build_object('id', (select id from shared), 'public', true));
select is((select (public, show_callsigns, public_slug is null) from callsign_groups where id = (select id from shared)),
  (false, false, true), 'the API cannot make a group page public');
select throws_ok(format($$ select pg_temp.call('patch_subscription', '{"id": "%s", "body": {"quiet_minutes": 7}}') $$,
  (select id from sub)), 'quiet_minutes must be 0, 5, 10, 30 or 60.');
select throws_ok(format($$ select pg_temp.call('patch_subscription', '{"id": "%s", "body": {"quiet_minutes": 3000000000}}') $$,
  (select id from sub)), 'quiet_minutes must be 0, 5, 10, 30 or 60.');
select throws_ok(format($$ select pg_temp.call('patch_subscription', '{"id": "%s", "body": {"quiet_minutes": 7.5}}') $$,
  (select id from sub)), 'quiet_minutes must be 0, 5, 10, 30 or 60.');
select throws_ok(format($$ select pg_temp.call('patch_subscription', '{"id": "%s", "body": {"quiet_minutes": "soon"}}') $$,
  (select id from sub)), 'quiet_minutes must be 0, 5, 10, 30 or 60.');
select is(pg_temp.call('patch_subscription', jsonb_build_object('id', (select id from sub),
  'body', '{"quiet_minutes": 60.0}'::jsonb)) -> 'quiet_minutes', '60'::jsonb, 'an allowed value written as 60.0 is accepted');
select is(pg_temp.call('patch_subscription', jsonb_build_object('id', (select id from sub),
  'body', '{"destinations": []}'::jsonb)) -> 'destinations', '[]'::jsonb, 'a subscription can have no destinations');
select is(pg_temp.call('patch_subscription', jsonb_build_object('id', (select id from sub),
  'body', jsonb_build_object('destinations', jsonb_build_array((select id from dest))))) -> 'destinations',
  jsonb_build_array((select id from dest)), 'and get one back');
select throws_ok(format($$ select pg_temp.call('delete_destination', '{"id": "%s"}') $$, (select id from dest)),
  'Remove it from its connections first.');

-- Push: created without a URL, listed as "Your devices", and never given a URL.
create temp table pushed as
  select pg_temp.call('create_destination', '{"type": "push", "name": "Phones"}') as j;
select is((select j ->> 'url_display' from pushed), 'Your devices', 'the API creates a push destination');
select is((select count(*) from jsonb_array_elements(pg_temp.call('list_destinations')) d
           where d ->> 'type' = 'push' and d ->> 'url_display' = 'Your devices'), 1::bigint,
  'push is listed like any other destination');
select throws_ok(format($$ select pg_temp.call('update_destination', '{"id": "%s", "url": "https://example.com/x"}') $$,
  (select j ->> 'id' from pushed)), 'Push notifications don''t use a URL.');
-- Many push destinations per account (20261016000400), each with its settings and a device count.
select is((pg_temp.call('create_destination', '{"type": "push", "name": "Desktop"}') ->> 'url_display'), 'Your devices',
  'a second push destination is created');
select throws_ok($$ select pg_temp.call('create_destination', '{"type": "push", "name": "phones"}') $$,
  'A destination named phones already exists. Choose a different name.');
select is((select d -> 'push' from jsonb_array_elements(pg_temp.call('list_destinations')) d where d ->> 'name' = 'Phones'),
  '{"sound": true, "urgency": "normal", "quiet_from": "22:00:00", "quiet_mode": "silent", "tap_target": "profile",
    "quiet_until": "07:00:00", "ttl_seconds": 1800, "device_count": 0, "quiet_enabled": false, "action_buttons": true,
    "replace_same_station": true, "title_fields": ["callsign", "frequency", "mode"],
    "body_fields": ["source", "reference", "place_name", "state"], "show_field_names": false, "body_separator": "dot"}'::jsonb,
  'a push destination shows its settings and device count, never devices');
select is((select count(*) from jsonb_array_elements(pg_temp.call('list_destinations')) d where d ? 'push'), 2::bigint,
  'only push destinations carry push');
-- Discord destinations (20261018000100) show their message settings, read only.
select pg_temp.call('create_destination', '{"type": "discord", "name": "Chat", "url": "https://discord.com/api/webhooks/1/a"}');
select is((select d -> 'discord' from jsonb_array_elements(pg_temp.call('list_destinations')) d where d ->> 'name' = 'Chat'),
  '{"style": "card", "footer": true, "separator": "dot", "bold_first": true, "card_color": "source", "title_link": "profile",
    "grid_fields": ["band", "spotter"], "line_fields": ["callsign", "frequency", "mode", "source", "reference", "place_name"],
    "link_preview": "hidden", "title_fields": ["callsign", "frequency", "mode"], "batch_seconds": 0,
    "detail_fields": ["source", "reference", "place_name", "state"], "show_field_names": false}'::jsonb,
  'a Discord destination shows its settings');
select results_eq($$ select d ->> 'type', d ? 'discord', d ? 'push', d ? 'webhook'
                     from jsonb_array_elements(pg_temp.call('list_destinations')) d order by d ->> 'name' $$,
  $$ values ('discord'::text, true, false, false), ('push', false, true, false), ('webhook', false, false, true),
            ('push', false, true, false) $$,
  'only Discord destinations carry discord, and only webhooks webhook');
-- Webhooks (20261018000300) show their settings, header names and times, read only.
select is((select d -> 'webhook' from jsonb_array_elements(pg_temp.call('list_destinations')) d where d ->> 'name' = 'Hook'),
  '{"fields": ["id", "time", "callsign", "frequency", "mode", "band", "source", "reference", "place_name", "state", "spotter"],
    "key_style": "snake", "time_format": "iso_utc", "frequency_unit": "khz", "missing_values": "omit", "batch_seconds": 0,
    "retry_policy": "three_10m", "pause_after_failures": 20, "headers": [], "auto_disabled_at": null}'::jsonb
  || jsonb_build_object('secret_rotated_at', now()),
  'a webhook created through the API gets the defaults and shows them');
update destinations set enabled = false, auto_disabled_at = now() - interval '1 hour', pause_failures = 20
  where id = (select id from dest);
select is((select (j -> 'enabled')::boolean and j #> '{webhook,auto_disabled_at}' = 'null'::jsonb
           from pg_temp.call('update_destination', jsonb_build_object('id', (select id from dest), 'enabled', true)) j),
  true, 'PATCH with "enabled": true resumes a paused webhook');
select is(pg_temp.call('update_destination', jsonb_build_object('id', (select j ->> 'id' from pushed), 'enabled', false)) -> 'enabled',
  'false'::jsonb, 'PATCH turns a destination off');
select is(pg_temp.call('update_destination', jsonb_build_object('id', (select j ->> 'id' from pushed), 'name', 'Phone')) -> 'enabled',
  'false'::jsonb, 'and a PATCH without enabled leaves it off');
select is((pg_temp.call('get_destination', jsonb_build_object('id', (select id from dest))) -> 'enabled'), 'true'::jsonb,
  'destinations start enabled');

-- Another user's token cannot see or change user 1's rows.
reset role;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
delete from api_tokens where name = 'ten';
create temp table other as select * from create_api_token('Other', 'write', null);
reset role;
select throws_ok(format($$ select api_call((select id from other), 'get_subscription', '{"id": "%s"}') $$,
  (select id from sub)), 'Connection not found.');
select throws_ok(format($$ select api_call((select id from other), 'patch_subscription', '{"id": "%s", "body": {"rules": []}}') $$,
  (select id from sub)), 'Connection not found.');

select * from finish();
rollback;

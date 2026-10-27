-- pgTAP: webhook destinations as canvas page 7 draws them
-- (20261018000300_webhook_destinations). The masked URL and rotation time,
-- settings with a defaults trigger and the backfill, extra headers in Vault,
-- the spot rendered in SQL as ordered pairs, the save/get/list/preview RPCs,
-- what claim_deliveries and Send test hand out, the pause after repeated
-- failures, duplicate and the management API's read-only view. The hold,
-- the per-claim cap and the retry schedules are in deliveries_rpc.test.sql;
-- the attempts predicate past the sweep's 500 in claim_expiry.test.sql.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(173);
select pgmq.purge_queue('spot_events');
select pgmq.purge_queue('deliveries_queue');
delete from deliveries;
delete from raw_spots;

create temp table defaults as select webhook_default_settings() as j;
grant select on defaults to authenticated;

-- Settings from a jsonb merged over the defaults, as the preview builds them.
create function pg_temp.ws(p jsonb) returns webhook_destination_settings language sql as $$
  select jsonb_populate_record(null::webhook_destination_settings, webhook_default_settings() || p);
$$;
-- The keys of a pair list, in order.
create function pg_temp.keys(p jsonb) returns text[] language sql as $$
  select array(select x ->> 'key' from jsonb_array_elements(p) with ordinality t(x, n) order by n);
$$;
-- The keys of a json object, in the order its text has them.
create function pg_temp.json_keys(p json) returns text[] language sql as $$
  select array(select k from json_object_keys(p) with ordinality t(k, n) order by n);
$$;
-- The Vault values of a destination's headers, by position (the runner may read Vault).
create function pg_temp.header_values(p_id uuid) returns table (name text, value text) language sql as $$
  select h.name, s.decrypted_secret from webhook_destination_headers h
  join vault.decrypted_secrets s on s.id = h.secret_id where h.destination_id = p_id order by h.position;
$$;

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '';
select throws_ok($$ select * from save_webhook_destination(null, 'x', true, 'https://example.com/h', null, null) $$,
  'P0001', 'Not signed in.', 'save needs a session');
select throws_ok(format('select get_webhook_destination(%L)', gen_random_uuid()), 'P0001', 'Not signed in.', 'get needs a session');
select throws_ok($$ select list_webhook_destination_settings() $$, 'P0001', 'Not signed in.', 'list needs a session');
select throws_ok($$ select preview_webhook_request(null) $$, 'P0001', 'Not signed in.', 'preview needs a session');

-- ---------------------------------------------------------------------------
-- Destinations: masked URL, rotation time, columns
-- ---------------------------------------------------------------------------
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table logger as select * from create_destination('webhook', 'Logger', 'https://logger.example.org/hook/abc123?k=v');
grant all on logger to authenticated;
reset role;
create temp view logger_row as select * from destinations where id = (select id from logger);
grant select on logger_row to authenticated;
select is((select url_display from logger), 'https://logger.example.org/hook/••••••',
  'a webhook''s display masks the last path segment and drops the query');
select is(array[destination_url_display('webhook', 'https://example.org/'), destination_url_display('webhook', 'https://example.org'),
                destination_url_display('webhook', 'https://example.org/abc'),
                destination_url_display('webhook', 'https://example.org:8443/a/b/'),
                destination_url_display('webhook', 'https://example.org/a/b#frag')],
  array['https://example.org/', 'https://example.org/', 'https://example.org/••••••', 'https://example.org:8443/a/••••••/',
        'https://example.org/a/••••••'],
  'a bare root stays; a trailing slash masks the segment before it and stays; the port stays; the fragment goes');
select is(destination_url_display('webhook', 'https://hooks.zapier.com/hooks/catch/123456/abcdef/'),
  'https://hooks.zapier.com/hooks/catch/123456/••••••/', 'a Zapier catch hook''s token is masked, not shown');
select is(destination_url_display('discord', 'https://discord.com/api/webhooks/1182334455/xY9abcTOKEN'),
  'https://discord.com/api/webhooks/1182…/xY9', 'Discord''s display is unchanged');
select is((select secret_rotated_at from logger_row), now(), 'a new webhook''s secret is stamped as rotated now');
select is((select count(*) from destinations where type = 'webhook' and secret_rotated_at is null), 0::bigint,
  'every webhook has a rotation time');
update destinations set secret_rotated_at = now() - interval '1 day' where id = (select id from logger);
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select matches(rotate_signing_secret((select id from logger)), '^whsec_[0-9a-f]{48}$', 'rotate returns a new secret');
select is((select secret_rotated_at from logger_row), now(), 'rotating moves the rotation time');
select throws_ok($$ select secret_rotated_at from destinations $$, '42501', null, 'clients cannot read secret_rotated_at');
select lives_ok($$ select auto_disabled_at from destinations $$, 'clients can read auto_disabled_at (the Paused chip)');
reset role;
select ok(not has_column_privilege('authenticated', 'public.destinations', 'pause_failures', 'select')
          and not has_column_privilege('authenticated', 'public.destinations', 'pause_failure_at', 'select')
          and not has_column_privilege('authenticated', 'public.destinations', 'secret_rotated_at', 'select')
          and has_column_privilege('authenticated', 'public.destinations', 'auto_disabled_at', 'select'),
  'only auto_disabled_at joins the client column grant');
select is((select pause_failures from logger_row), 0, 'the pause count starts at zero');

-- ---------------------------------------------------------------------------
-- Catalog and knobs
-- ---------------------------------------------------------------------------
select is(webhook_fields(), array['id', 'time', 'callsign', 'first_name', 'last_name', 'frequency', 'mode', 'band', 'source',
                                  'reference', 'place_name', 'state', 'spotter', 'country', 'url', 'comment'],
  'the field catalog, in the editor''s order');
select ok(webhook_fields_valid(array['id']) and webhook_fields_valid(webhook_fields())
          and not webhook_fields_valid('{}') and not webhook_fields_valid(null)
          and not webhook_fields_valid(array['id', 'id']) and not webhook_fields_valid(array['grid'])
          and not webhook_fields_valid(array[null]::text[]),
  'a field list is 1 to 16 known fields, each once');
select is(array[destination_batch_full('discord'), destination_batch_full('webhook'), destination_batch_full('push')],
  array[10, 50, null], 'a hold releases at 10 Discord spots or 50 webhook spots');
select is(array[webhook_claim_max(0), webhook_claim_max(10), webhook_claim_max(30), webhook_claim_max(60)],
  array[5::numeric, null, null, null], 'one request per spot: 5 a claim; grouped: no cap beyond the bucket');
select is(array[webhook_retry_max_attempts('none'), webhook_retry_max_attempts('three_10m'), webhook_retry_max_attempts('day')],
  array[1, 4, null], 'attempts: none 1, three_10m 4, day no limit');
select is(array[webhook_retries_exhausted('none', 0), webhook_retries_exhausted('none', 1),
                webhook_retries_exhausted('three_10m', 3), webhook_retries_exhausted('three_10m', 4),
                webhook_retries_exhausted('day', 1000), webhook_retries_exhausted(null, 1000)],
  array[false, true, false, true, false, false], 'exhausted once the attempts are used; never for day or other types');
select is((select array_agg(webhook_retry_delay('three_10m', a) order by a) from generate_series(1, 3) a),
  array[60, 180, 360], 'three_10m waits 60, 180 and 360 seconds');
select is((select array_agg(webhook_retry_delay('day', a) order by a) from generate_series(1, 8) a),
  array[30, 60, 120, 300, 900, 1800, 1800, 1800], 'day follows the old backoff, then every 30 minutes');
select is(webhook_retry_delay('none', 1), 0, 'none never waits');
select is(webhook_pause_spacing(), interval '30 seconds', 'failures count toward the pause at most every 30 seconds');
select ok(not has_function_privilege('authenticated', 'public.webhook_retry_delay(text, int)', 'execute')
          and not has_function_privilege('authenticated', 'public.webhook_claim_max(int)', 'execute')
          and not has_function_privilege('authenticated', 'public.destination_batch_full(text)', 'execute'),
  'the knobs are not callable by clients');

-- ---------------------------------------------------------------------------
-- Settings: the trigger, the backfill, privileges
-- ---------------------------------------------------------------------------
select is((select to_jsonb(s) - 'destination_id' from webhook_destination_settings s where s.destination_id = (select id from logger)),
  (select j from defaults), 'a new webhook gets the default settings through the trigger');
select is((select j from defaults),
  '{"fields": ["id", "time", "callsign", "frequency", "mode", "band", "source", "reference", "place_name", "state", "spotter"],
    "key_style": "snake", "time_format": "iso_utc", "frequency_unit": "khz", "missing_values": "omit", "batch_seconds": 0,
    "retry_policy": "three_10m", "pause_after_failures": 20}'::jsonb,
  'the defaults are the canvas''s, with the pause at 20 since the editor shipped (20261018000400)');
select is(webhook_legacy_settings(),
  (select j from defaults) || jsonb_build_object('fields', to_jsonb(webhook_fields()), 'batch_seconds', 10,
                                                 'retry_policy', 'day', 'pause_after_failures', null),
  'a webhook made before the migration gets every field, grouped every 10 s, retried for a day, never paused');
-- The migration's backfill, repeated: it restores a missing row once, with the legacy settings.
delete from webhook_destination_settings where destination_id = (select id from logger);
insert into webhook_destination_settings
select (jsonb_populate_record(null::webhook_destination_settings,
         webhook_legacy_settings() || jsonb_build_object('destination_id', d.id))).*
from destinations d
where d.type = 'webhook' and not exists (select 1 from webhook_destination_settings s where s.destination_id = d.id);
insert into webhook_destination_settings
select (jsonb_populate_record(null::webhook_destination_settings,
         webhook_legacy_settings() || jsonb_build_object('destination_id', d.id))).*
from destinations d
where d.type = 'webhook' and not exists (select 1 from webhook_destination_settings s where s.destination_id = d.id);
select results_eq($$ select cardinality(fields), batch_seconds, retry_policy, pause_after_failures
                     from webhook_destination_settings where destination_id = (select id from logger) $$,
  $$ values (16, 10, 'day'::text, null::int) $$, 'the backfill restores a missing row once, with the legacy settings');
update webhook_destination_settings s set fields = d.fields, batch_seconds = d.batch_seconds, retry_policy = d.retry_policy,
       pause_after_failures = d.pause_after_failures
  from pg_temp.ws('{}') d where s.destination_id = (select id from logger);
select ok((select c.relrowsecurity from pg_class c where c.oid = 'public.webhook_destination_settings'::regclass)
          and not has_table_privilege('authenticated', 'public.webhook_destination_settings', 'select')
          and not has_table_privilege('authenticated', 'public.webhook_destination_settings', 'update')
          and not has_table_privilege('anon', 'public.webhook_destination_settings', 'select')
          and not has_table_privilege('delivery_sender', 'public.webhook_destination_settings', 'select'),
  'settings: RLS on, no client or sender privileges');
select throws_ok($$ insert into webhook_destination_settings
                    select (jsonb_populate_record(null::webhook_destination_settings,
                            webhook_default_settings() || jsonb_build_object('destination_id', (select id from logger),
                                                                             'fields', '["id", "id"]'::jsonb))).* $$,
  '23514', null, 'the table refuses a field twice');
create temp table others as
  select (select id from create_destination('discord', 'Chat', 'https://discord.com/api/webhooks/1/a')) as chat;
grant select on others to authenticated;
select is((select count(*) from webhook_destination_settings where destination_id = (select chat from others)), 0::bigint,
  'other types get no webhook settings');

-- ---------------------------------------------------------------------------
-- Validation, through the preview (which writes nothing)
-- ---------------------------------------------------------------------------
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select throws_ok($$ select preview_webhook_request('[]') $$, 'P0001', 'Settings must be an object.', 'settings are an object');
select throws_ok($$ select preview_webhook_request('{"colour": "red"}') $$, 'P0001', 'Unknown setting colour.', 'unknown keys');
select throws_ok($$ select preview_webhook_request('{"fields": ["id", "grid"]}') $$, 'P0001', 'Unknown field grid.', 'unknown fields');
select throws_ok($$ select preview_webhook_request('{"fields": []}') $$, 'P0001', 'Pick at least one field.', 'at least one field');
select throws_ok($$ select preview_webhook_request('{"fields": ["id", "time", "id"]}') $$, 'P0001', 'Pick each field once.',
  'each field once');
select throws_ok($$ select preview_webhook_request('{"key_style": "kebab"}') $$, 'P0001', 'Pick a key style.', 'key style');
select throws_ok($$ select preview_webhook_request('{"time_format": "rfc2822"}') $$, 'P0001', 'Pick a time format.', 'time format');
select throws_ok($$ select preview_webhook_request('{"frequency_unit": "ghz"}') $$, 'P0001', 'Pick a frequency unit.', 'frequency unit');
select throws_ok($$ select preview_webhook_request('{"missing_values": "empty"}') $$, 'P0001',
  'Pick what to send when a spot has no value.', 'missing values');
select throws_ok($$ select preview_webhook_request('{"batch_seconds": 5}') $$, 'P0001', 'Pick a batch window.', 'batch window');
select throws_ok($$ select preview_webhook_request('{"retry_policy": "forever"}') $$, 'P0001', 'Pick a retry policy.', 'retry policy');
select throws_ok($$ select preview_webhook_request('{"pause_after_failures": 0}') $$, 'P0001',
  'Pause after 1 to 100 failures, or never.', 'pause below 1');
select throws_ok($$ select preview_webhook_request('{"pause_after_failures": 101}') $$, 'P0001',
  'Pause after 1 to 100 failures, or never.', 'pause above 100');
select lives_ok($$ select preview_webhook_request('{"pause_after_failures": null, "retry_policy": "none"}') $$,
  'pause null is never');
reset role;

-- ---------------------------------------------------------------------------
-- Rendering
-- ---------------------------------------------------------------------------
create temp table spot as select jsonb_build_object(
  'id', 4421907, 'source', 'pota', 'spot_time', '2026-10-17T17:42:09.750+00:00', 'callsign', 'KK4PWJ',
  'base_callsign', 'KK4PWJ', 'spotter', 'W4ABC', 'frequency_khz', 14062.000, 'band', '20m', 'mode', 'cw',
  'mode_family', 'cw', 'comment', 'say "hi"' || chr(10) || 'bye', 'pota_reference', 'US-2763',
  'pota_park_name', 'Falls Lake SRA', 'pota_location', 'US-NC', 'sota_summit_ref', null, 'wwff_reference', null,
  'wwff_reference_name', null) as j;
create temp table dx as select jsonb_build_object(
  'id', 7, 'source', 'dxcluster', 'spot_time', '2026-10-17T17:42:09Z', 'callsign', 'JA1XYZ', 'base_callsign', 'JA1XYZ',
  'spotter', 'W1AW', 'frequency_khz', 21074.000, 'band', '15m', 'mode', 'ft8', 'mode_family', 'digital', 'comment', '',
  'pota_reference', null, 'pota_park_name', null, 'pota_location', null, 'sota_summit_ref', null, 'wwff_reference', null,
  'wwff_reference_name', null) as j;

delete from callsign_licenses where callsign = 'KK4PWJ';
delete from hidden_callsigns where callsign = 'KK4PWJ';
insert into callsign_licenses (callsign, authority, name, first_name, last_name, loaded_at)
values ('KK4PWJ', 'FCC', 'Jane Q Doe', 'Jane', 'Doe', now());

select is(webhook_spot_fields(pg_temp.ws('{}'), (select j from spot)),
  '[{"key": "id", "value": 4421907}, {"key": "time", "value": "2026-10-17T17:42:09Z"}, {"key": "callsign", "value": "KK4PWJ"},
    {"key": "frequency_khz", "value": 14062}, {"key": "mode", "value": "cw"}, {"key": "band", "value": "20m"},
    {"key": "source", "value": "pota"}, {"key": "reference", "value": "US-2763"}, {"key": "place_name", "value": "Falls Lake SRA"},
    {"key": "state", "value": "NC"}, {"key": "spotter", "value": "W4ABC"}]'::jsonb,
  'the default eleven pairs, in order, values as stored');
select is(pg_temp.keys(webhook_spot_fields(pg_temp.ws('{}'), push_sample_spot())),
  array['id', 'time', 'callsign', 'frequency_khz', 'mode', 'band', 'source', 'reference', 'place_name', 'state', 'spotter'],
  'the sample spot renders the same keys');
select is(pg_temp.keys(webhook_spot_fields(pg_temp.ws(jsonb_build_object('fields', to_jsonb(webhook_fields()), 'key_style', 'camel')),
                                           (select j from spot))),
  array['id', 'time', 'callsign', 'firstName', 'lastName', 'frequencyKhz', 'mode', 'band', 'source', 'reference', 'placeName',
        'state', 'spotter', 'country', 'url', 'comment'], 'camelCase keys');
select is(array[webhook_field_value('first_name', (select j from spot), 'iso_utc', 'khz'),
                webhook_field_value('last_name', (select j from spot), 'iso_utc', 'khz'),
                webhook_field_value('first_name', (select j from dx), 'iso_utc', 'khz')],
  array['"Jane"', '"Doe"', null]::jsonb[], 'the names are the spotted call''s license''s, none without one');
insert into hidden_callsigns (callsign) values ('KK4PWJ');
select is(webhook_field_value('first_name', (select j from spot), 'iso_utc', 'khz'), null, 'a hidden call has no name');
delete from hidden_callsigns where callsign = 'KK4PWJ';
select is(array[webhook_field_key('frequency', 'snake', 'mhz'), webhook_field_key('frequency', 'snake', 'hz'),
                webhook_field_key('frequency', 'camel', 'mhz'), webhook_field_key('frequency', 'camel', 'hz'),
                webhook_field_key('place_name', 'snake', 'khz'), webhook_field_key('spotter', 'camel', 'khz'),
                webhook_field_key('first_name', 'snake', 'khz'), webhook_field_key('last_name', 'camel', 'khz')],
  array['frequency_mhz', 'frequency_hz', 'frequencyMhz', 'frequencyHz', 'place_name', 'spotter', 'first_name', 'lastName'],
  'the unit is in the key');
select is(array[webhook_field_value('frequency', (select j from spot), 'iso_utc', 'khz'),
                webhook_field_value('frequency', (select j from spot), 'iso_utc', 'mhz'),
                webhook_field_value('frequency', (select j from spot), 'iso_utc', 'hz'),
                webhook_field_value('frequency', '{"frequency_khz": 10123.900}', 'iso_utc', 'khz'),
                webhook_field_value('frequency', '{"frequency_khz": 10123.900}', 'iso_utc', 'mhz'),
                webhook_field_value('frequency', '{"frequency_khz": 10123.900}', 'iso_utc', 'hz')],
  array['14062', '14.062', '14062000', '10123.9', '10.1239', '10123900']::jsonb[], 'kHz, MHz and Hz, exact and without trailing zeros');
select is(array[webhook_field_value('time', (select j from spot), 'iso_utc', 'khz'),
                webhook_field_value('time', (select j from spot), 'unix_seconds', 'khz')],
  array['"2026-10-17T17:42:09Z"', '1792258929']::jsonb[], 'ISO 8601 UTC in whole seconds, or Unix seconds');
-- cty.dat as the test sets it: none, then one entity.
delete from cty_prefixes;
delete from cty_entities;
select is(pg_temp.keys(webhook_spot_fields(pg_temp.ws(jsonb_build_object('fields', to_jsonb(webhook_fields()))), (select j from dx))),
  array['id', 'time', 'callsign', 'frequency_khz', 'mode', 'band', 'source', 'spotter'],
  'a DX Cluster spot leaves out names, reference, place name, state, URL, the empty comment and an unknown country');
select is((select x -> 'value' from jsonb_array_elements(webhook_spot_fields(
             pg_temp.ws(jsonb_build_object('fields', to_jsonb(webhook_fields()), 'missing_values', 'null')), (select j from dx))) x
           where x ->> 'key' = 'country'), 'null'::jsonb, 'country is null without cty.dat');
select is((select jsonb_object_agg(x ->> 'key', x -> 'value') from jsonb_array_elements(webhook_spot_fields(
             pg_temp.ws(jsonb_build_object('fields', to_jsonb(webhook_fields()), 'missing_values', 'null')), (select j from dx))) x
           where x ->> 'key' in ('first_name', 'last_name', 'reference', 'place_name', 'state', 'url', 'comment')),
  '{"first_name": null, "last_name": null, "reference": null, "place_name": null, "state": null, "url": null, "comment": null}'::jsonb,
  'with "null" the missing values are sent as JSON null');
select load_cty('test', '[{"prefix":"JA","name":"Japan","continent":"AS","cq_zone":25,"itu_zone":45,"lat":36.4,"lon":138.38}]',
  '[{"pattern":"JA","exact":false,"entity":"JA","continent":"AS","cq_zone":25,"itu_zone":45}]');
select is(webhook_field_value('country', (select j from dx), 'iso_utc', 'khz'), '"Japan"'::jsonb,
  'country is the cty.dat entity name');
select is(array[webhook_field_value('url', (select j from spot), 'iso_utc', 'khz'),
                webhook_field_value('url', '{"source": "sotawatch", "sota_summit_ref": "W4C/CM-001"}', 'iso_utc', 'khz'),
                webhook_field_value('url', '{"source": "wwff", "wwff_reference": "KFF-5268"}', 'iso_utc', 'khz')],
  array['"https://pota.app/#/park/US-2763"', '"https://summits.sota.org.uk/summit/W4C/CM-001"',
        '"https://wwff.co/directory/?showRef=KFF-5268"']::jsonb[], 'the spot URL for POTA, SOTA and WWFF');
select is(array[webhook_field_value('reference', '{"source": "sotawatch", "sota_summit_ref": "W4C/CM-001"}', 'iso_utc', 'khz'),
                webhook_field_value('place_name', '{"source": "wwff", "wwff_reference_name": "Pisgah"}', 'iso_utc', 'khz'),
                webhook_field_value('state', '{"source": "pota", "pota_location": "US-NC,US-VA"}', 'iso_utc', 'khz'),
                webhook_field_value('mode', '{"mode": "FT8"}', 'iso_utc', 'khz')],
  array['"W4C/CM-001"', '"Pisgah"', '"NC/VA"', '"ft8"']::jsonb[], 'reference, place name and state as push renders them');
create temp table commented as
  select webhook_spot_object(pg_temp.ws('{"fields": ["comment"]}'), (select j from spot)) as o;
select is((select o ->> 'comment' from commented), 'say "hi"' || chr(10) || 'bye', 'a comment survives as a JSON string');
select is((select o::text from commented), '{ "comment" : "say \"hi\"\nbye" }', 'quotes and line breaks are escaped');
select is(pg_temp.json_keys(webhook_spot_object(pg_temp.ws('{"fields": ["comment", "spotter", "id", "time", "band"]}'), (select j from spot))),
  pg_temp.keys(webhook_spot_fields(pg_temp.ws('{"fields": ["comment", "spotter", "id", "time", "band"]}'), (select j from spot))),
  'the object''s keys are the pairs'' keys, in the picked order');
select is(pg_temp.json_keys(webhook_spot_object(pg_temp.ws('{"fields": ["comment", "spotter", "id", "time", "band"]}'), (select j from spot))),
  array['comment', 'spotter', 'id', 'time', 'band'], 'not sorted');
select is(webhook_request_body(pg_temp.ws('{}'), 918273, 'POTA states I still need', (select j from spot))::jsonb,
  jsonb_build_object('delivery_id', 918273, 'connection', 'POTA states I still need',
                     'spot', webhook_spot_object(pg_temp.ws('{}'), (select j from spot))::jsonb),
  'one request per spot: {delivery_id, connection, spot}');
select is(pg_temp.json_keys(webhook_request_body(pg_temp.ws('{}'), 1, 'c', (select j from spot))),
  array['delivery_id', 'connection', 'spot'], 'in that order');
select is(webhook_request_body(pg_temp.ws('{"batch_seconds": 30}'), 1, 'c', (select j from spot))::jsonb,
  jsonb_build_object('spots', jsonb_build_array(webhook_request_body(pg_temp.ws('{}'), 1, 'c', (select j from spot))::jsonb)),
  'grouped: {"spots": [item]}');
select is(webhook_spot_fields(pg_temp.ws('{"fields": ["reference"]}'), (select j from dx)), '[]'::jsonb,
  'no picked values are an empty pair list, never null');
select is(webhook_spot_object(pg_temp.ws('{"fields": ["reference"]}'), (select j from dx))::text, '{}', 'an empty object');
select is(webhook_request_body(pg_temp.ws('{"fields": ["reference"]}'), 1, 'c', (select j from dx))::jsonb -> 'spot', '{}'::jsonb,
  'and "spot": {} in the body');

-- ---------------------------------------------------------------------------
-- Save, get and list
-- ---------------------------------------------------------------------------
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table made as
  select * from save_webhook_destination(null, '  Shack  ', null, 'https://shack.example.com/hook/tok?x=1',
                                         '{"batch_seconds": 30, "key_style": "camel"}',
                                         '[{"name": "Authorization", "value": "Bearer abc"}]');
grant all on made to authenticated;
select matches((select signing_secret from made), '^whsec_[0-9a-f]{48}$', 'a new webhook returns its secret once');
select results_eq(format($$ select x ->> 'name', (x ->> 'enabled')::boolean, x ->> 'url_display', x #>> '{settings,key_style}',
                                   (x #>> '{settings,batch_seconds}')::int, x #>> '{settings,retry_policy}', x -> 'headers'
                            from (select get_webhook_destination(%L) as x) t $$, (select id from made)),
  $$ values ('Shack'::text, true, 'https://shack.example.com/hook/••••••'::text, 'camel'::text, 30, 'three_10m'::text,
             '[{"name": "Authorization"}]'::jsonb) $$,
  'save trims the name, starts enabled, masks the URL and merges settings over the defaults');
select is((select array_agg(k order by k) from jsonb_object_keys(get_webhook_destination((select id from made))) k),
  array['auto_disabled_at', 'enabled', 'headers', 'id', 'name', 'secret_rotated_at', 'settings', 'url_display'],
  'get returns no URL, secret or header value');
select ok(get_webhook_destination((select id from made))::text !~ 'Bearer abc|whsec_|tok\?', 'nothing secret in the text');
select throws_ok($$ select * from save_webhook_destination(null, 'Bad', true, '  ', null, null) $$,
  'P0001', 'Use an https URL.', 'a new one needs a URL');
select throws_ok($$ select * from save_webhook_destination(null, 'Bad', true, 'http://example.com/h', null, null) $$,
  'P0001', 'Use an https URL.', 'the URL is checked');
select throws_ok($$ select * from save_webhook_destination(null, 'shack', true, 'https://example.com/h', null, null) $$,
  'P0001', 'A destination named shack already exists. Choose a different name.', 'names are unique, ignoring case');
select throws_ok($$ select * from save_webhook_destination(null, ' ', true, 'https://example.com/h', null, null) $$,
  'P0001', 'Give the destination a name.', 'a new one needs a name');
select throws_ok($$ select * from save_webhook_destination(null, 'Bad', true, 'https://example.com/h', '{"x": 1}', null) $$,
  'P0001', 'Unknown setting x.', 'unknown settings refuse the save');
select throws_ok($$ select * from save_webhook_destination(null, 'Bad', true, 'https://example.com/h', '{"retry_policy": "x"}', null) $$,
  'P0001', 'Pick a retry policy.', 'bad settings refuse the create');
select throws_ok($$ select * from save_webhook_destination(null, 'Bad', true, 'https://example.com/h', null, '[{"name": "Host", "value": "x"}]') $$,
  'P0001', 'Host is set by Long Lines.', 'bad headers refuse the create');
select is((select count(*) from destinations where name = 'Bad'), 0::bigint, 'and nothing was created');

-- Update: the URL is kept unless replaced; a secret is never returned again.
reset role;
update destinations set health = 'failing', consecutive_failures = 7 where id = (select id from made);
create temp view made_row as select * from destinations where id = (select id from made);
grant select on made_row to authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is((select signing_secret from save_webhook_destination((select id from made), 'Shack 2', null, null, '{"fields": ["id"]}', null)),
  null, 'an update returns no secret');
select results_eq($$ select name, url, health, consecutive_failures from made_row $$,
  $$ values ('Shack 2'::text, 'https://shack.example.com/hook/tok?x=1'::text, 'failing'::text, 7) $$,
  'a null URL keeps the stored one and the health');
select is((get_webhook_destination((select id from made)) -> 'settings') - 'fields',
  ((select j from defaults) || '{"batch_seconds": 30, "key_style": "camel"}') - 'fields',
  'settings merge key by key over what is stored');
select save_webhook_destination((select id from made), null, null, '  ', null, null);
select is((select url from made_row), 'https://shack.example.com/hook/tok?x=1', 'a blank URL keeps the stored one');
select save_webhook_destination((select id from made), null, null, 'https://new.example.com/in/secret2', null, null);
select results_eq($$ select url, url_display, health, consecutive_failures from made_row $$,
  $$ values ('https://new.example.com/in/secret2'::text, 'https://new.example.com/in/••••••'::text, 'ok'::text, 0) $$,
  'a new URL is stored, masked, and clears failing health');
select save_webhook_destination((select id from made), null, false, null, null, null);
select is((select enabled from made_row), false, 'enabled is saved');
select throws_ok(format('select * from save_webhook_destination(%L, null, null, null, null, null)', (select chat from others)),
  'P0001', 'Destination not found.', 'a Discord destination is not saved here');
select throws_ok(format('select get_webhook_destination(%L)', (select chat from others)),
  'P0001', 'Destination not found.', 'or read');
select is((select jsonb_object_agg(case when x ->> 'destination_id' = (select id::text from made) then 'made' else 'logger' end,
                                   x - 'destination_id')
           from jsonb_array_elements(list_webhook_destination_settings()) x
           where x ->> 'destination_id' in ((select id::text from made), (select id::text from logger))),
  '{"made": {"field_count": 1, "batch_seconds": 30}, "logger": {"field_count": 11, "batch_seconds": 0}}'::jsonb,
  'list counts the fields and shows the window');
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select is(list_webhook_destination_settings(), '[]'::jsonb, 'another account lists none of them');
select throws_ok(format('select * from save_webhook_destination(%L, %L, null, null, null, null)', (select id from made), 'Mine'),
  'P0001', 'Destination not found.', 'another account''s webhook cannot be saved');
select throws_ok(format('select get_webhook_destination(%L)', (select id from made)),
  'P0001', 'Destination not found.', 'or read');
reset role;

-- ---------------------------------------------------------------------------
-- Extra headers in Vault
-- ---------------------------------------------------------------------------
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select save_webhook_destination((select id from logger), null, null, null, null,
  '[{"name": "Authorization", "value": "Bearer one"}, {"name": "X-Api-Key", "value": "k1"}]');
reset role;
create temp table h1 as select id, name, position, secret_id from webhook_destination_headers where destination_id = (select id from logger);
select results_eq($$ select * from pg_temp.header_values((select id from logger)) $$,
  $$ values ('Authorization'::text, 'Bearer one'::text), ('X-Api-Key', 'k1') $$, 'two headers, their values in Vault, in order');
select is(webhook_header_names((select id from logger)), '[{"name": "Authorization"}, {"name": "X-Api-Key"}]'::jsonb,
  'header names only, in order');
select is((select count(*) from vault.secrets where id in (select secret_id from h1) and secret <> 'Bearer one' and secret <> 'k1'),
  2::bigint, 'Vault stores the values encrypted');
-- Same names without values, reordered and recased: ids and secrets are kept.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select save_webhook_destination((select id from logger), null, null, null, null,
  '[{"name": "x-api-key"}, {"name": "Authorization", "value": ""}]');
reset role;
select results_eq($$ select h.id, h.name, h.position, h.secret_id from webhook_destination_headers h
                     where h.destination_id = (select id from logger) order by h.position $$,
  $$ select id, case when name = 'X-Api-Key' then 'x-api-key' else name end, (3 - position)::smallint, secret_id
     from h1 order by 3 - position $$,
  'without values the headers keep their ids and secrets, take the new order and the name as typed');
-- A new value replaces the secret; the old one leaves Vault.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select save_webhook_destination((select id from logger), null, null, null, null,
  '[{"name": "x-api-key", "value": "k2"}, {"name": "Authorization"}]');
reset role;
select results_eq($$ select * from pg_temp.header_values((select id from logger)) $$,
  $$ values ('x-api-key'::text, 'k2'::text), ('Authorization', 'Bearer one') $$, 'a new value is stored');
select is((select count(*) from vault.secrets where id = (select secret_id from h1 where name = 'X-Api-Key')), 0::bigint,
  'the replaced secret is deleted from Vault');
select is((select secret_id from webhook_destination_headers where name = 'Authorization' and destination_id = (select id from logger)),
  (select secret_id from h1 where name = 'Authorization'), 'the other keeps its secret');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select throws_ok(format($$ select save_webhook_destination(%L, null, null, null, null, '[{"name": "X-Key"}]') $$, (select id from logger)),
  'P0001', 'Give the X-Key header a value.', 'a renamed header needs a value');
select throws_ok(format($$ select save_webhook_destination(%L, null, null, null, null, %L) $$, (select id from logger),
                        (select jsonb_agg(jsonb_build_object('name', 'X-H' || i, 'value', 'v')) from generate_series(1, 11) i)),
  'P0001', 'Up to 10 headers.', 'at most ten');
select lives_ok(format($$ select save_webhook_destination(%L, null, null, null, null, %L) $$, (select id from logger),
                        (select jsonb_agg(jsonb_build_object('name', 'X-H' || i, 'value', 'v')) from generate_series(1, 10) i)),
  'ten are fine');
select throws_ok(format($$ select save_webhook_destination(%L, null, null, null, null, '[{"name": "Content-Type", "value": "x"}]') $$,
                        (select id from logger)), 'P0001', 'Content-Type is set by Long Lines.', 'Content-Type is reserved');
select throws_ok(format($$ select save_webhook_destination(%L, null, null, null, null, '[{"name": "x-longlines-anything", "value": "x"}]') $$,
                        (select id from logger)), 'P0001', 'x-longlines-anything is set by Long Lines.', 'X-LongLines-* is reserved');
select throws_ok(format($$ select save_webhook_destination(%L, null, null, null, null, '[{"name": "Proxy-Foo", "value": "x"}]') $$,
                        (select id from logger)), 'P0001', 'Proxy-Foo is set by Long Lines.', 'Proxy-* is reserved');
reset role;
select ok(not webhook_header_name_valid('HOST') and not webhook_header_name_valid('transfer-encoding')
          and not webhook_header_name_valid('User-Agent') and not webhook_header_name_valid('TE')
          and webhook_header_name_valid('Authorization') and webhook_header_name_valid('X-Api.Key_2')
          and not webhook_header_name_valid('-leading') and not webhook_header_name_valid(repeat('a', 65))
          and not webhook_header_name_valid(null),
  'the reserved list ignores case; names are tokens of at most 64');
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select throws_ok(format($$ select save_webhook_destination(%L, null, null, null, null,
                            '[{"name": "Authorization", "value": "a"}, {"name": "AUTHORIZATION", "value": "b"}]') $$,
                        (select id from logger)), 'P0001', 'Add each header once.', 'each name once, ignoring case');
select throws_ok(format($$ select save_webhook_destination(%L, null, null, null, null, %L) $$, (select id from logger),
                        jsonb_build_array(jsonb_build_object('name', 'X-A', 'value', 'a' || chr(13) || chr(10) || 'Evil: 1'))),
  'P0001', 'Header values can only use printable ASCII characters.', 'no line breaks in a value');
select throws_ok(format($$ select save_webhook_destination(%L, null, null, null, null, '[{"name": "X-A", "value": "café"}]') $$,
                        (select id from logger)), 'P0001', 'Header values can only use printable ASCII characters.', 'ASCII only');
select throws_ok(format($$ select save_webhook_destination(%L, null, null, null, null, %L) $$, (select id from logger),
                        jsonb_build_array(jsonb_build_object('name', 'X-A', 'value', repeat('v', 1025)))),
  'P0001', 'Header values can be up to 1,024 characters.', 'values up to 1,024 characters');
select throws_ok(format($$ select save_webhook_destination(%L, null, null, null, null, '[{"name": " ", "value": "x"}]') $$,
                        (select id from logger)), 'P0001', 'Give each header a name.', 'a header needs a name');
select throws_ok(format($$ select save_webhook_destination(%L, null, null, null, null, '[{"name": "Bad Name", "value": "x"}]') $$,
                        (select id from logger)), 'P0001', 'Header names use letters, digits, - _ and . only.', 'names are tokens');
select throws_ok(format($$ select save_webhook_destination(%L, null, null, null, null, '{"name": "X-A"}') $$,
                        (select id from logger)), 'P0001', 'Headers must be a list.', 'headers are a list');
reset role;
select is((select count(*) from webhook_destination_headers where destination_id = (select id from logger)), 10::bigint,
  'a refused save writes nothing');
create temp table h10 as select secret_id from webhook_destination_headers where destination_id = (select id from logger);
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select save_webhook_destination((select id from logger), null, null, null, null, '[]');
reset role;
select is((select count(*) from webhook_destination_headers where destination_id = (select id from logger)), 0::bigint,
  '[] removes every header');
select is((select count(*) from vault.secrets where id in (select secret_id from h10)), 0::bigint, 'and their Vault rows');
select ok((select c.relrowsecurity from pg_class c where c.oid = 'public.webhook_destination_headers'::regclass)
          and not has_table_privilege('authenticated', 'public.webhook_destination_headers', 'select')
          and not has_table_privilege('authenticated', 'public.webhook_destination_headers', 'insert')
          and not has_table_privilege('authenticated', 'public.webhook_destination_headers', 'delete')
          and not has_table_privilege('delivery_sender', 'public.webhook_destination_headers', 'select'),
  'headers: RLS on, no client or sender privileges');
select ok(not has_function_privilege('authenticated', 'public.webhook_header_values(uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public.set_webhook_headers(uuid, jsonb)', 'execute')
          and not has_function_privilege('authenticated', 'public.webhook_header_names(uuid)', 'execute')
          and not has_function_privilege('anon', 'public.webhook_header_values(uuid)', 'execute'),
  'clients cannot call the header helpers');

-- Deleting the destination as its owner removes the Vault rows.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table gone as
  select id from save_webhook_destination(null, 'Gone', true, 'https://gone.example.com/h', null,
                                          '[{"name": "X-A", "value": "a"}, {"name": "X-B", "value": "b"}]');
grant all on gone to authenticated;
reset role;
create temp table gone_secrets as select secret_id from webhook_destination_headers where destination_id = (select id from gone);
select is((select count(*) from vault.secrets where id in (select secret_id from gone_secrets)), 2::bigint, 'two Vault rows');
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
delete from destinations where id = (select id from gone);
reset role;
select is((select count(*) from vault.secrets where id in (select secret_id from gone_secrets)), 0::bigint,
  'deleting the destination as its owner deletes them');
select is((select count(*) from webhook_destination_settings where destination_id = (select id from gone)), 0::bigint,
  'and its settings');

-- ---------------------------------------------------------------------------
-- Preview
-- ---------------------------------------------------------------------------
select count(*) from ingest_spots(jsonb_build_array(
  jsonb_build_object('source','pota','source_spot_id','s1','content_hash','h1','spot_time',now(),'callsign','KK4PWJ',
    'spotter','W4ABC','frequency_khz',14062,'band','20m','mode','cw','comment','','pota_reference','US-2763',
    'pota_park_name','Falls Lake SRA','pota_location','US-NC','raw_payload','{}'::jsonb)));
create temp table s1 as select id from raw_spots where source_spot_id = 's1';
grant select on s1 to authenticated;
create temp table s1_body as
  select webhook_request_body(pg_temp.ws('{}'), 0, 'Parks I need', delivery_spot_json(r))::jsonb as j
  from raw_spots r where r.id = (select id from s1);
grant select on s1_body to authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table claimed_hook as
  select id from save_webhook_destination(null, 'Claimed', true, 'https://claim.example.com/h/tok', null,
                                          '[{"name": "Authorization", "value": "Bearer c"}, {"name": "X-Team", "value": "ops"}]');
grant all on claimed_hook to authenticated;
create temp table chat as select id from create_destination('discord', 'Claim chat', 'https://discord.com/api/webhooks/7/g');
grant all on chat to authenticated;
select save_subscription(jsonb_build_object('name', 'Parks I need', 'quiet_minutes', 0,
  'destinations', array[(select id from claimed_hook), (select id from chat)]));
select is(preview_webhook_request(null, (select id from s1), (select id from claimed_hook))::jsonb,
  (select j from s1_body),
  'the preview is webhook_request_body for the spot, with the connection that uses the destination');
select is(preview_webhook_request('{"batch_seconds": 10}', null, (select id from logger)) #>> '{spots,0,connection}',
  'Example connection', 'without a connection: "Example connection", the sample spot and the shape of the settings');
select is(preview_webhook_request(null) #>> '{spot,callsign}', 'N0CALL', 'without a spot it uses the sample');
select is(preview_webhook_request(null) ->> 'delivery_id', '0', 'delivery_id 0');
select is(pg_temp.json_keys(preview_webhook_request('{"fields": ["spotter", "callsign"]}') -> 'spot'), array['spotter', 'callsign'],
  'the preview''s text keeps the picked order');
select throws_ok($$ select preview_webhook_request(null, -1) $$, 'P0001', 'Spot not found.', 'an unknown spot');
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select is(preview_webhook_request(null, null, (select id from claimed_hook)) ->> 'connection', 'Example connection',
  'another account''s destination names no connection');
reset role;

-- ---------------------------------------------------------------------------
-- What claim_deliveries hands out
-- ---------------------------------------------------------------------------
select match_pending_spots();
update destinations set claim_tokens = 0, claim_tokens_at = now() - interval '1 minute', claim_due_at = '-infinity';
create temp table claimed as select * from claim_deliveries(200, 60);
select is((select count(*) from claimed), 2::bigint, 'the webhook and the Discord row are claimed');
select is((select destination -> 'webhook' from claimed where destination ->> 'type' = 'webhook'),
  '{"batch_seconds": 0, "headers": [{"name": "Authorization", "value": "Bearer c"}, {"name": "X-Team", "value": "ops"}]}'::jsonb,
  'a webhook carries its window and its header values, in order');
select is((select spot -> 'webhook_fields' from claimed where destination ->> 'type' = 'webhook'),
  (select webhook_spot_fields(pg_temp.ws('{}'), delivery_spot_json(r)) from raw_spots r where r.id = (select id from s1)),
  'its spot carries the pairs');
select is((select spot ->> 'webhook_connection' from claimed where destination ->> 'type' = 'webhook'), 'Parks I need',
  'and the connection''s name');
select is((select array_agg(k order by k) from claimed c, jsonb_object_keys(c.spot) k where c.destination ->> 'type' = 'webhook'),
  array['band', 'base_callsign', 'callsign', 'comment', 'frequency_khz', 'id', 'iota_reference', 'iota_reference_name',
        'mode', 'mode_family', 'pota_location', 'pota_park_name', 'pota_reference', 'sota_summit_ref', 'source', 'spot_time',
        'spotter', 'webhook_connection',
        'webhook_fields', 'wwbota_reference_name', 'wwbota_references', 'wwff_reference', 'wwff_reference_name'],
  'a webhook spot keeps the stored keys (the legacy body) plus the two webhook ones');
select ok((select not (destination ? 'webhook') and not (spot ? 'webhook_fields') and not (spot ? 'webhook_connection')
                  and destination ? 'discord' and spot ? 'discord_title'
           from claimed where destination ->> 'type' = 'discord'), 'a Discord row is unchanged');
select ok((select not (destination ? 'discord') and not (destination ? 'push') and not (spot ? 'discord_title')
           from claimed where destination ->> 'type' = 'webhook'), 'and a webhook row carries no Discord or push keys');
select is((select array_agg(k order by k) from claimed c, jsonb_object_keys(to_jsonb(c)) k where c.destination ->> 'type' = 'webhook'),
  array['attempts', 'created_at', 'delivery_id', 'destination', 'msg_id', 'spot', 'subscription_id'],
  'the result columns are unchanged');
select mark_deliveries_sent(array(select delivery_id from claimed), array(select msg_id from claimed));

-- A webhook that somehow lost its settings row is handed the defaults.
delete from webhook_destination_settings where destination_id = (select id from claimed_hook);
select count(*) from ingest_spots(jsonb_build_array(
  jsonb_build_object('source','pota','source_spot_id','s2','content_hash','h2','spot_time',now(),'callsign','KK4PWJ',
    'frequency_khz',14062,'band','20m','mode','cw','comment','','pota_reference','US-2763','raw_payload','{}'::jsonb)));
select match_pending_spots();
update destinations set claim_tokens = 0, claim_tokens_at = now() - interval '1 minute', claim_due_at = '-infinity';
create temp table claimed2 as select * from claim_deliveries(200, 60);
select results_eq($$ select (destination #>> '{webhook,batch_seconds}')::int, pg_temp.keys(spot -> 'webhook_fields')
                     from claimed2 where destination ->> 'type' = 'webhook' $$,
  $$ values (0, array['id', 'time', 'callsign', 'frequency_khz', 'mode', 'band', 'source', 'reference']) $$,
  'without a settings row the claim uses the defaults');
select mark_deliveries_sent(array(select delivery_id from claimed2), array(select msg_id from claimed2));
insert into webhook_destination_settings
select (jsonb_populate_record(null::webhook_destination_settings,
          webhook_default_settings() || jsonb_build_object('destination_id', (select id from claimed_hook)))).*;

-- ---------------------------------------------------------------------------
-- Send test (service role)
-- ---------------------------------------------------------------------------
update webhook_destination_settings set batch_seconds = 60, fields = '{callsign,spotter}' where destination_id = (select id from claimed_hook);
select is(webhook_test_delivery((select id from claimed_hook), (select id from s1)),
  (select jsonb_build_object(
     'webhook', '{"batch_seconds": 60, "headers": [{"name": "Authorization", "value": "Bearer c"}, {"name": "X-Team", "value": "ops"}]}'::jsonb,
     'spot', delivery_spot_json(r) || '{"webhook_fields": [{"key": "callsign", "value": "KK4PWJ"}, {"key": "spotter", "value": "W4ABC"}],
                                        "webhook_connection": "Test"}'::jsonb)
   from raw_spots r where r.id = (select id from s1)),
  'Send test hands the window, the header values and the chosen spot rendered as the claim would, from "Test"');
select is(webhook_test_delivery((select id from claimed_hook)) #>> '{spot,callsign}', 'N0CALL', 'without a spot it uses the sample');
select is(webhook_test_delivery((select id from claimed_hook), -1), null, 'an unknown spot returns null');
select is(webhook_test_delivery(gen_random_uuid()), null, 'an unknown destination returns null');
select is(webhook_test_delivery((select id from chat)), null, 'a Discord destination returns null');
select ok(not has_function_privilege('authenticated', 'public.webhook_test_delivery(uuid, bigint)', 'execute')
          and not has_function_privilege('delivery_sender', 'public.webhook_test_delivery(uuid, bigint)', 'execute')
          and has_function_privilege('service_role', 'public.webhook_test_delivery(uuid, bigint)', 'execute'),
  'Send test is the service role''s, not a client''s or the sender''s');
select ok(has_function_privilege('authenticated', 'public.save_webhook_destination(uuid, text, boolean, text, jsonb, jsonb)', 'execute')
          and has_function_privilege('authenticated', 'public.get_webhook_destination(uuid)', 'execute')
          and has_function_privilege('authenticated', 'public.list_webhook_destination_settings()', 'execute')
          and has_function_privilege('authenticated', 'public.preview_webhook_request(jsonb, bigint, uuid)', 'execute')
          and not has_function_privilege('anon', 'public.save_webhook_destination(uuid, text, boolean, text, jsonb, jsonb)', 'execute')
          and not has_function_privilege('authenticated', 'public.webhook_spot_fields(webhook_destination_settings, jsonb)', 'execute'),
  'signed-in clients get the four editor RPCs, anon none, and the renderer is not callable');

-- ---------------------------------------------------------------------------
-- Pause after repeated failures (decision 4)
-- ---------------------------------------------------------------------------
create temp table pz as select id from claimed_hook;
grant select on pz to authenticated;
create temp view pz_row as select * from destinations where id = (select id from pz);
grant select on pz_row to authenticated;
update webhook_destination_settings set pause_after_failures = 3, retry_policy = 'day' where destination_id = (select id from pz);
-- Its last success was long before these failures.
update destinations set last_success_at = now() - interval '1 hour' where id = (select id from pz);
create temp table pz_q (delivery_id bigint, msg_id bigint);
create function pg_temp.queue_pz(p_n int) returns void language plpgsql as $$
begin
  perform ingest_spots((select jsonb_agg(jsonb_build_object(
    'source', 'pota', 'source_spot_id', 'pz' || gen_random_uuid(), 'content_hash', 'h', 'spot_time', now(), 'callsign', 'KK4PWJ',
    'frequency_khz', 14062, 'band', '20m', 'mode', 'cw', 'comment', '', 'pota_reference', 'US-2763', 'raw_payload', '{}'::jsonb))
    from generate_series(1, p_n)));
  perform match_pending_spots();
  delete from pz_q;
  insert into pz_q
  select d.id, q.msg_id from deliveries d join pgmq.q_deliveries_queue q on (q.message ->> 'delivery_id')::bigint = d.id
  where d.destination_id = (select id from pz) and d.status = 'pending';
end $$;
create function pg_temp.fail_pz() returns void language sql as $$
  select mark_deliveries_failed(array(select delivery_id from pz_q order by delivery_id limit 1),
                                array(select msg_id from pz_q order by delivery_id limit 1), 'HTTP 500', 30);
$$;
select pg_temp.queue_pz(3);
select pg_temp.fail_pz();
select pg_temp.fail_pz();
select pg_temp.fail_pz();
select results_eq($$ select consecutive_failures, pause_failures, pause_failure_at, enabled, health from pz_row $$,
  $$ values (3, 1, now(), true, 'ok'::text) $$,
  'three failures inside 30 seconds count once toward the pause, three times toward health');
update destinations set pause_failure_at = pause_failure_at - interval '31 seconds' where id = (select id from pz);
select pg_temp.fail_pz();
select results_eq($$ select pause_failures, enabled, auto_disabled_at from pz_row $$,
  $$ values (2, true, null::timestamptz) $$, '31 seconds on, the next failure counts');
-- A success since the last counted failure restarts the count.
update destinations set pause_failure_at = pause_failure_at - interval '120 seconds',
                        last_success_at = pause_failure_at - interval '60 seconds' where id = (select id from pz);
select pg_temp.fail_pz();
select is((select pause_failures from pz_row), 1, 'a delivery that succeeded since the last counted failure restarts the count');
update destinations set pause_failure_at = pause_failure_at - interval '31 seconds' where id = (select id from pz);
select pg_temp.fail_pz();
update destinations set pause_failure_at = pause_failure_at - interval '31 seconds' where id = (select id from pz);
select is((select enabled from pz_row), true, 'two counted failures of three do not pause');
-- Another of its rows is waiting out a retry delay when the pause comes.
update pgmq.q_deliveries_queue set vt = clock_timestamp() + interval '6 minutes'
where msg_id = (select msg_id from pz_q order by delivery_id offset 1 limit 1);
select pg_temp.fail_pz();
select results_eq($$ select pause_failures, enabled, auto_disabled_at, health, consecutive_failures from pz_row $$,
  $$ values (3, false, now(), 'failing'::text, 7) $$,
  'the third counted failure turns the destination off with auto_disabled_at; health follows consecutive_failures, never paused');
-- Turned off, it counts no more.
update destinations set pause_failure_at = pause_failure_at - interval '31 seconds' where id = (select id from pz);
select pg_temp.fail_pz();
select is((select pause_failures from pz_row), 3, 'a disabled destination counts no more');
select is((select count(*) from pgmq.q_deliveries_queue
           where msg_id in (select msg_id from pz_q) and vt <= clock_timestamp()), 3::bigint,
  'the pause makes its whole queue visible, the row that just failed and one in backoff included');
-- The next claim drops its queue as lost, with dropped_at.
select count(*) from claim_deliveries(200, 60);
select results_eq($$ select status, dropped_at is not null, count(*) from deliveries
                     where id in (select delivery_id from pz_q) group by 1, 2 $$,
  $$ values ('dropped'::text, true, 3::bigint) $$, 'a paused webhook''s queued rows are dropped with dropped_at');
-- A destination turned off by hand still drops them without it.
select count(*) from ingest_spots(jsonb_build_array(
  jsonb_build_object('source','pota','source_spot_id','s3','content_hash','h3','spot_time',now(),'callsign','KK4PWJ',
    'frequency_khz',14062,'band','20m','mode','cw','comment','','pota_reference','US-2763','raw_payload','{}'::jsonb)));
select match_pending_spots();
update destinations set enabled = false where id = (select id from chat);
select count(*) from claim_deliveries(200, 60);
select results_eq($$ select status, dropped_at from deliveries d join raw_spots r on r.id = d.spot_id
                     where d.destination_id = (select id from chat) and r.source_spot_id = 's3' $$,
  $$ values ('dropped'::text, null::timestamptz) $$, 'a destination turned off by hand drops its rows without dropped_at');

-- Resume: Enabled on clears the pause; health waits for the next success.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is((select auto_disabled_at from destinations where id = (select id from pz)), now(), 'the client sees when it paused');
select is(get_webhook_destination((select id from pz)) ->> 'auto_disabled_at', to_jsonb(now()) #>> '{}',
  'and the editor too');
select save_webhook_destination((select id from pz), null, null, null, null, null);
select is((select enabled from pz_row), false, 'a save without enabled keeps it paused');
-- update_destination is the API's PATCH path (api_call runs it as the owner); the claims stay the owner's.
reset role;
select update_destination((select id from pz), null, null, true);
select results_eq($$ select enabled, auto_disabled_at, pause_failures, pause_failure_at, consecutive_failures, health from pz_row $$,
  $$ values (true, null::timestamptz, 0, null::timestamptz, 0, 'failing'::text) $$,
  'Enabled on clears auto_disabled_at and both counts and leaves health');
select results_eq($$ select (select count(*) from pgmq.q_deliveries_queue where msg_id in (select msg_id from pz_q)),
                            (select count(*) from deliveries where id in (select delivery_id from pz_q) and status <> 'dropped') $$,
  $$ values (0::bigint, 0::bigint) $$, 'resuming brings none of the dropped spots back: none is queued or claimable');
-- pause null never counts.
update webhook_destination_settings set pause_after_failures = null where destination_id = (select id from pz);
select pg_temp.queue_pz(1);
select pg_temp.fail_pz();
select results_eq($$ select pause_failures, pause_failure_at, enabled from pz_row $$,
  $$ values (0, null::timestamptz, true) $$, 'with the pause off nothing is counted');
-- Save with enabled true resumes as well.
update destinations set enabled = false, auto_disabled_at = now(), pause_failures = 20 where id = (select id from pz);
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select save_webhook_destination((select id from pz), null, true, null, null, null);
select results_eq($$ select enabled, auto_disabled_at, pause_failures from pz_row $$,
  $$ values (true, null::timestamptz, 0) $$, 'saving with Enabled on resumes it');
reset role;

-- ---------------------------------------------------------------------------
-- Duplicate, the management API and the account
-- ---------------------------------------------------------------------------
update webhook_destination_settings set fields = '{time,callsign}', key_style = 'camel', retry_policy = 'none'
  where destination_id = (select id from claimed_hook);
update destinations set secret_rotated_at = now() - interval '3 days' where id = (select id from claimed_hook);
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table copy1 as select duplicate_destination((select id from claimed_hook)) as id;
grant all on copy1 to authenticated;
reset role;
select results_eq(format($$ select c.name, c.enabled, c.url, c.url_display, c.signing_secret, c.secret_rotated_at
                            from destinations c where c.id = %L $$, (select id from copy1)),
  format($$ select 'Copy of Claimed'::text, false, s.url, s.url_display, s.signing_secret, s.secret_rotated_at
            from destinations s where s.id = %L $$, (select id from claimed_hook)),
  'a webhook copy has the URL, secret and rotation time, named "Copy of", and starts disabled');
select is((select to_jsonb(s) - 'destination_id' from webhook_destination_settings s where s.destination_id = (select id from copy1)),
  (select to_jsonb(s) - 'destination_id' from webhook_destination_settings s where s.destination_id = (select id from claimed_hook)),
  'and the settings');
select results_eq($$ select * from pg_temp.header_values((select id from copy1)) $$,
  $$ select * from pg_temp.header_values((select id from claimed_hook)) $$, 'and the headers with their values');
select is((select count(*) from webhook_destination_headers c join webhook_destination_headers s on s.secret_id = c.secret_id and s.destination_id <> c.destination_id
           where c.destination_id = (select id from copy1)), 0::bigint, 'each value re-created in Vault: the copy owns its secrets');

select is((select api_destination_json(d) -> 'webhook' from destinations d where d.id = (select id from claimed_hook)),
  (select to_jsonb(s) - 'destination_id' from webhook_destination_settings s where s.destination_id = (select id from claimed_hook))
  || jsonb_build_object('headers', '[{"name": "Authorization"}, {"name": "X-Team"}]'::jsonb,
                        'secret_rotated_at', now() - interval '3 days', 'auto_disabled_at', null),
  'the API shows a webhook''s settings, header names and times');
select ok((select api_destination_json(d)::text !~ 'Bearer c|ops|whsec_' and not (api_destination_json(d) ?| array['url', 'signing_secret'])
           from destinations d where d.id = (select id from claimed_hook)), 'and never a value, the URL or the secret');
select ok((select bool_and(not (api_destination_json(d) ? 'webhook')) from destinations d where d.type <> 'webhook'),
  'other types carry no webhook');

create temp table account_secrets as
  select h.secret_id from webhook_destination_headers h join destinations d on d.id = h.destination_id
  where d.user_id = '11111111-1111-1111-1111-111111111111';
select ok((select count(*) from account_secrets) >= 4, 'the account holds header secrets');
delete from deliveries;
delete from subscriptions where user_id = '11111111-1111-1111-1111-111111111111';
delete from auth.users where id = '11111111-1111-1111-1111-111111111111';
select is((select count(*) from vault.secrets where id in (select secret_id from account_secrets)), 0::bigint,
  'deleting the account deletes its header secrets from Vault');

select * from finish();
rollback;

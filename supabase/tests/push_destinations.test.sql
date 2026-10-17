-- pgTAP: push destinations as canvas page 5 draws them, on the sender
-- (20261016000400_push_destinations_v2). Many per account, unique names,
-- enabled, picked devices, settings, notification text built in SQL from
-- picked fields, quiet hours, the per-destination TTL, and what
-- claim_deliveries, the preview and Send test hand out.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(123);
select pgmq.purge_queue('spot_events');
select pgmq.purge_queue('deliveries_queue');
delete from deliveries;
delete from raw_spots;

-- The defaults as a stored row shows them (times as hh:mm:ss); clients cannot call the helper.
create temp table defaults as select push_default_settings() || '{"quiet_from": "22:00:00", "quiet_until": "07:00:00"}'::jsonb as j;
grant select on defaults to authenticated;

-- Two devices for A, one for B. Keys are valid shapes; nothing is sent.
\set p256dh '''BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'''
\set auth '''BTBZMqHH6r4Tts7J_aSIgg'''
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table a_phone as select register_push_device('https://fcm.googleapis.com/fcm/send/a-phone', :p256dh, :auth, 'Phone', 'Chrome on Android', true) as id;
create temp table a_desk as select register_push_device('https://updates.push.services.mozilla.com/wpush/v2/a-desk', :p256dh, :auth, 'Desk', 'Firefox on Linux', false) as id;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
create temp table b_phone as select register_push_device('https://web.push.apple.com/b-phone', :p256dh, :auth, 'iPhone', 'Safari on iPhone', true) as id;
grant all on a_phone, a_desk, b_phone to authenticated;

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '';
select throws_ok($$ select save_push_destination(null, 'x', true, null, null) $$, 'P0001', 'Not signed in.', 'save needs a session');
select throws_ok(format('select get_push_destination(%L)', gen_random_uuid()), 'P0001', 'Not signed in.', 'get needs a session');
select throws_ok(format('select duplicate_destination(%L)', gen_random_uuid()), 'P0001', 'Not signed in.', 'duplicate needs a session');
select throws_ok($$ select * from preview_push_notification(null, null, null, null) $$, 'P0001', 'Not signed in.', 'preview needs a session');

-- ---------------------------------------------------------------------------
-- Many per account, defaults, names
-- ---------------------------------------------------------------------------
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table pota as select save_push_destination(null, '  POTA on my phone  ', null, null, array[(select id from a_phone)]) as id;
create temp table desk as select save_push_destination(null, 'Desktop alerts', true,
  '{"title_fields": ["callsign", "band"], "urgency": "high", "ttl_seconds": 300, "sound": false}'::jsonb,
  array[(select id from a_phone), (select id from a_desk)]) as id;
grant all on pota, desk to authenticated;
select is((select count(*) from destinations where type = 'push'), 2::bigint, 'an account has two push destinations');
select results_eq(format($$ select name, enabled, url_display from destinations where id = %L $$, (select id from pota)),
  $$ values ('POTA on my phone'::text, true, 'Your devices'::text) $$, 'save trims the name, starts enabled and shows "Your devices"');
select is((get_push_destination((select id from pota)) -> 'settings'),
  (select j from defaults),
  'a new push destination gets the default settings');
select results_eq(format($$ select s -> 'title_fields', s -> 'body_fields', s ->> 'urgency', (s ->> 'ttl_seconds')::int, (s ->> 'sound')::boolean
                            from (select get_push_destination(%L) -> 'settings' as s) x $$, (select id from desk)),
  $$ values ('["callsign", "band"]'::jsonb, '["source", "reference", "place_name", "state"]'::jsonb, 'high'::text, 300, false) $$,
  'given settings are merged over the defaults');
select is((get_push_destination((select id from desk)) -> 'device_ids'),
  (select jsonb_agg(x order by x) from (select id as x from a_phone union all select id from a_desk) t),
  'get returns the member device ids');
select is((select array_agg(k order by k) from jsonb_object_keys(get_push_destination((select id from pota))) k),
  array['device_ids', 'enabled', 'id', 'name', 'settings'], 'get returns no endpoint or key');
select ok(has_column_privilege('authenticated', 'public.destinations', 'enabled', 'select'), 'clients may read enabled');

select throws_ok($$ select save_push_destination(null, 'pota ON my phone', true, null, null) $$,
  'P0001', 'A destination named pota ON my phone already exists. Choose a different name.', 'names are unique per account, ignoring case');
select throws_ok($$ select * from create_destination('webhook', 'Desktop Alerts', 'https://example.com/h') $$,
  'P0001', 'A destination named Desktop Alerts already exists. Choose a different name.', 'across every destination type');
select throws_ok(format('select save_push_destination(%L, %L, null, null, null)', (select id from desk), 'POTA on my phone'),
  'P0001', 'A destination named POTA on my phone already exists. Choose a different name.', 'renaming onto a taken name fails');
select throws_ok($$ select save_push_destination(null, '   ', true, null, null) $$, 'P0001', 'Give the destination a name.', 'a new one needs a name');
select lives_ok($$ select create_destination('push', 'Second push', null) $$, 'create_destination makes a second push destination too');
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select lives_ok($$ select save_push_destination(null, 'POTA on my phone', true, null, null) $$, 'another account may use the same name');

-- update_destination (the API's PATCH, run by api_call) reports a taken name the same way and
-- takes enabled. As the runner with A's claims still set, since clients cannot call it.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
reset role;
select throws_ok(format('select update_destination(%L, %L, null)', (select id from desk), 'pota on my phone'),
  'P0001', 'A destination named pota on my phone already exists. Choose a different name.', 'update_destination reports a taken name');
select update_destination((select id from desk), null, null, false);
select is((select enabled from destinations where id = (select id from desk)), false, 'update_destination turns a destination off');
select update_destination((select id from desk), 'Desktop alerts', null, null);
select is((select enabled from destinations where id = (select id from desk)), false, 'and a null p_enabled keeps it');
select update_destination((select id from desk), null, null, true);

-- Hosted duplicates: the oldest keeps its name, the rest get " (2)", " (3)", skipping names in use.
drop index destinations_user_name_key;
insert into destinations (user_id, type, name, url, url_display, created_at) values
  ('22222222-2222-2222-2222-222222222222', 'webhook', 'Club', 'https://e.com/1', 'e', now() - interval '3 days'),
  ('22222222-2222-2222-2222-222222222222', 'webhook', 'club', 'https://e.com/2', 'e', now() - interval '2 days'),
  ('22222222-2222-2222-2222-222222222222', 'webhook', 'CLUB', 'https://e.com/3', 'e', now() - interval '1 day'),
  ('22222222-2222-2222-2222-222222222222', 'webhook', 'Club (2)', 'https://e.com/4', 'e', now()),
  ('11111111-1111-1111-1111-111111111111', 'webhook', 'Club', 'https://e.com/5', 'e', now());
select is(rename_duplicate_destination_names(), 2, 'two duplicates renamed');
select results_eq($$ select name from destinations where url like 'https://e.com/%' order by url $$,
  $$ values ('Club'::text), ('club (3)'), ('CLUB (4)'), ('Club (2)'), ('Club') $$,
  'oldest first keeps its name; the others take the next free suffix');
create unique index destinations_user_name_key on destinations (user_id, lower(name));
delete from destinations where url like 'https://e.com/%';

-- ---------------------------------------------------------------------------
-- Settings and membership
-- ---------------------------------------------------------------------------
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select throws_ok(format('select save_push_destination(%L, null, null, %L, null)', (select id from desk), '{"title_fields": ["callsign", "grid"]}'),
  'P0001', 'Unknown field grid.', 'an unknown field is refused');
select throws_ok(format('select save_push_destination(%L, null, null, %L, null)', (select id from desk), '{"title_fields": []}'),
  'P0001', 'Pick 1 to 4 fields for the title.', 'the title needs a field');
select throws_ok(format('select save_push_destination(%L, null, null, %L, null)', (select id from desk),
                        '{"title_fields": ["callsign", "frequency", "band", "mode", "source"]}'),
  'P0001', 'Pick 1 to 4 fields for the title.', 'the title takes at most four');
select throws_ok(format('select save_push_destination(%L, null, null, %L, null)', (select id from desk),
                        '{"body_fields": ["callsign", "frequency", "band", "mode", "source", "reference", "place_name", "state", "spotter"]}'),
  'P0001', 'Pick up to 8 fields for the body.', 'the body takes at most eight');
select throws_ok(format('select save_push_destination(%L, null, null, %L, null)', (select id from desk), '{"body_fields": ["state", "state"]}'),
  'P0001', 'Pick each field once.', 'a field twice is refused');
select lives_ok(format('select save_push_destination(%L, null, null, %L, null)', (select id from desk), '{"body_fields": []}'),
  'the body may be empty');
select throws_ok(format('select save_push_destination(%L, null, null, %L, null)', (select id from desk), '{"colour": "red"}'),
  'P0001', 'Unknown setting colour.', 'an unknown setting is refused');
select throws_ok(format('select save_push_destination(%L, null, null, %L, null)', (select id from desk), '{"ttl_seconds": 60}'),
  '23514', null, 'drop-if-offline takes only the listed values');
select throws_ok(format('select save_push_destination(%L, null, null, %L, null)', (select id from desk), '{"body_separator": "semicolon"}'),
  '23514', null, 'the separator takes only the listed values');
select throws_ok(format('select save_push_destination(%L, null, null, null, %L)', (select id from desk), array[(select id from b_phone)]),
  'P0001', 'Device not found.', 'another account''s device cannot be picked');
select throws_ok(format('select save_push_destination(%L, null, null, null, null)', (select id from b_phone)),
  'P0001', 'Destination not found.', 'only the caller''s push destinations can be saved');
select save_push_destination((select id from desk), null, null, null, array[(select id from a_desk), (select id from a_desk)]);
select is((get_push_destination((select id from desk)) -> 'device_ids'), jsonb_build_array((select id from a_desk)),
  'device ids replace the membership, duplicates ignored');
select save_push_destination((select id from desk), 'Desktop', false, null, null);
select results_eq(format($$ select x ->> 'name', (x ->> 'enabled')::boolean, jsonb_array_length(x -> 'device_ids'), x #>> '{settings,urgency}'
                            from (select get_push_destination(%L) as x) t $$, (select id from desk)),
  $$ values ('Desktop'::text, false, 1, 'high'::text) $$, 'null arguments keep the devices and settings');
select save_push_destination((select id from desk), null, true, '{"body_fields": ["source", "reference", "place_name", "state"]}', null);
select is((select array_agg(x order by x) from list_push_devices() l, unnest(l.destination_ids) x where l.label = 'Phone'),
  array[(select id from pota)], 'list_push_devices shows which destinations a device is in');

-- RLS: no client reads or writes on the new tables.
select throws_ok($$ select * from push_destination_devices $$, '42501', null, 'clients cannot read push_destination_devices');
select throws_ok($$ select * from push_destination_settings $$, '42501', null, 'clients cannot read push_destination_settings');
select throws_ok(format($$ insert into push_destination_devices values (%L, %L) $$, (select id from pota), (select id from a_desk)),
  '42501', null, 'clients cannot add members directly');
select throws_ok($$ update push_destination_settings set sound = false $$, '42501', null, 'clients cannot change settings directly');
select throws_ok($$ update destinations set enabled = false $$, '42501', null, 'clients cannot flip enabled directly');
reset role;
select ok((select relrowsecurity from pg_class where relname = 'push_destination_devices')
          and (select relrowsecurity from pg_class where relname = 'push_destination_settings'), 'RLS is on for both tables');
select is((select count(*) from pg_policies where tablename in ('push_destination_devices', 'push_destination_settings')), 0::bigint,
  'with no policies');

-- ---------------------------------------------------------------------------
-- Rendering
-- ---------------------------------------------------------------------------
create temp table spot as select jsonb_build_object(
  'id', 1, 'source', 'pota', 'spot_time', '2026-10-05T13:45:12Z', 'callsign', 'KK4PWJ/P', 'base_callsign', 'KK4PWJ',
  'spotter', 'W1AW', 'frequency_khz', 14062, 'band', '20m', 'mode', 'cw', 'comment', 'QRT soon',
  'pota_reference', 'US-2763', 'pota_park_name', 'Pisgah National Forest', 'pota_location', 'US-NC,US-SC',
  'sota_summit_ref', null, 'wwff_reference', null, 'wwff_reference_name', null) as j;
select is(push_fields(), array['callsign', 'frequency', 'band', 'mode', 'source', 'reference', 'place_name', 'state', 'spotter', 'comment', 'time'],
  'the fixed field list, in the editor''s order');
select is((select array_agg(push_field_label(f) order by o) from unnest(push_fields()) with ordinality as t(f, o)),
  array['Callsign', 'Frequency', 'Band', 'Mode', 'Source', 'Reference', 'Place name', 'State', 'Spotter', 'Comment', 'Time'],
  'every field has its display name');
select is((select array_agg(render_push_field(f, (select j from spot)) order by o) from unnest(push_fields()) with ordinality as t(f, o)),
  array['KK4PWJ/P', '14.062 MHz', '20m', 'CW', 'POTA', 'US-2763', 'Pisgah National Forest', 'NC/SC', 'W1AW', 'QRT soon', '13:45Z'],
  'every field renders');
select is(render_push_field('place_name', (select j - 'pota_park_name' from spot)), null, 'a missing field renders null');
select is(render_push_field('comment', (select j || '{"comment": ""}' from spot)), null, 'an empty field renders null');
select is(render_push_field('reference', '{"source": "sotawatch", "sota_summit_ref": "W4C/CM-001"}'), 'W4C/CM-001', 'reference: the summit');
select is(render_push_field('reference', '{"source": "wwff", "wwff_reference": "KFF-6101"}'), 'KFF-6101', 'reference: the WWFF reference');
select is(render_push_field('place_name', '{"source": "wwff", "wwff_reference_name": "State Game Land PA 013"}'), 'State Game Land PA 013',
  'place name: the WWFF reference name');
select is(render_push_field('state', '{"pota_location": "US-NC"}'), 'NC', 'state: the part after the dash');
select is(render_push_field('grid', (select j from spot)), null, 'an unknown field renders null');

select is(render_push_fields(array['callsign', 'frequency', 'mode'], (select j from spot), 'dot', false),
  'KK4PWJ/P · 14.062 MHz · CW', 'the default title');
select is(render_push_fields(array['source', 'reference', 'place_name', 'state'], (select j from spot), 'dot', false),
  'POTA · US-2763 · Pisgah National Forest · NC/SC', 'the default body');
select is(render_push_fields(array['state', 'callsign'], (select j from spot), 'dot', false), 'NC/SC · KK4PWJ/P', 'fields render in the picked order');
select is(render_push_fields(array['source', 'reference', 'place_name', 'state'], (select j - 'pota_park_name' from spot), 'dot', false),
  'POTA · US-2763 · NC/SC', 'a missing field is skipped');
select is(render_push_fields(array['source', 'reference'], (select j from spot), 'comma', false), 'POTA, US-2763', 'a comma separator');
select is(render_push_fields(array['source', 'reference'], (select j from spot), 'newline', false), E'POTA\nUS-2763', 'a new line separator');
select is(render_push_fields(array['state', 'mode'], (select j from spot), 'dot', true), 'State: NC/SC · Mode: CW', 'field names as labels');
select is(render_push_fields(array['place_name'], (select j - 'pota_park_name' from spot), 'dot', false), '', 'nothing to show renders empty');
select is(push_clip(repeat('x', 400), 400), repeat('x', 400), 'push_clip leaves text within the limit alone');
select is(push_clip(repeat('x', 401), 400), repeat('x', 399) || '…', 'and cuts longer text with an ellipsis');
select results_eq(format($$ select length(f ->> 'push_title'), right(f ->> 'push_title', 1), length(f ->> 'push_body'), right(f ->> 'push_body', 1)
                            from (select push_spot_fields(jsonb_populate_record(null::push_destination_settings,
                                    push_default_settings() || '{"title_fields": ["comment"], "body_fields": ["comment"]}'), %L) as f) t $$,
                  (select j || jsonb_build_object('comment', repeat('x', 500)) from spot)),
  $$ values (160, '…', 400, '…') $$, 'a long comment is clipped to 160 title and 400 body characters');
-- Characters, not bytes: at four bytes each the text stays within 2,240 bytes, which
-- with the URLs and tag leaves a push payload under webpush.ts's 3,993-byte cap.
select results_eq(format($$ select length(f ->> 'push_title'), length(f ->> 'push_body'),
                                   octet_length(f ->> 'push_title') + octet_length(f ->> 'push_body') <= 2240
                            from (select push_spot_fields(jsonb_populate_record(null::push_destination_settings,
                                    push_default_settings() || '{"title_fields": ["comment"], "body_fields": ["comment"]}'), %L) as f) t $$,
                  (select j || jsonb_build_object('comment', repeat(U&'\+01F4FB', 1000)) from spot)),
  $$ values (160, 400, true) $$, 'four-byte characters are clipped by count, keeping the text within 2,240 bytes');
select is((push_spot_fields(jsonb_populate_record(null::push_destination_settings, push_default_settings() || '{"title_fields": ["place_name"]}'),
                            (select j - 'pota_park_name' from spot)) ->> 'push_title'), 'KK4PWJ/P',
  'a title with nothing to show falls back to the callsign');

select is(spot_source_url((select j from spot)), 'https://pota.app/#/park/US-2763', 'POTA links the park');
select is(spot_source_url('{"source": "sotawatch", "sota_summit_ref": "W4C/CM-001"}'), 'https://summits.sota.org.uk/summit/W4C/CM-001',
  'SOTA links the summit');
select is(spot_source_url('{"source": "wwff", "wwff_reference": "KFF-6101"}'), 'https://wwff.co/directory/?showRef=KFF-6101',
  'WWFF links the reference');
select is(spot_source_url('{"source": "rbn"}'), null, 'RBN has no source page');
select is(spot_source_url('{"source": "dxcluster"}'), null, 'DX Cluster has no source page');
select is(spot_source_url('{"source": "pota", "pota_reference": "US-1\"><x"}'), null, 'a reference outside the safe characters gets no link');
select is(push_profile_url((select j from spot)), '/call/KK4PWJ', 'the profile URL uses the base call from SQL');
select is(push_profile_url('{"callsign": "W4/KK4PWJ"}'), '/call/W4%2FKK4PWJ', 'and the call as spotted, escaped, when there is none');

-- Quiet hours in America/New_York (UTC-4 in October): 22:00 to 07:00 crosses midnight.
create temp table qs as
  select jsonb_populate_record(null::push_destination_settings, push_default_settings() || '{"quiet_enabled": true}') as s;
select is(push_quiet_now((select s from qs), 'America/New_York', '2026-10-15T03:30:00Z'), true, '23:30 local is quiet');
select is(push_quiet_now((select s from qs), 'America/New_York', '2026-10-15T10:30:00Z'), true, '06:30 local, after midnight, is quiet');
select is(push_quiet_now((select s from qs), 'America/New_York', '2026-10-15T11:00:00Z'), false, '07:00 local is not');
select is(push_quiet_now((select s from qs), 'America/New_York', '2026-10-15T01:30:00Z'), false, '21:30 local is not');
select is(push_quiet_now((select s from qs), 'UTC', '2026-10-15T23:30:00Z'), true, 'the time zone decides: 23:30 UTC is 19:30 in New York');
update qs set s.quiet_from = '09:00', s.quiet_until = '17:00';
select is(push_quiet_now((select s from qs), 'America/New_York', '2026-10-15T16:00:00Z'), true, 'a daytime range: 12:00 local is quiet');
select is(push_quiet_now((select s from qs), 'America/New_York', '2026-10-15T22:00:00Z'), false, 'and 18:00 local is not');
select is(push_quiet_now((select s from qs), 'Not/AZone', '2026-10-15T12:00:00Z'), true, 'an unknown time zone reads as UTC');
update qs set s.quiet_enabled = false;
select is(push_quiet_now((select s from qs), 'America/New_York', '2026-10-15T16:00:00Z'), false, 'off is never quiet');

-- ---------------------------------------------------------------------------
-- The matcher, claim_deliveries, the preview and Send test
-- ---------------------------------------------------------------------------
update profiles set timezone = 'America/New_York' where id = '11111111-1111-1111-1111-111111111111';
-- Desktop is in quiet hours for the next hour either side of now, in A's time zone.
update push_destination_settings set quiet_enabled = true, quiet_mode = 'skip',
  quiet_from = (now() at time zone 'America/New_York')::time - interval '1 hour',
  quiet_until = (now() at time zone 'America/New_York')::time + interval '1 hour',
  tap_target = 'source' where destination_id = (select id from desk);
-- A's Phone is blocked: pota keeps it as a member but has no one to send to.
update push_devices set blocked_at = now() where id = (select id from a_phone);
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table off as select save_push_destination(null, 'Off', false, null, array[(select id from a_desk)]) as id;
grant all on off to authenticated;
select save_subscription(jsonb_build_object('name', 'all', 'quiet_minutes', 0,
  'destinations', array[(select id from pota), (select id from desk), (select id from off)]));
reset role;
select count(*) from ingest_spots(jsonb_build_array(
  jsonb_build_object('source','pota','source_spot_id','s1','content_hash','h1','spot_time',now(),'callsign','KK4PWJ/P',
    'spotter','W1AW','frequency_khz',14062,'band','20m','mode','cw','comment','','pota_reference','US-2763',
    'pota_park_name','Pisgah National Forest','pota_location','US-NC','raw_payload','{}'::jsonb)));
create temp table s1 as select id from raw_spots where source_spot_id = 's1';
grant select on s1 to authenticated;
select is(match_pending_spots(), 2, 'a disabled destination gets no delivery');
select is((select count(*) from deliveries where destination_id = (select id from off)), 0::bigint, 'none for Off');
-- Buckets start empty and refill from creation (now() in a transaction): fill them.
update destinations set claim_tokens_at = now() - interval '1 minute';

create temp table claimed as select * from claim_deliveries(200, 60);
grant select on claimed to authenticated;
select is((select count(*) from claimed), 2::bigint, 'both deliveries claimed');
select is((select destination -> 'devices' from claimed where destination ->> 'id' = (select id::text from pota)), '[]'::jsonb,
  'a blocked member is skipped');
select is((select jsonb_agg(d ->> 'endpoint') from claimed, jsonb_array_elements(destination -> 'devices') d
           where destination ->> 'id' = (select id::text from desk)),
  '["https://updates.push.services.mozilla.com/wpush/v2/a-desk"]'::jsonb, 'only members are sent to, not every device of the owner');
select is((select destination -> 'push' from claimed where destination ->> 'id' = (select id::text from pota)),
  (select j from defaults), 'the destination carries its settings');
select results_eq(format($$ select destination #>> '{push,urgency}', (destination ->> 'quiet_now')::boolean
                            from claimed where destination ->> 'id' = %L $$, (select id from desk)),
  $$ values ('high'::text, true) $$, 'its own settings and quiet flag, decided per destination');
select results_eq(format($$ select spot ->> 'push_title', spot ->> 'push_body', spot ->> 'push_url', spot ->> 'push_source_url',
                                   (destination ->> 'quiet_now')::boolean
                            from claimed where destination ->> 'id' = %L $$, (select id from pota)),
  $$ values ('KK4PWJ/P · 14.062 MHz · CW'::text, 'POTA · US-2763 · Pisgah National Forest · NC'::text,
             '/call/KK4PWJ'::text, 'https://pota.app/#/park/US-2763'::text, false) $$,
  'a push spot carries its field-built text and URLs; the destination is not quiet');
select results_eq(format($$ select spot ->> 'push_title', spot ->> 'push_url'
                            from claimed where destination ->> 'id' = %L $$, (select id from desk)),
  $$ values ('KK4PWJ/P · 20m'::text, 'https://pota.app/#/park/US-2763'::text) $$,
  'each destination renders its own fields and tap target');
select is((select array_agg(k order by k) from claimed c, jsonb_object_keys(c.spot) k where c.destination ->> 'id' = (select id::text from pota)),
  array['band', 'base_callsign', 'callsign', 'comment', 'frequency_khz', 'id', 'mode', 'mode_family', 'pota_location',
        'pota_park_name', 'pota_reference', 'push_body', 'push_source_url', 'push_title', 'push_url', 'sota_summit_ref', 'source',
        'spot_time', 'spotter', 'wwff_reference', 'wwff_reference_name'],
  'the spot keeps its documented keys plus the four push ones');
select is((select array_agg(k order by k) from claimed c, jsonb_object_keys(to_jsonb(c)) k where c.destination ->> 'id' = (select id::text from pota)),
  array['attempts', 'created_at', 'delivery_id', 'destination', 'msg_id', 'spot', 'subscription_id'],
  'the result columns are unchanged');

-- The preview renders what the claim rendered, for the same spot.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select results_eq(format($$ select title, body, url, source_url from preview_push_notification(null, null, null, null, %s) $$, (select id from s1)),
  format($$ select spot ->> 'push_title', spot ->> 'push_body', spot ->> 'push_url', spot ->> 'push_source_url'
            from claimed where destination ->> 'id' = %L $$, (select id from pota)),
  'the preview renders exactly what claim_deliveries sends');
select results_eq($$ select title, body, url, source_url
                     from preview_push_notification(array['callsign', 'frequency'], array['place_name'], true, 'comma') $$,
  $$ values ('Callsign: N0CALL · Frequency: 14.062 MHz'::text, 'Place name: Test Park'::text, '/call/N0CALL'::text,
             'https://pota.app/#/park/US-0000'::text) $$,
  'without a spot the preview uses the sample spot, with the given fields, labels and separator');
select results_eq($$ select body from preview_push_notification(array['callsign'], array['source', 'reference'], false, 'newline') $$,
  $$ values (E'POTA\nUS-0000'::text) $$, 'the preview joins the body with the chosen separator');
select throws_ok($$ select * from preview_push_notification(array['nope'], null, null, null) $$, 'P0001', 'Unknown field nope.', 'the preview checks fields');
select throws_ok($$ select * from preview_push_notification(array[]::text[], null, null, null) $$, 'P0001', 'Pick 1 to 4 fields for the title.',
  'the preview needs a title field');
select throws_ok($$ select * from preview_push_notification(null, array['callsign', 'frequency', 'band', 'mode', 'source', 'reference', 'place_name', 'state', 'spotter'], null, null) $$,
  'P0001', 'Pick up to 8 fields for the body.', 'the preview caps the body');
select throws_ok($$ select * from preview_push_notification(null, null, null, 'tab') $$, 'P0001', 'Pick a separator.', 'the preview checks the separator');
select throws_ok($$ select * from preview_push_notification(null, null, null, null, -1) $$, 'P0001', 'Spot not found.', 'an unknown spot');
reset role;

-- Send test: the saved fields for the chosen spot, members only, never quiet.
select results_eq(format($$ select x -> 'spot' ->> 'push_title', x -> 'spot' ->> 'push_url', (x ->> 'quiet_now')::boolean,
                                   jsonb_array_length(x -> 'devices'), x #>> '{push,urgency}'
                            from (select push_test_delivery(%L, %s) as x) t $$,
                   (select id from desk), (select id from s1)),
  $$ values ('KK4PWJ/P · 20m'::text, 'https://pota.app/#/park/US-2763'::text, false, 1, 'high'::text) $$,
  'Send test renders the saved fields for the chosen spot, members only, never quiet');
select is((push_test_delivery((select id from pota)) -> 'spot' ->> 'callsign'), 'N0CALL', 'Send test without a spot uses the sample');
select is(push_test_delivery((select id from pota), -1), null, 'Send test with an unknown spot returns null');
select is(push_test_delivery(gen_random_uuid()), null, 'Send test for an unknown destination returns null');
select ok(not has_function_privilege('authenticated', 'public.push_test_delivery(uuid, bigint)', 'execute')
          and not has_function_privilege('authenticated', 'public.render_push_fields(text[], jsonb, text, boolean)', 'execute')
          and not has_function_privilege('authenticated', 'public.push_member_devices(uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public.rename_duplicate_destination_names()', 'execute'),
  'the worker and migration helpers are not callable by clients');
select ok(not has_function_privilege('delivery_sender', 'public.push_test_delivery(uuid, bigint)', 'execute')
          and not has_table_privilege('delivery_sender', 'public.push_destination_settings', 'select')
          and not has_table_privilege('delivery_sender', 'public.push_destination_devices', 'select'),
  'the sender role gets nothing new');

-- A destination disabled after its deliveries were queued: the next claim drops them.
select mark_deliveries_sent(array(select delivery_id from claimed), array(select msg_id from claimed));
update destinations set enabled = true where id = (select id from off);
select count(*) from ingest_spots(jsonb_build_array(
  jsonb_build_object('source','pota','source_spot_id','s2','content_hash','h2','spot_time',now(),'callsign','KK4PWJ/P',
    'spotter','W1AW','frequency_khz',14062,'band','20m','mode','cw','comment','','pota_reference','US-2763',
    'pota_park_name','Pisgah National Forest','pota_location','US-NC','raw_payload','{}'::jsonb)));
select is(match_pending_spots(), 3, 'enabled again, Off gets its delivery');
update destinations set enabled = false where id = (select id from off);
create temp table off_delivery as select id from deliveries where destination_id = (select id from off);
create temp table claimed2 as select * from claim_deliveries(200, 60);
select is((select count(*) from claimed2), 2::bigint, 'the disabled destination''s delivery is not claimed; the others are');
select results_eq($$ select status, dropped_at from deliveries where id = (select id from off_delivery) $$,
  $$ values ('dropped', null::timestamptz) $$, 'it is dropped without dropped_at, like a disabled subscription''s');
select is((select count(*) from pgmq.q_deliveries_queue where (message ->> 'delivery_id')::bigint = (select id from off_delivery)),
  0::bigint, 'and its message is archived');
select mark_deliveries_sent(array(select delivery_id from claimed2), array(select msg_id from claimed2));

-- A push destination that somehow lost its settings row is still handed its members and the defaults.
delete from push_destination_settings where destination_id = (select id from pota);
update push_devices set blocked_at = null where id = (select id from a_phone);
select count(*) from ingest_spots(jsonb_build_array(
  jsonb_build_object('source','pota','source_spot_id','s4','content_hash','h4','spot_time',now(),'callsign','KK4PWJ/P',
    'spotter','W1AW','frequency_khz',14062,'band','20m','mode','cw','comment','','pota_reference','US-2763',
    'pota_park_name','Pisgah National Forest','pota_location','US-NC','raw_payload','{}'::jsonb)));
select match_pending_spots();
create temp table claimed3 as select * from claim_deliveries(200, 60);
select results_eq(format($$ select jsonb_array_length(destination -> 'devices'), destination -> 'push' = (select j from defaults),
                                   (destination ->> 'quiet_now')::boolean, spot ->> 'push_title'
                            from claimed3 where destination ->> 'id' = %L $$, (select id from pota)),
  $$ values (1, true, false, 'KK4PWJ/P · 14.062 MHz · CW'::text) $$,
  'without a settings row the claim uses the defaults and still lists the members');
select mark_deliveries_sent(array(select delivery_id from claimed3), array(select msg_id from claimed3));
insert into push_destination_settings
select (jsonb_populate_record(null::push_destination_settings, push_default_settings() || jsonb_build_object('destination_id', (select id from pota)))).*;
update push_devices set blocked_at = now() where id = (select id from a_phone);

-- "Drop if the device is offline for" is the expiry sweep's limit per push destination.
update push_destination_settings set ttl_seconds = 14400 where destination_id = (select id from desk);
select count(*) from ingest_spots(jsonb_build_array(
  jsonb_build_object('source','pota','source_spot_id','s3','content_hash','h3','spot_time',now(),'callsign','KK4PWJ/P',
    'spotter','W1AW','frequency_khz',14062,'band','20m','mode','cw','comment','','pota_reference','US-2763',
    'pota_park_name','Pisgah National Forest','pota_location','US-NC','raw_payload','{}'::jsonb)));
create temp table s3 as select id from raw_spots where source_spot_id = 's3';
with ins as (
  insert into deliveries (subscription_id, destination_id, spot_id, created_at)
  select s.id, d.id, (select id from s3), now() - interval '31 minutes'
  from subscriptions s, destinations d
  where s.user_id = '11111111-1111-1111-1111-111111111111' and d.id in ((select id from pota), (select id from desk))
  returning id, destination_id
), q as (
  select pgmq.send_batch('deliveries_queue', (select array_agg(jsonb_build_object('delivery_id', ins.id)) from ins))
)
select count(*) from q;
update destinations set throttled_until = now() + interval '1 hour'; -- nothing claimable: the sweep is the only thing the call does
select count(*) from claim_deliveries(200, 60);
select results_eq(format($$ select status, dropped_at is not null from deliveries where destination_id = %L and spot_id = (select id from s3) $$, (select id from pota)),
  $$ values ('dropped', true) $$, 'a 31-minute-old row for a 30-minute destination is expired');
select results_eq(format($$ select status, dropped_at from deliveries where destination_id = %L and spot_id = (select id from s3) $$, (select id from desk)),
  $$ values ('pending', null::timestamptz) $$, 'and kept for a 4-hour one');
update destinations set throttled_until = null;

-- ---------------------------------------------------------------------------
-- Duplicate, moved devices and cascades
-- ---------------------------------------------------------------------------
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select save_push_destination((select id from desk), 'Desktop', null, null, null);
create temp table copy1 as select duplicate_destination((select id from desk)) as id;
create temp table copy2 as select duplicate_destination((select id from desk)) as id;
grant all on copy1, copy2 to authenticated;
select results_eq(format($$ select x ->> 'name', (x ->> 'enabled')::boolean, x -> 'device_ids', x -> 'settings'
                            from (select get_push_destination(%L) as x) t $$, (select id from copy1)),
  format($$ select 'Copy of Desktop'::text, false, x -> 'device_ids', x -> 'settings' from (select get_push_destination(%L) as x) t $$,
         (select id from desk)),
  'a copy has the settings and devices, named "Copy of", and starts disabled');
select is((get_push_destination((select id from copy2)) ->> 'name'), 'Copy of Desktop (2)', 'a second copy takes the next free name');
create temp table hook as select id from create_destination('webhook', 'Hook', 'https://example.com/h');
select throws_ok(format('select duplicate_destination(%L)', (select id from hook)), 'P0001',
  'Only push destinations can be duplicated.', 'only push destinations are duplicated');
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select throws_ok(format('select duplicate_destination(%L)', (select id from desk)), 'P0001', 'Destination not found.',
  'another account''s destination cannot be duplicated');

-- A's Desk moves to B: it leaves every one of A's destinations.
select register_push_device('https://updates.push.services.mozilla.com/wpush/v2/a-desk', :p256dh, :auth, 'Desk', 'Firefox on Linux', false);
reset role;
select is((select count(*) from push_destination_devices where device_id = (select id from a_desk)), 0::bigint,
  'a device that moves accounts leaves the old account''s destinations');

insert into push_destination_devices values ((select id from copy1), (select id from a_phone));
delete from push_devices where id = (select id from a_phone);
select is((select count(*) from push_destination_devices where device_id = (select id from a_phone)), 0::bigint,
  'deleting a device removes its memberships');
delete from destinations where id = (select id from copy1);
select is((select count(*) from push_destination_settings where destination_id = (select id from copy1)), 0::bigint,
  'deleting a destination removes its settings');
delete from deliveries;
delete from subscriptions where user_id = '11111111-1111-1111-1111-111111111111';
delete from auth.users where id = '11111111-1111-1111-1111-111111111111';
select is((select count(*) from push_destination_settings s join destinations d on d.id = s.destination_id
           where d.user_id = '11111111-1111-1111-1111-111111111111'), 0::bigint, 'settings go with their account');

select * from finish();
rollback;

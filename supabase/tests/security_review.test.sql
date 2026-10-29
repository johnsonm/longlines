-- pgTAP: the 2026-10-29 security review's SQL fixes.
-- 20261029000700: a webhook's new URL clears its extra headers, so stored
-- values never go to a host they were not set for.
-- 20261029000800: the destination previews and Send test refuse a retracted
-- logged contact, like every other reader of raw_spots.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(14);

create function pg_temp.spot(p_id text) returns bigint language sql as $$
  select (ingest_spots(jsonb_build_array(jsonb_build_object(
    'source', 'pota', 'source_spot_id', p_id, 'content_hash', 'h', 'spot_time', now(), 'callsign', 'K4ABC',
    'spotter', 'W4DOG', 'frequency_khz', 14062, 'band', '20m', 'mode', 'cw', 'mode_family', 'cw', 'comment', '',
    'pota_reference', 'K-0039', 'raw_payload', '{}'::jsonb)))).id;
$$;

-- ---------------------------------------------------------------------------
-- A new webhook URL clears the headers
-- ---------------------------------------------------------------------------
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table hook as
  select id from save_webhook_destination(null, 'Receiver', true, 'https://receiver.example.org/hook', null,
    '[{"name": "Authorization", "value": "Bearer k"}]');
grant select on hook to public;
reset role;
create temp table hook_secret as
  select secret_id from webhook_destination_headers where destination_id = (select id from hook);
select is((select count(*) from hook_secret), 1::bigint, 'the header is stored');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select save_webhook_destination((select id from hook), 'Renamed', null, null, null, '[{"name": "Authorization"}]');
reset role;
select is((select secret_id from webhook_destination_headers where destination_id = (select id from hook)),
  (select secret_id from hook_secret), 'a save that keeps the URL keeps the stored value');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select throws_ok(format($$ select save_webhook_destination(%L, null, null, 'https://other.example.net/h', null,
    '[{"name": "Authorization"}]') $$, (select id from hook)),
  'Give the Authorization header a value.', 'a new URL needs the header''s value typed again');
reset role;
select is((select url from destinations where id = (select id from hook)), 'https://receiver.example.org/hook',
  'the refused save leaves the URL');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select save_webhook_destination((select id from hook), null, null, 'https://other.example.net/h', null,
  '[{"name": "Authorization", "value": "Bearer new"}]');
reset role;
select is((select s.decrypted_secret from webhook_destination_headers h join vault.decrypted_secrets s on s.id = h.secret_id
           where h.destination_id = (select id from hook)), 'Bearer new', 'a new URL with the value typed stores it');
select is((select count(*) from vault.secrets where id = (select secret_id from hook_secret)), 0::bigint,
  'the old value''s Vault secret is gone');

-- The API's PATCH (update_destination alone) clears them for good.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select save_webhook_destination((select id from hook), null, null, null, null, '[{"name": "X-Key", "value": "v"}]');
reset role;
select set_config('request.jwt.claims',
  json_build_object('sub', '11111111-1111-1111-1111-111111111111', 'role', 'authenticated')::text, true);
select update_destination((select id from hook), null, 'https://third.example.com/h', null);
select is((select count(*) from webhook_destination_headers where destination_id = (select id from hook)), 0::bigint,
  'update_destination with a new URL deletes the headers');
select set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------------------
-- Previews and Send test refuse a retracted spot
-- ---------------------------------------------------------------------------
create temp table gone as select pg_temp.spot('retracted') as id;
update raw_spots set retracted_at = now() where id = (select id from gone);
grant select on gone to public;

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table phone as select register_push_device('https://fcm.googleapis.com/fcm/send/security-review',
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg',
  'Phone', 'Chrome on Android', true) as id;
create temp table pushd as select save_push_destination(null, 'Phone alerts', true, null, array[(select id from phone)]) as id;
create temp table club as select save_discord_destination(null, 'Club', true, 'https://discord.com/api/webhooks/1182334455/xY9abcTOKEN', null) as id;
grant select on phone, pushd, club to public;

select throws_ok(format($$ select * from preview_push_notification(null, null, null, null, %s) $$, (select id from gone)),
  'Spot not found.', 'the push preview refuses a retracted spot');
select throws_ok(format($$ select preview_discord_message(null, %s) $$, (select id from gone)),
  'Spot not found.', 'the Discord preview refuses a retracted spot');
select throws_ok(format($$ select preview_webhook_request(null, %s) $$, (select id from gone)),
  'Spot not found.', 'the webhook preview refuses a retracted spot');
reset role;

select is(push_test_delivery((select id from pushd), (select id from gone)), null,
  'push Send test reads a retracted spot as missing');
select is(discord_test_delivery((select id from club), (select id from gone)), null,
  'Discord Send test reads a retracted spot as missing');
select is(webhook_test_delivery((select id from hook), (select id from gone)), null,
  'webhook Send test reads a retracted spot as missing');

update raw_spots set retracted_at = null where id = (select id from gone);
select is(push_test_delivery((select id from pushd), (select id from gone)) -> 'spot' ->> 'callsign', 'K4ABC',
  'the same spot, no longer retracted, is read again');

select * from finish();
rollback;

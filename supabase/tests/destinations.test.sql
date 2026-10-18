-- pgTAP: destinations, URL validation, secret handling, RLS and column grants.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(68);

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');

-- Discord destination.
create temp table d1 as
  select * from create_destination('discord', 'Club', 'https://discord.com/api/webhooks/1182334455/xY9abcTOKEN');
select is((select type from d1), 'discord', 'discord destination created');
select is((select url_display from d1), 'https://discord.com/api/webhooks/1182…/xY9', 'discord url is masked for display');
select is((select signing_secret from d1), null, 'discord destination has no signing secret');
select is((select health from d1), 'ok', 'new destination is healthy');

-- Webhook destination.
create temp table d2 as
  select * from create_destination('webhook', 'Shack', 'https://shack.example.com:8443/spots?x=1');
select matches((select signing_secret from d2), '^whsec_[0-9a-f]{48}$', 'webhook gets a signing secret');
select is((select url_display from d2), 'https://shack.example.com:8443/spots', 'webhook display drops the query string');

-- Validation.
select throws_ok($$ select create_destination('discord', 'x', 'http://discord.com/api/webhooks/1/2') $$, 'P0001', 'Use an https URL.', 'rejects http');
select throws_ok($$ select create_destination('discord', 'x', 'https://evil.com/api/webhooks/1/2') $$, 'P0001', 'Use a Discord webhook URL.', 'rejects non-discord host');
select throws_ok($$ select create_destination('discord', 'x', 'https://discord.com/other/1/2') $$, 'P0001', 'Use a Discord webhook URL.', 'rejects wrong discord path');
select lives_ok($$ select create_destination('discord', 'x', 'https://discordapp.com/api/webhooks/1/2') $$, 'accepts discordapp.com');
select throws_ok($$ select create_destination('webhook', 'x', 'https://localhost/spots') $$, 'P0001', 'That address is not allowed.', 'rejects localhost');
select throws_ok($$ select create_destination('webhook', 'x', 'https://10.0.0.5/spots') $$, 'P0001', 'That address is not allowed.', 'rejects 10/8');
select throws_ok($$ select create_destination('webhook', 'x', 'https://172.16.4.4:8080/spots') $$, 'P0001', 'That address is not allowed.', 'rejects 172.16/12');
select throws_ok($$ select create_destination('webhook', 'x', 'https://192.168.1.1/spots') $$, 'P0001', 'That address is not allowed.', 'rejects 192.168/16');
select throws_ok($$ select create_destination('webhook', 'x', 'https://127.0.0.1/spots') $$, 'P0001', 'That address is not allowed.', 'rejects loopback');
select throws_ok($$ select create_destination('webhook', 'x', 'https://169.254.169.254/latest') $$, 'P0001', 'That address is not allowed.', 'rejects link-local');
select throws_ok($$ select create_destination('webhook', 'x', 'https://100.64.0.1/spots') $$, 'P0001', 'That address is not allowed.', 'rejects CGNAT');
select throws_ok($$ select create_destination('webhook', 'x', 'https://[::1]/spots') $$, 'P0001', 'That address is not allowed.', 'rejects IPv6 loopback');
select throws_ok($$ select create_destination('webhook', 'x', 'https://[fd12::1]/spots') $$, 'P0001', 'That address is not allowed.', 'rejects IPv6 ULA');
-- Private-only name suffixes (20261015000300); the same list is in urlsafety.ts.
select throws_ok($$ select create_destination('webhook', 'x', 'https://api.internal/spots') $$, 'P0001', 'That address is not allowed.', 'rejects .internal (Fly 6PN)');
select throws_ok($$ select create_destination('webhook', 'x', 'https://api.flycast/spots') $$, 'P0001', 'That address is not allowed.', 'rejects .flycast');
select throws_ok($$ select create_destination('webhook', 'x', 'https://printer.local/spots') $$, 'P0001', 'That address is not allowed.', 'rejects .local');
select throws_ok($$ select create_destination('webhook', 'x', 'https://box.localdomain/spots') $$, 'P0001', 'That address is not allowed.', 'rejects .localdomain');
select throws_ok($$ select create_destination('webhook', 'x', 'https://nas.home.arpa/spots') $$, 'P0001', 'That address is not allowed.', 'rejects .home.arpa');
select throws_ok($$ select create_destination('webhook', 'x', 'https://1.0.0.10.in-addr.arpa/spots') $$, 'P0001', 'That address is not allowed.', 'rejects .arpa');
select throws_ok($$ select create_destination('webhook', 'x', 'https://API.Internal:8443/spots') $$, 'P0001', 'That address is not allowed.', 'suffix check ignores case and port');
select throws_ok($$ select create_destination('webhook', 'x', 'https://api.internal./spots') $$, 'P0001', 'That address is not allowed.', 'a trailing dot does not evade the suffix check');
select throws_ok($$ select create_destination('webhook', 'x', 'https://[fdaa:0:1::3]/spots') $$, 'P0001', 'That address is not allowed.', 'rejects fdaa::/16 (Fly 6PN)');
select lives_ok($$ select create_destination('webhook', 'Public host', 'https://internal.example.com/spots') $$, 'a denied word inside a public name is fine');
-- Numeric hosts, userinfo and the special ranges (20261017001000); the same rules are in urlsafety.ts.
select throws_ok($$ select create_destination('webhook', 'x', 'https://2130706433/x') $$, 'P0001', 'That address is not allowed.', 'rejects a decimal IPv4');
select throws_ok($$ select create_destination('webhook', 'x', 'https://127.1/') $$, 'P0001', 'That address is not allowed.', 'rejects a short-form IPv4');
select throws_ok($$ select create_destination('webhook', 'x', 'https://0x7f000001/') $$, 'P0001', 'That address is not allowed.', 'rejects a hex IPv4');
select throws_ok($$ select create_destination('webhook', 'x', 'https://017700000001/') $$, 'P0001', 'That address is not allowed.', 'rejects an octal IPv4');
select throws_ok($$ select create_destination('webhook', 'x', 'https://010.0.0.1/') $$, 'P0001', 'That address is not allowed.', 'rejects a zero-led octet');
select throws_ok($$ select create_destination('webhook', 'x', 'https://example.0x7f/') $$, 'P0001', 'That address is not allowed.', 'rejects a host ending in a hex label');
select throws_ok($$ select create_destination('webhook', 'x', 'https://user@10.0.0.1/') $$, 'P0001', 'That address is not allowed.', 'rejects userinfo');
select throws_ok($$ select create_destination('webhook', 'x', 'https://user@example.com/') $$, 'P0001', 'That address is not allowed.', 'rejects userinfo on a public name');
select throws_ok($$ select create_destination('webhook', 'x', 'https://evil.example\@10.0.0.1/') $$, 'P0001', 'That address is not allowed.', 'rejects a backslash in the host');
select throws_ok($$ select create_destination('webhook', 'x', 'https://%31%32%37.0.0.1/') $$, 'P0001', 'That address is not allowed.', 'rejects a percent-encoded host');
select throws_ok($$ select create_destination('webhook', 'x', 'https://[64:ff9b::a00:1]/') $$, 'P0001', 'That address is not allowed.', 'rejects NAT64 of 10.0.0.1');
select throws_ok($$ select create_destination('webhook', 'x', 'https://[64:ff9b::a9fe:a9fe]/') $$, 'P0001', 'That address is not allowed.', 'rejects NAT64 of the metadata address');
select throws_ok($$ select create_destination('webhook', 'x', 'https://[64:ff9b:1::808:808]/') $$, 'P0001', 'That address is not allowed.', 'rejects local-use NAT64');
select throws_ok($$ select create_destination('webhook', 'x', 'https://[::7f00:1]/') $$, 'P0001', 'That address is not allowed.', 'rejects IPv4-compatible loopback');
select throws_ok($$ select create_destination('webhook', 'x', 'https://[::ffff:a00:1]/') $$, 'P0001', 'That address is not allowed.', 'rejects IPv4-mapped 10.0.0.1 in hex');
select throws_ok($$ select create_destination('webhook', 'x', 'https://[2002:7f00:1::]/') $$, 'P0001', 'That address is not allowed.', 'rejects 6to4 of loopback');
select throws_ok($$ select create_destination('webhook', 'x', 'https://[fec0::1]/') $$, 'P0001', 'That address is not allowed.', 'rejects IPv6 site-local');
select throws_ok($$ select create_destination('webhook', 'x', 'https://[ff02::1]/') $$, 'P0001', 'That address is not allowed.', 'rejects IPv6 multicast');
select throws_ok($$ select create_destination('webhook', 'x', 'https://[100::1]/') $$, 'P0001', 'That address is not allowed.', 'rejects IPv6 discard');
select throws_ok($$ select create_destination('webhook', 'x', 'https://224.0.0.1/') $$, 'P0001', 'That address is not allowed.', 'rejects multicast');
select throws_ok($$ select create_destination('webhook', 'x', 'https://240.0.0.1/') $$, 'P0001', 'That address is not allowed.', 'rejects 240/4');
select throws_ok($$ select create_destination('webhook', 'x', 'https://255.255.255.255/') $$, 'P0001', 'That address is not allowed.', 'rejects broadcast');
select throws_ok($$ select create_destination('webhook', 'x', 'https://192.0.0.8/') $$, 'P0001', 'That address is not allowed.', 'rejects 192.0.0.0/24');
select throws_ok($$ select create_destination('webhook', 'x', 'https://198.18.0.1/') $$, 'P0001', 'That address is not allowed.', 'rejects benchmarking');
select lives_ok($$ select create_destination('webhook', 'Public 0', 'https://8.8.8.8/spots') $$, 'accepts a public dotted quad');
select lives_ok($$ select create_destination('webhook', 'Public 1', 'https://[64:ff9b::808:808]/spots') $$, 'accepts NAT64 of a public address');
select lives_ok($$ select create_destination('webhook', 'Public 2', 'https://[2002:808:808::1]/spots') $$, 'accepts 6to4 of a public address');
select lives_ok($$ select create_destination('webhook', 'Public 3', 'https://[2606:4700::1111]/spots') $$, 'accepts a public IPv6 address');
select lives_ok($$ select create_destination('webhook', 'Public 4', 'https://hooks.example.com/a@b') $$, 'accepts an @ in the path');
select lives_ok($$ select create_destination('webhook', 'Public 5', 'https://1e100.example.net/spots') $$, 'accepts a name with digits');
select throws_ok($$ select create_destination('webhook', 'x', 'not a url') $$, 'P0001', 'Use an https URL.', 'rejects garbage');
select throws_ok($$ select create_destination('email', 'x', 'https://example.com') $$, 'P0001', 'Unknown destination type.', 'rejects unknown type');

-- Secrets are not readable through the table, even by the owner.
select throws_ok($$ select url from destinations $$, '42501', null, 'url column is not selectable');
select throws_ok($$ select signing_secret from destinations $$, '42501', null, 'signing_secret column is not selectable');
select is((select count(*) from destinations), 10::bigint, 'owner sees their destinations through allowed columns');
select throws_ok($$ insert into destinations (user_id, type, name, url, url_display) values (auth.uid(), 'webhook', 'x', 'https://e.com', 'e') $$,
  '42501', null, 'direct insert is not allowed');

-- Rotation returns a fresh secret once.
select isnt(rotate_signing_secret((select id from d2)), (select signing_secret from d2), 'rotate returns a new secret');

-- Another user sees nothing and cannot rotate.
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select is((select count(*) from destinations), 0::bigint, 'other user sees no destinations');
select throws_ok(format('select rotate_signing_secret(%L)', (select id from d2)), 'P0001', 'Destination not found.', 'other user cannot rotate');

select * from finish();
rollback;

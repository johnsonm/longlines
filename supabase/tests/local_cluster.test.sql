-- pgTAP: Local DX cluster destinations (20261028000500): the type and its knobs, relay presence,
-- the settings and their validation, the editor's RPCs, rendering (the mode word, the comment, the
-- spot event's values and the preview line, pinned to the contract's examples and to every line of
-- the DXSpider capture), the claim (only while the relay is connected, the per-relay cap, age-out),
-- the loop guard, duplicate, the management API's JSON, health left alone, and access.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(89);

delete from deliveries;
select pgmq.purge_queue('spot_events');
select pgmq.purge_queue('deliveries_queue');

create function pg_temp.sha(p_text text) returns text language sql as $$
  select encode(extensions.digest(p_text, 'sha256'), 'hex');
$$;
-- Relays: two of A's with spots:read, one of A's paired by a v1 relay, one of B's.
insert into relay_tokens (id, user_id, token_hash, token_prefix, device_name, client_version, scopes, platform)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', pg_temp.sha('a1'), 'll_relay_a1',
   'SHACK-PC', '0.2.0', array['contacts:write', 'spots:read'], 'windows'),
  ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', pg_temp.sha('a2'), 'll_relay_a2',
   'LAPTOP', '0.2.0', array['contacts:write', 'spots:read'], 'macos'),
  ('aaaaaaaa-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', pg_temp.sha('a3'), 'll_relay_a3',
   'OLD-PC', '0.1.0', array['contacts:write'], null),
  ('bbbbbbbb-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', pg_temp.sha('b1'), 'll_relay_b1',
   'B-SHACK', '0.2.0', array['contacts:write', 'spots:read'], 'linux');

-- A destination's bucket refills from claim_tokens_at; the claim reads the wall clock, so the
-- setup a claim reads is stamped by clock_timestamp() (see deliveries_rpc.test.sql).
create function pg_temp.fill_buckets() returns void language sql as $$
  update destinations set claim_tokens = 0, claim_tokens_at = clock_timestamp() - interval '1 minute',
                          claim_due_at = '-infinity';
$$;
create function pg_temp.fresh() returns void language sql as $$
  update deliveries set created_at = clock_timestamp() where status = 'pending';
$$;
create function pg_temp.spot(p_id text, p_extra jsonb) returns bigint language sql as $$
  select (ingest_spots(jsonb_build_array(jsonb_build_object(
    'source', 'pota', 'source_spot_id', p_id, 'content_hash', 'h', 'spot_time', now(), 'callsign', 'K4ABC',
    'spotter', 'W4DOG', 'frequency_khz', 14062, 'band', '20m', 'mode', 'cw', 'mode_family', 'cw', 'comment', '',
    'pota_reference', 'K-0039', 'raw_payload', '{}'::jsonb) || p_extra))).id;
$$;

-- ---------------------------------------------------------------------------
-- The type and its knobs
-- ---------------------------------------------------------------------------
select results_eq($$ select rate_per_minute, burst from destination_budget('local_cluster') $$,
  $$ values (120::numeric, 120::numeric) $$, 'local_cluster budget: 120 spots a minute');
select is(destination_max_age('local_cluster'), interval '2 minutes', 'local_cluster rows age out after 2 minutes');
select is(array[destination_claim_interval('local_cluster')::text, destination_claim_max('local_cluster')::text,
                destination_batch_full('local_cluster')::text],
  array['00:00:00', null, null], 'no claim interval, per-claim cap or batch hold');
select is(local_cluster_relay_cap(), 120, 'a relay gets at most 120 spots a minute');
select is(local_cluster_fields(), array['reference', 'source', 'comment'], 'the comment''s fields, in the editor''s order');
select is(local_cluster_default_settings(), '{"fields": ["reference"]}'::jsonb, 'a new destination puts the reference in');
select is(destination_url_display('local_cluster', null), 'Long Lines Relay', 'its display in place of a URL');
select throws_ok($$ insert into destinations (user_id, type, name, url, url_display)
                    values ('11111111-1111-1111-1111-111111111111', 'local_cluster', 'x', 'https://a.example', 'x') $$,
  '23514', null, 'a Local DX cluster has no URL');
select throws_ok($$ select validate_destination_url('local_cluster', 'https://a.example') $$,
  'A Local DX cluster doesn''t use a URL.');
select lives_ok($$ select validate_destination_url('local_cluster', null) $$, 'and needs none');

-- ---------------------------------------------------------------------------
-- Relay presence (the sender)
-- ---------------------------------------------------------------------------
select is(set_cluster_stream('aaaaaaaa-0000-0000-0000-000000000001', true), true, 'a relay with spots:read connects');
select ok((select cluster_connected_at is not null from relay_tokens where id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'its stream time is set');
select is(set_cluster_stream('aaaaaaaa-0000-0000-0000-000000000003', true), false,
  'a v1 relay without spots:read cannot connect');
select is(set_cluster_stream(gen_random_uuid(), true), false, 'an unknown relay is not connected');
select is(set_cluster_stream('aaaaaaaa-0000-0000-0000-000000000001', false), true, 'a relay disconnects');
select ok((select cluster_connected_at is null from relay_tokens where id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'its stream time is cleared');
select set_cluster_stream('aaaaaaaa-0000-0000-0000-000000000001', true);
select set_cluster_stream('bbbbbbbb-0000-0000-0000-000000000001', true);
select is(reset_cluster_streams(), 2, 'a sender start marks every connected relay offline');
select is((select count(*) from relay_tokens where cluster_connected_at is not null), 0::bigint, 'none stays connected');
select throws_ok($$ select set_cluster_stream(null, true) $$, '22023', null, 'presence needs a token');

-- ---------------------------------------------------------------------------
-- Rendering
-- ---------------------------------------------------------------------------
select is(array[local_cluster_mode_word('cw', 14062), local_cluster_mode_word('usb', 7100), local_cluster_mode_word('lsb', 14200),
                local_cluster_mode_word('ssb', 7185.5), local_cluster_mode_word('ssb', 5357), local_cluster_mode_word('ssb', 14285),
                local_cluster_mode_word('ssb', 3999.9), local_cluster_mode_word('ft8', 14074), local_cluster_mode_word('ft4', 14080),
                local_cluster_mode_word('rtty', 14085), local_cluster_mode_word('psk', 14070), local_cluster_mode_word('psk31', 14070),
                local_cluster_mode_word('js8', 14078), local_cluster_mode_word('data', 14100)],
  array['CW', 'USB', 'LSB', 'LSB', 'USB', 'USB', 'LSB', 'FT8', 'FT4', 'RTTY', 'PSK31', 'PSK31', 'JS8', 'DATA'],
  'the mode word: N1MM''s words, SSB''s sideband by frequency (USB on 60 m)');
select is(local_cluster_mode_word(null, 14062), null, 'no mode, no mode word');
select is(local_cluster_mode_word('', 14062), null, 'an empty mode is none');

select is(array[local_cluster_reference('{"pota_reference": "K-0039"}'),
                local_cluster_reference('{"sota_summit_ref": "W4C/CM-001"}'),
                local_cluster_reference('{"wwff_reference": "KFF-1234"}'),
                local_cluster_reference('{"wwbota_references": ["B/G-1042", "B/G-2001"]}'),
                local_cluster_reference('{"iota_reference": "NA-107"}')],
  array['POTA K-0039', 'SOTA W4C/CM-001', 'WWFF KFF-1234', 'WWBOTA B/G-1042, B/G-2001', 'IOTA NA-107'],
  'the reference, program first; every bunker');
select is(local_cluster_reference('{"pota_reference": null}'), null, 'no reference');

select is(local_cluster_comment(array['reference', 'source', 'comment'],
  '{"mode": "cw", "frequency_khz": 14062, "source": "pota", "pota_reference": "K-0039", "comment": "x"}'),
  'CW POTA K-0039 POTA x', 'mode word, then the fields in order');
select is(local_cluster_comment(array['comment', 'reference'],
  '{"mode": null, "frequency_khz": 14062, "pota_reference": "K-0039", "comment": " \t qrt  soon\n"}'),
  'qrt soon POTA K-0039', 'no mode word without a mode; the spotter''s comment trimmed, whitespace made one space');
select is(local_cluster_comment(array['comment'],
  '{"mode": "cw", "frequency_khz": 14062, "comment": "café ñandú  ok"}'),
  'CW caf? ?and? ok', 'non-ASCII becomes ?');
select is(local_cluster_comment(array['comment'],
  '{"mode": "cw", "frequency_khz": 14062, "comment": "abcdefghijklmnopqrstuvwxyz 12"}'),
  'CW abcdefghijklmnopqrstuvwxyz', 'cut to 30 characters and trimmed of the trailing space');
select is(local_cluster_comment(array[]::text[], '{"mode": null, "frequency_khz": 14062}'), '', 'no mode and no fields');

select is((local_cluster_spot_fields(
  (null, null, array['reference'])::local_cluster_destination_settings,
  jsonb_build_object('source', 'wwbota', 'spot_time', '2026-10-28T21:14:07Z', 'callsign', ' é/K4 ', 'spotter', null,
                     'frequency_khz', 14062.06, 'mode', 'ssb', 'wwbota_references', jsonb_build_array('B/G-1042')))),
  jsonb_build_object('cluster_spotter', 'LONGLINES', 'cluster_frequency_khz', 14062.1, 'cluster_callsign', '?/K4',
                     'cluster_comment', 'USB WWBOTA B/G-1042', 'cluster_time', '2114', 'cluster_mode', 'USB',
                     'cluster_reference', 'WWBOTA B/G-1042', 'cluster_source', 'wwbota',
                     'cluster_source_label', 'WWBOTA'),
  'the spot event''s values: LONGLINES for no spotter, one decimal, HHMM, a cleaned callsign');

-- The contract's example lines (10.3), rendered from spots.
create temp table examples (n int, spotter text, khz numeric, callsign text, fields text[], spot jsonb, line text);
insert into examples values
  (1, 'W4DOG', 14062, 'K4ABC', array['reference'], '{"mode": "cw", "pota_reference": "K-0039", "spot_time": "2026-10-28T21:14:07Z"}',
   'DX de W4DOG:     14062.0  K4ABC        CW POTA K-0039                 2114Z'),
  (2, 'KK4PWJ', 7185.5, 'W1AW', array['reference', 'source'],
   '{"mode": "ssb", "sota_summit_ref": "W4C/CM-001", "source": "sotawatch", "spot_time": "2026-10-28T21:10:00Z"}',
   'DX de KK4PWJ:     7185.5  W1AW         LSB SOTA W4C/CM-001 SOTAwatch  2110Z'),
  (3, 'W3LPL-#', 3530, 'G4ABC', array['source'], '{"mode": "cw", "source": "rbn", "spot_time": "2026-10-28T21:20:00Z"}',
   'DX de W3LPL-#:    3530.0  G4ABC        CW RBN                         2120Z'),
  (4, 'N4AB', 14062, 'K4ABC', array['reference', 'comment'],
   '{"mode": "cw", "pota_reference": "K-0039", "comment": "Shining Rock Wilderness", "spot_time": "2026-10-28T21:14:00Z"}',
   'DX de N4AB:      14062.0  K4ABC        CW POTA K-0039 Shining Rock Wi 2114Z'),
  (5, null, 7032.5, 'W9XYZ', array['reference'], '{"mode": "cw", "pota_reference": "K-4571", "spot_time": "2026-10-28T21:11:00Z"}',
   'DX de LONGLINES:  7032.5  W9XYZ        CW POTA K-4571                 2111Z'),
  (7, 'KK4PWJ', 14285, 'VP2E/KK4PWJ/M', array[]::text[], '{"mode": "ssb", "spot_time": "2026-10-28T21:20:00Z"}',
   'DX de KK4PWJ:    14285.0  VP2E/KK4PWJ/M USB                            2120Z'),
  (8, 'UR2680YL', 1296200, 'G4ABC', array[]::text[], '{"mode": "cw", "spot_time": "2026-10-28T21:20:00Z"}',
   'DX de UR2680YL: 1296200.0  G4ABC        CW                             2120Z');
select is_empty($$
  select e.n from examples e
  cross join lateral (select local_cluster_spot_fields((null, null, e.fields)::local_cluster_destination_settings,
    e.spot || jsonb_build_object('spotter', e.spotter, 'frequency_khz', e.khz, 'callsign', e.callsign)) as f) x
  where local_cluster_line(x.f ->> 'cluster_spotter', (x.f ->> 'cluster_frequency_khz')::numeric,
                           x.f ->> 'cluster_callsign', x.f ->> 'cluster_comment', x.f ->> 'cluster_time') <> e.line $$,
  'every Long Lines example line of the contract (10.3) renders byte for byte');
select is(local_cluster_line('KK4PWJ', 14050, 'LLTEST', 'CW Long Lines Relay test spot', '2102'),
  'DX de KK4PWJ:    14050.0  LLTEST       CW Long Lines Relay test spot  2102Z', 'and the relay''s test spot');

-- Every DX line of the DXSpider capture (supabase/functions/_shared/__tests__/fixtures/
-- dxcluster-telnet.txt, BELs dropped), split into its parts and laid out again.
create temp table capture (line text);
insert into capture values
  ('DX de HA7UL:      7146.0  HA7UL/P      CROTA HU-BCS-003               1316Z'),
  ('DX de F5PMW:     14238.0  KC1TLT                                      1316Z'),
  ('DX de AC3RA:      7040.5  WB4HRL                                      1316Z'),
  ('DX de M8NAQ:      7180.0  M7VDP        B/G-1042 ROC Group HQ No 12 -  1316Z'),
  ('DX de YB1LVL:    28074.0  F4HKP        FT8 -19dB from JN18 1524Hz     1316Z'),
  ('DX de EA7LMB:    21325.0  FM5BH        CQ DX                          1316Z'),
  ('DX de KC4JNS:    14228.0  K5CB         TX POTA 4371                   1317Z'),
  ('DX de EU4ABI:    21233.0  EA5H         cq 15 tnx 4 qso 73             1317Z'),
  ('DX de PD1JN:     14296.0  LY0AM        tnx 73                         1317Z'),
  ('DX de YB1LVL:    28074.0  IZ4TSV       FT8 -18dB from JN54 1933Hz     1317Z'),
  ('DX de UR2680YL:  14095.6  EA6AJ        WSPR sign -26                  1317Z'),
  ('DX de F5FRM:     21285.0  YC0SJA       CQ                             1318Z'),
  ('DX de UR2680YL:  14095.6  UR2680YL     SWL DigiClub University        1318Z'),
  ('DX de KB8OTK:    14075.2  VP2MAW                                      1318Z'),
  ('DX de F5PMW:     21325.0  FM5BH        IOTA NA 107                    1318Z'),
  ('DX de EA1FIC:    14305.0  SV8/DJ0MY    SSB [POTA] GR-0131 cq cq       1318Z'),
  ('DX de KC4JNS:    14225.0  KI4QVM       POTA US-0542                   1318Z'),
  ('DX de N0YO:      24915.8  F6HST                                       1319Z'),
  ('DX de EA2DSI:     7140.0  AM5GC        Dia de la Hispanidad y Diploma 1319Z'),
  ('DX de EA4HAG:     7060.0  EA1FIX       QSL ESPECIAL VIRGEN DEL PILAR  1319Z'),
  ('DX de DK2EA:     50313.0  EA5QE        JO50UF<>IM98PB 1004Hz CQ -8    1319Z'),
  ('DX de AC3RA:      7031.5  K1EBY                                       1319Z'),
  ('DX de IT9IAU:    18100.0  N1AQ         73 from Gabriele - FT8         1319Z');
select is((select count(*) from capture), 23::bigint, 'the capture''s 23 DX lines');
select is_empty($$
  select c.line from capture c
  cross join lateral (select regexp_match(c.line, '^DX de (\S+):\s+(\S+)  (.{12}) (.{30}) (\d{4})Z$') as m) p
  where p.m is null
     or local_cluster_line(p.m[1], p.m[2]::numeric, rtrim(p.m[3]), p.m[4], p.m[5]) <> c.line $$,
  'every capture line comes out byte for byte when parsed into its parts and laid out again');

-- ---------------------------------------------------------------------------
-- The editor's RPCs
-- ---------------------------------------------------------------------------
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select throws_ok($$ select save_local_cluster_destination(null, 'Shack', null, null) $$, 'Pick a relay.');
select throws_ok($$ select save_local_cluster_destination(null, 'Shack', null,
                      '{"relay_id": "bbbbbbbb-0000-0000-0000-000000000001"}') $$,
  'Relay not found.', 'another user''s relay cannot be picked');
select throws_ok($$ select save_local_cluster_destination(null, 'Shack', null, '{"relay_id": "nope"}') $$,
  'Relay not found.');
select throws_ok($$ select save_local_cluster_destination(null, 'Shack', null,
                      '{"relay_id": "aaaaaaaa-0000-0000-0000-000000000001", "fields": ["mode"]}') $$,
  'Unknown field mode.');
select throws_ok($$ select save_local_cluster_destination(null, 'Shack', null,
                      '{"relay_id": "aaaaaaaa-0000-0000-0000-000000000001", "fields": ["source", "source"]}') $$,
  'Pick each field once.');
select throws_ok($$ select save_local_cluster_destination(null, 'Shack', null,
                      '{"relay_id": "aaaaaaaa-0000-0000-0000-000000000001", "fields": "reference"}') $$,
  'Fields must be a list of field names.');
select throws_ok($$ select save_local_cluster_destination(null, 'Shack', null, '{"color": "red"}') $$,
  'Unknown setting color.');
select throws_ok($$ select save_local_cluster_destination(null, ' ', null, null) $$, 'Give the destination a name.');
select throws_ok($$ select * from create_destination('local_cluster', 'Shack', null) $$,
  'Add a Local DX cluster destination in the web app.', 'create_destination (and so the API) never makes one');
create temp table lc as
select save_local_cluster_destination(null, 'Shack', null, '{"relay_id": "aaaaaaaa-0000-0000-0000-000000000001"}') as id;
grant select on lc to public;
reset role;
select is((select type || ' ' || url_display || ' ' || enabled::text || ' ' || coalesce(url, 'no url')
           from destinations where id = (select id from lc)),
  'local_cluster Long Lines Relay true no url', 'a new destination: no URL, on');
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is(get_local_cluster_destination((select id from lc)),
  jsonb_build_object('id', (select id from lc), 'name', 'Shack', 'enabled', true, 'url_display', 'Long Lines Relay',
                     'settings', jsonb_build_object('relay_id', 'aaaaaaaa-0000-0000-0000-000000000001',
                                                    'fields', jsonb_build_array('reference'))),
  'the editor reads its relay and the default fields');
select throws_ok($$ select save_local_cluster_destination(null, 'shack', null,
                      '{"relay_id": "aaaaaaaa-0000-0000-0000-000000000001"}') $$,
  'A destination named shack already exists. Choose a different name.');
select is(save_local_cluster_destination((select id from lc), null, null, '{"fields": ["comment", "reference"]}'),
  (select id from lc), 'a save returns the id');
select is(get_local_cluster_destination((select id from lc)) -> 'settings',
  '{"relay_id": "aaaaaaaa-0000-0000-0000-000000000001", "fields": ["comment", "reference"]}'::jsonb,
  'settings merge key by key: the relay stays, the fields change in their order');
select save_local_cluster_destination((select id from lc), 'Shack PC', false, null);
select is((select name || ' ' || enabled::text from destinations where id = (select id from lc)), 'Shack PC false',
  'null settings keep them; name and enabled change');
select save_local_cluster_destination((select id from lc), null, true, '{"fields": ["reference"]}');
reset role;
select throws_ok($$ select update_destination((select id from lc), null, 'https://a.example', null) $$,
  'A Local DX cluster doesn''t use a URL.', 'update_destination (and so the API) refuses a URL');
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is(list_local_cluster_destination_settings(),
  jsonb_build_array(jsonb_build_object('destination_id', (select id from lc),
    'relay_id', 'aaaaaaaa-0000-0000-0000-000000000001', 'device_name', 'SHACK-PC', 'platform', 'windows',
    'cluster_connected_at', null, 'fields', jsonb_build_array('reference'))),
  'the list cards'' relay, platform and presence');
select is(preview_local_cluster_line(null, null),
  '{"line": "DX de W4DOG:     14062.0  K4ABC        CW POTA K-0039                 2114Z", "spotter": "W4DOG",
    "frequency_khz": 14062.0, "callsign": "K4ABC", "comment": "CW POTA K-0039", "time_utc": "2114"}'::jsonb,
  'the preview of the defaults is the editor''s sample line');
select is(preview_local_cluster_line('{"fields": ["reference", "comment"], "relay_id": null}', null) ->> 'line',
  'DX de W4DOG:     14062.0  K4ABC        CW POTA K-0039 Shining Rock Wi 2114Z', 'the preview follows the fields');
select throws_ok($$ select preview_local_cluster_line('{"fields": ["band"]}', null) $$, 'Unknown field band.');
select throws_ok($$ select preview_local_cluster_line(null, -1) $$, 'Spot not found.');
reset role;
create temp table preview_spot as select pg_temp.spot('preview', '{"spotter": "N4AB", "comment": "QRT 10 min"}') as id;
grant select on preview_spot to public;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is(preview_local_cluster_line('{"fields": ["comment"]}', (select id from preview_spot)) ->> 'comment',
  'CW QRT 10 min', 'the preview renders a chosen spot');
reset role;
update raw_spots set retracted_at = now() where id = (select id from preview_spot);
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select throws_ok($$ select preview_local_cluster_line(null, (select id from preview_spot)) $$, 'Spot not found.',
  'a retracted spot is not previewed');
reset role;

-- ---------------------------------------------------------------------------
-- Duplicate and the management API
-- ---------------------------------------------------------------------------
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table lc_copy as select duplicate_destination((select id from lc)) as id;
reset role;
select is((select type || ' ' || name || ' ' || enabled::text from destinations where id = (select id from lc_copy)),
  'local_cluster Copy of Shack PC false', 'a copy starts off');
select is((select relay_token_id::text || ' ' || fields::text from local_cluster_destination_settings
           where destination_id = (select id from lc_copy)),
  'aaaaaaaa-0000-0000-0000-000000000001 {reference}', 'with the same relay and fields');
select is(api_destination_json((select d from destinations d where id = (select id from lc))) -> 'local_cluster',
  '{"relay_id": "aaaaaaaa-0000-0000-0000-000000000001", "relay_name": "SHACK-PC", "fields": ["reference"]}'::jsonb,
  'the API shows the relay and fields');
delete from destinations where id = (select id from lc_copy);

-- ---------------------------------------------------------------------------
-- The claim
-- ---------------------------------------------------------------------------
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table conn as
select save_subscription(jsonb_build_object('name', 'POTA states', 'quiet_minutes', 0,
                                            'destinations', array[(select id from lc)])) as id;
reset role;

select pgmq.purge_queue('spot_events');
select pg_temp.spot('c1', '{}');
select is(match_pending_spots(), 1, 'a matching spot makes a delivery while the relay is offline');
select pg_temp.fresh();
select pg_temp.fill_buckets();
select is((select count(*) from claim_deliveries(200, 60)), 0::bigint, 'nothing is claimed while the relay is offline');
select is(health_oldest_ready_seconds(clock_timestamp()), null, 'and the health page sees nothing ready');
select set_cluster_stream('aaaaaaaa-0000-0000-0000-000000000001', true);
create temp table claimed as select * from claim_deliveries(200, 60);
select is((select count(*) from claimed), 1::bigint, 'it is claimed once the relay connects');
select is((select destination -> 'local_cluster' from claimed),
  '{"relay_id": "aaaaaaaa-0000-0000-0000-000000000001", "device_name": "SHACK-PC"}'::jsonb,
  'the destination names its relay');
select is((select destination ->> 'url' from claimed), null, 'and has no URL');
select is((select jsonb_build_object('spotter', spot ->> 'cluster_spotter', 'khz', spot -> 'cluster_frequency_khz',
                                     'call', spot ->> 'cluster_callsign', 'comment', spot ->> 'cluster_comment',
                                     'mode', spot ->> 'cluster_mode', 'reference', spot ->> 'cluster_reference',
                                     'source', spot ->> 'cluster_source', 'label', spot ->> 'cluster_source_label',
                                     'connection', spot ->> 'cluster_connection')
           from claimed),
  '{"spotter": "W4DOG", "khz": 14062.0, "call": "K4ABC", "comment": "CW POTA K-0039", "mode": "CW",
    "reference": "POTA K-0039", "source": "pota", "label": "POTA", "connection": "POTA states"}'::jsonb,
  'the spot carries the finished cluster values and the connection''s name');
select ok((select spot ->> 'cluster_time' ~ '^[0-2][0-9][0-5][0-9]$' from claimed), 'cluster_time is HHMM');
select mark_deliveries_sent(array(select delivery_id from claimed), array(select msg_id from claimed));
select is((select status from deliveries where id = (select delivery_id from claimed)), 'sent', 'the ack marks it sent');

-- Age-out: a row that waited past 2 minutes is dropped, and the destination's health is not touched.
select set_cluster_stream('aaaaaaaa-0000-0000-0000-000000000001', false);
select pg_temp.spot('c2', '{}');
select match_pending_spots();
update deliveries set created_at = clock_timestamp() - interval '3 minutes' where status = 'pending';
select set_cluster_stream('aaaaaaaa-0000-0000-0000-000000000001', true);
select pg_temp.fill_buckets();
select is((select count(*) from claim_deliveries(200, 60)), 0::bigint, 'a row older than 2 minutes is not claimed');
select is((select status || ' ' || (dropped_at is not null)::text from deliveries d
           join raw_spots r on r.id = d.spot_id where r.source_spot_id = 'c2'),
  'dropped true', 'the expiry sweep drops it as lost');
select is((select health || ' ' || consecutive_failures || ' ' || coalesce(auto_disabled_at::text, 'on')
           from destinations where id = (select id from lc)),
  'ok 0 on', 'a relay offline is never a failure: health, failures and the pause stay as they were');

-- The relay cap: a second destination on the same relay already had 119 sent this minute.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table lc2 as
select save_local_cluster_destination(null, 'Second', null, '{"relay_id": "aaaaaaaa-0000-0000-0000-000000000001"}') as id;
grant select on lc2 to public;
reset role;
insert into subscription_destinations (subscription_id, destination_id) values ((select id from conn), (select id from lc2));
delete from deliveries where destination_id = (select id from lc);
insert into deliveries (subscription_id, destination_id, spot_id, status, sent_at)
select (select id from conn), (select id from lc2), pg_temp.spot('sent' || i, '{}'), 'sent', clock_timestamp()
from generate_series(1, 119) i;
select pgmq.purge_queue('spot_events');
select pg_temp.spot('cap1', jsonb_build_object('spot_time', now() - interval '30 seconds', 'callsign', 'N0OLD'));
select pg_temp.spot('cap2', jsonb_build_object('spot_time', now(), 'callsign', 'N0NEW'));
select is(match_pending_spots(), 4, 'two spots for each of the two destinations');
select pg_temp.fresh();
select pg_temp.fill_buckets();
create temp table capped as select * from claim_deliveries(200, 60);
select is((select array_agg(spot ->> 'callsign') from capped), array['N0NEW'],
  'the relay gets only what the cap leaves this minute: one spot, the newest, across its destinations');
select is((select count(*) from pgmq.q_deliveries_queue where vt <= clock_timestamp()), 3::bigint,
  'the rest stay queued (to age out)');
update deliveries set sent_at = clock_timestamp() - interval '2 minutes' where status = 'sent';
select is((select count(*) from claim_deliveries(200, 60)), 3::bigint, 'a minute later the relay has room again');

-- ---------------------------------------------------------------------------
-- The loop guard
-- ---------------------------------------------------------------------------
select pgmq.purge_queue('deliveries_queue');
delete from deliveries;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table wa as select * from create_destination('webhook', 'Hook', 'https://hooks.example.com/a');
create temp table conn_logged as
select save_subscription(jsonb_build_object('name', 'Logged', 'quiet_minutes', 0, 'sources', array['logged'],
                                            'destinations', array[(select id from lc), (select id from wa)])) as id;
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
create temp table lcb as
select save_local_cluster_destination(null, 'B shack', null, '{"relay_id": "bbbbbbbb-0000-0000-0000-000000000001"}') as id;
select save_subscription(jsonb_build_object('name', 'Logged', 'quiet_minutes', 0, 'sources', array['logged'],
                                            'destinations', array[(select id from lcb)]));
reset role;
select pgmq.purge_queue('spot_events');
select apply_logged_contacts('11111111-1111-1111-1111-111111111111', jsonb_build_array(jsonb_build_object(
  'op', 'upsert', 'external_id', 'loop-1', 'logger_app', 'N1MM', 'relay_version', '0.2.0',
  'spot', jsonb_build_object(
    'source', 'logged', 'source_spot_id', '11111111-1111-1111-1111-111111111111|loop-1', 'content_hash', 'loop',
    'spot_time', now(), 'callsign', 'W1AW', 'spotter', 'KK4PWJ', 'frequency_khz', 14025, 'band', '20m',
    'mode', 'cw', 'mode_family', 'cw', 'comment', '', 'raw_payload', '{}'::jsonb))));
select is(match_pending_spots(), 2, 'a logged contact matches two connections');
select is((select array_agg(dest.name order by dest.name) from deliveries d join destinations dest on dest.id = d.destination_id),
  array['B shack', 'Hook'],
  'the user''s own contact goes to their webhook and to another user''s cluster, never back to their own cluster');

-- A spot without a frequency never goes to a cluster.
select pg_temp.spot('nofreq', '{"frequency_khz": 0}');
select is(match_pending_spots(), 0, 'a spot without a frequency is not sent to a cluster');

-- ---------------------------------------------------------------------------
-- Revoking the relay, and access
-- ---------------------------------------------------------------------------
delete from relay_tokens where id = 'aaaaaaaa-0000-0000-0000-000000000002';
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
delete from relay_tokens where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select is(get_local_cluster_destination((select id from lc)) -> 'settings' ->> 'relay_id', null,
  'revoking the relay leaves the destination without one');
select throws_ok($$ select save_local_cluster_destination((select id from lc), null, null, '{"fields": []}') $$,
  'Pick a relay.', 'until another relay is picked');
select is((select count(*) from relay_tokens where id = 'aaaaaaaa-0000-0000-0000-000000000003'), 1::bigint,
  'users still read their relays');
select is((select array[platform, cluster_connected_at::text] from relay_tokens
           where id = 'aaaaaaaa-0000-0000-0000-000000000003'), array[null, null]::text[],
  'with platform and presence in the column grant');
select throws_ok($$ select * from local_cluster_destination_settings $$, '42501', null,
  'clients cannot read the settings table');
select throws_ok($$ select set_cluster_stream('aaaaaaaa-0000-0000-0000-000000000003', true) $$, '42501', null,
  'clients cannot set presence');
select throws_ok($$ select reset_cluster_streams() $$, '42501', null, 'or reset it');
select throws_ok($$ select relay_account(auth.uid(), 'aaaaaaaa-0000-0000-0000-000000000003') $$, '42501', null,
  'or read the v2 account');
reset role;
select ok(has_function_privilege('authenticated', 'public.save_local_cluster_destination(uuid, text, boolean, jsonb)', 'execute')
          and has_function_privilege('authenticated', 'public.get_local_cluster_destination(uuid)', 'execute')
          and has_function_privilege('authenticated', 'public.list_local_cluster_destination_settings()', 'execute')
          and has_function_privilege('authenticated', 'public.preview_local_cluster_line(jsonb, bigint)', 'execute')
          and not has_function_privilege('authenticated', 'public.local_cluster_spot_fields(local_cluster_destination_settings, jsonb)', 'execute'),
  'clients may call the four editor RPCs and nothing else here');
select ok(has_function_privilege('delivery_sender', 'public.authenticate_relay_token(text)', 'execute')
          and has_function_privilege('delivery_sender', 'public.set_cluster_stream(uuid, boolean)', 'execute')
          and has_function_privilege('delivery_sender', 'public.reset_cluster_streams()', 'execute'),
  'the sender may authenticate relays and set their presence');

select * from finish();
rollback;

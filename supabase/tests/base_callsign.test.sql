-- pgTAP: base callsigns (20261012000010, 20261012000040). The rule, the generated raw_spots
-- column, its index and the RBN watchlist that shares the matcher's rules.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(27);

-- The spec's examples.
select is(base_callsign('KK4PWJ/P'), 'KK4PWJ', 'a /P suffix is dropped');
select is(base_callsign('KK4PWJ/QRP'), 'KK4PWJ', 'a /QRP suffix is dropped');
select is(base_callsign('W4/G4OBK'), 'G4OBK', 'a US call-area prefix is dropped');
select is(base_callsign('VE3/KK4PWJ'), 'KK4PWJ', 'a foreign prefix is dropped');

-- Every known suffix and a single digit.
select is(base_callsign('KK4PWJ/M'), 'KK4PWJ', '/M is dropped');
select is(base_callsign('KK4PWJ/MM'), 'KK4PWJ', '/MM is dropped');
select is(base_callsign('KK4PWJ/AM'), 'KK4PWJ', '/AM is dropped');
select is(base_callsign('KK4PWJ/R'), 'KK4PWJ', '/R is dropped');
select is(base_callsign('KD9XYZ/4'), 'KD9XYZ', 'a single call-area digit is dropped');
select is(base_callsign('EA8/G4OBK/QRP'), 'G4OBK', 'prefix and suffix together');
select is(base_callsign('K1A/QRPP'), 'K1A', '/QRPP is dropped, though longer than the call');
select is(base_callsign('EA1FIC-2'), 'EA1FIC', 'an SSID is dropped');
select is(base_callsign('dk9ip-#'), 'DK9IP', 'a skimmer marker is dropped');

-- Normalisation and ties.
select is(base_callsign('  kk4pwj/p '), 'KK4PWJ', 'input is trimmed and uppercased');
select is(base_callsign('G4OBK'), 'G4OBK', 'a plain call is its own base');
select is(base_callsign('VP2V/W1AW'), 'W1AW', 'equal lengths, both callsign-shaped: the later part');
select is(base_callsign('KH6/K1A'), 'K1A', 'a three-character call after a three-character prefix');
select is(base_callsign('W1AW/ABCD'), 'W1AW', 'a length tie goes to the part with a digit after a letter');
select is(base_callsign('ABCD/W1AW'), 'W1AW', 'the callsign-shaped part wins a tie in either position');
select is(base_callsign('P'), 'P', 'nothing left after dropping suffixes: the input itself');
select ok(base_callsign(null) is null, 'null stays null');

-- The generated column and the self-spot rule that uses the function.
insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, frequency_khz, comment, raw_payload)
values ('pota', 'bc1', 'bc1', now(), 'VE3/KK4PWJ/P', 14062, '', '{}');
select is((select base_callsign from raw_spots where source_spot_id = 'bc1'), 'KK4PWJ',
  'raw_spots.base_callsign is generated from callsign');
select ok(is_self_spot('VE3/KK4PWJ', 'KK4PWJ/QRP'), 'is_self_spot follows the new suffix rules');
select has_index('public', 'raw_spots', 'raw_spots_base_callsign_time_idx', 'raw_spots has the base callsign index');

-- The RBN watchlist: exact or base, enabled subscriptions accepting the source.
insert into subscriptions (id, user_id, name, enabled, sources, bands, modes, callsigns, reference, quiet_minutes)
values (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 'base', true, '{rbn}', '{}', '{}', '{KK4PWJ}', '', 0),
       (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 'exact', true, '{}', '{}', '{}', '{W1AW/P}', '', 0),
       (gen_random_uuid(), '11111111-1111-1111-1111-111111111111', 'off', false, '{rbn}', '{}', '{}', '{K9OFF}', '', 0);
select is(array(select watched_among('rbn', array['KK4PWJ/P', 'W4/KK4PWJ', 'W1AW', 'W1AW/P', 'K9OFF', 'N0NE'])),
  array['KK4PWJ/P', 'W1AW/P', 'W4/KK4PWJ'],
  'watched_among: base-call matches, exact /P only, disabled subscriptions ignored');
select is(array(select watched_among('pota', array['KK4PWJ/P', 'W1AW/P'])), array['W1AW/P'],
  'watched_among follows each subscription''s sources');
select ok(not has_function_privilege('authenticated', 'public.watched_among(text, text[])', 'execute')
          and not has_function_privilege('anon', 'public.watched_among(text, text[])', 'execute')
          and not has_function_privilege('authenticated', 'public.callsign_matches(text[], text, text)', 'execute')
          and not has_function_privilege('authenticated', 'public.source_matches(text[], text)', 'execute'),
  'clients cannot call watched_among or the shared match rules');

select * from finish();
rollback;

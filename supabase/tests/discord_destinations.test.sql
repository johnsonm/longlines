-- pgTAP: Discord destinations as canvas page 8 draws them
-- (20261018000100_discord_destinations). Settings with a defaults trigger,
-- the save/get/list/preview RPCs, the message rendered in SQL from picked
-- fields, what claim_deliveries and Send test hand out, duplicate and the
-- management API's read-only view. The batch hold is in deliveries_rpc.test.sql.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(153);
select pgmq.purge_queue('spot_events');
select pgmq.purge_queue('deliveries_queue');
delete from deliveries;
delete from raw_spots;

-- The defaults as a stored row shows them; clients cannot call the helper.
create temp table defaults as select discord_default_settings() as j;
grant select on defaults to authenticated;
\set url1 '''https://discord.com/api/webhooks/1182334455/xY9abcTOKEN'''
\set url2 '''https://discord.com/api/webhooks/2/b'''

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '';
select throws_ok($$ select save_discord_destination(null, 'x', true, 'https://discord.com/api/webhooks/1/a', null) $$,
  'P0001', 'Not signed in.', 'save needs a session');
select throws_ok(format('select get_discord_destination(%L)', gen_random_uuid()), 'P0001', 'Not signed in.', 'get needs a session');
select throws_ok($$ select list_discord_destination_settings() $$, 'P0001', 'Not signed in.', 'list needs a session');
select throws_ok($$ select preview_discord_message(null) $$, 'P0001', 'Not signed in.', 'preview needs a session');

-- ---------------------------------------------------------------------------
-- Create, the trigger and the backfill
-- ---------------------------------------------------------------------------
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table club as select save_discord_destination(null, '  Club  ', null, :url1, null) as id;
create temp table quiet as select save_discord_destination(null, 'Quiet', false, :url2, '{"style": "plain"}') as id;
grant all on club, quiet to authenticated;
select results_eq(format($$ select type, name, enabled, url_display from destinations where id = %L $$, (select id from club)),
  $$ values ('discord'::text, 'Club'::text, true, 'https://discord.com/api/webhooks/1182…/xY9'::text) $$,
  'save trims the name, starts enabled and masks the URL');
select is((get_discord_destination((select id from club)) -> 'settings'), (select j from defaults),
  'a new Discord destination gets the default settings');
select results_eq(format($$ select (x ->> 'enabled')::boolean, x #>> '{settings,style}', x #> '{settings,title_fields}'
                            from (select get_discord_destination(%L) as x) t $$, (select id from quiet)),
  $$ values (false, 'plain'::text, '["callsign", "frequency", "mode"]'::jsonb) $$,
  'enabled and the given settings are kept, merged over the defaults');
select throws_ok($$ select save_discord_destination(null, 'Bad', true, 'https://example.com/hook', null) $$,
  'P0001', 'Use a Discord webhook URL.', 'a URL that is not a Discord webhook is refused');
select throws_ok($$ select save_discord_destination(null, 'Bad', true, null, null) $$,
  'P0001', 'Use a Discord webhook URL.', 'a new one needs a URL');
select throws_ok($$ select save_discord_destination(null, 'Bad', true, '  ', null) $$,
  'P0001', 'Use a Discord webhook URL.', 'a blank URL is no URL');
select throws_ok($$ select save_discord_destination(null, 'club', true, 'https://discord.com/api/webhooks/3/c', null) $$,
  'P0001', 'A destination named club already exists. Choose a different name.', 'names are unique per account, ignoring case');
select throws_ok($$ select save_discord_destination(null, '   ', true, 'https://discord.com/api/webhooks/3/c', null) $$,
  'P0001', 'Give the destination a name.', 'a new one needs a name');
select throws_ok($$ select save_discord_destination(null, 'Bad', true, 'https://discord.com/api/webhooks/3/c', '{"style": "embed"}') $$,
  'P0001', 'Pick a message style.', 'bad settings refuse the create');
select is((select count(*) from destinations where name = 'Bad'), 0::bigint, 'and nothing was created');

create temp table raw as select id from create_destination('discord', 'Raw', 'https://discord.com/api/webhooks/4/d');
create temp table phone as select id from create_destination('push', 'Phone', null);
create temp table hook as select id from create_destination('webhook', 'Hook', 'https://example.com/h');
grant all on raw, phone, hook to authenticated;
reset role;
select is((select to_jsonb(s) - 'destination_id' from discord_destination_settings s where s.destination_id = (select id from raw)),
  (select j from defaults), 'create_destination(''discord'', ...) gets the defaults through the trigger');
select is((select count(*) from discord_destination_settings where destination_id in ((select id from phone), (select id from hook))),
  0::bigint, 'push and webhook destinations get no Discord settings');
-- The migration's backfill, repeated: it restores a missing row and adds nothing the second time.
delete from discord_destination_settings where destination_id = (select id from raw);
insert into discord_destination_settings
select (jsonb_populate_record(null::discord_destination_settings,
         discord_default_settings() || jsonb_build_object('destination_id', d.id))).*
from destinations d
where d.type = 'discord' and not exists (select 1 from discord_destination_settings s where s.destination_id = d.id);
insert into discord_destination_settings
select (jsonb_populate_record(null::discord_destination_settings,
         discord_default_settings() || jsonb_build_object('destination_id', d.id))).*
from destinations d
where d.type = 'discord' and not exists (select 1 from discord_destination_settings s where s.destination_id = d.id);
select is((select count(*) from discord_destination_settings where destination_id = (select id from raw)), 1::bigint,
  'the backfill restores a missing row once');
select is((select count(*) from destinations d where d.type = 'discord'
           and not exists (select 1 from discord_destination_settings s where s.destination_id = d.id)), 0::bigint,
  'every Discord destination has settings');

-- ---------------------------------------------------------------------------
-- Update: name, enabled, Replace URL
-- ---------------------------------------------------------------------------
update destinations set health = 'failing', consecutive_failures = 7, last_error = 'HTTP 404', last_error_at = now()
where id = (select id from club);
-- Clients cannot read url or the failure columns; a view owned by the runner can.
create temp view club_row as select * from destinations where id = (select id from club);
grant select on club_row to authenticated;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select save_discord_destination((select id from club), 'Club chat', null, null, null);
select results_eq($$ select name, health, consecutive_failures from club_row $$,
  $$ values ('Club chat'::text, 'failing'::text, 7) $$, 'a rename keeps the health');
select save_discord_destination((select id from club), null, null, :url1, null);
select is((select consecutive_failures from club_row), 7,
  'saving the same URL keeps the failure count');
select save_discord_destination((select id from club), null, null, '', null);
select is((select url from club_row), :url1, 'an empty URL keeps the stored one');
select save_discord_destination((select id from club), null, null, 'https://discord.com/api/webhooks/9876/newTOKEN', null);
select results_eq($$ select url, url_display, health, consecutive_failures, last_error from club_row $$,
  $$ values ('https://discord.com/api/webhooks/9876/newTOKEN'::text, 'https://discord.com/api/webhooks/9876…/new'::text,
             'ok'::text, 0, null::text) $$,
  'a new URL is stored, masked, and clears failing health');
select throws_ok(format('select save_discord_destination(%L, null, null, %L, null)', (select id from club), 'https://example.com/x'),
  'P0001', 'Use a Discord webhook URL.', 'a replacement URL is checked');
select throws_ok(format('select save_discord_destination(%L, %L, null, null, null)', (select id from club), 'raw'),
  'P0001', 'A destination named raw already exists. Choose a different name.', 'renaming onto a taken name fails');
select throws_ok(format('select save_discord_destination(%L, %L, null, null, null)', (select id from club), ' '),
  'P0001', 'Give the destination a name.', 'a blank rename is refused');
select save_discord_destination((select id from club), null, false, null, null);
select save_discord_destination((select id from club), 'Club chat', null, null, null);
select is((select enabled from club_row), false, 'enabled is saved, and a null keeps it');
select save_discord_destination((select id from club), null, true, null, null);
select throws_ok(format('select save_discord_destination(%L, null, null, null, null)', (select id from phone)),
  'P0001', 'Destination not found.', 'a push destination is not saved here');
select throws_ok(format('select save_discord_destination(%L, null, null, null, null)', gen_random_uuid()),
  'P0001', 'Destination not found.', 'an unknown id');
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
select throws_ok(format('select save_discord_destination(%L, %L, null, null, null)', (select id from club), 'Mine'),
  'P0001', 'Destination not found.', 'another account''s destination cannot be saved');
select throws_ok(format('select get_discord_destination(%L)', (select id from club)),
  'P0001', 'Destination not found.', 'or read');
select is((select count(*) from jsonb_array_elements(list_discord_destination_settings()) x
           where x ->> 'destination_id' = (select id::text from club)), 0::bigint, 'or listed');
select lives_ok($$ select save_discord_destination(null, 'Club chat', true, 'https://discord.com/api/webhooks/5/e', null) $$,
  'another account may use the same name');

-- ---------------------------------------------------------------------------
-- Settings: every message, merging
-- ---------------------------------------------------------------------------
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create function pg_temp.save_settings(p jsonb) returns uuid language sql as $$
  select save_discord_destination((select id from club), null, null, null, p);
$$;
select throws_ok($$ select pg_temp.save_settings('{"colour": "red"}') $$, 'P0001', 'Unknown setting colour.', 'an unknown setting');
select throws_ok($$ select pg_temp.save_settings('[]') $$, 'P0001', 'Settings must be an object.', 'settings are an object');
select throws_ok($$ select pg_temp.save_settings('{"title_fields": ["callsign", "comment"]}') $$,
  'P0001', 'Comment is not available here.', 'Comment is refused with its own message');
select throws_ok($$ select pg_temp.save_settings('{"line_fields": ["grid"]}') $$, 'P0001', 'Unknown field grid.', 'an unknown field');
select throws_ok($$ select pg_temp.save_settings('{"title_fields": []}') $$, 'P0001', 'Pick 1 to 4 fields for the title.',
  'the title needs a field');
select throws_ok($$ select pg_temp.save_settings('{"title_fields": ["callsign", "frequency", "band", "mode", "source"]}') $$,
  'P0001', 'Pick 1 to 4 fields for the title.', 'the title takes at most four');
select throws_ok($$ select pg_temp.save_settings('{"detail_fields": ["callsign", "frequency", "band", "mode", "source", "reference", "place_name", "state", "spotter"]}') $$,
  'P0001', 'Pick up to 8 fields for the details.', 'the details take at most eight');
select throws_ok($$ select pg_temp.save_settings('{"grid_fields": ["callsign", "frequency", "band", "mode", "source", "reference", "place_name"]}') $$,
  'P0001', 'Pick up to 6 fields for the grid.', 'the grid takes at most six');
select throws_ok($$ select pg_temp.save_settings('{"line_fields": []}') $$, 'P0001', 'Pick 1 to 8 fields for the message.',
  'the plain line needs a field');
select throws_ok($$ select pg_temp.save_settings('{"line_fields": ["callsign", "frequency", "band", "mode", "source", "reference", "place_name", "state", "spotter"]}') $$,
  'P0001', 'Pick 1 to 8 fields for the message.', 'the plain line takes at most eight');
select throws_ok($$ select pg_temp.save_settings('{"grid_fields": ["band", "band"]}') $$, 'P0001', 'Pick each field once.',
  'a field twice is refused');
select throws_ok($$ select pg_temp.save_settings('{"style": "embed"}') $$, 'P0001', 'Pick a message style.', 'the style');
select throws_ok($$ select pg_temp.save_settings('{"title_link": "home"}') $$, 'P0001', 'Pick what the title links to.', 'the title link');
select throws_ok($$ select pg_temp.save_settings('{"card_color": "pink"}') $$, 'P0001', 'Pick a card color.', 'the card color');
select throws_ok($$ select pg_temp.save_settings('{"link_preview": "maybe"}') $$, 'P0001', 'Pick a link preview.', 'the link preview');
select throws_ok($$ select pg_temp.save_settings('{"separator": "tab"}') $$, 'P0001', 'Pick a separator.', 'the separator');
select throws_ok($$ select pg_temp.save_settings('{"batch_seconds": 45}') $$, 'P0001', 'Pick a batch window.', 'the batch window');
select throws_ok($$ select pg_temp.save_settings('{"footer": null}') $$, 'P0001', 'Turn each switch on or off.', 'a switch cannot be null');
select lives_ok($$ select pg_temp.save_settings('{"detail_fields": [], "grid_fields": []}') $$, 'details and grid may be empty');
select pg_temp.save_settings('{"card_color": "red", "batch_seconds": 30}');
select results_eq(format($$ select s ->> 'card_color', (s ->> 'batch_seconds')::int, s -> 'detail_fields', s -> 'grid_fields', s -> 'title_fields'
                            from (select get_discord_destination(%L) -> 'settings' as s) t $$, (select id from club)),
  $$ values ('red'::text, 30, '[]'::jsonb, '[]'::jsonb, '["callsign", "frequency", "mode"]'::jsonb) $$,
  'a save merges over the stored settings, keeping untouched keys');
select is((select array_agg(k order by k) from jsonb_object_keys(get_discord_destination((select id from club))) k),
  array['enabled', 'id', 'name', 'settings', 'url_display'], 'get returns no URL');
select is((select array_agg(k order by k) from jsonb_object_keys(get_discord_destination((select id from club)) -> 'settings') k),
  array['batch_seconds', 'bold_first', 'card_color', 'detail_fields', 'footer', 'grid_fields', 'line_fields', 'link_preview',
        'separator', 'show_field_names', 'style', 'title_fields', 'title_link'], 'the thirteen settings');
select throws_ok(format('select get_discord_destination(%L)', (select id from phone)), 'P0001', 'Destination not found.',
  'get reads Discord destinations only');
select results_eq(format($$ select x ->> 'style', (x ->> 'field_count')::int
                            from jsonb_array_elements(list_discord_destination_settings()) x
                            where x ->> 'destination_id' in (%L, %L, %L) order by x ->> 'style', (x ->> 'field_count')::int $$,
                         (select id from raw), (select id from quiet), (select id from club)),
  $$ values ('card'::text, 3), ('card', 9), ('plain', 6) $$,
  'the list counts a card''s title, details and grid, and a plain line''s fields');
select is((select array_agg(k order by k) from jsonb_array_elements(list_discord_destination_settings()) x, jsonb_object_keys(x) k
           where x ->> 'destination_id' = (select id::text from raw)),
  array['destination_id', 'field_count', 'style'], 'and carries nothing else');
select is((select count(*) from jsonb_array_elements(list_discord_destination_settings())), 3::bigint,
  'one entry per Discord destination of the caller');

-- RLS: no client reads or writes on the table.
select throws_ok($$ select * from discord_destination_settings $$, '42501', null, 'clients cannot read the settings');
select throws_ok($$ update discord_destination_settings set footer = false $$, '42501', null, 'clients cannot change them directly');
select throws_ok(format($$ insert into discord_destination_settings select (jsonb_populate_record(null::discord_destination_settings,
                           %L::jsonb || jsonb_build_object('destination_id', %L::uuid))).* $$, (select j from defaults), (select id from hook)),
  '42501', null, 'or add a row');
reset role;
select ok((select relrowsecurity from pg_class where relname = 'discord_destination_settings'), 'RLS is on');
select is((select count(*) from pg_policies where tablename = 'discord_destination_settings'), 0::bigint, 'with no policies');

-- ---------------------------------------------------------------------------
-- Rendering
-- ---------------------------------------------------------------------------
create temp table spot as select jsonb_build_object(
  'id', 1, 'source', 'pota', 'spot_time', '2026-10-05T13:45:12Z', 'callsign', 'KK4PWJ/P', 'base_callsign', 'KK4PWJ',
  'spotter', 'W1AW', 'frequency_khz', 14062, 'band', '20m', 'mode', 'cw', 'comment', 'QRT soon',
  'pota_reference', 'US-2763', 'pota_park_name', 'Pisgah National Forest', 'pota_location', 'US-NC,US-SC',
  'sota_summit_ref', null, 'wwff_reference', null, 'wwff_reference_name', null) as j;
create function pg_temp.settings(p jsonb default '{}') returns discord_destination_settings language sql as $$
  select jsonb_populate_record(null::discord_destination_settings, discord_default_settings() || p);
$$;
create function pg_temp.line(p discord_destination_settings, p_spot jsonb) returns text language sql as $$
  select discord_plain_line(p, discord_field_values(p_spot), p_spot);
$$;

select is(discord_fields(), array['callsign', 'first_name', 'last_name', 'frequency', 'band', 'mode', 'source', 'reference', 'place_name',
                                  'state', 'spotter', 'time'],
  'the Discord fields are push''s without Comment, in the editor''s order');
select ok(discord_fields_valid(array['callsign'], 1, 4) and not discord_fields_valid(array['comment'], 0, 8)
          and not discord_fields_valid(array['band', 'band'], 0, 8) and not discord_fields_valid(array[]::text[], 1, 4),
  'discord_fields_valid checks names, repeats and the count');
select throws_ok($$ update discord_destination_settings set line_fields = array['comment'] where destination_id = (select id from raw) $$,
  '23514', null, 'the table''s checks refuse Comment too');
select is(app_site_url(), 'https://longlines.io', 'the site URL knob');
select is((select array_agg(discord_source_color(s) order by o)
           from unnest(array['pota', 'sotawatch', 'wwff', 'wwbota', 'dxcluster', 'rbn', 'aprs']) with ordinality as t(s, o)),
  array[3066993, 10181046, 1752220, 15844367, 3447003, 15105570, 9807270],
  'by source: POTA green, SOTA purple, WWFF teal, WWBOTA gold, DX Cluster blue, RBN orange, anything else grey');
select is((select array_agg(discord_color(pg_temp.settings(jsonb_build_object('card_color', c)), (select j from spot)) order by o)
           from unnest(array['source', 'blue', 'green', 'purple', 'orange', 'red', 'grey']) with ordinality as t(c, o)),
  array[3066993, 3447003, 3066993, 10181046, 15105570, 15158332, 9807270], 'the named colors, the same for every spot');
select is(discord_color(pg_temp.settings('{"card_color": "red"}'), '{"source": "rbn"}'), 15158332, 'a named color ignores the source');
select is(discord_footer((select j from spot)), 'POTA · 13:45 UTC', 'the footer: the source and the UTC time');
select is(discord_footer('{"source": "sotawatch", "spot_time": "2026-10-05T07:05:00Z"}'), 'SOTAwatch · 07:05 UTC', 'with the source''s label');
select is(discord_grid(array['band', 'place_name', 'spotter'], discord_field_values((select j - 'pota_park_name' from spot))),
  '[{"name": "Band", "value": "20m"}, {"name": "Spotter", "value": "W1AW"}]'::jsonb, 'the grid skips a missing park and keeps the order');
select is(discord_grid(array[]::text[], discord_field_values((select j from spot))), '[]'::jsonb, 'an empty grid');
select is((select array_agg(k order by k) from jsonb_object_keys(discord_field_values((select j - 'pota_park_name' from spot))) k),
  array['band', 'callsign', 'frequency', 'mode', 'reference', 'source', 'spotter', 'state', 'time'],
  'a spot is rendered once per field, without Comment or what it lacks');
select ok((select bool_and(discord_join(f, discord_field_values(sp), sep, lab) = render_push_fields(f, sp, sep, lab))
           from (values (array['callsign', 'frequency', 'mode']), (array['state', 'place_name', 'spotter']), (array[]::text[]),
                        (array['time', 'band', 'reference', 'source'])) a(f),
                (values ('dot'), ('comma'), ('newline')) b(sep), (values (true), (false)) c(lab),
                (select j as sp from spot union all select j - 'pota_park_name' - 'pota_location' from spot) d),
  'discord_join joins exactly as push''s render_push_fields does');

select is(pg_temp.line(pg_temp.settings(), (select j from spot)),
  '**[KK4PWJ/P](https://longlines.io/call/KK4PWJ)** · 14.062 MHz · CW · POTA · US-2763 · Pisgah National Forest',
  'the default plain line: the callsign bold and linked to the profile');
select is(pg_temp.line(pg_temp.settings('{"bold_first": false}'), (select j from spot)),
  '[KK4PWJ/P](https://longlines.io/call/KK4PWJ) · 14.062 MHz · CW · POTA · US-2763 · Pisgah National Forest', 'bold off');
select is(pg_temp.line(pg_temp.settings('{"line_fields": ["state", "callsign"], "show_field_names": true}'), (select j from spot)),
  '**State: NC/SC** · Callsign: [KK4PWJ/P](https://longlines.io/call/KK4PWJ)', 'labels on; the first field is bold whatever it is');
select is(pg_temp.line(pg_temp.settings('{"line_fields": ["source", "band"], "separator": "comma"}'), (select j from spot)),
  '**POTA**, 20m', 'a comma separator');
select is(pg_temp.line(pg_temp.settings('{"line_fields": ["place_name"]}'), (select j - 'pota_park_name' from spot)),
  'KK4PWJ/P', 'a line with nothing to show falls back to the callsign');

-- Escaping: a feed's text is never markup (DX Cluster takes any run without
-- spaces as a call, and spotters and park names are what the upstream sent).
select is(discord_escape('[FREE-QSL](HTTPS://EVIL.EXAMPLE)'), '\[FREE-QSL\]\(HTTPS://EVIL.EXAMPLE\)',
  'a masked link is escaped');
select is(discord_escape('a\b `c` *d* _e_ ~f~ ||g|| <@1> <t:1> #h > i'),
  'a\\b \`c\` \*d\* \_e\_ \~f\~ \|\|g\|\| \<\@1\> \<t:1\> \#h \> i', 'every markdown character, mentions and timestamps');
select is(array[discord_escape('- x'), discord_escape('12. y'), discord_escape('14.062 MHz'), discord_escape('US-2763')],
  array['\- x', '12\. y', '14.062 MHz', 'US-2763'], 'a list marker at the start, but not a frequency or a reference');
select is(array[discord_escape(E'Park\n- list\n  - nested'), discord_escape(E'x\n  - y'), discord_escape('  1. y'),
              discord_escape(E'\t- x'), discord_escape(E'a\n\t12. b')],
  array[E'Park\n\\- list\n  \\- nested', E'x\n  \\- y', '  1\. y', E'\t\\- x', E'a\n\t12\\. b'],
  'an indented list marker is escaped too, on any line');
select is(array[discord_clip('abc\[def', 5), discord_clip('ab\\cdef', 5), discord_clip('abcdefgh', 5), discord_clip('abc', 5)],
  array['abc…', 'ab\\…', 'abcd…', 'abc'], 'a clip never leaves a lone backslash before the ellipsis');
select is(render_push_field('spotter', '{"spotter": "[X](Y)"}'), '[X](Y)', 'push''s renderer stays unescaped');

create temp table hostile as select (select j from spot) || jsonb_build_object(
  'source', 'dxcluster', 'callsign', '[FREE-QSL](HTTPS://EVIL.EXAMPLE)', 'base_callsign', '[FREE-QSL](HTTPS:',
  'spotter', '[CLAIM](HTTPS://EVIL.EXAMPLE)') as j;
select is(discord_profile_url((select j from hostile)), null, 'a call that is not safe in a URL has no profile link');
select is(discord_profile_url((select j from spot)), 'https://longlines.io/call/KK4PWJ', 'a normal one has');
select is(pg_temp.line(pg_temp.settings(), (select j from hostile)),
  '**\[FREE-QSL\]\(HTTPS://EVIL.EXAMPLE\)** · 14.062 MHz · CW · DX Cluster · US-2763 · Pisgah National Forest',
  'a hostile callsign in the plain line is escaped text with no link');
-- Discord's masked-link text ignores escapes, so a '\[' with no ']' would
-- break the link and show '[..](..)' as literal text (20261018000200).
select is(pg_temp.line(pg_temp.settings(), (select j from spot) || '{"source": "dxcluster", "callsign": "K1ABC/[", "base_callsign": "K1ABC"}'),
  '**K1ABC/\[** · 14.062 MHz · CW · DX Cluster · US-2763 · Pisgah National Forest',
  'a callsign with a bracket is bold text with no link, though its base call has a profile');
select is(pg_temp.line(pg_temp.settings('{"line_fields": ["mode", "callsign"]}'), (select j from spot) || '{"callsign": "K1ABC/]", "base_callsign": "K1ABC"}'),
  '**CW** · K1ABC/\]', 'a closing bracket drops the link too');
select results_eq($$ select f ->> 'discord_title', f ->> 'discord_description', f #>> '{discord_grid,1,value}', f ->> 'discord_url'
                     from (select discord_spot_fields(pg_temp.settings('{"detail_fields": ["callsign", "spotter"]}'),
                                                      (select j from hostile)) as f) t $$,
  $$ values ('\[FREE-QSL\]\(HTTPS://EVIL.EXAMPLE\) · 14.062 MHz · CW'::text,
             '\[FREE-QSL\]\(HTTPS://EVIL.EXAMPLE\) · \[CLAIM\]\(HTTPS://EVIL.EXAMPLE\)'::text,
             '\[CLAIM\]\(HTTPS://EVIL.EXAMPLE\)'::text, null::text) $$,
  'the title, the description and the grid escape a hostile callsign and spotter, and the title has no link');
select is(discord_title_url(pg_temp.settings('{"title_link": "source"}'), (select j from hostile)), null,
  'nor a source link when the source has no page');
select is((discord_spot_fields(pg_temp.settings('{"title_fields": ["place_name"]}'),
                               (select j - 'pota_park_name' from hostile)) ->> 'discord_title'),
  '\[FREE-QSL\]\(HTTPS://EVIL.EXAMPLE\)', 'the title''s callsign fallback is escaped too');

-- Clipping the plain line never cuts inside its markup.
create temp table trail as select (select j from spot) || jsonb_build_object(
  'pota_park_name', 'Chattahoochee-Oconee National Forest Wilderness Area',
  'pota_location', 'US-CT,US-GA,US-NC,US-SC,US-TN,US-VA,US-AL,US-KY,US-WV,US-MD,US-PA,US-NY') as j;
select is(pg_temp.line(pg_temp.settings('{"line_fields": ["place_name", "state", "reference", "frequency", "mode", "callsign"],
                                          "show_field_names": true}'), (select j from trail)),
  '**Place name: Chattahoochee-Oconee National Forest Wilderness Area** · State: CT/GA/NC/SC/TN/VA/AL/KY/WV/MD/PA/NY · Reference: US-2763 · Frequency: 14.062 MHz · Mode: CW · Callsign: KK4PWJ/P',
  'a link that no longer fits is dropped, not cut: the callsign stays as text');
select is(pg_temp.line(pg_temp.settings('{"line_fields": ["place_name", "callsign"]}'),
                       (select j || jsonb_build_object('pota_park_name', repeat('x', 300)) from spot)),
  '**' || repeat('x', 185) || '…**', 'a first field longer than the line is clipped inside its bold');
create temp table cut as select pg_temp.line(pg_temp.settings('{"line_fields": ["place_name", "callsign"], "bold_first": false}'),
                       (select j || jsonb_build_object('pota_park_name', repeat('y', 120)) from spot)) as l;
select is((select l from cut), repeat('y', 120) || ' · [KK4PWJ/P](https://longlines.io/call/KK4PWJ)',
  'a link that fits stays whole');
select is(pg_temp.line(pg_temp.settings('{"line_fields": ["place_name", "callsign"], "bold_first": false}'),
                       (select j || jsonb_build_object('pota_park_name', repeat('y', 146)) from spot)),
  repeat('y', 146) || ' · [KK4P…](https://longlines.io/call/KK4PWJ)', 'a value cut inside its link keeps the link whole');
select is(pg_temp.line(pg_temp.settings('{"line_fields": ["place_name", "callsign"], "bold_first": false}'),
                       (select j || jsonb_build_object('pota_park_name', repeat('y', 183)) from spot)),
  repeat('y', 183) || ' · KK4…', 'with no room for the link the value is cut as text');
select is(pg_temp.line(pg_temp.settings('{"line_fields": ["place_name", "callsign"], "bold_first": false}'),
                       (select j || jsonb_build_object('pota_park_name', repeat('y', 188)) from spot)),
  repeat('y', 188) || '…', 'with no room for the next value the cut is marked after the last one');
select ok((select bool_and(length(pg_temp.line(pg_temp.settings(jsonb_build_object('line_fields', f, 'show_field_names', lab,
                                                                                    'bold_first', b)), j)) <= 190)
           from (values ('["place_name", "callsign", "state", "spotter"]'::jsonb), ('["callsign", "place_name", "state"]'),
                        ('["state", "place_name", "reference", "callsign"]')) a(f),
                (values (true), (false)) c(lab), (values (true), (false)) d(b),
                (select j from trail union all select j || jsonb_build_object('pota_park_name', repeat('[z]', 70)) from spot
                 union all select j || jsonb_build_object('pota_park_name', repeat('w', 175)) from spot) e),
  'every clipped line is at most 190 characters');

select is(discord_title_url(pg_temp.settings(), (select j from spot)), 'https://longlines.io/call/KK4PWJ',
  'the title links to the profile, by base call');
select is(discord_title_url(pg_temp.settings('{"title_link": "source"}'), (select j from spot)), 'https://pota.app/#/park/US-2763',
  'or to the spot on the source site');
select is(discord_title_url(pg_temp.settings('{"title_link": "source"}'), '{"source": "rbn", "callsign": "K1ABC"}'),
  'https://longlines.io/call/K1ABC', 'a source without a page links the profile');
select is(discord_title_url(pg_temp.settings('{"title_link": "none"}'), (select j from spot)), null, 'or nothing');

create temp table long as select (select j from spot) || jsonb_build_object('pota_park_name', repeat('x', 5000)) as j;
select results_eq($$ select length(f ->> 'discord_title'), right(f ->> 'discord_title', 1), length(f ->> 'discord_description'),
                            length(f #>> '{discord_grid,0,value}'), length(f ->> 'discord_line')
                     from (select discord_spot_fields(pg_temp.settings('{"title_fields": ["place_name"], "detail_fields": ["place_name"],
                                                                          "grid_fields": ["place_name"], "line_fields": ["place_name"]}'),
                                                      (select j from long)) as f) t $$,
  $$ values (256, '…'::text, 4096, 1024, 190) $$, 'title, description, grid values and the line are clipped to Discord''s limits');

create temp table fields as select discord_spot_fields(pg_temp.settings(), (select j from spot)) as f;
select is((select array_agg(k order by k) from fields, jsonb_object_keys(f) k),
  array['discord_color', 'discord_description', 'discord_footer', 'discord_grid', 'discord_line', 'discord_style',
        'discord_suppress_embeds', 'discord_title', 'discord_url'], 'always the nine keys');
select results_eq($$ select f ->> 'discord_style', f ->> 'discord_title', f ->> 'discord_description', f -> 'discord_grid',
                            f ->> 'discord_footer', (f ->> 'discord_color')::int, f ->> 'discord_url' from fields $$,
  $$ values ('card'::text, 'KK4PWJ/P · 14.062 MHz · CW'::text, 'POTA · US-2763 · Pisgah National Forest · NC/SC'::text,
             '[{"name": "Band", "value": "20m"}, {"name": "Spotter", "value": "W1AW"}]'::jsonb, 'POTA · 13:45 UTC'::text,
             3066993, 'https://longlines.io/call/KK4PWJ'::text) $$,
  'the default card');
select is((discord_spot_fields(pg_temp.settings('{"detail_fields": ["state", "spotter"], "show_field_names": true, "separator": "newline"}'),
                               (select j from spot)) ->> 'discord_description'), E'State: NC/SC\nSpotter: W1AW',
  'details take field names and the separator');
select is((discord_spot_fields(pg_temp.settings('{"title_fields": ["place_name"]}'), (select j - 'pota_park_name' from spot)) ->> 'discord_title'),
  'KK4PWJ/P', 'a title with nothing to show falls back to the callsign');
select results_eq($$ select f ->> 'discord_description', jsonb_typeof(f -> 'discord_footer')
                     from (select discord_spot_fields(pg_temp.settings('{"detail_fields": [], "footer": false}'), (select j from spot)) as f) t $$,
  $$ values (''::text, 'null'::text) $$, 'empty details render empty; the footer off is null');
select is((select array_agg((discord_spot_fields(pg_temp.settings(s), (select j from spot)) ->> 'discord_suppress_embeds')::boolean order by o)
           from unnest(array['{"style": "plain"}', '{"style": "plain", "link_preview": "shown"}', '{"style": "card"}']::jsonb[])
                with ordinality as t(s, o)),
  array[true, false, false], 'embeds are suppressed only for a plain line with link preview hidden');

-- ---------------------------------------------------------------------------
-- claim_deliveries, the preview and Send test
-- ---------------------------------------------------------------------------
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table card1 as select save_discord_destination(null, 'Card chat', true, 'https://discord.com/api/webhooks/6/f', null) as id;
create temp table plain1 as select save_discord_destination(null, 'Plain chat', true, 'https://discord.com/api/webhooks/7/g',
  '{"style": "plain", "separator": "comma"}') as id;
grant all on card1, plain1 to authenticated;
select save_subscription(jsonb_build_object('name', 'all', 'quiet_minutes', 0,
  'destinations', array[(select id from card1), (select id from plain1), (select id from phone)]));
reset role;
select count(*) from ingest_spots(jsonb_build_array(
  jsonb_build_object('source','pota','source_spot_id','s1','content_hash','h1','spot_time',now(),'callsign','KK4PWJ/P',
    'spotter','W1AW','frequency_khz',14062,'band','20m','mode','cw','comment','','pota_reference','US-2763',
    'pota_park_name','Pisgah National Forest','pota_location','US-NC','raw_payload','{}'::jsonb)));
create temp table s1 as select id from raw_spots where source_spot_id = 's1';
grant select on s1 to authenticated;
select is(match_pending_spots(), 3, 'two Discord destinations and a push one get a delivery each');
update destinations set claim_tokens_at = now() - interval '1 minute', claim_due_at = '-infinity';
create temp table claimed as select * from claim_deliveries(200, 60);
grant select on claimed to authenticated;
create function pg_temp.discord_keys(p jsonb) returns jsonb language sql as $$
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each(p) e(k, v) where k like 'discord\_%';
$$;
select is((select count(*) from claimed), 3::bigint, 'all three claimed');
select is((select destination -> 'discord' from claimed where destination ->> 'id' = (select id::text from card1)),
  (select j from defaults), 'a Discord destination carries its settings');
select is((select destination #>> '{discord,style}' from claimed where destination ->> 'id' = (select id::text from plain1)),
  'plain', 'each its own');
select is((select array_agg(k order by k) from claimed c, jsonb_object_keys(c.spot) k where c.destination ->> 'id' = (select id::text from card1)),
  array['band', 'base_callsign', 'callsign', 'comment', 'discord_color', 'discord_description', 'discord_footer', 'discord_grid',
        'discord_line', 'discord_style', 'discord_suppress_embeds', 'discord_title', 'discord_url', 'frequency_khz', 'id',
        'iota_reference', 'iota_reference_name', 'mode', 'mode_family', 'pota_location', 'pota_park_name', 'pota_reference', 'sota_summit_ref', 'source', 'spot_time', 'spotter',
        'wwbota_reference_name', 'wwbota_references', 'wwff_reference', 'wwff_reference_name'],
  'a Discord spot keeps its documented keys plus the nine discord ones');
select results_eq(format($$ select spot ->> 'discord_line', (spot ->> 'discord_suppress_embeds')::boolean
                            from claimed where destination ->> 'id' = %L $$, (select id from plain1)),
  $$ values ('**[KK4PWJ/P](https://longlines.io/call/KK4PWJ)**, 14.062 MHz, CW, POTA, US-2763, Pisgah National Forest'::text, true) $$,
  'the plain destination''s line, with its separator');
select ok((select not (destination ? 'discord') and not exists (select 1 from jsonb_object_keys(spot) k where k like 'discord%')
                  and spot ? 'push_title'
           from claimed where destination ->> 'id' = (select id::text from phone)),
  'a push row carries no discord keys');
select ok((select bool_and(not (destination ? 'push') and not (spot ? 'push_title'))
           from claimed where destination ->> 'type' = 'discord'), 'and Discord rows no push ones');
select is((select array_agg(k order by k) from claimed c, jsonb_object_keys(to_jsonb(c)) k where c.destination ->> 'id' = (select id::text from card1)),
  array['attempts', 'created_at', 'delivery_id', 'destination', 'msg_id', 'spot', 'subscription_id'],
  'the result columns are unchanged');
select mark_deliveries_sent(array(select delivery_id from claimed), array(select msg_id from claimed));

-- A Discord destination that somehow lost its settings row is handed the defaults.
delete from discord_destination_settings where destination_id = (select id from card1);
select count(*) from ingest_spots(jsonb_build_array(
  jsonb_build_object('source','pota','source_spot_id','s2','content_hash','h2','spot_time',now(),'callsign','KK4PWJ/P',
    'spotter','W1AW','frequency_khz',14062,'band','20m','mode','cw','comment','','pota_reference','US-2763',
    'pota_park_name','Pisgah National Forest','pota_location','US-NC','raw_payload','{}'::jsonb)));
select match_pending_spots();
-- A Discord destination is claimed on average every 10 seconds, never within 5 (destination_claim_interval).
select is((select count(*) from claim_deliveries(200, 60) c where c.destination ->> 'id' = (select id::text from card1)), 0::bigint,
  'a Discord destination claimed a moment ago waits for the claim interval');
update destinations set claim_tokens_at = now() - interval '1 minute', claim_due_at = '-infinity';
create temp table claimed2 as select * from claim_deliveries(200, 60);
select results_eq(format($$ select destination -> 'discord' = (select j from defaults), spot ->> 'discord_title'
                            from claimed2 where destination ->> 'id' = %L $$, (select id from card1)),
  $$ values (true, 'KK4PWJ/P · 14.062 MHz · CW'::text) $$, 'without a settings row the claim uses the defaults');
select mark_deliveries_sent(array(select delivery_id from claimed2), array(select msg_id from claimed2));
insert into discord_destination_settings
select (jsonb_populate_record(null::discord_destination_settings, discord_default_settings() || jsonb_build_object('destination_id', (select id from card1)))).*;

-- The preview renders what the claim rendered, for the same spot.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is(preview_discord_message(null, (select id from s1)),
  (select pg_temp.discord_keys(spot) from claimed where destination ->> 'id' = (select id::text from card1)),
  'the card preview renders exactly what claim_deliveries sends');
select is(preview_discord_message('{"style": "plain", "separator": "comma"}', (select id from s1)),
  (select pg_temp.discord_keys(spot) from claimed where destination ->> 'id' = (select id::text from plain1)),
  'and the plain one');
select results_eq($$ select f ->> 'discord_title', f ->> 'discord_line', f ->> 'discord_url'
                     from (select preview_discord_message('{"title_fields": ["callsign", "band"]}') as f) t $$,
  $$ values ('N0CALL · 20m'::text, '**[N0CALL](https://longlines.io/call/N0CALL)** · 14.062 MHz · CW · POTA · US-0000 · Test Park'::text,
             'https://longlines.io/call/N0CALL'::text) $$,
  'without a spot the preview uses the sample spot, with the given settings over the defaults');
select is((preview_discord_message('{}') ->> 'discord_color')::int, 3066993, 'an empty object is the defaults');
select throws_ok($$ select preview_discord_message(null, -1) $$, 'P0001', 'Spot not found.', 'an unknown spot');
select throws_ok($$ select preview_discord_message('{"colour": "red"}') $$, 'P0001', 'Unknown setting colour.', 'the preview checks keys');
select throws_ok($$ select preview_discord_message('{"line_fields": ["comment"]}') $$, 'P0001', 'Comment is not available here.',
  'and fields');
select throws_ok($$ select preview_discord_message('{"batch_seconds": 5}') $$, 'P0001', 'Pick a batch window.', 'and every setting');
reset role;

-- Send test: the saved settings for the chosen spot, marked as a test.
select results_eq(format($$ select x -> 'discord' = (select j from defaults), x #>> '{spot,discord_footer}', x #>> '{spot,discord_line}',
                                   x #>> '{spot,discord_title}', x #>> '{spot,callsign}'
                            from (select discord_test_delivery(%L, %s) as x) t $$, (select id from card1), (select id from s1)),
  format($$ values (true, %L, %L, 'KK4PWJ/P · 14.062 MHz · CW'::text, 'KK4PWJ/P'::text) $$,
         'Test message from Long Lines · ' || (select discord_footer(delivery_spot_json(r)) from raw_spots r where r.id = (select id from s1)),
         'Test message from Long Lines · **[KK4PWJ/P](https://longlines.io/call/KK4PWJ)** · 14.062 MHz · CW · POTA · US-2763 · Pisgah National Forest'),
  'Send test renders the saved settings for the chosen spot and marks the footer and the line');
select is((select array_agg(k order by k) from jsonb_object_keys(discord_test_delivery((select id from card1))) k),
  array['discord', 'spot'], 'it returns the settings and the spot');
update discord_destination_settings set style = 'plain', line_fields = array['place_name', 'callsign'], bold_first = false
  where destination_id = (select id from card1);
update raw_spots set pota_park_name = repeat('p', 300) where id = (select id from s1);
create temp table long_test as select discord_test_delivery((select id from card1), (select id from s1)) #>> '{spot,discord_line}' as l;
select results_eq($$ select length(l), left(l, 31), right(l, 1) from long_test $$,
  $$ values (190, 'Test message from Long Lines · '::text, '…'::text) $$,
  'the marked test line stays within the line''s 190 characters');
update raw_spots set pota_park_name = 'Pisgah National Forest' where id = (select id from s1);
update discord_destination_settings s set style = d.style, line_fields = d.line_fields, bold_first = d.bold_first
  from jsonb_populate_record(null::discord_destination_settings, discord_default_settings()) d
  where s.destination_id = (select id from card1);
update discord_destination_settings set footer = false where destination_id = (select id from card1);
select is((discord_test_delivery((select id from card1)) #>> '{spot,discord_footer}'), 'Test message from Long Lines',
  'with the footer off the marker stands alone');
select is((discord_test_delivery((select id from card1)) #>> '{spot,callsign}'), 'N0CALL', 'without a spot it uses the sample');
select is(discord_test_delivery((select id from card1), -1), null, 'an unknown spot returns null');
select is(discord_test_delivery(gen_random_uuid()), null, 'an unknown destination returns null');
select is(discord_test_delivery((select id from phone)), null, 'a push destination returns null');
select ok(not has_function_privilege('authenticated', 'public.discord_test_delivery(uuid, bigint)', 'execute')
          and not has_function_privilege('authenticated', 'public.discord_spot_fields(discord_destination_settings, jsonb)', 'execute')
          and not has_function_privilege('authenticated', 'public.discord_default_settings()', 'execute')
          and not has_function_privilege('authenticated', 'public.validate_discord_settings(discord_destination_settings)', 'execute'),
  'the test RPC and the helpers are not callable by clients');
select ok(not has_function_privilege('delivery_sender', 'public.discord_test_delivery(uuid, bigint)', 'execute')
          and not has_table_privilege('delivery_sender', 'public.discord_destination_settings', 'select'),
  'the sender role gets nothing new');
select ok(has_function_privilege('authenticated', 'public.save_discord_destination(uuid, text, boolean, text, jsonb)', 'execute')
          and has_function_privilege('authenticated', 'public.get_discord_destination(uuid)', 'execute')
          and has_function_privilege('authenticated', 'public.list_discord_destination_settings()', 'execute')
          and has_function_privilege('authenticated', 'public.preview_discord_message(jsonb, bigint)', 'execute')
          and not has_function_privilege('anon', 'public.save_discord_destination(uuid, text, boolean, text, jsonb)', 'execute'),
  'signed-in clients get the four editor RPCs, anon none');

-- ---------------------------------------------------------------------------
-- Duplicate, the management API and cascades
-- ---------------------------------------------------------------------------
update discord_destination_settings set style = 'plain', card_color = 'purple', batch_seconds = 60
where destination_id = (select id from card1);
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table copy1 as select duplicate_destination((select id from card1)) as id;
create temp table copy2 as select duplicate_destination((select id from card1)) as id;
grant all on copy1, copy2 to authenticated;
select results_eq(format($$ select x ->> 'name', (x ->> 'enabled')::boolean, x ->> 'url_display', x -> 'settings'
                            from (select get_discord_destination(%L) as x) t $$, (select id from copy1)),
  format($$ select 'Copy of Card chat'::text, false, x ->> 'url_display', x -> 'settings' from (select get_discord_destination(%L) as x) t $$,
         (select id from card1)),
  'a Discord copy has the settings and the masked URL, named "Copy of", and starts disabled');
select is((get_discord_destination((select id from copy2)) ->> 'name'), 'Copy of Card chat (2)', 'a second copy takes the next free name');
select lives_ok(format('select duplicate_destination(%L)', (select id from phone)), 'push destinations still duplicate');
select lives_ok(format('select duplicate_destination(%L)', (select id from hook)),
  'a webhook duplicates too (20261018000300)');
reset role;
select is((select url from destinations where id = (select id from copy1)), 'https://discord.com/api/webhooks/6/f',
  'the copy posts to the same channel');

select is((select api_destination_json(d) -> 'discord' from destinations d where d.id = (select id from card1)),
  (select to_jsonb(s) - 'destination_id' from discord_destination_settings s where s.destination_id = (select id from card1)),
  'the API shows a Discord destination''s settings');
select ok((select not (api_destination_json(d) ? 'push') and not (api_destination_json(d) ? 'url')
           from destinations d where d.id = (select id from card1)), 'and neither push nor the URL');
select ok((select bool_and(not (api_destination_json(d) ? 'discord')) from destinations d where d.type <> 'discord'),
  'other types carry no discord');

delete from destinations where id = (select id from copy1);
select is((select count(*) from discord_destination_settings where destination_id = (select id from copy1)), 0::bigint,
  'deleting a destination removes its settings');
delete from deliveries;
delete from subscriptions where user_id = '11111111-1111-1111-1111-111111111111';
delete from auth.users where id = '11111111-1111-1111-1111-111111111111';
select is((select count(*) from discord_destination_settings s join destinations d on d.id = s.destination_id
           where d.user_id = '11111111-1111-1111-1111-111111111111'), 0::bigint, 'settings go with their account');

select * from finish();
rollback;

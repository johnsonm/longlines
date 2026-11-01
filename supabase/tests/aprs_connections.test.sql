-- pgTAP: APRS-IS as a connection source (20261031000100): the source check and a spot without a
-- frequency through ingest_spots and its dedup key, opt-in matching, the RBN-style station guard
-- (matcher and save-time check), watched_among, deliveries (never to a Local DX cluster), the
-- renderers with no frequency, and the readers that leave APRS spots out (spot_stream, the recent
-- spots list, a group's on-air count) or count them (the preview, the Home page).
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(36);

delete from deliveries;
delete from subscription_quiet;
select pgmq.purge_queue('spot_events');
select pgmq.purge_queue('deliveries_queue');

-- A's relay, connected, for the Local DX cluster destination.
insert into relay_tokens (id, user_id, token_hash, token_prefix, device_name, client_version, scopes, platform,
                          cluster_connected_at)
values ('aaaaaaaa-0000-0000-0000-0000000000a1', '11111111-1111-1111-1111-111111111111',
        encode(extensions.digest('aprs-a1', 'sha256'), 'hex'), 'll_relay_ap', 'SHACK-PC', '0.2.0',
        array['contacts:write', 'spots:read'], 'linux', now());

-- ---------------------------------------------------------------------------
-- Saving: an APRS-only connection must name stations in every group
-- ---------------------------------------------------------------------------

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select throws_ok($$ select save_subscription('{"name":"x","sources":["aprs"]}') $$,
  'P0001', 'APRS-IS reports stations by callsign. Add at least one callsign.',
  'an APRS-only connection without stations is refused');
select throws_ok($$ select save_subscription('{"name":"x","sources":["aprs"],"rules":[[{"field":"callsign","op":"is","values":["K4ABC"]}],[{"field":"band","op":"is","values":["20m"]}]]}') $$,
  'P0001', 'APRS-IS reports stations by callsign. Each Or needs its own callsign or group rule.',
  'every Or of an APRS-only connection needs its own stations');
select throws_ok($$ select save_subscription('{"name":"x","sources":["rbn","aprs"]}') $$,
  'P0001', 'RBN and APRS-IS report stations by callsign. Add at least one callsign.',
  'so does a connection on RBN and APRS-IS together');
select throws_ok($$ select save_subscription('{"name":"x","sources":["rbn"]}') $$,
  'P0001', 'RBN reports stations by callsign. Add at least one callsign.', 'the RBN-only message is unchanged');
select lives_ok($$ select save_subscription('{"name":"Mixed","sources":["aprs","pota"],"destinations":[]}') $$,
  'with another source listed the connection may save without stations (APRS spots just never pass)');

create temp table dh as select * from create_destination('webhook', 'Hook', 'https://hooks.example.com/aprs');
create temp table dd as select * from create_destination('discord', 'Chat', 'https://discord.com/api/webhooks/9/a');
create temp table dl as
select save_local_cluster_destination(null, 'Shack', null, '{"relay_id": "aaaaaaaa-0000-0000-0000-0000000000a1"}') as id;
create temp table grp as select save_callsign_group('{"name":"Rovers","callsigns":["K4ABC"]}') as id;
create temp table subs as
select save_subscription(jsonb_build_object('name', 'Tracker', 'sources', array['aprs'], 'quiet_minutes', 0,
         'rules', '[[{"field":"callsign","op":"is","values":["K4ABC"]}]]'::jsonb,
         'destinations', array[(select id from dh), (select id from dd), (select id from dl)])) as named,
       save_subscription(jsonb_build_object('name', 'Anything from K4ABC', 'quiet_minutes', 0,
         'rules', '[[{"field":"callsign","op":"is","values":["K4ABC"]}]]'::jsonb,
         'destinations', array[(select id from dh)])) as any_source,
       save_subscription(jsonb_build_object('name', 'Twenty', 'sources', array['aprs', 'pota'], 'quiet_minutes', 0,
         'rules', '[[{"field":"band","op":"is","values":["20m"]}], [{"field":"callsign","op":"is_not","values":["N0NE"]}]]'::jsonb,
         'destinations', array[(select id from dh)])) as unnamed;
reset role;

-- ---------------------------------------------------------------------------
-- Ingest
-- ---------------------------------------------------------------------------

select is((select count(*) from ingest_spots(jsonb_build_array(
  jsonb_build_object('source', 'aprs', 'source_spot_id', 'K4ABC-9|2026-10-31T18:00:00.000Z', 'content_hash', 'aprs-h1',
    'spot_time', now(), 'callsign', 'K4ABC-9', 'spotter', 'W1ABC-10', 'frequency_khz', null,
    'comment', '=4237.14N/07120.83W[/A=000164', 'raw_payload', '{}'::jsonb)))), 1::bigint,
  'ingest_spots stores an aprs spot without a frequency');
select is((select frequency_khz from raw_spots where content_hash = 'aprs-h1'), null, 'its frequency is null');
select is((select count(*) from ingest_spots(jsonb_build_array(
  jsonb_build_object('source', 'aprs', 'source_spot_id', 'K4ABC-9|2026-10-31T18:00:00.000Z', 'content_hash', 'aprs-h1',
    'spot_time', now(), 'callsign', 'K4ABC-9', 'spotter', 'W1ABC-10', 'frequency_khz', null,
    'comment', '=4237.15N/07120.84W[/A=000170', 'raw_payload', '{}'::jsonb)))), 0::bigint,
  'a second packet in the same bucket hits the dedup key');
select throws_ok($$ insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, frequency_khz, raw_payload)
                    values ('bogus', 'x', 'x', now(), 'K4ABC', 14062, '{}') $$,
  '23514', null, 'raw_spots still refuses an unknown source');

-- ---------------------------------------------------------------------------
-- Matching
-- ---------------------------------------------------------------------------

select ok(not source_matches('{}', 'aprs'), 'source_matches: empty sources leave out aprs');
select ok(source_matches('{aprs}', 'aprs'), 'source_matches: sources {aprs} take aprs');
select ok((select spot_matches(s, r) from subscriptions s, raw_spots r
           where s.id = (select named from subs) and r.content_hash = 'aprs-h1'),
  'spot_matches: a callsign is rule passes an aprs spot');
select ok((select not spot_matches(s, r) from subscriptions s, raw_spots r
           where s.id = (select unnamed from subs) and r.content_hash = 'aprs-h1'),
  'spot_matches: groups that name no stations never pass an aprs spot, though the is_not rule passes it');
select ok((select not spot_matches(s, r) from subscriptions s, raw_spots r
           where s.id = (select any_source from subs) and r.content_hash = 'aprs-h1'),
  'spot_matches: an any-source connection never gets an aprs spot');

select is(array(select watched_among('aprs', array['K4ABC-9', 'N0NE'])), array['K4ABC-9'],
  'watched_among(''aprs'') returns a call an aprs connection names');
-- The any-source connection names W1AW only for the sources it takes.
update subscriptions set rules = '[[{"field":"callsign","op":"is","values":["W1AW"]}]]' where id = (select any_source from subs);
select is(array(select watched_among('aprs', array['W1AW-7'])), '{}'::text[],
  'and not a call only an any-source connection names');
select is(array(select watched_among('pota', array['W1AW-7'])), array['W1AW-7'],
  'which the same connection watches for its own sources');
update subscriptions set rules = '[[{"field":"callsign","op":"is","values":["K4ABC"]}]]' where id = (select any_source from subs);

select is(match_pending_spots(), 2, 'the matcher makes two deliveries for the aprs spot');
select set_eq(
  $$ select dd.type from deliveries d join destinations dd on dd.id = d.destination_id
     join raw_spots r on r.id = d.spot_id where r.content_hash = 'aprs-h1' $$,
  array['webhook', 'discord'], 'to the webhook and Discord destinations, never to the Local DX cluster');
select is((select count(*) from deliveries where subscription_id <> (select named from subs)), 0::bigint,
  'only the connection that lists aprs and names the station gets it');

-- ---------------------------------------------------------------------------
-- Rendering, with no frequency
-- ---------------------------------------------------------------------------

create temp table spot as select delivery_spot_json(r) as j from raw_spots r where r.content_hash = 'aprs-h1';
select is(render_push_field('frequency', (select j from spot)), null, 'push: no frequency field');
select is(render_push_field('source', (select j from spot)), 'APRS-IS', 'push: the source is APRS-IS');
select is(push_spot_fields(jsonb_populate_record(null::push_destination_settings, push_default_settings()), (select j from spot)),
  '{"push_title": "K4ABC-9", "push_body": "APRS-IS", "push_url": "/call/K4ABC", "push_source_url": null}'::jsonb,
  'push_spot_fields renders the spot without a frequency');
select is(discord_spot_fields(jsonb_populate_record(null::discord_destination_settings, discord_default_settings()),
                              (select j from spot)) ->> 'discord_title', 'K4ABC-9', 'discord_spot_fields renders it');
select is((discord_spot_fields(jsonb_populate_record(null::discord_destination_settings, discord_default_settings()),
                               (select j from spot)) ->> 'discord_color')::int, 11027200, 'in APRS-IS dark orange');
select ok(not (discord_spot_fields(jsonb_populate_record(null::discord_destination_settings,
                                     discord_default_settings() || '{"detail_fields": ["frequency", "spotter"]}'), (select j from spot))
               ->> 'discord_grid') like '%Frequency%',
  'a Discord frequency field picked shows nothing for it');
select is((select count(*) from jsonb_array_elements(
             webhook_spot_fields(jsonb_populate_record(null::webhook_destination_settings,
                                   webhook_default_settings() || '{"fields": ["callsign", "frequency", "band", "comment"]}'),
                                 (select j from spot))) e
           where e ->> 'key' like 'frequency%' and e -> 'value' <> 'null'::jsonb), 0::bigint,
  'webhook_spot_fields carries no frequency value');
select is(spot_source_url((select j from spot)), null, 'no source page for APRS-IS');

-- ---------------------------------------------------------------------------
-- Read models
-- ---------------------------------------------------------------------------

select is((select count(*) from spot_stream where source = 'aprs'), 0::bigint, 'spot_stream leaves aprs spots out');
select is((select count(*) from recent_spots where source = 'aprs'), 0::bigint, 'so does recent_spots');
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is((select count(*) from list_recent_spots('aprs', 50)), 0::bigint, 'list_recent_spots(''aprs'') returns nothing');
select is((select count from preview_subscription('{"sources":["aprs"],"rules":[[{"field":"callsign","op":"is","values":["K4ABC"]}]]}')),
  1::bigint, 'the preview counts the aprs spot for a connection that would get it');
select set_eq(
  $$ select e ->> 'source' from jsonb_array_elements(home_flow() -> 'subscription_sources') e
     where (e ->> 'subscription_id')::uuid = (select named from subs) $$,
  array['aprs'], 'home_flow lists aprs for an aprs connection that names stations');
select set_eq(
  $$ select e ->> 'source' from jsonb_array_elements(home_flow() -> 'subscription_sources') e
     where (e ->> 'subscription_id')::uuid = (select unnamed from subs) $$,
  array['pota'], 'and not for one whose groups name none');
reset role;
-- Service role only (list_callsign_groups calls it); the claims still name A.
select is((select on_air from callsign_group_rows((select id from grp))), '{"count": 0, "latest": null}'::jsonb,
  'an APRS beacon does not put a group member on the air');
insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, frequency_khz, band, raw_payload)
values ('pota', 'aprs-p1', 'aprs-p1', now(), 'K4ABC', 14062, '20m', '{}');
select is((select on_air -> 'latest' ->> 'source' from callsign_group_rows((select id from grp))), 'pota',
  'a POTA spot of the same member still does');

select * from finish();
rollback;

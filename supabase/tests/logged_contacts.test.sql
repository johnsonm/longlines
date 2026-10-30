-- pgTAP: logged contacts as a source (20261028000300): the source checks and ingest_state row,
-- every branch of apply_logged_contacts (created, unchanged, updated, retracted, unknown, created
-- again, rejected), the retraction marker in each reader (spot_stream, recent spots, the preview,
-- callsign groups' on-air check, the matcher), opt-in matching, rendering, archiving, the rollups
-- labelling the operator's role logged, access, and the state and grid a newer relay sends
-- (20261029001100).
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(81);

create function pg_temp.d(p_offset int) returns date language sql as $$
  select (now() at time zone 'utc')::date + p_offset;
$$;
create function pg_temp.at(p_offset int, p_hms text) returns timestamptz language sql as $$
  select ((pg_temp.d(p_offset))::text || ' ' || p_hms || '+00')::timestamptz;
$$;
-- One upsert item as the relay-api function sends it.
create function pg_temp.up(p_user uuid, p_ext text, p_hash text, p_spotter text, p_call text, p_khz numeric)
returns jsonb language sql as $$
  select jsonb_build_object(
    'op', 'upsert', 'external_id', p_ext, 'logger_app', 'N1MM', 'relay_version', '0.1.0',
    'spot', jsonb_build_object(
      'source', 'logged', 'source_spot_id', p_user::text || '|' || p_ext, 'content_hash', p_hash,
      'spot_time', now(), 'callsign', p_call, 'spotter', p_spotter, 'frequency_khz', p_khz,
      'band', '20m', 'mode', 'cw', 'mode_family', 'cw', 'comment', '',
      'raw_payload', jsonb_build_object('external_id', p_ext, 'call', p_call)));
$$;
create function pg_temp.del(p_ext text) returns jsonb language sql as $$
  select jsonb_build_object('op', 'delete', 'external_id', p_ext, 'logger_app', null, 'relay_version', '0.1.0',
                            'spot', null);
$$;
-- User A (KK4PWJ) applies a batch; the statuses, in order.
create function pg_temp.a(variadic p_items jsonb[]) returns text[] language sql as $$
  select array(select e ->> 'status'
               from jsonb_array_elements(apply_logged_contacts('11111111-1111-1111-1111-111111111111',
                                                               to_jsonb(p_items))) with ordinality as x(e, n)
               order by n);
$$;
create function pg_temp.spot(p_hash text) returns raw_spots language sql as $$
  select * from raw_spots where source = 'logged' and content_hash = p_hash;
$$;

delete from deliveries;
delete from raw_spots;
delete from rbn_spots;
delete from callsign_activity;
delete from callsign_reach;
delete from callsign_references;
delete from callsign_seen;
delete from callsign_variants;
delete from callsign_rollup_days;
delete from callsign_days;
delete from reference_days;
delete from callsign_rollup_failures;
delete from archive_log;
select pgmq.purge_queue('spot_events');
select pgmq.purge_queue('deliveries_queue');

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------

select ok(exists (select 1 from ingest_state where source = 'logged'), 'ingest_state has a logged row');
select ok(not exists (select 1 from cron.job where jobname like '%logged%'), 'no cron job: contacts arrive when logged');
select col_is_null('raw_spots', 'retracted_at', 'raw_spots.retracted_at is nullable');
select lives_ok($$ insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, frequency_khz, comment, raw_payload)
                   values ('logged', 'x|probe', 'probe', now(), 'W1AW', 14025, '', '{}') $$,
  'raw_spots accepts source logged');
delete from raw_spots where content_hash = 'probe';

-- ---------------------------------------------------------------------------
-- The rollups: the operator's own log counts under spotter, labelled logged
-- ---------------------------------------------------------------------------

select load_cty('test',
  '[{"prefix":"K","name":"United States","continent":"NA","cq_zone":5,"itu_zone":8,"lat":37.6,"lon":-91.87}]',
  '[{"pattern":"K","exact":false,"entity":"K","continent":"NA","cq_zone":5,"itu_zone":8},
    {"pattern":"W","exact":false,"entity":"K","continent":"NA","cq_zone":5,"itu_zone":8},
    {"pattern":"N","exact":false,"entity":"K","continent":"NA","cq_zone":5,"itu_zone":8}]');
insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, spotter, frequency_khz, band, mode,
                       mode_family, comment, raw_payload, retracted_at)
values ('logged', 'u|r1', 'r1', pg_temp.at(-3, '12:00:00'), 'W1AW', 'KK4PWJ/P', 14025, '20m', 'cw', 'cw', '', '{}', null),
       ('logged', 'u|r2', 'r2', pg_temp.at(-3, '13:00:00'), 'N4RET', 'KK4PWJ', 14026, '20m', 'cw', 'cw', '', '{}', now());
select is(rollup_callsign_day(pg_temp.d(-3)), 1::bigint, 'the roll-up counts the live contact only');
select is((select array_agg(role || ' ' || base || ' ' || source order by role, base) from callsign_activity
           where period = pg_temp.d(-3)),
  array['heard W1AW logged', 'spotter KK4PWJ logged'],
  'callsign_activity labels both sides logged: the operator as spotter, the worked call as heard');
select is((select count(*) from callsign_activity where base = 'N4RET'), 0::bigint, 'a retracted contact is in no rollup');
delete from raw_spots;
select pgmq.purge_queue('spot_events');

-- ---------------------------------------------------------------------------
-- Connections and groups, for the readers below
-- ---------------------------------------------------------------------------

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
create temp table dst as select * from create_destination('webhook', 'Hook', 'https://hooks.example.com/a');
create temp table subs as
select save_subscription(jsonb_build_object('name', 'My log', 'sources', array['logged'], 'quiet_minutes', 0,
         'destinations', array[(select id from dst)])) as logged_only,
       save_subscription(jsonb_build_object('name', 'Anything', 'quiet_minutes', 0,
         'destinations', array[(select id from dst)])) as any_source;
create temp table g_ret as select save_callsign_group('{"name":"Retracted","callsigns":["N0RET"]}') as id;
create temp table g_new as select save_callsign_group('{"name":"Live","callsigns":["N0NEW"]}') as id;
reset role;

-- ---------------------------------------------------------------------------
-- apply_logged_contacts
-- ---------------------------------------------------------------------------

select is(pg_temp.a(pg_temp.up('11111111-1111-1111-1111-111111111111', 'c1', 'h1', 'KK4PWJ', 'W1AW', 14025)),
  array['created'], 'upsert, no contact: created');
select is((select (callsign, spotter, source_spot_id, retracted_at is null)::text from pg_temp.spot('h1')),
  '(W1AW,KK4PWJ,11111111-1111-1111-1111-111111111111|c1,t)',
  'the spot: worked call as callsign, mycall as spotter, the account and the logger id as source_spot_id');
select is((select (state, content_hash, logger_app, relay_version, spot_id = (pg_temp.spot('h1')).id)::text
           from logged_contacts where external_id = 'c1'),
  '(live,h1,N1MM,0.1.0,t)', 'the contact points at its spot');

select is(pg_temp.a(pg_temp.up('11111111-1111-1111-1111-111111111111', 'c1', 'h1', 'KK4PWJ', 'W1AW', 14025)),
  array['unchanged'], 'upsert, live, same content: unchanged');
select is((select count(*) from raw_spots where source = 'logged'), 1::bigint, 'an unchanged resend stores nothing');

select is(pg_temp.a(pg_temp.up('11111111-1111-1111-1111-111111111111', 'c1', 'h2', 'KK4PWJ/P', 'W1AW', 14026)),
  array['updated'], 'upsert, live, other content: updated (a portable mycall passes the callsign check)');
select ok((pg_temp.spot('h1')).retracted_at is not null, 'the edit retracts the old spot');
select ok((pg_temp.spot('h2')).retracted_at is null, 'and stores the new one');
select is((select (state, content_hash, spot_id = (pg_temp.spot('h2')).id)::text from logged_contacts where external_id = 'c1'),
  '(live,h2,t)', 'the contact points at the new spot');

select is(pg_temp.a(pg_temp.del('c1')), array['retracted'], 'delete, live: retracted');
select ok((pg_temp.spot('h2')).retracted_at is not null, 'the delete retracts the spot');
select is((select count(*) from raw_spots where source = 'logged'), 2::bigint, 'and deletes no row');
select is((select state from logged_contacts where external_id = 'c1'), 'retracted', 'the contact is retracted');
select is(pg_temp.a(pg_temp.del('c1'), pg_temp.del('never-sent')), array['unknown', 'unknown'],
  'delete, already retracted or never sent: unknown');

select is(pg_temp.a(pg_temp.up('11111111-1111-1111-1111-111111111111', 'c1', 'h1', 'KK4PWJ', 'W1AW', 14025)),
  array['created'], 'upsert, retracted: created');
select ok((pg_temp.spot('h1')).retracted_at is null, 'content stored before comes back on its own row');
select is((select count(*) from raw_spots where source = 'logged'), 2::bigint, 'instead of a copy');
select is((select (state, retracted_at is null, spot_id = (pg_temp.spot('h1')).id)::text from logged_contacts
           where external_id = 'c1'), '(live,t,t)', 'the contact is live again');

select is(apply_logged_contacts('11111111-1111-1111-1111-111111111111', jsonb_build_array(
            pg_temp.up('11111111-1111-1111-1111-111111111111', 'c2', 'h4', 'K4XYZ', 'VE3ABC', 21074))),
  '[{"external_id": "c2", "status": "rejected", "reason": "mycall_mismatch"}]'::jsonb,
  'an upsert logged under another station''s call is rejected');
select ok(not exists (select 1 from raw_spots where content_hash = 'h4')
          and not exists (select 1 from logged_contacts where external_id = 'c2'),
  'and changes nothing');
select is(apply_logged_contacts('33333333-3333-3333-3333-333333333333', jsonb_build_array(
            pg_temp.up('33333333-3333-3333-3333-333333333333', 'c9', 'h9', 'KK4PWJ', 'W1AW', 14025),
            pg_temp.del('c9'))) #>> '{0,reason}', 'mycall_mismatch',
  'an account without a callsign can post no contact');

select is(pg_temp.a(pg_temp.del('c3'),
                    pg_temp.up('11111111-1111-1111-1111-111111111111', 'c3', 'h5', 'KK4PWJ', 'N0RET', 7030),
                    pg_temp.del('c3'),
                    pg_temp.up('11111111-1111-1111-1111-111111111111', 'c3', 'h6', 'KK4PWJ', 'N0NEW', 7031)),
  array['unknown', 'created', 'retracted', 'created'],
  'a batch applies in order, several operations for one contact included');
select is((select content_hash from logged_contacts where external_id = 'c3'), 'h6', 'the last operation wins');

select is(apply_logged_contacts('22222222-2222-2222-2222-222222222222', jsonb_build_array(
            pg_temp.up('22222222-2222-2222-2222-222222222222', 'c1', 'hb', 'W1AW', 'KK4PWJ', 14025))) #>> '{0,status}',
  'created', 'external ids are per account: another account''s c1 is a new contact');
select is((select count(*) from logged_contacts where external_id = 'c1'), 2::bigint, 'one row per account');

select throws_ok(
  $$ select apply_logged_contacts('11111111-1111-1111-1111-111111111111', '[{"op": "replace", "external_id": "c1"}]') $$,
  '22023', 'Not a logged contact item.', 'an unknown op is refused');
select throws_ok(
  $$ select apply_logged_contacts('11111111-1111-1111-1111-111111111111',
       jsonb_build_array(pg_temp.up('22222222-2222-2222-2222-222222222222', 'c1', 'hx', 'KK4PWJ', 'W1AW', 14025))) $$,
  '22023', 'Not a logged contact spot.', 'a spot must carry the caller''s own source_spot_id');
select throws_ok($$ select apply_logged_contacts(null, '[]') $$, '22023', null, 'a user is required');

select is((select total_spots_ingested from ingest_state where source = 'logged'), 6::bigint,
  'ingest_state counts the spots stored: created and updated, not unchanged');
select ok((select last_success_at > now() - interval '1 minute' from ingest_state where source = 'logged'),
  'and the time of the last request');

-- ---------------------------------------------------------------------------
-- Readers skip retracted spots
-- ---------------------------------------------------------------------------

-- Live: h1 (A's c1), h6 (A's c3), hb (B's c1). Retracted: h2, h5.
select is((select array_agg(callsign order by callsign) from spot_stream where source = 'logged'),
  array['KK4PWJ', 'N0NEW', 'W1AW'], 'spot_stream leaves out retracted spots');
select is((select count(*) from spot_stream where source = 'logged' and spotter_base = 'KK4PWJ'), 2::bigint,
  'the operator''s live contacts, by spotter base');

select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is((select array_agg(callsign order by callsign) from list_recent_spots('logged', 50)),
  array['KK4PWJ', 'N0NEW', 'W1AW'], 'list_recent_spots leaves out retracted spots');
select is((select count from preview_subscription('{"sources": ["logged"]}')), 3::bigint,
  'preview_subscription matches like the matcher: no retracted spot');
select is((select count from preview_subscription('{}')), 0::bigint, 'and an any-source preview has no logged contact');
select is((select (on_air ->> 'count')::int from list_callsign_groups() where id = (select id from g_ret)), 0,
  'callsign groups: a member whose only spot is retracted is not on the air');
select is((select on_air -> 'latest' ->> 'source' from list_callsign_groups() where id = (select id from g_new)), 'logged',
  'and a live logged contact is');
reset role;

select is(match_pending_spots(), 3, 'the matcher creates three deliveries');
select is((select array_agg(r.content_hash order by r.content_hash) from deliveries d join raw_spots r on r.id = d.spot_id
           where d.subscription_id = (select logged_only from subs)),
  array['h1', 'h6', 'hb'], 'a connection listing logged gets each live contact once, never a retracted one');
select is((select count(*) from deliveries where subscription_id = (select any_source from subs)), 0::bigint,
  'an any-source connection gets no logged contacts');

-- ---------------------------------------------------------------------------
-- Matching, rendering, archive
-- ---------------------------------------------------------------------------

select ok(not source_matches('{}', 'logged'), 'source_matches: empty sources leave out logged');
select ok(source_matches('{logged}', 'logged'), 'source_matches: sources {logged} take logged');
select is(normalize_subscription_sources('["LOGGED"]'), array['logged'], 'a connection may pick logged');

select is(push_source_label('logged'), 'Logged contacts', 'the push and Discord label');
select is(discord_source_color('logged'), 15277667, 'the Discord color');
select is(render_push_field('source', delivery_spot_json(pg_temp.spot('h1'))), 'Logged contacts', 'source: Logged contacts');
select is(render_push_field('spotter', delivery_spot_json(pg_temp.spot('h1'))), 'KK4PWJ', 'spotter: mycall as logged');

select is(archive_slice_minutes('logged'), 60, 'logged slices are an hour');
select is((select columns -> 'retracted_at' is not null and json_array_length(columns -> 'retracted_at') = 5
           from archive_columns('logged', now() - interval '1 minute', now() + interval '1 minute')),
  true, 'archive_columns writes every logged row, retracted ones with their retraction time');
select is((select count(*) from json_array_elements_text((select columns -> 'retracted_at'
           from archive_columns('logged', now() - interval '1 minute', now() + interval '1 minute'))) v
           where v is not null), 2::bigint, 'two of them retracted');
insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, frequency_khz, comment, raw_payload)
values ('pota', 'p1', 'p1', now(), 'N4DXX', 14062, '', '{}');
select ok((select columns ->> 'source' = '["pota"]' and columns -> 'retracted_at' is null
           from archive_columns('pota', now() - interval '1 minute', now() + interval '1 minute')),
  'other sources'' files are unchanged');
select ok(exists (select 1 from archive_status where source = 'logged'), 'archive_status lists logged');
select lives_ok(format('select log_archive(%L, %L, %L, 0, null, null)', 'logged',
  date_trunc('hour', now()) - interval '3 hours', date_trunc('hour', now()) - interval '2 hours'),
  'archive_log accepts logged');

-- Two requests for one new contact at once must not both store a live spot: an account's batches
-- apply one at a time, under a transaction-level advisory lock held from the first apply above.
select ok(exists (
  select 1
  from pg_locks l,
       (select hashtextextended('logged_contacts:11111111-1111-1111-1111-111111111111', 0) as k) h
  where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.granted and l.objsubid = 1
    and l.classid = ((h.k >> 32) & 4294967295)::oid and l.objid = (h.k & 4294967295)::oid),
  'apply_logged_contacts holds the account''s lock until commit');

-- ---------------------------------------------------------------------------
-- Access and account deletion
-- ---------------------------------------------------------------------------

select ok(not has_function_privilege('authenticated', 'public.apply_logged_contacts(uuid, jsonb)', 'execute')
          and not has_function_privilege('anon', 'public.apply_logged_contacts(uuid, jsonb)', 'execute'),
  'apply_logged_contacts is service role only');
select ok(not has_table_privilege('authenticated', 'logged_contacts', 'select')
          and not has_table_privilege('anon', 'logged_contacts', 'select'),
  'logged_contacts is service role only');
select ok((select relrowsecurity from pg_class where oid = 'public.logged_contacts'::regclass), 'logged_contacts has RLS on');

delete from auth.users where id = '22222222-2222-2222-2222-222222222222';
select is((select count(*) from logged_contacts where user_id = '22222222-2222-2222-2222-222222222222'), 0::bigint,
  'deleting an account deletes its contacts');
select ok(exists (select 1 from raw_spots where content_hash = 'hb'), 'and keeps their spots, like any other spot');

-- A base call two profiles share (20261029000600): N5LL/P taken after N5LL. Only the profile that
-- has held the base longest posts as it, by callsign_since: the N5LL/P account is the older one,
-- so switching an old account to a held call does not take the call over.
reset role;
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('77777777-7777-7777-7777-777777777777', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'g@example.com', '', '{"provider":"google","providers":["google"]}', '{}', now(), now()),
       ('78787878-7878-7878-7878-787878787878', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'h@example.com', '', '{"provider":"google","providers":["google"]}', '{}', now(), now());
insert into profiles (id, callsign, created_at, callsign_since)
values ('78787878-7878-7878-7878-787878787878', 'N5LL', now(), now()),
       ('77777777-7777-7777-7777-777777777777', 'N5LL/P', now() - interval '1 year', now() + interval '1 second');
select is(apply_logged_contacts('77777777-7777-7777-7777-777777777777', jsonb_build_array(
            pg_temp.up('77777777-7777-7777-7777-777777777777', 'x1', 'hx1', 'N5LL/P', 'K1ABC', 14025))) #>> '{0,reason}',
  'mycall_mismatch', 'a later profile sharing a base call cannot post as it');
select is(apply_logged_contacts('78787878-7878-7878-7878-787878787878', jsonb_build_array(
            pg_temp.up('78787878-7878-7878-7878-787878787878', 'x2', 'hx2', 'N5LL/P', 'K1ABC', 14025))) #>> '{0,status}',
  'created', 'the longest holder of the base call still can');

-- ---------------------------------------------------------------------------
-- State and grid from the relay (20261029001100): stored, never content
-- ---------------------------------------------------------------------------

create function pg_temp.sg(p_ext text, p_hash text, p_state text, p_grid text) returns jsonb language sql as $$
  select pg_temp.up('11111111-1111-1111-1111-111111111111', p_ext, p_hash, 'KK4PWJ', 'W4STA', 14030)
         || jsonb_build_object('us_state', p_state, 'gridsquare', p_grid);
$$;
create function pg_temp.sgrow(p_ext text) returns text language sql as $$
  select (coalesce(us_state, '-'), coalesce(gridsquare, '-'), content_hash)::text from logged_contacts
  where user_id = '11111111-1111-1111-1111-111111111111' and external_id = p_ext;
$$;
select col_is_null('logged_contacts', 'us_state', 'logged_contacts.us_state is nullable');
select col_is_null('logged_contacts', 'gridsquare', 'logged_contacts.gridsquare is nullable');
select is(pg_temp.a(pg_temp.sg('s1', 'hs1', 'NC', 'FM05OX')), array['created'], 'an upsert with a state and a grid');
select is(pg_temp.sgrow('s1'), '(NC,FM05OX,hs1)', 'both are stored on the contact');
select is(pg_temp.a(pg_temp.sg('s1', 'hs1', 'VA', null)), array['unchanged'], 'a resend with another state is unchanged');
select is(pg_temp.sgrow('s1'), '(VA,-,hs1)', 'and updates the stored state and grid');
select is((select count(*) from raw_spots where source = 'logged' and content_hash = 'hs1'), 1::bigint,
  'without storing another spot');
select is(pg_temp.a(pg_temp.sg('s2', 'hs2', 'nc', 'ZZ99')), array['created'], 'an upsert with a malformed state and grid');
select is(pg_temp.sgrow('s2'), '(-,-,hs2)', 'stores neither: they read as not sent');
select is(pg_temp.a(pg_temp.sg('s2', 'hs3', 'GA', 'EM73')), array['updated'], 'an edit');
select is(pg_temp.sgrow('s2'), '(GA,EM73,hs3)', 'stores the edit''s state and grid');
select throws_ok($$ update logged_contacts set us_state = 'North Carolina' where external_id = 's1' $$, '23514', null,
  'us_state is two capital letters');
select throws_ok($$ update logged_contacts set gridsquare = 'fm05' where external_id = 's1' $$, '23514', null,
  'gridsquare is a Maidenhead locator in capitals');

select * from finish();
rollback;

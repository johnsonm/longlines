-- pgTAP: client read models (recent_spots, ingest_health), service-role-only
-- tables, and the sign-in helper functions.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(31);

-- Start from empty tables so the counts below are exact: supabase/seed.sql fills
-- them on a local reset and on preview branches. The test rolls back, so the
-- seed data survives. deliveries references raw_spots without cascade.
delete from deliveries;
delete from raw_spots;
delete from rbn_spots;

-- A fresh spot and an old one.
insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, spotter, frequency_khz, band, mode, comment, pota_reference, raw_payload)
values ('pota', 't1', 'h1', now() - interval '5 minutes', 'KK4PWJ', 'W4ABC', 14062, '20m', 'cw', 'hi', 'US-2763', '{"secret":"yes"}'),
       ('pota', 't2', 'h2', now() - interval '2 days', 'N4DXX', null, 7185, '40m', 'ssb', '', 'US-0817', '{}');

-- RBN counts the whole feed in rbn_spots, not just the watched stations that
-- reach raw_spots: three spots in the last hour, one earlier today, one older.
insert into rbn_spots (spot_time, received_at, spotter, callsign, frequency_khz, snr, speed, speed_unit, spot_type, line)
select t, t, 'W3LPL', c, 14025, 10, 25, 'WPM', 'CQ', 'DX de W3LPL'
from (values (now() - interval '1 minute', 'K1AAA'), (now() - interval '10 minutes', 'K1BBB'),
             (now() - interval '50 minutes', 'K1CCC'), (now() - interval '5 hours', 'K1DDD'),
             (now() - interval '2 days', 'K1EEE')) as v(t, c);

-- The view's counts are for operators; clients get only freshness (20261015001100).
update ingest_state set last_success_at = now() - interval '2 minutes' where source = 'pota';
select is((select spots_last_hour from ingest_health where source = 'rbn'), 3::bigint,
  'RBN spots in the last hour count every rbn_spots row, not just raw_spots');
select is((select spots_last_24h from ingest_health where source = 'rbn'), 4::bigint,
  'RBN spots in the last 24 hours come from rbn_spots');

-- Read models for signed-in users.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is((select count(*) from list_recent_spots('pota', 200)), 1::bigint, 'list_recent_spots shows only the last 24 hours');
select is((select callsign from list_recent_spots('pota', 200)), 'KK4PWJ', 'list_recent_spots exposes the normalized fields');
select is((select count(*) from list_recent_spots('pota', 0)), 0::bigint, 'list_recent_spots honors max_rows');
select is((select count(*) from list_recent_spots('sotawatch', 200)), 0::bigint, 'list_recent_spots shows one source');
select is((select count(*) from list_recent_spots('rbn', 200)), 4::bigint, 'RBN recent spots are every rbn_spots row in the last 24 hours');
select is((select callsign from list_recent_spots('rbn', 1)), 'K1AAA', 'RBN recent spots are newest first');
select is((select comment from list_recent_spots('rbn', 1)), '10 dB 25 WPM CQ', 'RBN recent spots carry the comment ingest-rbn writes');
select hasnt_column('public', 'recent_spots', 'raw_payload', 'recent_spots has no raw_payload column');
select throws_ok('select * from recent_spots', '42501', null, 'recent_spots view is not readable by clients directly');
select throws_ok('delete from recent_spots', '42501', null, 'recent_spots is read-only for clients');
select throws_ok('select raw_payload from raw_spots', '42501', null, 'raw_spots is not readable by clients');
select is((select count(*) from list_ingest_health()), 6::bigint, 'list_ingest_health is callable by signed-in users (one row per source)');
select is((select seconds_since_last_success from list_ingest_health() where source = 'pota'), 120,
  'list_ingest_health reports the age of the last success');
select is(pg_get_function_result('public.list_ingest_health()'::regprocedure),
  'TABLE(source text, last_run_at timestamp with time zone, last_success_at timestamp with time zone, seconds_since_last_success integer, consecutive_failures integer, last_error text)',
  'list_ingest_health returns freshness only, no spot counts');
select throws_ok('select * from ingest_health', '42501', null, 'ingest_health view is not readable by clients directly');
select throws_ok('select * from ingest_state', '42501', null, 'ingest_state stays hidden');

-- Service-role-only tables.
select throws_ok('select * from deliveries', '42501', null, 'deliveries hidden from clients');
select throws_ok('select * from subscription_quiet', '42501', null, 'subscription_quiet hidden from clients');
select throws_ok('select * from sign_in_attempts', '42501', null, 'sign_in_attempts hidden from clients');
select throws_ok($$ select email_for_identifier('KK4PWJ') $$, '42501', null, 'email lookup not callable by clients');
select throws_ok($$ select record_sign_in_attempt('KK4PWJ') $$, '42501', null, 'attempt recording not callable by clients');

-- Anonymous users see nothing.
set local role anon;
select throws_ok('select * from recent_spots', '42501', null, 'anon cannot read recent_spots');
select throws_ok($$ select * from list_recent_spots('pota', 10) $$, '42501', null, 'anon cannot call list_recent_spots');
select throws_ok('select * from list_ingest_health()', '42501', null, 'anon cannot call list_ingest_health');
reset role;

-- Both views are invoker views, so the security linter has nothing to flag.
select is((select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'v'
           and c.relname in ('recent_spots', 'ingest_health') and 'security_invoker=true' = any(c.reloptions)),
          2::bigint, 'recent_spots and ingest_health are invoker views');

-- Service role helpers (run as the owner here; grants are checked above).
select is(email_for_identifier(' kk4pwj '), 'a@example.com', 'callsign resolves to email, case-insensitive');
select is(email_for_identifier('b@example.com'), 'b@example.com', 'email passes through');
select is(email_for_identifier('N0SUCH'), null, 'unknown callsign gives null');
select is((select record_sign_in_attempt('x') + record_sign_in_attempt('x')), 3, 'attempts accumulate within the window');

select * from finish();
rollback;

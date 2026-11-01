-- pgTAP: the outbound sender's role (20261015000200 sender_role). The role
-- may execute exactly the sender RPC allowlist and nothing else in public,
-- has no table privileges and no usage on pgmq. The allowlist gained
-- throttle_destination and delivery_queue_stats in 20261015000400, and
-- record_sender_heartbeat in 20261021000100 (the Health page), and authenticate_relay_token,
-- set_cluster_stream and reset_cluster_streams in 20261028000500 (the Local DX cluster's spots
-- stream), and pause_destination in 20261031000300 (the permanent-failure pause).
begin;
create extension if not exists pgtap with schema extensions;
select plan(23);

select ok(exists (
  select 1 from pg_roles
  where rolname = 'delivery_sender' and not rolcanlogin and rolconnlimit = 4
    and not rolsuper and not rolcreaterole and not rolcreatedb and not rolbypassrls),
  'delivery_sender exists, cannot log in, is limited to 4 connections and has no special attributes');

select set_eq(
  $$select unnest(rolconfig) from pg_roles where rolname = 'delivery_sender'$$,
  array['statement_timeout=30s', 'idle_in_transaction_session_timeout=30s', 'search_path=public'],
  'role settings: 30 s statement and idle-in-transaction timeouts, search_path public');

select ok(has_schema_privilege('delivery_sender', 'public', 'usage'), 'usage on public');

create temp view public_functions as
select p.oid, p.proname
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e');

select set_eq(
  $$select proname::text from public_functions where has_function_privilege('delivery_sender', oid, 'execute')$$,
  array['claim_deliveries', 'mark_deliveries_sent', 'mark_deliveries_failed',
        'prune_push_devices', 'record_push_results', 'throttle_destination', 'delivery_queue_stats',
        'record_sender_heartbeat', 'authenticate_relay_token', 'set_cluster_stream', 'reset_cluster_streams',
        'pause_destination'],
  'delivery_sender may execute exactly the sender RPC allowlist');

select is(
  (select count(*) from pg_tables
    where schemaname = 'public'
      and has_table_privilege('delivery_sender', format('%I.%I', schemaname, tablename),
                              'select, insert, update, delete, truncate, references, trigger')),
  0::bigint, 'no privilege on any table in public');

select is(
  (select count(*) from pg_views
    where schemaname = 'public'
      and has_table_privilege('delivery_sender', format('%I.%I', schemaname, viewname), 'select')),
  0::bigint, 'no select on any view in public');

-- pg_net grants usage on `net` to public, so that schema is not listed here.
select is(
  (select count(*) from pg_namespace
    where nspname in ('pgmq', 'partitions', 'auth', 'storage', 'vault', 'cron', 'extensions')
      and has_schema_privilege('delivery_sender', nspname, 'usage')),
  0::bigint, 'no usage on pgmq or any other internal schema');

select is(
  (select count(*) from pg_tables
    where schemaname = 'pgmq'
      and has_table_privilege('delivery_sender', format('%I.%I', schemaname, tablename),
                              'select, insert, update, delete')),
  0::bigint, 'no privilege on any pgmq table');

-- pg_net's request queue is supabase_admin's, granted to PUBLIC, and postgres cannot revoke that,
-- so this role (any role) can read every queued request. cron_call_function (20261029000500)
-- therefore sends the anon key and the cron secret, never the service-role key, once Vault holds
-- both new secrets; until then it falls back to the service-role header for the rollout.
select ok(has_table_privilege('delivery_sender', 'net.http_request_queue', 'select'),
  'the role can still read pg_net''s queue (its PUBLIC grant), so no key may be queued there');
delete from vault.secrets
where name in ('longlines_supabase_url', 'longlines_service_role_key', 'longlines_anon_key', 'longlines_cron_secret');
select vault.create_secret('http://127.0.0.1:9', 'longlines_supabase_url');
select vault.create_secret('pgtap-service-role-key', 'longlines_service_role_key');
create temp table cron_old as select public.cron_call_function('pgtap', 'ingest-pota', '{}'::jsonb, 1000) as id;
select is((select q.headers ->> 'Authorization' from net.http_request_queue q where q.id = (select id from cron_old)),
  'Bearer pgtap-service-role-key', 'without the new secrets cron still sends the service-role key (rollout)');
select vault.create_secret('pgtap-anon-key', 'longlines_anon_key');
select vault.create_secret('pgtap-cron-secret', 'longlines_cron_secret');
create temp table cron_new as select public.cron_call_function('pgtap', 'ingest-pota', '{}'::jsonb, 1000) as id;
select is((select q.headers from net.http_request_queue q where q.id = (select id from cron_new)),
  '{"Content-Type": "application/json", "Authorization": "Bearer pgtap-anon-key", "x-cron-secret": "pgtap-cron-secret"}'::jsonb,
  'with them a queued cron request carries the anon key and the cron secret');
select is(position('pgtap-service-role-key' in (select q.headers::text from net.http_request_queue q
                                                where q.id = (select id from cron_new))), 0,
  'and not the service-role key');

-- As the role. The runner's postgres user is not a superuser, so it joins the
-- role for the rest of this transaction; pgTAP lives in extensions, so the
-- role borrows usage on that schema too. Both grants roll back at the end,
-- and the assertions above already pinned that it has neither.
grant delivery_sender to current_user;
grant usage on schema extensions to delivery_sender;
set local role delivery_sender;

select lives_ok($$ select * from public.claim_deliveries(1, 60) $$, 'the role can claim');
select lives_ok($$ select public.mark_deliveries_sent(array[]::bigint[], array[]::bigint[]) $$, 'the role can ack');
select throws_ok($$ select public.throttle_destination('00000000-0000-0000-0000-000000000000', array[]::bigint[], null) $$,
  'P0001', 'Destination not found.', 'the role can throttle (the call reaches the function)');
select throws_ok($$ select public.pause_destination('00000000-0000-0000-0000-000000000000', array[]::bigint[], array[]::bigint[], 'gone') $$,
  'P0001', 'Destination not found.', 'the role can pause a destination (the call reaches the function)');
select lives_ok($$ select * from public.delivery_queue_stats() $$, 'the role can read queue stats');
select lives_ok($$ select public.record_sender_heartbeat(now(), now(), 1) $$, 'the role can report its heartbeat');
select lives_ok($$ select * from public.authenticate_relay_token(repeat('0', 64)) $$, 'the role can authenticate a relay');
select lives_ok($$ select public.set_cluster_stream('00000000-0000-0000-0000-000000000000', false),
                          public.reset_cluster_streams() $$, 'the role can set and reset relay presence');
select throws_ok($$ select count(*) from public.deliveries $$, '42501', null, 'the role cannot read deliveries');
select throws_ok($$ select * from pgmq.metrics('deliveries_queue') $$, '42501', null, 'the role cannot reach pgmq');
select throws_ok($$ select public.match_pending_spots() $$, '42501', null, 'the matcher stays service_role only');

reset role;
select * from finish();
rollback;

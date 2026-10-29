-- pgTAP: the security advisor's function lints (20261012000120 advisor_fixes).
-- Each list is the set clients may call or the advisor still reports, each
-- entry on purpose; a new function that lands in one fails here instead of in
-- the dashboard.
begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

create temp view public_functions as
select p.oid, p.proname, p.proconfig
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e');

select set_eq(
  $$select proname::text from public_functions where has_function_privilege('anon', oid, 'execute')$$,
  array[]::text[],
  'anon may execute no public function');

select set_eq(
  $$select proname::text from public_functions where has_function_privilege('authenticated', oid, 'execute')$$,
  array['complete_profile', 'create_destination', 'rotate_signing_secret', 'save_subscription',
        'delete_subscription', 'preview_subscription', 'list_ingest_health', 'list_recent_spots',
        'normalize_group_callsigns', 'save_callsign_group', 'delete_callsign_group', 'list_callsign_groups',
        'get_group_statistics', 'list_group_summaries', 'home_flow',
        'create_api_token', 'rotate_api_token', 'lookup_relay_pairing', 'answer_relay_pairing',
        'register_push_device', 'unregister_push_device', 'list_push_devices', 'delete_push_device',
        'rename_push_device', 'report_push_device_blocked', 'save_push_destination', 'get_push_destination',
        'duplicate_destination', 'preview_push_notification',
        'save_discord_destination', 'get_discord_destination', 'list_discord_destination_settings',
        'preview_discord_message',
        'save_webhook_destination', 'get_webhook_destination', 'list_webhook_destination_settings',
        'preview_webhook_request',
        'save_local_cluster_destination', 'get_local_cluster_destination', 'list_local_cluster_destination_settings',
        'preview_local_cluster_line'],
  'authenticated may execute only the client RPCs');

select set_eq(
  $$select proname::text from public_functions
    where not exists (select 1 from unnest(coalesce(proconfig, '{}')) c where c like 'search_path=%')$$,
  array['mode_bucket', 'is_self_spot', 'source_matches', 'callsign_matches', 'int_array_sum'],
  'only the inlined SQL helpers and the aggregate run without a pinned search_path');

-- Every public table has RLS on (20261017004000); service-role-only tables have
-- no policies, so a stray client grant still reads nothing.
select is_empty(
  $$select c.relname::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
      and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')$$,
  'every table in public has row level security on');

-- Revoking a new function from public is enough to close it to clients.
create function public.advisor_probe() returns int language sql as 'select 1';
revoke all on function public.advisor_probe() from public;
select ok(not has_function_privilege('anon', 'public.advisor_probe()', 'execute')
          and not has_function_privilege('authenticated', 'public.advisor_probe()', 'execute')
          and has_function_privilege('service_role', 'public.advisor_probe()', 'execute'),
  'a new function revoked from public is executable by service_role only');

-- That holds only for functions postgres owns: supabase_admin's default privileges still grant new
-- public functions to anon and authenticated, so one it created would stay callable after the
-- revoke (#133). Extension members are left out.
select is_empty(
  $$select p.proname::text || ' (' || pg_get_userbyid(p.proowner) || ')' from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proowner <> 'postgres'::regrole
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')$$,
  'every function in public is owned by postgres');

select * from finish();
rollback;

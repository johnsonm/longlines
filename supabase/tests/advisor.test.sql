-- pgTAP: the security advisor's function lints (20261012000120 advisor_fixes).
-- Each list is the set clients may call or the advisor still reports, each
-- entry on purpose; a new function that lands in one fails here instead of in
-- the dashboard.
begin;
create extension if not exists pgtap with schema extensions;
select plan(4);

create temp view public_functions as
select p.oid, p.proname, p.proconfig
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e');

select set_eq(
  $$select proname::text from public_functions where has_function_privilege('anon', oid, 'execute')$$,
  array['callsign_available'],
  'anon may execute only the sign-up callsign check');

select set_eq(
  $$select proname::text from public_functions where has_function_privilege('authenticated', oid, 'execute')$$,
  array['callsign_available', 'create_destination', 'rotate_signing_secret', 'save_subscription',
        'delete_subscription', 'preview_subscription', 'list_ingest_health', 'list_recent_spots',
        'normalize_group_callsigns', 'save_callsign_group', 'delete_callsign_group', 'list_callsign_groups',
        'create_api_token', 'rotate_api_token'],
  'authenticated may execute only the client RPCs');

select set_eq(
  $$select proname::text from public_functions
    where not exists (select 1 from unnest(coalesce(proconfig, '{}')) c where c like 'search_path=%')$$,
  array['mode_bucket', 'is_self_spot', 'spot_matches', 'source_matches', 'callsign_matches', 'int_array_sum'],
  'only the inlined SQL helpers and the aggregate run without a pinned search_path');

-- Revoking a new function from public is enough to close it to clients.
create function public.advisor_probe() returns int language sql as 'select 1';
revoke all on function public.advisor_probe() from public;
select ok(not has_function_privilege('anon', 'public.advisor_probe()', 'execute')
          and not has_function_privilege('authenticated', 'public.advisor_probe()', 'execute')
          and has_function_privilege('service_role', 'public.advisor_probe()', 'execute'),
  'a new function revoked from public is executable by service_role only');

select * from finish();
rollback;

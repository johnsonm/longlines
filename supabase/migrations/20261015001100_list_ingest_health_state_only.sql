-- list_ingest_health() reads ingest_state only.
--
-- The Sources pages time out ("canceling statement due to statement timeout")
-- because list_ingest_health() returned the whole ingest_health view, whose
-- spots_last_hour / spots_last_24h count rbn_spots and aprs_packets: hundreds of
-- thousands of rows per call. Warm it takes about half a second; on a cold cache
-- or beside the hourly rollups it reaches the authenticated role's 8 s limit.
-- The web reads only seconds_since_last_success, so the RPC drops the counts.
-- The view keeps them for operators (docs/OPERATIONS.md).
--
-- The return type changes, so the function is dropped and recreated with its
-- grants.

drop function public.list_ingest_health();

create function public.list_ingest_health()
returns table (
  source text,
  last_run_at timestamptz,
  last_success_at timestamptz,
  seconds_since_last_success int,
  consecutive_failures int,
  last_error text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.source,
    s.last_run_at,
    s.last_success_at,
    extract(epoch from (now() - s.last_success_at))::int,
    s.consecutive_failures,
    s.last_error
  from ingest_state s
  order by s.source;
$$;

revoke all on function public.list_ingest_health() from public, anon, authenticated;
grant execute on function public.list_ingest_health() to authenticated;

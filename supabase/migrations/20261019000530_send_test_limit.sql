-- A rate limit on the web app's Send test (REVIEW.md, "Edge Function
-- handlers" #4). Only the management API's test was capped (60 a minute per
-- token, api_call), so a signed-in user could loop Send test against a
-- Discord webhook from Supabase's shared egress.
--
-- record_send_test counts one test per destination per minute window, as
-- record_profile_lookup does for lookups, and answers whether it may go: at
-- most 10 a minute per destination and 30 a minute per account. The send-test
-- function calls it before sending; housekeeping prunes old windows
-- (20261019000540). Service role only, like lookup_rate_limits.

create table send_test_limits (
  destination_id uuid        not null references destinations(id) on delete cascade,
  window_start   timestamptz not null,
  user_id        uuid        not null references auth.users(id) on delete cascade,
  tests          int         not null,
  primary key (destination_id, window_start)
);

create index send_test_limits_user_window_idx on send_test_limits (user_id, window_start);

alter table send_test_limits enable row level security;
revoke all on send_test_limits from anon, authenticated;

create function public.send_test_destination_limit() returns int language sql immutable
set search_path = '' as 'select 10';
create function public.send_test_account_limit() returns int language sql immutable
set search_path = '' as 'select 30';

-- Records one test of p_destination_id by p_user_id and answers true when it
-- is within both limits. A destination the user does not own answers null
-- and records nothing (the caller then answers 404). A refused test still
-- counts, so a client that keeps retrying stays refused for the minute.
create function public.record_send_test(p_user_id uuid, p_destination_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window  timestamptz := date_trunc('minute', now());
  v_tests   int;
  v_account bigint;
begin
  if not exists (select 1 from destinations d where d.id = p_destination_id and d.user_id = p_user_id) then
    return null;
  end if;
  -- One account's tests are counted one at a time.
  perform pg_advisory_xact_lock(hashtextextended('send_test:' || p_user_id::text, 0));
  insert into send_test_limits (destination_id, window_start, user_id, tests)
  values (p_destination_id, v_window, p_user_id, 1)
  on conflict (destination_id, window_start) do update set tests = send_test_limits.tests + 1
  returning tests into v_tests;
  select coalesce(sum(l.tests), 0) into v_account
  from send_test_limits l
  where l.user_id = p_user_id and l.window_start = v_window;
  return v_tests <= public.send_test_destination_limit() and v_account <= public.send_test_account_limit();
end;
$$;

revoke all on function public.send_test_destination_limit() from public, anon, authenticated;
revoke all on function public.send_test_account_limit() from public, anon, authenticated;
revoke all on function public.record_send_test(uuid, uuid) from public, anon, authenticated;
grant execute on function public.record_send_test(uuid, uuid) to service_role;

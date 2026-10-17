-- Sign-in rate limiting per (identifier, client), counting failures only.
--
-- record_sign_in_attempt counted every attempt per identifier, successes too,
-- so anyone could keep a callsign's owner locked out with one bad request
-- every 90 seconds, and a user re-checking their own password locked
-- themselves out. Now each attempt carries the client (an HMAC of the
-- caller's address, built by the sign-in function as callsign-profile builds
-- its key) and:
--   * begin_sign_in_attempt refuses (null) once that client has 10 attempts
--     on the identifier in 15 minutes, or the identifier has 100 from all
--     clients, so distributed guessing stays bounded; otherwise it logs the
--     attempt and returns its id;
--   * forget_sign_in_attempt deletes the row again when the password turned
--     out right (or was never checked), so only failures stay counted.
-- A refused attempt is not logged, so one client hammering an identifier
-- cannot push it to the shared ceiling on its own.
--
-- run_housekeeping keeps deleting by attempted_at; identifier and attempted_at
-- are unchanged.

-- The old rows have no client and include successes; they are a rate-limit
-- log at most a day old, so start clean.
delete from sign_in_attempts;

alter table sign_in_attempts add column client text not null;

create index sign_in_attempts_identifier_client_idx
  on sign_in_attempts (identifier, client, attempted_at desc);

drop function public.record_sign_in_attempt(text);

-- Logs an attempt and returns its id, or null when the client or the
-- identifier is over its limit (nothing is logged then).
create function public.begin_sign_in_attempt(p_identifier text, p_client text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text := lower(trim(p_identifier));
  v_since timestamptz := now() - interval '15 minutes';
  v_id bigint;
begin
  -- Serialise attempts on one identifier so concurrent requests cannot all
  -- pass the counts before any of them is logged.
  perform pg_advisory_xact_lock(hashtextextended('sign_in_attempts:' || v_key, 0));
  if (select count(*) from sign_in_attempts a
      where a.identifier = v_key and a.client = p_client and a.attempted_at > v_since) >= 10
     or (select count(*) from sign_in_attempts a
         where a.identifier = v_key and a.attempted_at > v_since) >= 100 then
    return null;
  end if;
  insert into sign_in_attempts (identifier, client) values (v_key, p_client)
  returning id into v_id;
  return v_id;
end;
$$;

-- Removes an attempt that was not a wrong password.
create function public.forget_sign_in_attempt(p_attempt_id bigint)
returns void
language sql
security definer
set search_path = public
as $$
  delete from sign_in_attempts where id = p_attempt_id;
$$;

revoke all on function public.begin_sign_in_attempt(text, text) from public, anon, authenticated;
revoke all on function public.forget_sign_in_attempt(bigint) from public, anon, authenticated;
grant execute on function public.begin_sign_in_attempt(text, text) to service_role;
grant execute on function public.forget_sign_in_attempt(bigint) to service_role;

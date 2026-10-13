-- cached_callsign_profile (20261012000130, applied and so not edited): two
-- fixes to the build lock.
--
-- The wait is capped at 2 s. A waiter used to queue for as long as the builder
-- ran, and the wait counted against its own statement timeout (8 s through the
-- API). When a build failed or was cancelled at that timeout, each waiter in
-- turn started its own build with the budget already spent, so every request
-- for the call failed. A build takes well under a second at hosted scale; a
-- longer wait means that build is slow or stuck, and the waiter builds its own
-- as it did before 20261012000130.
--
-- The hidden check runs again after the wait. A call hidden while a request
-- waited used to be served from the entry the builder had just cached.
--
-- One loop holds the hidden check and the cache read, so the two passes
-- cannot drift apart.

create or replace function public.cached_callsign_profile(p_callsign text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base         text := public.base_callsign(p_callsign);
  v_lock_timeout text := current_setting('lock_timeout');
  v_payload      jsonb;
begin
  for v_pass in 1..2 loop
    if exists (select 1 from hidden_callsigns h where h.callsign = v_base) then
      return public.callsign_profile(p_callsign);
    end if;

    select c.payload into v_payload
    from callsign_profile_cache c
    where c.callsign = v_base and c.generated_at > now() - interval '15 minutes';
    if found then
      return v_payload;
    end if;

    exit when v_pass = 2;

    -- Held until this request commits, after the upsert below. Each statement
    -- takes a new snapshot, so the second pass sees what a builder committed.
    perform set_config('lock_timeout', '2s', true);
    begin
      perform pg_advisory_xact_lock(hashtext('callsign_profile_cache'), hashtext(v_base));
    exception when lock_not_available then
      null;
    end;
    perform set_config('lock_timeout', v_lock_timeout, true);
  end loop;

  v_payload := public.callsign_profile(p_callsign);
  if v_payload is null then
    return null;
  end if;
  insert into callsign_profile_cache (callsign, payload, generated_at)
  values (v_base, v_payload, now())
  on conflict (callsign) do update set payload = excluded.payload, generated_at = excluded.generated_at;
  return v_payload;
end;
$$;

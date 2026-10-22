-- The profile cache's freshness in one place (#134). cached_callsign_profile serves an entry
-- younger than profile_cache_ttl() and prune_callsign_lookups deletes the rest; both wrote out
-- 15 minutes before, so changing one alone would prune entries the cache still serves, or keep
-- ones it never will. cached_callsign_profile is 20261013000310's and prune_callsign_lookups
-- 20261012000060's, with only that change. Same signatures, so the grants carry over.

create function public.profile_cache_ttl()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '15 minutes' $$;

revoke all on function public.profile_cache_ttl() from public;

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
    where c.callsign = v_base and c.generated_at > now() - public.profile_cache_ttl();
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

create or replace function public.prune_callsign_lookups()
returns void
language sql
security definer
set search_path = public
as $$
  delete from lookup_rate_limits where window_start < date_trunc('minute', now());
  delete from callsign_profile_cache where generated_at <= now() - public.profile_cache_ttl();
$$;

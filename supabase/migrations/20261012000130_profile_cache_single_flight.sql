-- cached_callsign_profile (20261012000060, applied and so not edited): one
-- build per call at a time. Before, every request that missed the cache built
-- the profile itself, so a shared link or an expiring popular entry ran the
-- same multi-scan build once per concurrent request. A miss now takes a
-- transaction-scoped advisory lock on the base call and checks the cache again
-- once it has it: the first request builds and caches, the rest wait for its
-- commit and serve that entry. Hidden calls are never cached and skip the lock.

create or replace function public.cached_callsign_profile(p_callsign text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base    text := public.base_callsign(p_callsign);
  v_payload jsonb;
begin
  if exists (select 1 from hidden_callsigns h where h.callsign = v_base) then
    return public.callsign_profile(p_callsign);
  end if;

  select c.payload into v_payload
  from callsign_profile_cache c
  where c.callsign = v_base and c.generated_at > now() - interval '15 minutes';
  if found then
    return v_payload;
  end if;

  -- Held until this request commits, after the upsert below. Each statement
  -- takes a new snapshot, so the second read sees an entry a waiter committed.
  perform pg_advisory_xact_lock(hashtext('callsign_profile_cache'), hashtext(v_base));
  select c.payload into v_payload
  from callsign_profile_cache c
  where c.callsign = v_base and c.generated_at > now() - interval '15 minutes';
  if found then
    return v_payload;
  end if;

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

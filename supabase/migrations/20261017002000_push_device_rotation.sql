-- register_push_device follows an endpoint the push service rotated.
--
-- On pushsubscriptionchange the browser re-subscribes with a new endpoint and
-- the app re-registers it. Upserting by endpoint alone made that a new
-- device in no push destination, while the old row kept the memberships and
-- was pruned on its first 410, so the user stopped receiving everything.
-- The app now also sends the endpoint it remembers (p_previous_endpoint):
-- when that is one of the caller's own devices and the new endpoint is not
-- registered yet, the device takes the new endpoint and keys in place,
-- keeping its id, name, descriptor and destinations. Another account's
-- endpoint never matches. Otherwise the behavior is 20261016000400's.

drop function public.register_push_device(text, text, text, text, text, boolean);
create function public.register_push_device(
  p_endpoint text, p_p256dh text, p_auth text, p_label text,
  p_agent text default null, p_standalone boolean default null,
  p_previous_endpoint text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_p256dh bytea := public.base64url_bytes(p_p256dh);
  v_auth bytea := public.base64url_bytes(p_auth);
  v_label text := left(coalesce(nullif(trim(p_label), ''), 'This browser'), 60);
  v_agent text := left(coalesce(trim(p_agent), ''), 60);
  v_id uuid;
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  perform public.validate_push_endpoint(p_endpoint);
  if v_p256dh is null or length(v_p256dh) <> 65 or get_byte(v_p256dh, 0) <> 4
     or v_auth is null or length(v_auth) <> 16 then
    raise exception 'That browser sent an invalid subscription.';
  end if;
  -- Serializes one account's registrations, so two new browsers at once
  -- cannot both pass the cap.
  perform pg_advisory_xact_lock(hashtextextended('push_devices:' || v_user::text, 0));

  -- A rotated endpoint: the caller's own device moves to the new one. Ahead
  -- of the cap, since the device count does not change.
  if nullif(trim(p_previous_endpoint), '') is not null and trim(p_previous_endpoint) <> trim(p_endpoint)
     and not exists (select 1 from push_devices p where p.endpoint = trim(p_endpoint)) then
    update push_devices p
    set endpoint      = trim(p_endpoint),
        p256dh        = rtrim(p_p256dh, '='),
        auth          = rtrim(p_auth, '='),
        label         = case when p_label is null then p.label else v_label end,
        agent         = case when p_agent is null then p.agent else v_agent end,
        standalone    = coalesce(p_standalone, p.standalone),
        last_error    = null,
        last_error_at = null,
        blocked_at    = null
    where p.user_id = v_user and p.endpoint = trim(p_previous_endpoint)
    returning p.id into v_id;
    if v_id is not null then
      return v_id;
    end if;
  end if;

  if (select count(*) from push_devices p where p.user_id = v_user and p.endpoint <> trim(p_endpoint)) >= 20 then
    raise exception 'You can turn on notifications on up to 20 devices. Remove one first.';
  end if;

  insert into push_devices as p (user_id, endpoint, p256dh, auth, label, agent, standalone)
  values (v_user, trim(p_endpoint), rtrim(p_p256dh, '='), rtrim(p_auth, '='), v_label, v_agent,
          coalesce(p_standalone, false))
  on conflict (endpoint) do update
  set user_id         = excluded.user_id,
      p256dh          = excluded.p256dh,
      auth            = excluded.auth,
      label           = case when p_label is null and p.user_id = excluded.user_id then p.label else excluded.label end,
      agent           = case when p_agent is null and p.user_id = excluded.user_id then p.agent else excluded.agent end,
      standalone      = case when p_standalone is null and p.user_id = excluded.user_id then p.standalone else excluded.standalone end,
      created_at      = case when p.user_id = excluded.user_id then p.created_at else now() end,
      last_success_at = case when p.user_id = excluded.user_id then p.last_success_at end,
      last_error      = null,
      last_error_at   = null,
      blocked_at      = null
  returning p.id into v_id;

  delete from push_destination_devices m
  using destinations d
  where m.device_id = v_id and d.id = m.destination_id and d.user_id <> v_user;
  return v_id;
end;
$$;

revoke all on function public.register_push_device(text, text, text, text, text, boolean, text) from public;
grant execute on function public.register_push_device(text, text, text, text, text, boolean, text) to authenticated;

-- Push notifications: a third destination type that fans out to every browser
-- where its owner turned notifications on. See
-- docs/superpowers/specs/2026-10-13-push-notifications-design.md.
--
-- One push destination per account, with no URL. Devices live in
-- push_devices, which only the service role can read: an endpoint is a
-- capability URL and p256dh/auth decrypt-and-send keys, so no client read ever
-- returns them. The worker POSTs to an endpoint a client chose, so endpoints
-- must be https on a known push-service host (validate_push_endpoint here and
-- assertSafePushEndpoint in _shared/delivery/urlsafety.ts; change both together).

-- ---------------------------------------------------------------------------
-- Destinations
-- ---------------------------------------------------------------------------

alter table destinations drop constraint destinations_type_check;
alter table destinations add constraint destinations_type_check
  check (type in ('discord', 'webhook', 'push'));
alter table destinations alter column url drop not null;
alter table destinations add constraint destinations_push_has_no_url
  check ((type = 'push') = (url is null));

create unique index destinations_one_push_per_user on destinations (user_id) where type = 'push';

-- Same as 20261006000002 plus push, which must not have a URL.
create or replace function public.validate_destination_url(p_type text, p_url text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_parts text[];
begin
  if p_type not in ('discord', 'webhook', 'push') then
    raise exception 'Unknown destination type.';
  end if;
  if p_type = 'push' then
    if p_url is not null then
      raise exception 'Push notifications don''t use a URL.';
    end if;
    return;
  end if;
  v_parts := public.parse_https_url(p_url);
  if v_parts is null then
    raise exception 'Use an https URL.';
  end if;
  if p_type = 'discord' then
    if v_parts[1] not in ('discord.com', 'discordapp.com') or v_parts[3] not like '/api/webhooks/%' then
      raise exception 'Use a Discord webhook URL.';
    end if;
  else
    if public.is_private_host(v_parts[1]) then
      raise exception 'That address is not allowed.';
    end if;
  end if;
end;
$$;

-- Same as 20261006000002 plus push's fixed "Your devices".
create or replace function public.destination_url_display(p_type text, p_url text)
returns text
language sql
immutable
set search_path = ''
as $$
  with p as (select public.parse_https_url(p_url) as parts),
       d as (select regexp_match(parts[3], '^/api/webhooks/([^/]+)/([^/]*)') as m, parts from p)
  select case
    when p_type = 'push' then 'Your devices'
    when p_type = 'discord' then
      'https://' || parts[1] || '/api/webhooks/' || left(coalesce(m[1], ''), 4) || '…/' || left(coalesce(m[2], ''), 3)
    else 'https://' || parts[1] || parts[2] || parts[3]
  end
  from d;
$$;

-- Same as 20261006000002, except a second push destination gets a message
-- instead of the unique index's error. Push gets no URL and no secret.
create or replace function public.create_destination(p_type text, p_name text, p_url text)
returns table (id uuid, type text, name text, url_display text, health text, created_at timestamptz, signing_secret text)
language plpgsql
security definer
set search_path = public, extensions
as $$
#variable_conflict use_column
declare
  v_user uuid := auth.uid();
  v_id uuid;
  v_secret text;
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'Give the destination a name.';
  end if;
  perform public.validate_destination_url(p_type, p_url);
  if p_type = 'webhook' then
    v_secret := 'whsec_' || encode(gen_random_bytes(24), 'hex');
  end if;
  begin
    insert into destinations (user_id, type, name, url, url_display, signing_secret)
    values (v_user, p_type, trim(p_name), trim(p_url), public.destination_url_display(p_type, p_url), v_secret)
    returning destinations.id into v_id;
  exception when unique_violation then
    raise exception 'You already have push notifications.';
  end;
  return query
    select d.id, d.type, d.name, d.url_display, d.health, d.created_at, d.signing_secret
    from destinations d where d.id = v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Devices
-- ---------------------------------------------------------------------------

create table push_devices (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  endpoint         text not null unique,   -- secret: a capability URL
  p256dh           text not null,          -- secret
  auth             text not null,          -- secret
  label            text not null,
  created_at       timestamptz not null default now(),
  last_success_at  timestamptz,
  last_error       text,
  last_error_at    timestamptz
);

create index push_devices_user_id_idx on push_devices (user_id);

alter table push_devices enable row level security;
revoke all on push_devices from anon, authenticated;

-- Raises unless the endpoint is https on a browser push service, with no port
-- or credentials. Suffixes keep their leading dot, so evilpush.apple.com fails.
create function public.validate_push_endpoint(p_endpoint text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_parts text[] := public.parse_https_url(p_endpoint);
  v_host text := v_parts[1];
begin
  if v_parts is null or v_parts[2] <> '' or v_host !~ '^[a-z0-9.-]+$'
     or not (v_host in ('fcm.googleapis.com', 'updates.push.services.mozilla.com')
             or v_host like '%.push.apple.com' or v_host like '%.notify.windows.com') then
    raise exception 'Use a browser push service.';
  end if;
end;
$$;

-- Bytes of a base64url string (padding optional), or null when it is not one.
create function public.base64url_bytes(p_text text)
returns bytea
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := rtrim(coalesce(p_text, ''), '=');
begin
  if v !~ '^[A-Za-z0-9_-]+$' then
    return null;
  end if;
  return decode(translate(v, '-_', '+/') || repeat('=', (4 - length(v) % 4) % 4), 'base64');
exception when others then
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Client RPCs
-- ---------------------------------------------------------------------------

-- Turn notifications on for one browser. Upserts by endpoint: a browser that
-- moves to another account is reassigned to the caller with its status
-- cleared. Creates the account's push destination on first use (named
-- p_name, else "Push notifications") and returns its id.
create function public.register_push_device(
  p_endpoint text, p_p256dh text, p_auth text, p_label text, p_name text default null)
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
  if (select count(*) from push_devices p where p.user_id = v_user and p.endpoint <> trim(p_endpoint)) >= 20 then
    raise exception 'You can turn on notifications on up to 20 devices. Remove one first.';
  end if;

  insert into destinations (user_id, type, name, url, url_display)
  values (v_user, 'push', coalesce(nullif(trim(p_name), ''), 'Push notifications'), null,
          public.destination_url_display('push', null))
  on conflict (user_id) where type = 'push' do nothing;
  select d.id into v_id from destinations d where d.user_id = v_user and d.type = 'push';

  insert into push_devices as p (user_id, endpoint, p256dh, auth, label)
  values (v_user, trim(p_endpoint), rtrim(p_p256dh, '='), rtrim(p_auth, '='), v_label)
  on conflict (endpoint) do update
  set user_id         = excluded.user_id,
      p256dh          = excluded.p256dh,
      auth            = excluded.auth,
      label           = excluded.label,
      created_at      = case when p.user_id = excluded.user_id then p.created_at else now() end,
      last_success_at = case when p.user_id = excluded.user_id then p.last_success_at end,
      last_error      = null,
      last_error_at   = null;
  return v_id;
end;
$$;

-- Turn notifications off for one browser (sign-out, "Turn off"). Silent when
-- the caller has no such device.
create function public.unregister_push_device(p_endpoint text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;
  delete from push_devices p where p.user_id = auth.uid() and p.endpoint = trim(p_endpoint);
end;
$$;

-- The caller's devices, newest first. Labels and status only: never the
-- endpoint or the keys. is_current marks the row for p_current_endpoint.
create function public.list_push_devices(p_current_endpoint text default null)
returns table (id uuid, label text, created_at timestamptz, last_success_at timestamptz,
               last_error text, last_error_at timestamptz, is_current boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;
  return query
    select p.id, p.label, p.created_at, p.last_success_at, p.last_error, p.last_error_at,
           coalesce(p.endpoint = trim(p_current_endpoint), false)
    from push_devices p
    where p.user_id = auth.uid()
    order by p.created_at desc, p.id;
end;
$$;

create function public.delete_push_device(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;
  delete from push_devices p where p.id = p_id and p.user_id = auth.uid();
  if not found then
    raise exception 'Device not found.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Worker RPCs (service role)
-- ---------------------------------------------------------------------------

-- Subscriptions a push service answered 404/410 for: gone for good.
create function public.prune_push_devices(p_endpoints text[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  delete from push_devices p where p.endpoint = any (p_endpoints);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Per-device status after a send: p_ok endpoints took every notification;
-- p_errors is {endpoint: message}.
create function public.record_push_results(p_ok text[], p_errors jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update push_devices p
  set last_success_at = now(), last_error = null, last_error_at = null
  where p.endpoint = any (p_ok);
  update push_devices p
  set last_error = left(e.value, 500), last_error_at = now()
  from jsonb_each_text(coalesce(p_errors, '{}'::jsonb)) e
  where p.endpoint = e.key;
end;
$$;

-- claim_deliveries: same as 20261006000014 plus base_callsign in the spot and,
-- for push, the owner's devices (one push destination per account, so the
-- owner's devices are the destination's).
create or replace function public.claim_deliveries(p_limit int default 200, p_vt int default 60)
returns table (
  msg_id bigint, delivery_id bigint, subscription_id uuid, attempts int, created_at timestamptz,
  destination jsonb, spot jsonb
)
language plpgsql
security definer
set search_path = public, pgmq
as $$
declare
  v_msgs    jsonb;
  v_orphans bigint[];
begin
  select jsonb_agg(jsonb_build_object('msg_id', m.msg_id, 'delivery_id', (m.message ->> 'delivery_id')::bigint))
    into v_msgs
  from pgmq.read('deliveries_queue', p_vt, p_limit) m;

  if v_msgs is null then
    return;
  end if;

  select array_agg((x ->> 'msg_id')::bigint) into v_orphans
  from jsonb_array_elements(v_msgs) x
  where not exists (select 1 from deliveries d where d.id = (x ->> 'delivery_id')::bigint);
  if v_orphans is not null then
    perform pgmq.archive('deliveries_queue', v_orphans);
  end if;

  return query
    select
      (x ->> 'msg_id')::bigint,
      d.id, d.subscription_id, d.attempts, d.created_at,
      jsonb_build_object(
        'id', dest.id, 'type', dest.type, 'name', dest.name, 'url', dest.url,
        'signing_secret', dest.signing_secret, 'health', dest.health,
        'consecutive_failures', dest.consecutive_failures
      ) || case when dest.type = 'push' then jsonb_build_object('devices', dv.devices) else '{}'::jsonb end,
      jsonb_build_object(
        'id', r.id, 'source', r.source, 'spot_time', r.spot_time, 'callsign', r.callsign,
        'base_callsign', r.base_callsign,
        'spotter', r.spotter, 'frequency_khz', r.frequency_khz, 'band', r.band, 'mode', r.mode,
        'mode_family', r.mode_family,
        'comment', r.comment, 'pota_reference', r.pota_reference, 'pota_park_name', r.pota_park_name,
        'pota_location', r.pota_location, 'sota_summit_ref', r.sota_summit_ref
      )
    from jsonb_array_elements(v_msgs) x
    join deliveries d on d.id = (x ->> 'delivery_id')::bigint
    join destinations dest on dest.id = d.destination_id
    join raw_spots r on r.id = d.spot_id
    cross join lateral (
      select coalesce(jsonb_agg(jsonb_build_object('endpoint', p.endpoint, 'p256dh', p.p256dh, 'auth', p.auth)
                                order by p.created_at, p.id), '[]'::jsonb) as devices
      from push_devices p
      where dest.type = 'push' and p.user_id = dest.user_id
    ) dv
    order by d.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

revoke all on function public.validate_push_endpoint(text) from public;
revoke all on function public.base64url_bytes(text) from public;
revoke all on function public.register_push_device(text, text, text, text, text) from public;
revoke all on function public.unregister_push_device(text) from public;
revoke all on function public.list_push_devices(text) from public;
revoke all on function public.delete_push_device(uuid) from public;
revoke all on function public.prune_push_devices(text[]) from public;
revoke all on function public.record_push_results(text[], jsonb) from public;
grant execute on function public.register_push_device(text, text, text, text, text) to authenticated;
grant execute on function public.unregister_push_device(text) to authenticated;
grant execute on function public.list_push_devices(text) to authenticated;
grant execute on function public.delete_push_device(uuid) to authenticated;

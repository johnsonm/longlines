-- Management API: personal API tokens and the SQL behind the `api` Edge
-- Function (docs/API.md).
--
-- A token is "ll_live_" plus 52 base32 characters (260 random bits). Only its
-- SHA-256 is stored, with the first 12 characters ("ll_live_7hq2") kept to tell
-- tokens apart; the plaintext is returned once, by create_api_token or
-- rotate_api_token, the same way create_destination returns a signing secret.
-- Random tokens that long need no slow hash.
--
-- The Edge Function authenticates a request with authenticate_api_request and
-- then runs one operation through api_call, which acts as the token's owner by
-- setting the request's JWT claims for the transaction and calling the same
-- RPCs the web app calls. Validation, ownership checks and messages therefore
-- live in one place for both clients.

create table api_tokens (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  name           text not null check (name = trim(name) and name <> ''),
  scope          text not null check (scope in ('read', 'write')),
  token_hash     text not null unique,          -- secret; never granted
  token_prefix   text not null,                 -- first 12 characters, for display
  lifetime_days  int check (lifetime_days in (30, 90, 365)),  -- null = never expires
  expires_at     timestamptz,
  created_at     timestamptz not null default now(),
  rotated_at     timestamptz,
  last_used_at   timestamptz
);

create index api_tokens_user_id_idx on api_tokens (user_id);

-- Requests per token per minute. authenticate_api_request drops a token's
-- earlier windows as it opens a new one, so no cron job is needed.
create table api_rate_limits (
  token_id      uuid        not null references api_tokens(id) on delete cascade,
  window_start  timestamptz not null,
  requests      int         not null,
  primary key (token_id, window_start)
);

-- Access: own tokens readable without the hash; delete is the only direct
-- write. api_rate_limits is service-role only (RLS on, no policies).
alter table api_tokens enable row level security;
alter table api_rate_limits enable row level security;

revoke all on api_tokens, api_rate_limits from anon, authenticated;
grant select (id, user_id, name, scope, token_prefix, lifetime_days, expires_at, created_at,
              rotated_at, last_used_at)
  on api_tokens to authenticated;
grant delete on api_tokens to authenticated;

create policy api_tokens_select_own on api_tokens
  for select to authenticated using (user_id = (select auth.uid()));
create policy api_tokens_delete_own on api_tokens
  for delete to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Token RPCs (web app)
-- ---------------------------------------------------------------------------

-- "ll_live_" plus 52 characters of a-z2-7, five random bits each (a 32-letter
-- alphabet, so masking a byte to five bits is unbiased).
create function public.new_api_token()
returns text
language sql
volatile
set search_path = public, extensions
as $$
  select 'll_live_' || string_agg(substr('abcdefghijklmnopqrstuvwxyz234567', (get_byte(r.b, i) & 31) + 1, 1), '' order by i)
  from (select gen_random_bytes(52) as b) r, generate_series(0, 51) as i;
$$;

create function public.create_api_token(p_name text, p_scope text, p_lifetime_days int default null)
returns table (id uuid, name text, scope text, token_prefix text, lifetime_days int,
               expires_at timestamptz, created_at timestamptz, token text)
language plpgsql
security definer
set search_path = public, extensions
as $$
#variable_conflict use_column
declare
  v_user  uuid := auth.uid();
  v_name  text := trim(coalesce(p_name, ''));
  v_token text := public.new_api_token();
  v_id    uuid;
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  if v_name = '' then
    raise exception 'Give the token a name.';
  end if;
  if p_scope is null or p_scope not in ('read', 'write') then
    raise exception 'Pick what the token can do.';
  end if;
  if p_lifetime_days is not null and p_lifetime_days not in (30, 90, 365) then
    raise exception 'Pick when the token expires.';
  end if;
  -- Serializes one user's creates so two at once cannot pass the cap together.
  perform pg_advisory_xact_lock(hashtextextended('api_tokens:' || v_user::text, 0));
  if (select count(*) from api_tokens t where t.user_id = v_user) >= 10 then
    raise exception 'You can have up to 10 tokens. Delete one first.';
  end if;
  insert into api_tokens (user_id, name, scope, token_hash, token_prefix, lifetime_days, expires_at)
  values (v_user, v_name, p_scope, encode(digest(v_token, 'sha256'), 'hex'), left(v_token, 12),
          p_lifetime_days, now() + make_interval(days => p_lifetime_days))
  returning api_tokens.id into v_id;
  return query
    select t.id, t.name, t.scope, t.token_prefix, t.lifetime_days, t.expires_at, t.created_at, v_token
    from api_tokens t where t.id = v_id;
end;
$$;

-- A new secret for the same token: the old one stops working at once, and the
-- expiry window starts again from now.
create function public.rotate_api_token(p_id uuid)
returns table (token_prefix text, expires_at timestamptz, token text)
language plpgsql
security definer
set search_path = public, extensions
as $$
#variable_conflict use_column
declare
  v_token text := public.new_api_token();
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;
  return query
    update api_tokens t
    set token_hash   = encode(digest(v_token, 'sha256'), 'hex'),
        token_prefix = left(v_token, 12),
        expires_at   = now() + make_interval(days => t.lifetime_days),
        rotated_at   = now(),
        last_used_at = null
    where t.id = p_id and t.user_id = auth.uid()
    returning t.token_prefix, t.expires_at, v_token;
  if not found then
    raise exception 'Token not found.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Operations the web app does not have yet. They act as auth.uid() like the
-- client RPCs, but only api_call runs them.
-- ---------------------------------------------------------------------------

-- Rename a destination and/or change its URL (null keeps the current value).
-- The type cannot change. A new URL is checked and masked like a new destination.
create function public.update_destination(p_id uuid, p_name text, p_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_type text;
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  select d.type into v_type from destinations d where d.id = p_id and d.user_id = v_user for update;
  if v_type is null then
    raise exception 'Destination not found.';
  end if;
  if p_name is not null and trim(p_name) = '' then
    raise exception 'Give the destination a name.';
  end if;
  if p_url is not null then
    perform public.validate_destination_url(v_type, p_url);
  end if;
  update destinations d
  set name        = coalesce(trim(p_name), d.name),
      url         = coalesce(trim(p_url), d.url),
      url_display = coalesce(public.destination_url_display(v_type, p_url), d.url_display)
  where d.id = p_id;
end;
$$;

-- The web app deletes destinations directly and maps the foreign-key error;
-- this gives the API the same message.
create function public.delete_destination(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;
  delete from destinations d where d.id = p_id and d.user_id = auth.uid();
  if not found then
    raise exception 'Destination not found.';
  end if;
exception
  when foreign_key_violation then
    raise exception 'Remove it from its subscriptions first.';
end;
$$;

-- Change only the given fields: the stored subscription, as a save_subscription
-- payload, merged with the patch and saved through save_subscription, so a
-- patch is validated exactly like a full save.
create function public.patch_subscription(p_id uuid, p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;
  if jsonb_typeof(p_patch) is distinct from 'object' then
    raise exception 'Send the fields to change as a JSON object.';
  end if;
  select to_jsonb(s) - 'user_id' - 'created_at' - 'updated_at'
         || jsonb_build_object('destinations', coalesce(
              (select jsonb_agg(sd.destination_id) from subscription_destinations sd
               where sd.subscription_id = s.id), '[]'::jsonb))
  into v_current
  from subscriptions s
  where s.id = p_id and s.user_id = auth.uid()
  for update;
  if v_current is null then
    raise exception 'Subscription not found.';
  end if;
  perform public.save_subscription(v_current || (p_patch - 'id'));
end;
$$;

-- Add and remove a subscription's typed callsigns in one statement, so two
-- scripts adding members at once cannot lose each other's change. Calls are
-- normalized like save_subscription's; a call in both lists ends up removed.
create function public.edit_subscription_callsigns(p_id uuid, p_add jsonb, p_remove jsonb)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_calls text[];
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;
  update subscriptions s
  set callsigns = (
    select coalesce(array_agg(c order by c), '{}')
    from (
      select unnest(s.callsigns) as c
      union
      select unnest(public.jsonb_text_array(p_add, 'upper'))
      except
      select unnest(public.jsonb_text_array(p_remove, 'upper'))
    ) t
  )
  where s.id = p_id and s.user_id = auth.uid()
  returning s.callsigns into v_calls;
  if not found then
    raise exception 'Subscription not found.';
  end if;
  return v_calls;
end;
$$;

-- A group's name and/or whole member list (a missing key keeps the current
-- value), saved through save_callsign_group so normalization, rejection and the
-- 1,000-call cap are the web app's.
create function public.patch_callsign_group(p_id uuid, p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;
  if jsonb_typeof(p_patch) is distinct from 'object' then
    raise exception 'Send the fields to change as a JSON object.';
  end if;
  select jsonb_build_object('id', g.id, 'name', g.name, 'callsigns', coalesce(
           (select jsonb_agg(m.callsign) from callsign_group_members m where m.group_id = g.id), '[]'::jsonb))
  into v_current
  from callsign_groups g
  where g.id = p_id and g.user_id = auth.uid()
  for update;
  if v_current is null then
    raise exception 'Group not found.';
  end if;
  perform public.save_callsign_group(v_current || p_patch);
end;
$$;

-- Add and remove group members in one locked step, for scripts that sync a
-- roster a call at a time. Both lists are normalized to base calls the way
-- members are stored, so removing KK4PWJ/P removes KK4PWJ, and a call in both
-- lists ends up removed. An invalid call to add refuses the request, as it does
-- in the web app; the save enforces the 1,000-call cap.
create function public.edit_group_callsigns(p_id uuid, p_add jsonb, p_remove jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name   text;
  v_add    jsonb;
  v_remove jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;
  select g.name into v_name from callsign_groups g where g.id = p_id and g.user_id = auth.uid() for update;
  if v_name is null then
    raise exception 'Group not found.';
  end if;
  v_add := public.normalize_group_callsigns(
    array(select jsonb_array_elements_text(coalesce(p_add, '[]'::jsonb))));
  if jsonb_array_length(v_add -> 'rejected') > 0 then
    raise exception 'Not a callsign: %.', v_add -> 'rejected' ->> 0;
  end if;
  v_remove := public.normalize_group_callsigns(
    array(select jsonb_array_elements_text(coalesce(p_remove, '[]'::jsonb))));
  perform public.save_callsign_group(jsonb_build_object('id', p_id, 'name', v_name, 'callsigns', to_jsonb(array(
    select m.callsign from callsign_group_members m where m.group_id = p_id
    union
    select jsonb_array_elements_text(v_add -> 'callsigns')
    except
    select jsonb_array_elements_text(v_remove -> 'callsigns')))));
end;
$$;

-- ---------------------------------------------------------------------------
-- API JSON shapes. Destinations never include url or signing_secret.
-- ---------------------------------------------------------------------------

create function public.api_destination_json(d destinations)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'id', d.id, 'type', d.type, 'name', d.name, 'url_display', d.url_display,
    'health', d.health, 'consecutive_failures', d.consecutive_failures,
    'last_success_at', d.last_success_at, 'last_error', d.last_error,
    'last_error_at', d.last_error_at, 'created_at', d.created_at);
$$;

create function public.api_subscription_json(s subscriptions)
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(s) - 'user_id'
    || jsonb_build_object('destinations', coalesce(
         (select jsonb_agg(sd.destination_id order by sd.destination_id)
          from subscription_destinations sd where sd.subscription_id = s.id), '[]'::jsonb));
$$;

-- ---------------------------------------------------------------------------
-- Service-role entry points for the `api` Edge Function
-- ---------------------------------------------------------------------------

-- The token behind a SHA-256 hex digest, if it exists and has not expired,
-- with this request counted against its current minute. No row means 401.
create function public.authenticate_api_request(p_token_hash text)
returns table (token_id uuid, user_id uuid, scope text, requests int)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_token    api_tokens%rowtype;
  v_window   timestamptz := date_trunc('minute', now());
  v_requests int;
begin
  select * into v_token from api_tokens t
  where t.token_hash = p_token_hash and (t.expires_at is null or t.expires_at > now());
  if not found then
    return;
  end if;
  if v_token.last_used_at is null or v_token.last_used_at < now() - interval '1 minute' then
    update api_tokens t set last_used_at = now() where t.id = v_token.id;
  end if;
  delete from api_rate_limits r where r.token_id = v_token.id and r.window_start < v_window;
  insert into api_rate_limits (token_id, window_start, requests)
  values (v_token.id, v_window, 1)
  on conflict (token_id, window_start) do update set requests = api_rate_limits.requests + 1
  returning api_rate_limits.requests into v_requests;
  return query select v_token.id, v_token.user_id, v_token.scope, v_requests;
end;
$$;

-- Runs one API operation as the token's owner and returns its JSON result.
-- The operation list is the allowlist: anything else raises. Each operation
-- names the scope it needs; the Edge Function checks scope first, and this
-- checks it again so a routing mistake cannot let a read token write.
--
-- Acting as the owner: auth.uid() reads request.jwt.claim.sub, then
-- request.jwt.claims. Both are set with set_config(..., true) and put back
-- before returning, so nothing later in the transaction runs as the owner. On
-- an error the rollback (of the transaction or the caller's savepoint) undoes
-- them. PostgREST runs each RPC call in its own transaction anyway.
create function public.api_call(p_token_id uuid, p_op text, p_args jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub    text := current_setting('request.jwt.claim.sub', true);
  v_claims text := current_setting('request.jwt.claims', true);
  v_user   uuid;
  v_scope  text;
  v_needs  text;
  v_id     uuid;
  v_result jsonb;
begin
  select t.user_id, t.scope into v_user, v_scope from api_tokens t
  where t.id = p_token_id and (t.expires_at is null or t.expires_at > now());
  if v_user is null then
    raise exception 'Token not found.';
  end if;

  v_needs := case
    when p_op in ('list_destinations', 'get_destination', 'list_subscriptions',
                  'get_subscription', 'list_groups', 'get_group')
      then 'read'
    when p_op in ('create_destination', 'update_destination', 'delete_destination',
                  'rotate_signing_secret', 'create_subscription', 'replace_subscription',
                  'patch_subscription', 'delete_subscription', 'add_subscription_callsigns',
                  'remove_subscription_callsigns', 'create_group', 'update_group', 'delete_group',
                  'add_group_members', 'remove_group_members')
      then 'write'
  end;
  if v_needs is null then
    raise exception 'Unknown operation.';
  end if;
  if v_needs = 'write' and v_scope <> 'write' then
    raise exception 'This token is read only.';
  end if;

  perform set_config('request.jwt.claim.sub', v_user::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_user, 'role', 'authenticated')::text, true);

  v_id := nullif(p_args ->> 'id', '')::uuid;

  case p_op
    -- Destinations
    when 'list_destinations' then
      select coalesce(jsonb_agg(public.api_destination_json(d) order by d.created_at), '[]')
      into v_result from destinations d where d.user_id = v_user;
    when 'get_destination' then
      select public.api_destination_json(d) into v_result
      from destinations d where d.id = v_id and d.user_id = v_user;
      if v_result is null then
        raise exception 'Destination not found.';
      end if;
    when 'create_destination' then
      select to_jsonb(c) into v_result
      from public.create_destination(p_args ->> 'type', p_args ->> 'name', p_args ->> 'url') c;
    when 'update_destination' then
      perform public.update_destination(v_id, p_args ->> 'name', p_args ->> 'url');
      select public.api_destination_json(d) into v_result from destinations d where d.id = v_id;
    when 'delete_destination' then
      perform public.delete_destination(v_id);
      v_result := jsonb_build_object('deleted', true);
    when 'rotate_signing_secret' then
      v_result := jsonb_build_object('signing_secret', public.rotate_signing_secret(v_id));

    -- Subscriptions
    when 'list_subscriptions' then
      select coalesce(jsonb_agg(public.api_subscription_json(s) order by s.created_at), '[]')
      into v_result from subscriptions s where s.user_id = v_user;
    when 'get_subscription' then
      select public.api_subscription_json(s) into v_result
      from subscriptions s where s.id = v_id and s.user_id = v_user;
      if v_result is null then
        raise exception 'Subscription not found.';
      end if;
    when 'create_subscription' then
      v_id := public.save_subscription(coalesce(p_args -> 'body', '{}') - 'id');
      select public.api_subscription_json(s) into v_result from subscriptions s where s.id = v_id;
    when 'replace_subscription' then
      perform public.save_subscription(
        coalesce(p_args -> 'body', '{}') || jsonb_build_object('id', v_id));
      select public.api_subscription_json(s) into v_result from subscriptions s where s.id = v_id;
    when 'patch_subscription' then
      perform public.patch_subscription(v_id, p_args -> 'body');
      select public.api_subscription_json(s) into v_result from subscriptions s where s.id = v_id;
    when 'delete_subscription' then
      perform public.delete_subscription(v_id);
      v_result := jsonb_build_object('deleted', true);
    when 'add_subscription_callsigns' then
      v_result := jsonb_build_object('callsigns', to_jsonb(
        public.edit_subscription_callsigns(v_id, p_args -> 'callsigns', null)));
    when 'remove_subscription_callsigns' then
      v_result := jsonb_build_object('callsigns', to_jsonb(
        public.edit_subscription_callsigns(v_id, null, p_args -> 'callsigns')));

    -- Callsign groups
    when 'list_groups' then
      select coalesce(jsonb_agg(to_jsonb(g)), '[]') into v_result
      from public.list_callsign_groups() g;
    when 'get_group' then
      select to_jsonb(g) into v_result from public.list_callsign_groups() g where g.id = v_id;
      if v_result is null then
        raise exception 'Group not found.';
      end if;
    when 'create_group' then
      v_id := public.save_callsign_group(p_args - 'id');
      select to_jsonb(g) into v_result from public.list_callsign_groups() g where g.id = v_id;
    when 'update_group' then
      perform public.patch_callsign_group(v_id, p_args - 'id');
      select to_jsonb(g) into v_result from public.list_callsign_groups() g where g.id = v_id;
    when 'delete_group' then
      perform public.delete_callsign_group(v_id);
      v_result := jsonb_build_object('deleted', true);
    when 'add_group_members' then
      perform public.edit_group_callsigns(v_id, p_args -> 'callsigns', null);
      select to_jsonb(g) into v_result from public.list_callsign_groups() g where g.id = v_id;
    when 'remove_group_members' then
      perform public.edit_group_callsigns(v_id, null, p_args -> 'callsigns');
      select to_jsonb(g) into v_result from public.list_callsign_groups() g where g.id = v_id;
  end case;

  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public.new_api_token() from public;
revoke all on function public.create_api_token(text, text, int) from public;
revoke all on function public.rotate_api_token(uuid) from public;
revoke all on function public.update_destination(uuid, text, text) from public;
revoke all on function public.delete_destination(uuid) from public;
revoke all on function public.patch_subscription(uuid, jsonb) from public;
revoke all on function public.edit_subscription_callsigns(uuid, jsonb, jsonb) from public;
revoke all on function public.patch_callsign_group(uuid, jsonb) from public;
revoke all on function public.edit_group_callsigns(uuid, jsonb, jsonb) from public;
revoke all on function public.api_destination_json(destinations) from public;
revoke all on function public.api_subscription_json(subscriptions) from public;
revoke all on function public.authenticate_api_request(text) from public;
revoke all on function public.api_call(uuid, text, jsonb) from public;
grant execute on function public.create_api_token(text, text, int) to authenticated;
grant execute on function public.rotate_api_token(uuid) to authenticated;

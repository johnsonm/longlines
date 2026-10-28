-- Long Lines Relay pairing and relay tokens (Long Lines Relay, phase 1).
-- Spec: docs/superpowers/specs/2026-10-28-logged-contacts-design.md. The wire contract is
-- docs/contract.md in sonyccd/longlines-relay (sections 3 and 4).
--
-- The relay signs in the way a TV signs in (RFC 8628, device authorization grant):
--
-- 1. The relay-api function's POST /device/start calls start_relay_pairing, which stores a
--    pending relay_pairings row holding only the SHA-256 of a random device code, and returns the
--    device code (the relay's polling secret) and a short user code (XXXX-XXXX).
-- 2. The relay opens /relay/approve?code=<user code> in the browser (and shows /relay, where the
--    code can be typed, in case the browser did not open). The signed-in user sees the
--    pairing through lookup_relay_pairing and answers it with answer_relay_pairing (Allow or Deny);
--    both are the only client RPCs here.
-- 3. The relay polls POST /device/token, which calls poll_relay_pairing with the device code's
--    hash. On an approved pairing it creates the relay_tokens row and returns the token once.
--
-- Relay tokens are their own table, apart from api_tokens: a relay token can post logged contacts
-- (scope contacts:write) and read its account's callsign and email, nothing else; it never reaches
-- api_call. Like api_tokens, only the token's SHA-256 is stored, the owner reads their tokens
-- without the hash and revokes one with a plain delete (RLS), and deleting the account deletes
-- them. scopes is an array from the start: phase 2 adds spots:read to the checks below.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

-- One sign-in attempt by a relay. A pairing lives 10 minutes; prune_relay_pairings deletes rows
-- a day old. status: pending until answered; approved or denied by the user who answered
-- (user_id); claimed once its token was handed out; expired when a poll found it past expires_at
-- while still pending. An approved pairing past expires_at stays approved and polls as expired.
create table relay_pairings (
  id               uuid        primary key default gen_random_uuid(),
  device_code_hash text        not null unique check (device_code_hash ~ '^[0-9a-f]{64}$'),
  user_code        text        not null unique
                               check (user_code ~ '^[0-9BCDFGHJKMNPQRSTVWXYZ]{4}-[0-9BCDFGHJKMNPQRSTVWXYZ]{4}$'),
  status           text        not null default 'pending'
                               check (status in ('pending', 'approved', 'denied', 'claimed', 'expired')),
  user_id          uuid        references auth.users (id) on delete cascade,
  device_name      text        not null check (char_length(device_name) between 1 and 64),
  client_version   text        not null check (char_length(client_version) between 1 and 32),
  scopes           text[]      not null default array['contacts:write']
                               check (cardinality(scopes) > 0 and scopes <@ array['contacts:write']),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default now() + interval '10 minutes',
  answered_at      timestamptz,
  last_polled_at   timestamptz,
  interval_seconds int         not null default 5 check (interval_seconds between 1 and 60),
  check ((user_id is null) = (status in ('pending', 'expired')))
);

create index relay_pairings_user_id_idx on relay_pairings (user_id);

comment on table relay_pairings is
  'Long Lines Relay sign-ins in progress (RFC 8628 style). Only the device code''s SHA-256 is stored. Service role only; the web reads one through lookup_relay_pairing and answers it with answer_relay_pairing.';

-- One relay signed in to an account. token_hash is the lower-case hex SHA-256 of the token and is
-- never granted; the plaintext leaves the database once, from poll_relay_pairing.
-- contacts_window_start / contacts_window_count are record_relay_contacts' one-minute window.
create table relay_tokens (
  id                    uuid        primary key default gen_random_uuid(),
  user_id               uuid        not null references auth.users (id) on delete cascade,
  token_hash            text        not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  token_prefix          text        not null,
  device_name           text        not null check (char_length(device_name) between 1 and 64),
  client_version        text        not null check (char_length(client_version) between 1 and 32),
  scopes                text[]      not null
                                    check (cardinality(scopes) > 0 and scopes <@ array['contacts:write']),
  created_at            timestamptz not null default now(),
  last_used_at          timestamptz,
  contacts_window_start timestamptz,
  contacts_window_count int         not null default 0
);

create index relay_tokens_user_id_idx on relay_tokens (user_id);

comment on table relay_tokens is
  'Long Lines Relay tokens, one per signed-in computer. Owners read them without token_hash and revoke one with a delete. Created only by poll_relay_pairing.';
comment on column relay_tokens.id is
  'The stable handle of a signed-in relay; a phase-2 relay destination would reference it.';

alter table relay_pairings enable row level security;
alter table relay_tokens enable row level security;

revoke all on relay_pairings, relay_tokens from anon, authenticated;
grant select (id, user_id, token_prefix, device_name, client_version, scopes, created_at, last_used_at)
  on relay_tokens to authenticated;
grant delete on relay_tokens to authenticated;

create policy relay_tokens_select_own on relay_tokens
  for select to authenticated using (user_id = (select auth.uid()));
create policy relay_tokens_delete_own on relay_tokens
  for delete to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 2. Codes and tokens
-- ---------------------------------------------------------------------------

-- Most relays one account may have signed in, counting approved pairings not yet claimed.
create function public.relay_tokens_max()
returns int
language sql
immutable
set search_path = ''
as $$
  select 10;
$$;

-- Contacts one relay token may post per minute (contract section 8).
create function public.relay_contacts_per_minute()
returns int
language sql
immutable
set search_path = ''
as $$
  select 120;
$$;

-- "ll_relay_" plus 52 characters of a-z2-7, five random bits each, as new_api_token.
create function public.new_relay_token()
returns text
language sql
volatile
set search_path = public, extensions
as $$
  select 'll_relay_' || string_agg(substr('abcdefghijklmnopqrstuvwxyz234567', (get_byte(r.b, i) & 31) + 1, 1), '' order by i)
  from (select gen_random_bytes(52) as b) r, generate_series(0, 51) as i;
$$;

-- A user code: XXXX-XXXX from the 30 characters of Crockford base32 without vowels. 30 does not
-- divide 256, so bytes of 240 and up are skipped rather than folded (240 = 8 * 30), which would
-- favour the first 16 characters.
create function public.new_relay_user_code()
returns text
language plpgsql
volatile
set search_path = public, extensions
as $$
declare
  v_alphabet constant text := '0123456789BCDFGHJKMNPQRSTVWXYZ';
  v_code  text := '';
  v_bytes bytea;
  v_byte  int;
begin
  while char_length(v_code) < 8 loop
    v_bytes := gen_random_bytes(16);
    for i in 0..15 loop
      v_byte := get_byte(v_bytes, i);
      if v_byte < 240 and char_length(v_code) < 8 then
        v_code := v_code || substr(v_alphabet, v_byte % 30 + 1, 1);
      end if;
    end loop;
  end loop;
  return left(v_code, 4) || '-' || right(v_code, 4);
end;
$$;

-- A user code as typed, in its stored form, or null when it cannot be one: upper case, spaces and
-- hyphens dropped, O read as 0 and I and L as 1 (Crockford's reading), eight characters of the
-- alphabet, a hyphen after the fourth.
create function public.relay_user_code(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when s.c ~ '^[0-9BCDFGHJKMNPQRSTVWXYZ]{8}$' then left(s.c, 4) || '-' || right(s.c, 4) end
  from (select translate(upper(regexp_replace(coalesce(p_text, ''), '[[:space:]-]', '', 'g')), 'OIL', '011') as c) s;
$$;

-- ---------------------------------------------------------------------------
-- 3. Pairing (relay-api: device/start and device/token)
-- ---------------------------------------------------------------------------

-- POST /device/start: a new pending pairing. Returns the contract's response body (4.1); the
-- device code is returned here once and only its hash is stored.
create function public.start_relay_pairing(p_device_name text, p_client_version text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_device text := encode(gen_random_bytes(32), 'hex');
  v_name   text := trim(p_device_name);
  v_row    relay_pairings%rowtype;
begin
  if v_name is null or char_length(v_name) not between 1 and 64
     or p_client_version is null or char_length(p_client_version) not between 1 and 32 then
    raise exception 'Not a relay device name and version.' using errcode = '22023';
  end if;
  -- A fresh code that is already taken (kept a day) is drawn again.
  for v_try in 1..5 loop
    begin
      insert into relay_pairings (device_code_hash, user_code, device_name, client_version)
      values (encode(digest(v_device, 'sha256'), 'hex'), public.new_relay_user_code(), v_name, p_client_version)
      returning * into v_row;
      exit;
    exception
      when unique_violation then
        if v_try = 5 then
          raise;
        end if;
    end;
  end loop;
  return jsonb_build_object(
    'device_code', v_device,
    'user_code', v_row.user_code,
    -- The short address the relay shows for typing a code by hand (/relay goes on to the approval
    -- page); the browser opens the complete one, the approval page with the code filled in.
    'verification_uri', public.app_site_url() || '/relay',
    'verification_uri_complete', public.app_site_url() || '/relay/approve?code=' || v_row.user_code,
    'expires_in', extract(epoch from v_row.expires_at - v_row.created_at)::int,
    'interval', v_row.interval_seconds);
end;
$$;

-- POST /device/token: one poll. Returns {status} with status authorization_pending, slow_down,
-- access_denied or expired_token (the contract's error codes, 4.2), or {status: 'ok',
-- access_token, scopes} once, creating the token, for an approved pairing.
--
-- A poll sooner than interval_seconds after the previous one is slow_down. One second of
-- network jitter is allowed, so a relay that waits exactly the interval is never told to slow down
-- because one request took longer than the next.
create function public.poll_relay_pairing(p_device_code_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row   relay_pairings%rowtype;
  v_token text;
begin
  select * into v_row from relay_pairings p where p.device_code_hash = p_device_code_hash for update;
  if not found then
    return jsonb_build_object('status', 'expired_token');
  end if;
  if v_row.status in ('claimed', 'expired') or v_row.expires_at <= now() then
    if v_row.status = 'pending' then
      update relay_pairings set status = 'expired' where id = v_row.id;
    end if;
    return jsonb_build_object('status', 'expired_token');
  end if;
  update relay_pairings set last_polled_at = now() where id = v_row.id;
  if v_row.last_polled_at is not null
     and now() < v_row.last_polled_at + make_interval(secs => v_row.interval_seconds - 1) then
    return jsonb_build_object('status', 'slow_down');
  end if;
  if v_row.status = 'pending' then
    return jsonb_build_object('status', 'authorization_pending');
  end if;
  if v_row.status = 'denied' then
    return jsonb_build_object('status', 'access_denied');
  end if;
  -- Approved: answer_relay_pairing kept the account under relay_tokens_max().
  v_token := public.new_relay_token();
  insert into relay_tokens (user_id, token_hash, token_prefix, device_name, client_version, scopes)
  values (v_row.user_id, encode(digest(v_token, 'sha256'), 'hex'), left(v_token, 13),
          v_row.device_name, v_row.client_version, v_row.scopes);
  update relay_pairings set status = 'claimed' where id = v_row.id;
  return jsonb_build_object('status', 'ok', 'access_token', v_token, 'scopes', to_jsonb(v_row.scopes));
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Approval (web: /relay/approve)
-- ---------------------------------------------------------------------------

-- The approval page's read of a code: {status: 'pending', code, device_name, scopes, expires_at}
-- for a pending, unexpired pairing; {status: 'expired', code} for one that expired or was already
-- answered or claimed (by anyone: whose it was is never told); {status: 'unknown', code} for a
-- code no pairing has (code null when it cannot be a code at all).
create function public.lookup_relay_pairing(p_user_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_code text := public.relay_user_code(p_user_code);
  v_row  relay_pairings%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;
  if v_code is null then
    return jsonb_build_object('status', 'unknown', 'code', null);
  end if;
  select * into v_row from relay_pairings p where p.user_code = v_code;
  if not found then
    return jsonb_build_object('status', 'unknown', 'code', v_code);
  end if;
  if v_row.status <> 'pending' or v_row.expires_at <= now() then
    return jsonb_build_object('status', 'expired', 'code', v_code);
  end if;
  return jsonb_build_object(
    'status', 'pending',
    'code', v_code,
    'device_name', v_row.device_name,
    'scopes', to_jsonb(v_row.scopes),
    'expires_at', v_row.expires_at);
end;
$$;

-- Allow (p_approve true) or Deny a pending pairing as the signed-in user. Returns {status} with
-- status approved, denied, expired (no longer pending, as lookup_relay_pairing says) or unknown.
-- Allow needs a callsign (the contract never pairs an account without one) and room under
-- relay_tokens_max(), counting the account's tokens and its approved pairings not yet claimed.
create function public.answer_relay_pairing(p_user_code text, p_approve boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_code text := public.relay_user_code(p_user_code);
  v_row  relay_pairings%rowtype;
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  if p_approve is null then
    raise exception 'Choose Allow or Deny.';
  end if;
  if v_code is null then
    return jsonb_build_object('status', 'unknown');
  end if;
  select * into v_row from relay_pairings p where p.user_code = v_code for update;
  if not found then
    return jsonb_build_object('status', 'unknown');
  end if;
  if v_row.status <> 'pending' or v_row.expires_at <= now() then
    return jsonb_build_object('status', 'expired');
  end if;
  if not p_approve then
    update relay_pairings set status = 'denied', user_id = v_user, answered_at = now() where id = v_row.id;
    return jsonb_build_object('status', 'denied');
  end if;
  if not exists (select 1 from profiles p where p.id = v_user) then
    raise exception 'Add your callsign to your account first.';
  end if;
  -- Serializes one user's approvals so two at once cannot pass the cap together.
  perform pg_advisory_xact_lock(hashtextextended('relay_tokens:' || v_user::text, 0));
  if (select count(*) from relay_tokens t where t.user_id = v_user)
     + (select count(*) from relay_pairings p
        where p.user_id = v_user and p.status = 'approved' and p.expires_at > now())
     >= public.relay_tokens_max() then
    raise exception 'You can connect up to 10 relays. Disconnect one in API tokens first.';
  end if;
  update relay_pairings set status = 'approved', user_id = v_user, answered_at = now() where id = v_row.id;
  return jsonb_build_object('status', 'approved');
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Authenticated routes (relay-api: me and contacts)
-- ---------------------------------------------------------------------------

-- The token's id, owner and scopes; no row for an unknown or revoked token. Touches last_used_at
-- at most once a minute, as authenticate_api_request does.
create function public.authenticate_relay_token(p_token_hash text)
returns table (token_id uuid, user_id uuid, scopes text[])
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_token relay_tokens%rowtype;
begin
  select * into v_token from relay_tokens t where t.token_hash = p_token_hash;
  if not found then
    return;
  end if;
  if v_token.last_used_at is null or v_token.last_used_at < now() - interval '1 minute' then
    update relay_tokens t set last_used_at = now() where t.id = v_token.id;
  end if;
  return query select v_token.id, v_token.user_id, v_token.scopes;
end;
$$;

-- Counts p_count contacts against the token's one-minute window (relay_contacts_per_minute()) and
-- returns 0, or, when they would take the window past the limit, counts nothing and returns the
-- seconds until the window ends (the 429's Retry-After). Windows are whole UTC minutes.
create function public.record_relay_contacts(p_token_id uuid, p_count int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window timestamptz := date_trunc('minute', now());
  v_used   int;
begin
  if p_token_id is null or p_count is null or p_count < 1 then
    raise exception 'record_relay_contacts needs a token and a count.' using errcode = '22023';
  end if;
  select case when t.contacts_window_start = v_window then t.contacts_window_count else 0 end
  into v_used
  from relay_tokens t where t.id = p_token_id
  for update;
  if not found then
    raise exception 'Unknown relay token.' using errcode = '22023';
  end if;
  if v_used + p_count > public.relay_contacts_per_minute() then
    return greatest(1, ceil(extract(epoch from v_window + interval '1 minute' - now()))::int);
  end if;
  update relay_tokens
  set contacts_window_start = v_window, contacts_window_count = v_used + p_count
  where id = p_token_id;
  return 0;
end;
$$;

-- GET /me: {callsign, email} of the account, or null when it has no profile (never paired: see
-- answer_relay_pairing). Touches auth.users, so service role only, as email_for_identifier.
create function public.relay_account(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('callsign', p.callsign, 'email', u.email::text)
  from profiles p
  join auth.users u on u.id = p.id
  where p.id = p_user_id;
$$;

-- ---------------------------------------------------------------------------
-- 6. Pruning
-- ---------------------------------------------------------------------------

-- Pairings a day old: long past their 10 minutes, kept that long only so a code is not drawn
-- again while a relay or a browser tab might still show it.
create function public.prune_relay_pairings()
returns void
language sql
security definer
set search_path = public
as $$
  delete from relay_pairings where created_at < now() - interval '1 day';
$$;

-- prune_callsign_lookups (hourly, cron prune-callsign-lookups): as in 20261027001200, plus the
-- relay pairings. relay-api's per-client limits share lookup_rate_limits, which this prunes too.
create or replace function public.prune_callsign_lookups()
returns void
language sql
security definer
set search_path = public
as $$
  delete from lookup_rate_limits where window_start < date_trunc('minute', now());
  delete from callsign_profile_cache where generated_at <= now() - public.profile_cache_ttl();
  delete from reference_profile_cache where generated_at <= now() - public.profile_cache_ttl();
  select public.prune_relay_pairings();
$$;

-- ---------------------------------------------------------------------------
-- 7. Grants
-- ---------------------------------------------------------------------------

revoke all on function public.relay_tokens_max() from public, anon, authenticated;
revoke all on function public.relay_contacts_per_minute() from public, anon, authenticated;
revoke all on function public.new_relay_token() from public, anon, authenticated;
revoke all on function public.new_relay_user_code() from public, anon, authenticated;
revoke all on function public.relay_user_code(text) from public, anon, authenticated;
revoke all on function public.start_relay_pairing(text, text) from public, anon, authenticated;
revoke all on function public.poll_relay_pairing(text) from public, anon, authenticated;
revoke all on function public.lookup_relay_pairing(text) from public, anon, authenticated;
revoke all on function public.answer_relay_pairing(text, boolean) from public, anon, authenticated;
revoke all on function public.authenticate_relay_token(text) from public, anon, authenticated;
revoke all on function public.record_relay_contacts(uuid, int) from public, anon, authenticated;
revoke all on function public.relay_account(uuid) from public, anon, authenticated;
revoke all on function public.prune_relay_pairings() from public, anon, authenticated;

grant execute on function public.start_relay_pairing(text, text) to service_role;
grant execute on function public.poll_relay_pairing(text) to service_role;
grant execute on function public.authenticate_relay_token(text) to service_role;
grant execute on function public.record_relay_contacts(uuid, int) to service_role;
grant execute on function public.relay_account(uuid) to service_role;
grant execute on function public.lookup_relay_pairing(text) to authenticated;
grant execute on function public.answer_relay_pairing(text, boolean) to authenticated;

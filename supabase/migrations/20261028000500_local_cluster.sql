-- Local DX cluster destinations (Long Lines Relay, phase 2): the spots that match a connection go
-- to one of the user's paired relays, which re-serves them as a DX cluster on the user's computer
-- so a logger's bandmap shows them. The wire contract is docs/contract.md (v2) in
-- sonyccd/longlines-relay; it wins on wire details.
--
-- 1. Relay scopes and presence. A v2 pairing may ask for spots:read as well as contacts:write
--    (start_relay_pairing's four-argument overload, with the relay's platform); the v1 overload
--    keeps asking for contacts:write alone. relay_tokens gains platform and cluster_connected_at,
--    which the sender sets while the relay's spots stream is open (set_cluster_stream) and clears
--    on disconnect and at start (reset_cluster_streams). relay_account's two-argument overload is
--    GET /v2/me's account and token.
-- 2. The destination type local_cluster: no URL ('Long Lines Relay' as its display), settings in
--    local_cluster_destination_settings (the relay and the comment's fields, in order), written
--    only by save_local_cluster_destination. The management API reads them and never creates one.
-- 3. Rendering in SQL: local_cluster_spot_fields adds the finished cluster_* values to a claimed
--    spot (contract 9.4 and 10.2), and local_cluster_line lays out the DX cluster line for the
--    editor's preview only (contract 10.1). The relay owns the served line; both are pinned to
--    the contract's example lines.
-- 4. Drop-if-offline: claim_deliveries takes a local_cluster row only while its relay is
--    connected, at most local_cluster_relay_cap() a minute per relay (newest first, across every
--    destination that targets it), and destination_max_age('local_cluster') (2 minutes) ages the
--    rest out through the existing expiry sweep. Nothing here touches consecutive_failures,
--    health or auto_disabled_at.
-- 5. Loop guard: match_pending_spots never sends a user's own logged contacts, or a spot without
--    a frequency, to that user's local_cluster destinations.
--
-- The sender's grants gain authenticate_relay_token, set_cluster_stream and reset_cluster_streams
-- (sender_role.test.sql); its SENDER_RPCS allowlist follows in the sender's PR.

-- ---------------------------------------------------------------------------
-- 1. Relay scopes, platform and presence
-- ---------------------------------------------------------------------------

alter table relay_pairings drop constraint relay_pairings_scopes_check;
alter table relay_pairings add constraint relay_pairings_scopes_check
  check (cardinality(scopes) > 0 and scopes <@ array['contacts:write', 'spots:read']);
alter table relay_tokens drop constraint relay_tokens_scopes_check;
alter table relay_tokens add constraint relay_tokens_scopes_check
  check (cardinality(scopes) > 0 and scopes <@ array['contacts:write', 'spots:read']);

-- The relay's OS as its v2 pairing named it; null for a v1 pairing.
alter table relay_pairings add column platform text check (platform in ('windows', 'macos', 'linux'));
alter table relay_tokens add column platform text check (platform in ('windows', 'macos', 'linux'));
-- When the relay's spots stream opened; null while none is open. Written only by the sender
-- (set_cluster_stream, reset_cluster_streams).
alter table relay_tokens add column cluster_connected_at timestamptz;

comment on column relay_tokens.platform is
  'The relay''s OS (windows, macos, linux) from its v2 pairing; null for a v1 pairing.';
comment on column relay_tokens.cluster_connected_at is
  'When the relay''s spots stream opened; null while none is open. The claim sends a Local DX cluster destination''s spots only while it is set.';

grant select (platform, cluster_connected_at) on relay_tokens to authenticated;

-- The scopes a relay token can carry, in the contract's order (3.1). A pairing stores the scopes it
-- asked for in this order, so a token's scopes and every reply listing them follow it.
create function public.relay_scopes()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['contacts:write', 'spots:read'];
$$;

-- The body of both start_relay_pairing overloads (as in 20261028000400, plus scopes and platform):
-- a new pending pairing asking for p_scopes, and the contract's response body (4.1).
create function public.insert_relay_pairing(p_device_name text, p_client_version text, p_scopes text[],
                                            p_platform text)
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
      insert into relay_pairings (device_code_hash, user_code, device_name, client_version, scopes, platform)
      values (encode(digest(v_device, 'sha256'), 'hex'), public.new_relay_user_code(), v_name, p_client_version,
              p_scopes, p_platform)
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
    'verification_uri', public.app_site_url() || '/relay',
    'verification_uri_complete', public.app_site_url() || '/relay/approve?code=' || v_row.user_code,
    'expires_in', extract(epoch from v_row.expires_at - v_row.created_at)::int,
    'interval', v_row.interval_seconds);
end;
$$;

-- POST /v1/device/start: as in 20261028000400, through insert_relay_pairing. A v1 pairing asks
-- for contacts:write alone and names no platform.
create or replace function public.start_relay_pairing(p_device_name text, p_client_version text)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.insert_relay_pairing(p_device_name, p_client_version, array['contacts:write'], null);
$$;

-- POST /v2/device/start: the scopes the relay asks for (one or both of relay_scopes(), each once)
-- and its platform (windows, macos or linux). The scopes are stored in the contract's order.
create function public.start_relay_pairing(p_device_name text, p_client_version text, p_scopes text[],
                                           p_platform text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_scopes is null or cardinality(p_scopes) = 0 or array_position(p_scopes, null) is not null
     or not (p_scopes <@ public.relay_scopes())
     or (select count(distinct s) from unnest(p_scopes) s) <> cardinality(p_scopes) then
    raise exception 'Not relay scopes.' using errcode = '22023';
  end if;
  if p_platform is null or p_platform not in ('windows', 'macos', 'linux') then
    raise exception 'Not a relay platform.' using errcode = '22023';
  end if;
  return public.insert_relay_pairing(p_device_name, p_client_version,
    array(select s from unnest(public.relay_scopes()) with ordinality as t(s, o) where s = any (p_scopes) order by o),
    p_platform);
end;
$$;

-- POST /device/token: as in 20261028000400, except that the token also takes the pairing's
-- platform.
create or replace function public.poll_relay_pairing(p_device_code_hash text)
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
  insert into relay_tokens (user_id, token_hash, token_prefix, device_name, client_version, scopes, platform)
  values (v_row.user_id, encode(digest(v_token, 'sha256'), 'hex'), left(v_token, 13),
          v_row.device_name, v_row.client_version, v_row.scopes, v_row.platform);
  update relay_pairings set status = 'claimed' where id = v_row.id;
  return jsonb_build_object('status', 'ok', 'access_token', v_token, 'scopes', to_jsonb(v_row.scopes));
end;
$$;

-- GET /v2/me: relay_account's callsign and email plus the token: relay_id (its id), device_name
-- and scopes. Null when the account has no profile or the token is not the account's. The
-- one-argument relay_account stays GET /v1/me's.
create function public.relay_account(p_user_id uuid, p_token_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('callsign', p.callsign, 'email', u.email::text, 'relay_id', t.id,
                            'device_name', t.device_name, 'scopes', to_jsonb(t.scopes))
  from profiles p
  join auth.users u on u.id = p.id
  join relay_tokens t on t.id = p_token_id and t.user_id = p.id
  where p.id = p_user_id;
$$;

-- The sender, when a relay's spots stream opens (p_connected true) or closes. True when the token
-- exists (and, to connect, carries spots:read); false otherwise, and nothing changes. A stream that
-- replaces an older one for the same token is already connected: the sender clears presence only
-- when the stream that closes is the token's current one.
create function public.set_cluster_stream(p_token_id uuid, p_connected boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_token_id is null or p_connected is null then
    raise exception 'set_cluster_stream needs a token and a state.' using errcode = '22023';
  end if;
  update relay_tokens t
  set cluster_connected_at = case when p_connected then now() end
  where t.id = p_token_id
    and (not p_connected or 'spots:read' = any (t.scopes));
  return found;
end;
$$;

-- The sender at start: no stream is open, whatever a previous process left set. Returns the
-- number of relays it marked offline.
create function public.reset_cluster_streams()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  update relay_tokens t set cluster_connected_at = null where t.cluster_connected_at is not null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The destination type
-- ---------------------------------------------------------------------------

alter table destinations drop constraint destinations_type_check;
alter table destinations add constraint destinations_type_check
  check (type in ('discord', 'webhook', 'push', 'local_cluster'));
alter table destinations drop constraint destinations_push_has_no_url;
alter table destinations add constraint destinations_no_url_types
  check ((type in ('push', 'local_cluster')) = (url is null));

-- As in 20261019000520, plus local_cluster, which has no URL.
create or replace function public.validate_destination_url(p_type text, p_url text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_parts text[];
  v_host text;
begin
  if p_type not in ('discord', 'webhook', 'push', 'local_cluster') then
    raise exception 'Unknown destination type.';
  end if;
  if p_type = 'push' then
    if p_url is not null then
      raise exception 'Push notifications don''t use a URL.';
    end if;
    return;
  end if;
  if p_type = 'local_cluster' then
    if p_url is not null then
      raise exception 'A Local DX cluster doesn''t use a URL.';
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
    v_host := rtrim(v_parts[1], '.');
    if v_host ~ '[@\\%[:space:][:cntrl:]]'
       or v_host ~ '[^\x01-\x7f]'
       or public.is_private_host(v_host)
       or v_host like any (array['%.internal', '%.flycast', '%.local', '%.localdomain', '%.home.arpa', '%.arpa'])
    then
      raise exception 'That address is not allowed.';
    end if;
  end if;
end;
$$;

-- As in 20261018000300, plus local_cluster's fixed 'Long Lines Relay'.
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
    when p_type = 'local_cluster' then 'Long Lines Relay'
    when p_type = 'discord' then
      'https://' || parts[1] || '/api/webhooks/' || left(coalesce(m[1], ''), 4) || '…/' || left(coalesce(m[2], ''), 3)
    when p_type = 'webhook' then
      'https://' || parts[1] || parts[2] || regexp_replace(parts[3], '[^/]+(/*)$', '••••••\1')
    else 'https://' || parts[1] || parts[2] || parts[3]
  end
  from d;
$$;

-- As in 20261016000400, except that a Local DX cluster is refused: it is made only in the web app
-- (save_local_cluster_destination), which picks its relay. The API reaches this through api_call.
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
  v_constraint text;
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  if p_type = 'local_cluster' then
    raise exception 'Add a Local DX cluster destination in the web app.';
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
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'destinations_user_name_key' then
      raise exception 'A destination named % already exists. Choose a different name.', trim(p_name);
    end if;
    raise;
  end;
  return query
    select d.id, d.type, d.name, d.url_display, d.health, d.created_at, d.signing_secret
    from destinations d where d.id = v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Knobs
-- ---------------------------------------------------------------------------

-- As in 20261018000100, plus local_cluster: 120 spots a minute, as the relay cap.
create or replace function public.destination_budget(p_type text)
returns table (rate_per_minute numeric, burst numeric)
language sql
immutable
set search_path = ''
as $$
  select r, b
  from (values ('discord', 300::numeric, 100::numeric), ('push', 3::numeric, 3::numeric),
               ('webhook', 1000::numeric, 1000::numeric),
               ('local_cluster', 120::numeric, 120::numeric)) as k (t, r, b)
  where k.t = p_type;
$$;

-- As in 20261015000400, plus local_cluster: 2 minutes. A spot that waited longer for its relay
-- to connect is no use in a bandmap, so the expiry sweep drops it (contract 9.2).
create or replace function public.destination_max_age(p_type text)
returns interval
language sql
immutable
set search_path = ''
as $$
  select case p_type
    when 'push' then interval '15 minutes'
    when 'local_cluster' then interval '2 minutes'
    else interval '24 hours'
  end;
$$;

-- The most spots one relay is sent per minute, across every Local DX cluster destination that
-- targets it (contract 9.4). The claim counts the relay's rows sent in the last minute and takes
-- at most the rest, newest first; what it leaves ages out (destination_max_age).
create function public.local_cluster_relay_cap()
returns int
language sql
immutable
set search_path = ''
as $$
  select 120;
$$;

-- ---------------------------------------------------------------------------
-- 4. Settings (service role only, like discord_destination_settings)
-- ---------------------------------------------------------------------------

-- The fields a spot line's comment can carry after the mode word, in the editor's order.
create function public.local_cluster_fields()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['reference', 'source', 'comment'];
$$;

-- True when every name is a local cluster field and none is there twice. Empty is fine: the
-- comment is then the mode word alone.
create function public.local_cluster_fields_valid(p_fields text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_fields is not null
     and p_fields <@ public.local_cluster_fields()
     and array_position(p_fields, null) is null
     and (select count(distinct f) from unnest(p_fields) f) = cardinality(p_fields);
$$;

-- One row per Local DX cluster destination: the relay it sends to (null once that relay is
-- revoked, which stops it until another is picked) and the comment's fields in order.
create table local_cluster_destination_settings (
  destination_id uuid primary key references destinations (id) on delete cascade,
  relay_token_id uuid references relay_tokens (id) on delete set null,
  fields         text[] not null check (public.local_cluster_fields_valid(fields))
);
create index local_cluster_destination_settings_relay_idx on local_cluster_destination_settings (relay_token_id);
alter table local_cluster_destination_settings enable row level security;
revoke all on local_cluster_destination_settings from anon, authenticated;

comment on table local_cluster_destination_settings is
  'Local DX cluster destinations: the relay (relay_tokens.id) and the comment''s fields. Written only by save_local_cluster_destination; service role only.';

-- A new destination's settings as the editor starts them. Clients name the relay with the key
-- relay_id; save_local_cluster_destination and the preview accept that key and these.
create function public.local_cluster_default_settings()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select '{"fields": ["reference"]}'::jsonb;
$$;

-- Not security definer, like Discord's: destinations are inserted only inside definer RPCs or by
-- the service role.
create function public.local_cluster_destination_settings_default()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  insert into local_cluster_destination_settings
  select * from jsonb_populate_record(null::local_cluster_destination_settings,
    public.local_cluster_default_settings() || jsonb_build_object('destination_id', new.id));
  return null;
end;
$$;

create trigger destinations_local_cluster_settings
  after insert on destinations
  for each row when (new.type = 'local_cluster')
  execute function public.local_cluster_destination_settings_default();

-- A settings row as clients see it: {relay_id, fields}.
create function public.local_cluster_settings_json(p_settings local_cluster_destination_settings)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object('relay_id', p_settings.relay_token_id, 'fields', to_jsonb(p_settings.fields));
$$;

-- Raises "Unknown setting {key}." for a key that is neither relay_id nor a default's key.
create function public.check_local_cluster_setting_keys(p_settings jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key text;
begin
  if p_settings is null then
    return;
  end if;
  if jsonb_typeof(p_settings) <> 'object' then
    raise exception 'Settings must be an object.';
  end if;
  select k into v_key from jsonb_object_keys(p_settings) k
  where k <> 'relay_id' and not public.local_cluster_default_settings() ? k
  order by k limit 1;
  if v_key is not null then
    raise exception 'Unknown setting %.', v_key;
  end if;
end;
$$;

-- Client settings ({relay_id, fields}) as a row for p_destination_id, with the editor's messages
-- for a value of the wrong shape.
create function public.local_cluster_settings_record(p_destination_id uuid, p_settings jsonb)
returns local_cluster_destination_settings
language plpgsql
stable
set search_path = ''
as $$
declare
  v_row public.local_cluster_destination_settings;
begin
  v_row.destination_id := p_destination_id;
  if jsonb_typeof(p_settings -> 'relay_id') = 'string' then
    if (p_settings ->> 'relay_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Relay not found.';
    end if;
    v_row.relay_token_id := (p_settings ->> 'relay_id')::uuid;
  elsif coalesce(jsonb_typeof(p_settings -> 'relay_id'), 'null') <> 'null' then
    raise exception 'Relay not found.';
  end if;
  if coalesce(jsonb_typeof(p_settings -> 'fields'), 'null') <> 'array' then
    raise exception 'Fields must be a list of field names.';
  end if;
  if exists (select 1 from jsonb_array_elements(p_settings -> 'fields') e where jsonb_typeof(e) <> 'string') then
    raise exception 'Fields must be a list of field names.';
  end if;
  v_row.fields := array(select e from jsonb_array_elements_text(p_settings -> 'fields') with ordinality as t(e, o)
                        order by o);
  return v_row;
end;
$$;

-- The comment's fields, with the editor's messages.
create function public.validate_local_cluster_fields(p_fields text[])
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_field text;
begin
  select f into v_field from unnest(coalesce(p_fields, '{}')) f
  where f is null or not (f = any (public.local_cluster_fields())) limit 1;
  if found then
    raise exception 'Unknown field %.', coalesce(v_field, 'null');
  end if;
  if p_fields is null or (select count(distinct f) from unnest(p_fields) f) <> cardinality(p_fields) then
    raise exception 'Pick each field once.';
  end if;
end;
$$;

-- Every check a save makes: the fields, and a relay that belongs to p_user.
create function public.validate_local_cluster_settings(p_settings local_cluster_destination_settings, p_user uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  perform public.validate_local_cluster_fields(p_settings.fields);
  if p_settings.relay_token_id is null then
    raise exception 'Pick a relay.';
  end if;
  if not exists (select 1 from public.relay_tokens t where t.id = p_settings.relay_token_id and t.user_id = p_user) then
    raise exception 'Relay not found.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Rendering, in SQL only (contract 9.4 and 10)
-- ---------------------------------------------------------------------------

-- The mode word (contract 10.2): the first word of the comment, in the words loggers know, from
-- the stored (canonical, lower-case) mode. SSB takes its sideband from the frequency: lower below
-- 10 MHz except 60 m (5000 to 5500 kHz), upper otherwise. Null for a spot without a mode.
create function public.local_cluster_mode_word(p_mode text, p_frequency_khz numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when nullif(trim(p_mode), '') is null then null
    when lower(trim(p_mode)) = 'ssb' then
      case when p_frequency_khz between 5000 and 5500 then 'USB'
           when p_frequency_khz < 10000 then 'LSB'
           else 'USB' end
    when lower(trim(p_mode)) in ('psk', 'psk31') then 'PSK31'
    else regexp_replace(upper(trim(p_mode)), '[^\x21-\x7e]', '?', 'g')
  end;
$$;

-- A spotter or callsign for the line (contract 10.1): trimmed, every character outside U+0021 to
-- U+007E made '?'; null when nothing is left.
create function public.local_cluster_station(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(regexp_replace(regexp_replace(coalesce(p_text, ''), '^\s+|\s+$', '', 'g'), '[^\x21-\x7e]', '?', 'g'), '');
$$;

-- The spot's reference with its program first (contract 9.4): POTA, SOTA, WWFF, WWBOTA (every
-- bunker, joined with ', '), else IOTA, as render_push_field('reference') picks it. Null when the
-- spot has none.
create function public.local_cluster_reference(p_spot jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    'POTA ' || nullif(p_spot ->> 'pota_reference', ''),
    'SOTA ' || nullif(p_spot ->> 'sota_summit_ref', ''),
    'WWFF ' || nullif(p_spot ->> 'wwff_reference', ''),
    'WWBOTA ' || (select string_agg(x, ', ' order by o)
                  from jsonb_array_elements_text(
                         case when jsonb_typeof(p_spot -> 'wwbota_references') = 'array'
                              then p_spot -> 'wwbota_references' end) with ordinality as t(x, o)
                  where x <> ''),
    'IOTA ' || nullif(p_spot ->> 'iota_reference', ''));
$$;

-- The finished comment (contract 10.2): the mode word when the spot has a mode, then each picked
-- field the spot has, in order (reference program first, the source's name, the spotter's comment
-- trimmed with each run of whitespace made one space), joined with single spaces, every character
-- outside U+0020 to U+007E made '?', cut to 30 characters and trimmed of a trailing space.
-- Stable, not immutable: plpgsql_check reads array_to_string as stable.
create function public.local_cluster_comment(p_fields text[], p_spot jsonb)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_parts text[] := array[]::text[];
  v_field text;
  v_value text;
begin
  v_value := public.local_cluster_mode_word(p_spot ->> 'mode', (p_spot ->> 'frequency_khz')::numeric);
  if v_value is not null then
    v_parts := v_parts || v_value;
  end if;
  foreach v_field in array coalesce(p_fields, '{}') loop
    v_value := case v_field
      when 'reference' then public.local_cluster_reference(p_spot)
      when 'source' then public.push_source_label(p_spot ->> 'source')
      when 'comment' then nullif(regexp_replace(regexp_replace(coalesce(p_spot ->> 'comment', ''),
                                                               '^\s+|\s+$', '', 'g'), '\s+', ' ', 'g'), '')
    end;
    if v_value is not null then
      v_parts := v_parts || v_value;
    end if;
  end loop;
  return rtrim(left(regexp_replace(array_to_string(v_parts, ' '), '[^\x20-\x7e]', '?', 'g'), 30), ' ');
end;
$$;

-- What a Local DX cluster destination adds to a claimed spot: the contract's spot event values
-- (9.4), finished here so the sender only names them. cluster_spotter is LONGLINES for a spot
-- without one; cluster_frequency_khz has at most one decimal; cluster_time is HHMM (UTC).
-- Stable, not immutable, as discord_spot_fields: jsonb_build_object and the time cast are.
create function public.local_cluster_spot_fields(p_settings local_cluster_destination_settings, p_spot jsonb)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'cluster_spotter', coalesce(public.local_cluster_station(p_spot ->> 'spotter'), 'LONGLINES'),
    'cluster_frequency_khz', round((p_spot ->> 'frequency_khz')::numeric, 1),
    'cluster_callsign', coalesce(public.local_cluster_station(p_spot ->> 'callsign'), ''),
    'cluster_comment', public.local_cluster_comment(p_settings.fields, p_spot),
    'cluster_time', to_char((p_spot ->> 'spot_time')::timestamptz at time zone 'UTC', 'HH24MI'),
    'cluster_mode', public.local_cluster_mode_word(p_spot ->> 'mode', (p_spot ->> 'frequency_khz')::numeric),
    'cluster_reference', public.local_cluster_reference(p_spot),
    'cluster_source', p_spot ->> 'source',
    'cluster_source_label', public.push_source_label(p_spot ->> 'source'));
$$;

-- One DX cluster line in DXSpider's layout (contract 10.1), without its CR LF: 'DX de ', the
-- spotter and ':' with the frequency (one decimal) right-aligned to column 24 and at least one
-- space between, two spaces, the callsign padded to 12, a space, the comment cut and padded to 30,
-- a space, HHMM and 'Z'. Only the spotter, callsign and comment are cleaned (as 10.1 says) and
-- only the comment is cut; a longer spotter, frequency or callsign moves the rest right. For the
-- editor's preview; the relay serves the real line.
create function public.local_cluster_line(p_spotter text, p_frequency_khz numeric, p_callsign text,
                                          p_comment text, p_time text)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'DX de ' || x.h || repeat(' ', greatest(1, 18 - length(x.h) - length(x.f))) || x.f || '  '
         || x.c || repeat(' ', greatest(0, 12 - length(x.c))) || ' '
         || x.m || repeat(' ', 30 - length(x.m)) || ' ' || coalesce(p_time, '') || 'Z'
  from (select coalesce(public.local_cluster_station(p_spotter), 'LONGLINES') || ':' as h,
               round(p_frequency_khz, 1)::text as f,
               coalesce(public.local_cluster_station(p_callsign), '') as c,
               left(regexp_replace(coalesce(p_comment, ''), '[^\x20-\x7e]', '?', 'g'), 30) as m) x;
$$;

-- The editor's sample spot: the contract's first example (10.3), W4DOG spotting K4ABC in POTA
-- K-0039 on 14062.0 kHz CW at 21:14 UTC today, with a spotter's comment for that field.
create function public.local_cluster_sample_spot()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select public.push_sample_spot() || jsonb_build_object(
    'callsign', 'K4ABC', 'base_callsign', 'K4ABC', 'spotter', 'W4DOG', 'frequency_khz', 14062,
    'band', '20m', 'mode', 'cw', 'mode_family', 'cw', 'comment', 'Shining Rock Wilderness',
    'pota_reference', 'K-0039', 'pota_park_name', 'Shining Rock Wilderness', 'pota_location', 'US-NC',
    'spot_time', (date_trunc('day', now() at time zone 'UTC') + interval '21 hours 14 minutes') at time zone 'UTC');
$$;

-- ---------------------------------------------------------------------------
-- 6. Matching: the loop guard
-- ---------------------------------------------------------------------------

-- As in 20261028000300, except that a local_cluster destination never takes a spot of its owner's
-- own logged contacts (the relay would serve the user's own contact back to their logger) or a
-- spot without a frequency (a cluster line needs one). The guard is in candidates too, so a
-- connection left with nothing to deliver to stamps no quiet window.
create or replace function public.match_pending_spots(batch_size int default 500)
returns int
language plpgsql
security definer
set search_path = public, pgmq
as $$
declare
  v_msg_ids      bigint[];
  v_spot_ids     bigint[];
  v_delivery_ids bigint[];
begin
  select array_agg(m.msg_id), array_agg((m.message ->> 'spot_id')::bigint)
    into v_msg_ids, v_spot_ids
  from pgmq.read('spot_events', 60, batch_size) m;

  if v_msg_ids is null then
    return 0;
  end if;

  with candidates as (
    select s.id as subscription_id, s.quiet_minutes, r.id as spot_id, r.callsign, r.spot_time,
           r.source, r.frequency_khz
    from raw_spots r
    join subscriptions s on s.enabled and public.spot_matches(s, r)
      and exists (select 1 from subscription_destinations sd
                  join destinations dd on dd.id = sd.destination_id and dd.enabled
                  where sd.subscription_id = s.id
                    and not (dd.type = 'local_cluster'
                             and (r.frequency_khz <= 0
                                  or (r.source = 'logged'
                                      and exists (select 1 from logged_contacts lc
                                                  where lc.spot_id = r.id and lc.user_id = dd.user_id)))))
    where r.id = any (v_spot_ids)
      and r.retracted_at is null
  ),
  -- With a quiet window, only the earliest spot per callsign in this batch is eligible.
  eligible as (
    (
      select distinct on (c.subscription_id, c.callsign) c.*
      from candidates c
      where c.quiet_minutes > 0
      order by c.subscription_id, c.callsign, c.spot_time, c.spot_id
    )
    union all
    select c.* from candidates c where c.quiet_minutes = 0
  ),
  allowed as (
    select e.*
    from eligible e
    left join subscription_quiet q
      on q.subscription_id = e.subscription_id and q.callsign = e.callsign
    where e.quiet_minutes = 0
       or q.last_sent_at is null
       or q.last_sent_at <= now() - make_interval(mins => e.quiet_minutes)
  ),
  stamp_quiet as (
    insert into subscription_quiet (subscription_id, callsign, last_sent_at)
    select distinct a.subscription_id, a.callsign, now()
    from allowed a
    where a.quiet_minutes > 0
    on conflict (subscription_id, callsign) do update set last_sent_at = excluded.last_sent_at
  ),
  ins as (
    insert into deliveries (subscription_id, destination_id, spot_id)
    select distinct on (sd.destination_id, a.spot_id) a.subscription_id, sd.destination_id, a.spot_id
    from allowed a
    join subscription_destinations sd on sd.subscription_id = a.subscription_id
    join destinations dd on dd.id = sd.destination_id and dd.enabled
    where not (dd.type = 'local_cluster'
               and (a.frequency_khz <= 0
                    or (a.source = 'logged'
                        and exists (select 1 from logged_contacts lc
                                    where lc.spot_id = a.spot_id and lc.user_id = dd.user_id))))
    order by sd.destination_id, a.spot_id, a.subscription_id
    on conflict (destination_id, spot_id) do nothing
    returning id
  )
  select array_agg(ins.id) into v_delivery_ids from ins;

  if v_delivery_ids is not null then
    perform pgmq.send_batch(
      'deliveries_queue',
      (select array_agg(jsonb_build_object('delivery_id', d)) from unnest(v_delivery_ids) as d)
    );
  end if;

  perform pgmq.archive('spot_events', v_msg_ids);

  -- Tell a listening sender there is work (delivered on commit). The sender polls today and
  -- will LISTEN on this channel later; until then the notify has no subscriber.
  if v_delivery_ids is not null then
    perform pg_notify('deliveries', '');
  end if;

  return coalesce(cardinality(v_delivery_ids), 0);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. claim_deliveries
-- ---------------------------------------------------------------------------

-- As in 20261021000600 (signature, result columns, grants, sweeps, hold, budget, debit and stamp
-- unchanged), plus Local DX cluster destinations:
--   1. `ready` takes a local_cluster row only while its relay's stream is open
--      (relay_tokens.cluster_connected_at); a row that waits longer than
--      destination_max_age('local_cluster') is dropped by the expiry sweep (0b), as any row past
--      its age. health_oldest_ready_seconds repeats the predicate.
--   2. the relay cap: after each destination's budget, a relay is handed at most
--      local_cluster_relay_cap() less its rows sent in the last minute, newest first across every
--      destination that targets it (relay_ranked, relay_sent). What it leaves waits or ages out.
--   3. a local_cluster destination's jsonb gains `local_cluster` ({relay_id, device_name}), and its
--      spots the cluster_* keys (local_cluster_spot_fields) and cluster_connection (the
--      connection's name), built once per destination as for the other types.
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
  c_expire_batch constant int := 500;
  v_now       timestamptz := clock_timestamp();
  v_unwanted  bigint[];
  v_expired   bigint[];
  v_orphans   bigint[];
  v_claimed   jsonb;
begin
  -- 0a. Unwanted: the subscription is disabled, no longer sends to this
  -- destination, or the destination is disabled or paused by hand. Not a
  -- loss, so dropped_at stays null, unless repeated failures turned the
  -- destination off (auto_disabled_at): then the spots are lost.
  with unwanted as (
    select d.id, dest.auto_disabled_at is not null as lost
    from pgmq.q_deliveries_queue q
    join deliveries d on d.id = (q.message ->> 'delivery_id')::bigint
    join subscriptions s on s.id = d.subscription_id
    join destinations dest on dest.id = d.destination_id
    where q.vt <= v_now
      and d.status in ('pending', 'failed')
      and (not s.enabled
           or not dest.enabled
           or dest.health = 'paused'
           or not exists (select 1 from subscription_destinations sd
                          where sd.subscription_id = d.subscription_id
                            and sd.destination_id = d.destination_id))
    order by d.created_at
    limit c_expire_batch
  ),
  dropped as (
    update deliveries d
    set status = 'dropped', dropped_at = case when unwanted.lost then v_now end
    from unwanted
    where d.id = unwanted.id and d.status in ('pending', 'failed')
    returning d.id
  )
  select array_agg(dropped.id) into v_unwanted from dropped;

  if v_unwanted is not null then
    perform pgmq.archive('deliveries_queue', array(
      select q.msg_id from pgmq.q_deliveries_queue q
      where (q.message ->> 'delivery_id')::bigint = any (v_unwanted)));
  end if;

  -- 0b. Expire: a push destination's own TTL when it has one, else the type's;
  -- and a webhook row whose retry policy's attempts are used up.
  with old as (
    select d.id
    from pgmq.q_deliveries_queue q
    join deliveries d on d.id = (q.message ->> 'delivery_id')::bigint
    join destinations dest on dest.id = d.destination_id
    left join push_destination_settings ps on ps.destination_id = dest.id
    left join webhook_destination_settings ws on ws.destination_id = dest.id
    where q.vt <= v_now
      and d.status in ('pending', 'failed')
      and (d.created_at < v_now - coalesce(make_interval(secs => ps.ttl_seconds),
                                           public.destination_max_age(dest.type))
           or public.webhook_retries_exhausted(ws.retry_policy, d.attempts))
    order by d.created_at
    limit c_expire_batch
  ),
  dropped as (
    update deliveries d
    set status = 'dropped', dropped_at = v_now
    from old
    where d.id = old.id and d.status in ('pending', 'failed')
    returning d.id
  )
  select array_agg(dropped.id) into v_expired from dropped;

  if v_expired is not null then
    perform pgmq.archive('deliveries_queue', array(
      select q.msg_id from pgmq.q_deliveries_queue q
      where (q.message ->> 'delivery_id')::bigint = any (v_expired)));
  end if;

  -- 1. Orphans: a visible message whose delivery row is gone.
  select array_agg(q.msg_id) into v_orphans
  from pgmq.q_deliveries_queue q
  where q.vt <= v_now
    and not exists (select 1 from deliveries d where d.id = (q.message ->> 'delivery_id')::bigint);
  if v_orphans is not null then
    perform pgmq.archive('deliveries_queue', v_orphans);
  end if;

  -- 1 to 5. Ready, hold, budget, rank, choose, claim. Ready leaves out what
  -- 0b would expire, with the same predicates, for rows past its 500.
  with ready as (
    select q.msg_id, d.id as delivery_id, d.destination_id, dest.type, r.spot_time, d.created_at,
           coalesce(ds.batch_seconds, ws.batch_seconds, 0) as batch_seconds,
           lcs.relay_token_id as relay_id
    from pgmq.q_deliveries_queue q
    join deliveries d on d.id = (q.message ->> 'delivery_id')::bigint
    join destinations dest on dest.id = d.destination_id
    join subscriptions s on s.id = d.subscription_id
    join raw_spots r on r.id = d.spot_id
    left join push_destination_settings ps on ps.destination_id = dest.id
    left join discord_destination_settings ds on ds.destination_id = dest.id
    left join webhook_destination_settings ws on ws.destination_id = dest.id
    left join local_cluster_destination_settings lcs on lcs.destination_id = dest.id
    left join relay_tokens rt on rt.id = lcs.relay_token_id
    where q.vt <= v_now
      and d.created_at >= v_now - coalesce(make_interval(secs => ps.ttl_seconds),
                                           public.destination_max_age(dest.type))
      and not public.webhook_retries_exhausted(ws.retry_policy, d.attempts)
      and dest.health <> 'paused'
      and dest.enabled
      and (dest.throttled_until is null or dest.throttled_until <= v_now)
      and (dest.type <> 'local_cluster' or rt.cluster_connected_at is not null)
      and s.enabled
      and exists (select 1 from subscription_destinations sd
                  where sd.subscription_id = d.subscription_id
                    and sd.destination_id = d.destination_id)
  ),
  -- A Discord or webhook destination with a window waits until its oldest
  -- ready row is that old or destination_batch_full(type) are ready.
  held as (
    select ready.destination_id
    from ready
    where ready.batch_seconds > 0
    group by ready.destination_id, ready.type, ready.batch_seconds
    having min(ready.created_at) > v_now - make_interval(secs => ready.batch_seconds)
       and count(*) < public.destination_batch_full(ready.type)
  ),
  budget as (
    select dest.id as destination_id,
           least(b.burst,
                 dest.claim_tokens
                 + b.rate_per_minute * greatest(0, extract(epoch from v_now - dest.claim_tokens_at)) / 60) as available,
           case when dest.type = 'webhook' then public.webhook_claim_max(coalesce(ws.batch_seconds, 0))
                else public.destination_claim_max(dest.type) end as claim_max
    from destinations dest
    cross join lateral public.destination_budget(dest.type) b
    left join webhook_destination_settings ws on ws.destination_id = dest.id
    where dest.id in (select distinct ready.destination_id from ready)
      and dest.id not in (select held.destination_id from held)
      and dest.claim_due_at <= v_now + public.destination_claim_interval(dest.type) / 2
  ),
  ranked as (
    select ready.msg_id, ready.delivery_id, ready.destination_id, ready.spot_time, ready.relay_id,
           budget.available, budget.claim_max,
           row_number() over (partition by ready.destination_id
                              order by ready.spot_time desc, ready.delivery_id desc) as rn
    from ready
    join budget on budget.destination_id = ready.destination_id
  ),
  -- Each destination's share under its own budget.
  affordable as (
    select ranked.*
    from ranked
    where ranked.rn <= floor(ranked.available)
      and (ranked.claim_max is null or ranked.rn <= ranked.claim_max)
  ),
  -- A relay's rows sent in the last minute, across its destinations (deliveries_sent_at_idx).
  relay_sent as (
    select lcs.relay_token_id as relay_id, count(*) as n
    from deliveries d
    join local_cluster_destination_settings lcs on lcs.destination_id = d.destination_id
    where d.sent_at > v_now - interval '1 minute'
      and lcs.relay_token_id in (select affordable.relay_id from affordable where affordable.relay_id is not null)
    group by lcs.relay_token_id
  ),
  relay_ranked as (
    select affordable.*,
           row_number() over (partition by affordable.relay_id
                              order by affordable.spot_time desc, affordable.delivery_id desc) as relay_rn
    from affordable
  ),
  chosen as (
    select rr.msg_id, rr.delivery_id, rr.destination_id, rr.spot_time, rr.available, rr.rn
    from relay_ranked rr
    left join relay_sent rs on rs.relay_id = rr.relay_id
    where rr.relay_id is null
       or rr.relay_rn <= public.local_cluster_relay_cap() - coalesce(rs.n, 0)
    order by rr.rn, rr.spot_time desc, rr.delivery_id desc
    limit p_limit
  ),
  claimed as (
    update pgmq.q_deliveries_queue q
    set vt = v_now + make_interval(secs => p_vt), read_ct = q.read_ct + 1
    from chosen
    where q.msg_id = chosen.msg_id and q.vt <= v_now
    returning q.msg_id, chosen.delivery_id, chosen.destination_id, chosen.available, chosen.rn, chosen.spot_time
  )
  select jsonb_agg(jsonb_build_object(
           'msg_id', claimed.msg_id, 'delivery_id', claimed.delivery_id,
           'destination_id', claimed.destination_id, 'available', claimed.available,
           'rn', claimed.rn, 'spot_time', claimed.spot_time))
    into v_claimed
  from claimed;

  if v_claimed is null then
    return;
  end if;

  -- 6. Debit.
  update destinations dest
  set claim_tokens = c.available - c.n, claim_tokens_at = v_now,
      claim_due_at = greatest(dest.claim_due_at, v_now) + public.destination_claim_interval(dest.type)
  from (
    select (x ->> 'destination_id')::uuid as destination_id,
           max((x ->> 'available')::numeric) as available,
           count(*) as n
    from jsonb_array_elements(v_claimed) x
    group by 1
  ) c
  where dest.id = c.destination_id;

  -- 6b. Stamp the URL generation the rows go out at. The debit holds each
  -- destination's row lock until this claim commits, so update_destination
  -- cannot change the URL between this stamp and the return below.
  update deliveries d
  set url_generation = dest.url_generation
  from destinations dest
  where d.id in (select (x ->> 'delivery_id')::bigint from jsonb_array_elements(v_claimed) x)
    and dest.id = d.destination_id;

  -- 7. Return, in the order chosen: every destination's newest spot first.
  -- A push destination's members, settings and quiet flag, a Discord
  -- destination's settings, a webhook destination's window and headers, and a
  -- Local DX cluster destination's relay, are built once per destination; their
  -- spots carry what is rendered from their fields. A destination somehow
  -- without a settings row (the triggers make one for every insert) is handed
  -- the defaults rather than left undeliverable.
  return query
    with push_dests as (
      select dest.id as p_id, ps.s as p_settings,
             jsonb_build_object(
               'devices', public.push_member_devices(dest.id),
               'push', to_jsonb(ps.s) - 'destination_id',
               'quiet_now', public.push_quiet_now(ps.s, pr.timezone, v_now)) as p_extra
      from destinations dest
      cross join lateral (
        select coalesce(
          (select st from push_destination_settings st where st.destination_id = dest.id),
          jsonb_populate_record(null::push_destination_settings,
                                public.push_default_settings() || jsonb_build_object('destination_id', dest.id))) as s
      ) ps
      left join profiles pr on pr.id = dest.user_id
      where dest.type = 'push'
        and dest.id in (select distinct (x ->> 'destination_id')::uuid from jsonb_array_elements(v_claimed) x)
    ),
    discord_dests as (
      select dest.id as d_id, ds.s as d_settings,
             jsonb_build_object('discord', to_jsonb(ds.s) - 'destination_id') as d_extra
      from destinations dest
      cross join lateral (
        select coalesce(
          (select st from discord_destination_settings st where st.destination_id = dest.id),
          jsonb_populate_record(null::discord_destination_settings,
                                public.discord_default_settings() || jsonb_build_object('destination_id', dest.id))) as s
      ) ds
      where dest.type = 'discord'
        and dest.id in (select distinct (x ->> 'destination_id')::uuid from jsonb_array_elements(v_claimed) x)
    ),
    webhook_dests as (
      select dest.id as w_id, ws.s as w_settings,
             jsonb_build_object('webhook', jsonb_build_object(
               'batch_seconds', (ws.s).batch_seconds,
               'headers', public.webhook_header_values(dest.id))) as w_extra
      from destinations dest
      cross join lateral (
        select coalesce(
          (select st from webhook_destination_settings st where st.destination_id = dest.id),
          jsonb_populate_record(null::webhook_destination_settings,
                                public.webhook_default_settings() || jsonb_build_object('destination_id', dest.id))) as s
      ) ws
      where dest.type = 'webhook'
        and dest.id in (select distinct (x ->> 'destination_id')::uuid from jsonb_array_elements(v_claimed) x)
    ),
    cluster_dests as (
      select dest.id as c_id, cs.s as c_settings,
             jsonb_build_object('local_cluster', jsonb_build_object(
               'relay_id', rt.id, 'device_name', rt.device_name)) as c_extra
      from destinations dest
      cross join lateral (
        select coalesce(
          (select st from local_cluster_destination_settings st where st.destination_id = dest.id),
          jsonb_populate_record(null::local_cluster_destination_settings,
                                public.local_cluster_default_settings() || jsonb_build_object('destination_id', dest.id))) as s
      ) cs
      left join relay_tokens rt on rt.id = (cs.s).relay_token_id
      where dest.type = 'local_cluster'
        and dest.id in (select distinct (x ->> 'destination_id')::uuid from jsonb_array_elements(v_claimed) x)
    )
    select
      (x ->> 'msg_id')::bigint,
      d.id, d.subscription_id, d.attempts, d.created_at,
      jsonb_build_object(
        'id', dest.id, 'type', dest.type, 'name', dest.name, 'url', dest.url,
        'signing_secret', dest.signing_secret, 'health', dest.health,
        'consecutive_failures', dest.consecutive_failures
      ) || coalesce(pd.p_extra, dd.d_extra, wd.w_extra, cd.c_extra, '{}'::jsonb),
      public.delivery_spot_json(r)
        || case when pd.p_id is not null then public.push_spot_fields(pd.p_settings, public.delivery_spot_json(r))
                when dd.d_id is not null then public.discord_spot_fields(dd.d_settings, public.delivery_spot_json(r))
                when wd.w_id is not null then jsonb_build_object(
                  'webhook_fields', public.webhook_spot_fields(wd.w_settings, public.delivery_spot_json(r)),
                  'webhook_connection', s.name)
                when cd.c_id is not null then
                  public.local_cluster_spot_fields(cd.c_settings, public.delivery_spot_json(r))
                  || jsonb_build_object('cluster_connection', s.name)
                else '{}'::jsonb end
    from jsonb_array_elements(v_claimed) x
    join deliveries d on d.id = (x ->> 'delivery_id')::bigint
    join destinations dest on dest.id = d.destination_id
    join subscriptions s on s.id = d.subscription_id
    join raw_spots r on r.id = d.spot_id
    left join push_dests pd on pd.p_id = dest.id
    left join discord_dests dd on dd.d_id = dest.id
    left join webhook_dests wd on wd.w_id = dest.id
    left join cluster_dests cd on cd.c_id = dest.id
    order by (x ->> 'rn')::bigint, (x ->> 'spot_time')::timestamptz desc, d.id desc;
end;
$$;

-- As in 20261021000100, plus claim_deliveries' new `ready` predicate: a local_cluster row is ready
-- only while its relay is connected. Change the two together.
create or replace function public.health_oldest_ready_seconds(p_now timestamptz)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select max(x.age)::int
  from (
    select extract(epoch from p_now - max(d.created_at)) as age
    from pgmq.q_deliveries_queue q
    join deliveries d on d.id = (q.message ->> 'delivery_id')::bigint
    join destinations dest on dest.id = d.destination_id
    join subscriptions s on s.id = d.subscription_id
    left join push_destination_settings ps on ps.destination_id = dest.id
    left join webhook_destination_settings ws on ws.destination_id = dest.id
    left join local_cluster_destination_settings lcs on lcs.destination_id = dest.id
    left join relay_tokens rt on rt.id = lcs.relay_token_id
    where q.vt <= p_now
      and d.created_at >= p_now - coalesce(make_interval(secs => ps.ttl_seconds),
                                           public.destination_max_age(dest.type))
      and not public.webhook_retries_exhausted(ws.retry_policy, d.attempts)
      and dest.health <> 'paused'
      and dest.enabled
      and (dest.throttled_until is null or dest.throttled_until <= p_now)
      and (dest.type <> 'local_cluster' or rt.cluster_connected_at is not null)
      and s.enabled
      and exists (select 1 from subscription_destinations sd
                  where sd.subscription_id = d.subscription_id
                    and sd.destination_id = d.destination_id)
    group by d.destination_id
  ) x;
$$;

-- ---------------------------------------------------------------------------
-- 8. Client RPCs
-- ---------------------------------------------------------------------------

-- Creates (p_id null) or updates one of the caller's Local DX cluster destinations, as
-- save_push_destination does for push: no URL, a null name or enabled keeps what is stored, and
-- p_settings ({relay_id, fields}) is merged key by key over the current settings and checked as a
-- whole. A new destination always needs a relay. Returns the destination id.
create function public.save_local_cluster_destination(p_id uuid, p_name text, p_enabled boolean, p_settings jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user       uuid := auth.uid();
  v_id         uuid := p_id;
  v_settings   local_cluster_destination_settings;
  v_constraint text;
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  if (v_id is null and coalesce(trim(p_name), '') = '') or (p_name is not null and trim(p_name) = '') then
    raise exception 'Give the destination a name.';
  end if;
  perform public.check_local_cluster_setting_keys(p_settings);
  if v_id is not null
     and not exists (select 1 from destinations d where d.id = v_id and d.user_id = v_user and d.type = 'local_cluster') then
    raise exception 'Destination not found.';
  end if;
  if v_id is null or p_settings is not null then
    v_settings := public.local_cluster_settings_record(v_id,
      coalesce((select public.local_cluster_settings_json(s) from local_cluster_destination_settings s
                where s.destination_id = v_id), public.local_cluster_default_settings())
      || coalesce(p_settings, '{}'::jsonb));
    perform public.validate_local_cluster_settings(v_settings, v_user);
  end if;

  begin
    if v_id is null then
      insert into destinations (user_id, type, name, url, url_display, enabled)
      values (v_user, 'local_cluster', trim(p_name), null, public.destination_url_display('local_cluster', null),
              coalesce(p_enabled, true))
      returning id into v_id;
    else
      update destinations d
      set name = coalesce(trim(p_name), d.name), enabled = coalesce(p_enabled, d.enabled)
      where d.id = v_id;
    end if;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'destinations_user_name_key' then
      raise exception 'A destination named % already exists. Choose a different name.', trim(p_name);
    end if;
    raise;
  end;

  if v_settings.fields is not null then
    insert into local_cluster_destination_settings (destination_id, relay_token_id, fields)
    values (v_id, v_settings.relay_token_id, v_settings.fields)
    on conflict (destination_id) do update
    set relay_token_id = excluded.relay_token_id, fields = excluded.fields;
  end if;
  return v_id;
end;
$$;

-- One of the caller's Local DX cluster destinations for the editor: its settings ({relay_id,
-- fields}). relay_id is null once that relay was revoked.
create function public.get_local_cluster_destination(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;
  select jsonb_build_object(
           'id', d.id, 'name', d.name, 'enabled', d.enabled, 'url_display', d.url_display,
           'settings', public.local_cluster_settings_json(s))
    into v_result
  from destinations d
  join local_cluster_destination_settings s on s.destination_id = d.id
  where d.id = p_id and d.user_id = auth.uid() and d.type = 'local_cluster';
  if v_result is null then
    raise exception 'Destination not found.';
  end if;
  return v_result;
end;
$$;

-- Each of the caller's Local DX cluster destinations with its relay, for the list cards' type line
-- ("Local DX cluster · Shack PC") and the Relay offline chip, so the settings table keeps no client
-- grant: [{destination_id, relay_id, device_name, platform, cluster_connected_at, fields}], the
-- relay's keys null when it was revoked.
create function public.list_local_cluster_destination_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'destination_id', d.id, 'relay_id', t.id, 'device_name', t.device_name, 'platform', t.platform,
             'cluster_connected_at', t.cluster_connected_at, 'fields', to_jsonb(s.fields))
           order by d.created_at, d.id)
    from destinations d
    join local_cluster_destination_settings s on s.destination_id = d.id
    left join relay_tokens t on t.id = s.relay_token_id
    where d.user_id = auth.uid() and d.type = 'local_cluster'), '[]'::jsonb);
end;
$$;

-- The editor's preview: the settings (merged over the defaults; null for the defaults) rendered
-- against raw_spots row p_spot_id, or the sample spot, through the same local_cluster_spot_fields
-- the claim calls, after the same field checks a save makes (the relay is not needed to preview).
-- A retracted spot (a logged contact taken back) is not found, as for every reader of raw_spots.
-- Returns {line, spotter, frequency_khz, callsign, comment, time_utc}; line has no CR LF.
create function public.preview_local_cluster_line(p_settings jsonb, p_spot_id bigint default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_settings local_cluster_destination_settings;
  v_spot     jsonb;
  v_fields   jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;
  perform public.check_local_cluster_setting_keys(p_settings);
  v_settings := public.local_cluster_settings_record(null,
    public.local_cluster_default_settings() || coalesce(p_settings, '{}'::jsonb));
  perform public.validate_local_cluster_fields(v_settings.fields);
  if p_spot_id is null then
    v_spot := public.local_cluster_sample_spot();
  else
    select public.delivery_spot_json(r) into v_spot from raw_spots r
    where r.id = p_spot_id and r.retracted_at is null;
    if v_spot is null then
      raise exception 'Spot not found.';
    end if;
  end if;
  v_fields := public.local_cluster_spot_fields(v_settings, v_spot);
  return jsonb_build_object(
    'line', public.local_cluster_line(v_fields ->> 'cluster_spotter', (v_fields ->> 'cluster_frequency_khz')::numeric,
                                      v_fields ->> 'cluster_callsign', v_fields ->> 'cluster_comment',
                                      v_fields ->> 'cluster_time'),
    'spotter', v_fields -> 'cluster_spotter',
    'frequency_khz', v_fields -> 'cluster_frequency_khz',
    'callsign', v_fields -> 'cluster_callsign',
    'comment', v_fields -> 'cluster_comment',
    'time_utc', v_fields -> 'cluster_time');
end;
$$;

-- As in 20261018000300, plus a Local DX cluster's settings (its relay and fields).
create or replace function public.duplicate_destination(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_src  destinations;
  v_id   uuid;
  v_name text;
  v_constraint text;
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  select * into v_src from destinations d where d.id = p_id and d.user_id = v_user;
  if not found then
    raise exception 'Destination not found.';
  end if;
  v_name := public.unique_destination_name(v_user, 'Copy of ' || v_src.name);
  begin
    insert into destinations (user_id, type, name, url, url_display, enabled, signing_secret, secret_rotated_at)
    values (v_user, v_src.type, v_name, v_src.url, v_src.url_display, false, v_src.signing_secret,
            v_src.secret_rotated_at)
    returning id into v_id;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'destinations_user_name_key' then
      raise exception 'A destination named % already exists. Choose a different name.', v_name;
    end if;
    raise;
  end;
  if v_src.type = 'push' then
    update push_destination_settings s
    set title_fields = o.title_fields, body_fields = o.body_fields, show_field_names = o.show_field_names,
        body_separator = o.body_separator, tap_target = o.tap_target, action_buttons = o.action_buttons,
        urgency = o.urgency, ttl_seconds = o.ttl_seconds, replace_same_station = o.replace_same_station,
        sound = o.sound, quiet_enabled = o.quiet_enabled, quiet_from = o.quiet_from,
        quiet_until = o.quiet_until, quiet_mode = o.quiet_mode
    from push_destination_settings o
    where s.destination_id = v_id and o.destination_id = p_id;
    insert into push_destination_devices (destination_id, device_id)
    select v_id, m.device_id from push_destination_devices m where m.destination_id = p_id;
  elsif v_src.type = 'discord' then
    update discord_destination_settings s
    set style = o.style, title_fields = o.title_fields, detail_fields = o.detail_fields,
        grid_fields = o.grid_fields, title_link = o.title_link, card_color = o.card_color, footer = o.footer,
        line_fields = o.line_fields, bold_first = o.bold_first, link_preview = o.link_preview,
        show_field_names = o.show_field_names, separator = o.separator, batch_seconds = o.batch_seconds
    from discord_destination_settings o
    where s.destination_id = v_id and o.destination_id = p_id;
  elsif v_src.type = 'webhook' then
    update webhook_destination_settings s
    set fields = o.fields, key_style = o.key_style, time_format = o.time_format,
        frequency_unit = o.frequency_unit, missing_values = o.missing_values, batch_seconds = o.batch_seconds,
        retry_policy = o.retry_policy, pause_after_failures = o.pause_after_failures
    from webhook_destination_settings o
    where s.destination_id = v_id and o.destination_id = p_id;
    insert into webhook_destination_headers (destination_id, position, name, secret_id)
    select v_id, h.position, h.name, public.webhook_header_secret(v.decrypted_secret)
    from webhook_destination_headers h
    join vault.decrypted_secrets v on v.id = h.secret_id
    where h.destination_id = p_id;
  elsif v_src.type = 'local_cluster' then
    update local_cluster_destination_settings s
    set relay_token_id = o.relay_token_id, fields = o.fields
    from local_cluster_destination_settings o
    where s.destination_id = v_id and o.destination_id = p_id;
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Management API
-- ---------------------------------------------------------------------------

-- As in 20261018000300, plus a Local DX cluster's relay and fields (read only: the API neither
-- creates one nor changes its settings).
create or replace function public.api_destination_json(d destinations)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'id', d.id, 'type', d.type, 'name', d.name, 'url_display', d.url_display, 'enabled', d.enabled,
    'health', d.health, 'consecutive_failures', d.consecutive_failures,
    'last_success_at', d.last_success_at, 'last_error', d.last_error,
    'last_error_at', d.last_error_at, 'created_at', d.created_at)
  || case when d.type = 'push' then jsonb_build_object('push',
       (select to_jsonb(s) - 'destination_id' from push_destination_settings s where s.destination_id = d.id)
       || jsonb_build_object('device_count',
            (select count(*) from push_destination_devices m where m.destination_id = d.id)))
     when d.type = 'discord' then jsonb_build_object('discord',
       (select to_jsonb(s) - 'destination_id' from discord_destination_settings s where s.destination_id = d.id))
     when d.type = 'webhook' then jsonb_build_object('webhook',
       coalesce((select to_jsonb(s) - 'destination_id' from webhook_destination_settings s
                 where s.destination_id = d.id), '{}'::jsonb)
       || jsonb_build_object('headers', public.webhook_header_names(d.id),
                             'secret_rotated_at', d.secret_rotated_at, 'auto_disabled_at', d.auto_disabled_at))
     when d.type = 'local_cluster' then jsonb_build_object('local_cluster',
       coalesce((select jsonb_build_object('relay_id', t.id, 'relay_name', t.device_name, 'fields', to_jsonb(s.fields))
                 from local_cluster_destination_settings s
                 left join relay_tokens t on t.id = s.relay_token_id
                 where s.destination_id = d.id),
                jsonb_build_object('relay_id', null, 'relay_name', null, 'fields', '[]'::jsonb)))
     else '{}'::jsonb end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Access. Every function above starts executable by public; revoking that leaves
-- service_role (20261012000120). Clients get the four Local DX cluster RPCs; the sender gets
-- authenticate_relay_token and the two presence RPCs. Redefined functions keep their grants
-- (create or replace keeps them).
-- ---------------------------------------------------------------------------

revoke all on function public.relay_scopes() from public;
revoke all on function public.insert_relay_pairing(text, text, text[], text) from public;
revoke all on function public.start_relay_pairing(text, text, text[], text) from public;
revoke all on function public.relay_account(uuid, uuid) from public;
revoke all on function public.set_cluster_stream(uuid, boolean) from public;
revoke all on function public.reset_cluster_streams() from public;
revoke all on function public.local_cluster_relay_cap() from public;
revoke all on function public.local_cluster_fields() from public;
revoke all on function public.local_cluster_fields_valid(text[]) from public;
revoke all on function public.local_cluster_default_settings() from public;
revoke all on function public.local_cluster_destination_settings_default() from public;
revoke all on function public.local_cluster_settings_json(local_cluster_destination_settings) from public;
revoke all on function public.check_local_cluster_setting_keys(jsonb) from public;
revoke all on function public.local_cluster_settings_record(uuid, jsonb) from public;
revoke all on function public.validate_local_cluster_fields(text[]) from public;
revoke all on function public.validate_local_cluster_settings(local_cluster_destination_settings, uuid) from public;
revoke all on function public.local_cluster_mode_word(text, numeric) from public;
revoke all on function public.local_cluster_station(text) from public;
revoke all on function public.local_cluster_reference(jsonb) from public;
revoke all on function public.local_cluster_comment(text[], jsonb) from public;
revoke all on function public.local_cluster_spot_fields(local_cluster_destination_settings, jsonb) from public;
revoke all on function public.local_cluster_line(text, numeric, text, text, text) from public;
revoke all on function public.local_cluster_sample_spot() from public;
revoke all on function public.save_local_cluster_destination(uuid, text, boolean, jsonb) from public;
revoke all on function public.get_local_cluster_destination(uuid) from public;
revoke all on function public.list_local_cluster_destination_settings() from public;
revoke all on function public.preview_local_cluster_line(jsonb, bigint) from public;

grant execute on function public.start_relay_pairing(text, text, text[], text) to service_role;
grant execute on function public.relay_account(uuid, uuid) to service_role;
grant execute on function public.authenticate_relay_token(text) to delivery_sender;
grant execute on function public.set_cluster_stream(uuid, boolean) to service_role, delivery_sender;
grant execute on function public.reset_cluster_streams() to service_role, delivery_sender;
grant execute on function public.save_local_cluster_destination(uuid, text, boolean, jsonb) to authenticated;
grant execute on function public.get_local_cluster_destination(uuid) to authenticated;
grant execute on function public.list_local_cluster_destination_settings() to authenticated;
grant execute on function public.preview_local_cluster_line(jsonb, bigint) to authenticated;

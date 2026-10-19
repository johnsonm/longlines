-- Webhook destinations as canvas page 7 draws them: an ordered pick of fields
-- with fixed key names, key style, time format, frequency unit and missing
-- values; extra headers kept in Supabase Vault; one request per spot or
-- grouped every 10, 30 or 60 seconds; a retry policy and a pause after
-- repeated failures; a preview and Send test. See
-- docs/superpowers/specs/2026-10-18-webhook-destination-design.md.
--
-- The model is Discord's (20261018000100): a settings table with a defaults
-- trigger, the spot rendered here (webhook_spot_fields, as ordered
-- [{key, value}] pairs because jsonb does not keep key order) and carried in
-- the jsonb claim_deliveries already returns, a preview RPC and a
-- service-role test RPC that call the same renderer, policy (hold, per-claim
-- cap, retry schedule, attempt limit, pause) in SQL, and a sender that only
-- builds the body in the pairs' order, signs it and posts it.
--
-- claim_deliveries and mark_deliveries_failed keep their signatures and
-- result columns (sender spec, sections 2, 3 and 10). The sender tolerates a
-- claim without the `webhook` key and sends the legacy body, so this and the
-- sender ship in either order.
--
-- The sender's RPC allowlist, its grants (sender_role.test.sql) and its env do
-- not change; the new tables give delivery_sender nothing.

-- ---------------------------------------------------------------------------
-- 1. Destinations: rotation time, pause columns, masked URL
-- ---------------------------------------------------------------------------

-- When the signing secret was made or last rotated (decision 7). Webhooks
-- only; not in the client column grant (the editor reads it through
-- get_webhook_destination).
alter table destinations add column secret_rotated_at timestamptz;
-- Set when repeated failures turned the destination off (decision 4); the
-- list cards show Paused while it is set, so clients may read it.
alter table destinations add column auto_disabled_at timestamptz;
-- The pause's own count, spaced at least webhook_pause_spacing() apart, and
-- when it last moved (decision 4). Not in the client column grant.
alter table destinations add column pause_failures int not null default 0;
alter table destinations add column pause_failure_at timestamptz;
grant select (auto_disabled_at) on destinations to authenticated;

update destinations set secret_rotated_at = created_at where type = 'webhook' and secret_rotated_at is null;

-- A new webhook's secret is made with the row, so create_destination needs no
-- change; duplicate_destination passes the source's time, which this keeps.
create function public.destinations_secret_rotated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.secret_rotated_at := now();
  return new;
end;
$$;

create trigger destinations_secret_rotated_at
  before insert on destinations
  for each row when (new.type = 'webhook' and new.secret_rotated_at is null)
  execute function public.destinations_secret_rotated_at();

-- Same as 20261014000100 except a webhook's display (decision 8): scheme,
-- host, port and path without the query, the last non-empty path segment
-- replaced by '••••••' (a trailing slash kept), as the list artboard draws.
-- A webhook URL often carries its token in the path (a Zapier catch hook
-- ends .../123456/abcdef/), and the URL is never returned.
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
    when p_type = 'webhook' then
      'https://' || parts[1] || parts[2] || regexp_replace(parts[3], '[^/]+(/*)$', '••••••\1')
    else 'https://' || parts[1] || parts[2] || parts[3]
  end
  from d;
$$;

update destinations
set url_display = coalesce(public.destination_url_display(type, url), url_display)
where type = 'webhook';

-- Same as 20261006000002 plus the rotation time.
create or replace function public.rotate_signing_secret(p_destination_id uuid)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_secret text := 'whsec_' || encode(gen_random_bytes(24), 'hex');
  v_found boolean;
begin
  update destinations d
  set signing_secret = v_secret, secret_rotated_at = now()
  where d.id = p_destination_id and d.user_id = auth.uid() and d.type = 'webhook'
  returning true into v_found;
  if v_found is null then
    raise exception 'Destination not found.';
  end if;
  return v_secret;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Field catalog, knobs and settings
-- ---------------------------------------------------------------------------

-- The fields a webhook spot can carry, in the editor's order (decision 6).
create function public.webhook_fields()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['id', 'time', 'callsign', 'frequency', 'mode', 'band', 'source', 'reference', 'place_name',
               'state', 'spotter', 'country', 'url', 'comment'];
$$;

-- True when every name is a webhook field, none twice, and there are 1 to 14.
-- The check constraint uses it; saves and the preview raise the editor's
-- messages first (validate_webhook_fields).
create function public.webhook_fields_valid(p_fields text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_fields is not null
     and cardinality(p_fields) between 1 and 14
     and p_fields <@ public.webhook_fields()
     and (select count(distinct f) from unnest(p_fields) f) = cardinality(p_fields);
$$;

-- How many ready rows release a batch hold at once (decision 12): Discord 10
-- (one message of ten spots), a webhook 50 (one request). Null for types
-- without a hold.
create function public.destination_batch_full(p_type text)
returns int
language sql
immutable
set search_path = ''
as $$
  select case p_type when 'discord' then 10 when 'webhook' then 50 end;
$$;

-- The most spots one claim hands a webhook (decision 13): five when it sends
-- one request per spot, so a receiver that answers just inside the sender's
-- 10 s timeout holds a worker for at most 50 s a cycle; no cap beyond the
-- bucket when it groups (a claim of 200 is at most four requests of 50).
create function public.webhook_claim_max(p_batch_seconds int)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case when p_batch_seconds = 0 then 5::numeric end;
$$;

-- Attempts a retry policy allows, the first send included (decision 14):
-- none 1, three_10m 4, day no limit (the 24-hour age drops it).
create function public.webhook_retry_max_attempts(p_policy text)
returns int
language sql
immutable
set search_path = ''
as $$
  select case p_policy when 'none' then 1 when 'three_10m' then 4 end;
$$;

-- True when a row has used up its policy's attempts. The claim's expiry
-- sweep drops such a row and `ready` leaves it out; keep the two together.
-- False for a policy without a limit and for rows that are not webhooks
-- (a null policy).
create function public.webhook_retries_exhausted(p_policy text, p_attempts int)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_attempts >= public.webhook_retry_max_attempts(p_policy), false);
$$;

-- Seconds to wait after failed attempt p_attempt (1-based) before the next:
-- three_10m retries about 1, 4 and 10 minutes after the first failure; day is
-- the old TypeScript backoff (30 s, 1 m, 2 m, 5 m, 15 m, then every 30 m).
-- none never retries (mark_deliveries_failed makes its row visible at once
-- for the sweep).
create function public.webhook_retry_delay(p_policy text, p_attempt int)
returns int
language sql
immutable
set search_path = ''
as $$
  select case p_policy
    when 'three_10m' then (array[60, 180, 360])[least(greatest(coalesce(p_attempt, 1), 1), 3)]
    when 'day' then coalesce((array[30, 60, 120, 300, 900])[greatest(coalesce(p_attempt, 1), 1)], 1800)
    else 0
  end;
$$;

-- The least gap between two failures that both count toward the pause
-- (decision 4): the sender marks one failure per destination per cycle, every
-- few seconds, so twenty uncounted calls would be two minutes of downtime.
create function public.webhook_pause_spacing()
returns interval
language sql
immutable
set search_path = ''
as $$
  select interval '30 seconds';
$$;

-- One row per webhook destination. RLS on, no policies, no client grants:
-- clients read it through get_webhook_destination and
-- list_webhook_destination_settings and write it through
-- save_webhook_destination.
create table webhook_destination_settings (
  destination_id       uuid primary key references destinations(id) on delete cascade,
  fields               text[] not null check (public.webhook_fields_valid(fields)),
  key_style            text not null check (key_style in ('snake', 'camel')),
  time_format          text not null check (time_format in ('iso_utc', 'unix_seconds')),
  frequency_unit       text not null check (frequency_unit in ('khz', 'mhz', 'hz')),
  missing_values       text not null check (missing_values in ('omit', 'null')),
  batch_seconds        int not null check (batch_seconds in (0, 10, 30, 60)),
  retry_policy         text not null check (retry_policy in ('none', 'three_10m', 'day')),
  pause_after_failures int check (pause_after_failures between 1 and 100)
);
alter table webhook_destination_settings enable row level security;
revoke all on webhook_destination_settings from anon, authenticated;

-- A new webhook's settings, keyed by column (the canvas's defaults, except
-- the pause). save_webhook_destination and the preview accept exactly these
-- keys. pause_after_failures stays null until the web editor ships (PR 3's
-- migration makes it 20): until then the app can neither show a paused
-- webhook nor turn one back on, so a webhook made through the old dialog
-- must not turn itself off.
create function public.webhook_default_settings()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'fields', jsonb_build_array('id', 'time', 'callsign', 'frequency', 'mode', 'band', 'source', 'reference',
                                'place_name', 'state', 'spotter'),
    'key_style', 'snake',
    'time_format', 'iso_utc',
    'frequency_unit', 'khz',
    'missing_values', 'omit',
    'batch_seconds', 0,
    'retry_policy', 'three_10m',
    'pause_after_failures', null);
$$;

-- The settings a webhook made before this migration gets (decision 10): as
-- close to the old behaviour as the new body allows. Every field, grouped
-- every 10 seconds (the old body was a list per claim), retried for 24 hours,
-- never paused.
create function public.webhook_legacy_settings()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select public.webhook_default_settings()
      || jsonb_build_object('fields', to_jsonb(public.webhook_fields()), 'batch_seconds', 10,
                            'retry_policy', 'day', 'pause_after_failures', null);
$$;

-- Not security definer, like Discord's: destinations are inserted only
-- inside definer RPCs or by the service role.
create function public.webhook_destination_settings_default()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  insert into webhook_destination_settings
  select * from jsonb_populate_record(null::webhook_destination_settings,
    public.webhook_default_settings() || jsonb_build_object('destination_id', new.id));
  return null;
end;
$$;

create trigger destinations_webhook_settings
  after insert on destinations
  for each row when (new.type = 'webhook')
  execute function public.webhook_destination_settings_default();

-- Existing webhooks get the legacy settings. Idempotent.
insert into webhook_destination_settings
select (jsonb_populate_record(null::webhook_destination_settings,
         public.webhook_legacy_settings() || jsonb_build_object('destination_id', d.id))).*
from destinations d
where d.type = 'webhook'
  and not exists (select 1 from webhook_destination_settings s where s.destination_id = d.id);

-- Raises "Unknown setting {key}." for a key that is not a settings column.
create function public.check_webhook_setting_keys(p_settings jsonb)
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
  where not public.webhook_default_settings() ? k
  order by k limit 1;
  if v_key is not null then
    raise exception 'Unknown setting %.', v_key;
  end if;
end;
$$;

-- Raises the editor's message when the field list is not usable.
create function public.validate_webhook_fields(p_fields text[])
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_field text;
  v_count int := coalesce(cardinality(p_fields), 0);
begin
  select f into v_field from unnest(coalesce(p_fields, '{}')) f
  where f is null or not (f = any (public.webhook_fields())) limit 1;
  if found then
    raise exception 'Unknown field %.', coalesce(v_field, 'null');
  end if;
  if v_count = 0 then
    raise exception 'Pick at least one field.';
  end if;
  if (select count(distinct f) from unnest(p_fields) f) <> v_count then
    raise exception 'Pick each field once.';
  end if;
end;
$$;

-- Every check of the table's constraints, with a message, so the preview
-- (which writes nothing) refuses what a save would refuse, and a save says
-- why instead of failing a constraint. The editor's selects and switches
-- cannot produce these; a malformed request can.
create function public.validate_webhook_settings(p_settings webhook_destination_settings)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  perform public.validate_webhook_fields(p_settings.fields);
  if p_settings.key_style is null or p_settings.key_style not in ('snake', 'camel') then
    raise exception 'Pick a key style.';
  end if;
  if p_settings.time_format is null or p_settings.time_format not in ('iso_utc', 'unix_seconds') then
    raise exception 'Pick a time format.';
  end if;
  if p_settings.frequency_unit is null or p_settings.frequency_unit not in ('khz', 'mhz', 'hz') then
    raise exception 'Pick a frequency unit.';
  end if;
  if p_settings.missing_values is null or p_settings.missing_values not in ('omit', 'null') then
    raise exception 'Pick what to send when a spot has no value.';
  end if;
  if p_settings.batch_seconds is null or p_settings.batch_seconds not in (0, 10, 30, 60) then
    raise exception 'Pick a batch window.';
  end if;
  if p_settings.retry_policy is null or p_settings.retry_policy not in ('none', 'three_10m', 'day') then
    raise exception 'Pick a retry policy.';
  end if;
  if p_settings.pause_after_failures is not null and p_settings.pause_after_failures not between 1 and 100 then
    raise exception 'Pause after 1 to 100 failures, or never.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Extra headers, their values in Supabase Vault (decision 5)
-- ---------------------------------------------------------------------------

-- A header name a user may set: a token of letters, digits, '-', '_' and '.'
-- (at most 64), and not one Long Lines sets or that changes how the request
-- is framed or routed. The same list is WEBHOOK_RESERVED_HEADERS in
-- _shared/delivery/format.ts; change both together.
create function public.webhook_header_name_valid(p_name text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_name ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'
                  and lower(p_name) not in ('accept', 'connection', 'content-encoding', 'content-length',
                                            'content-type', 'expect', 'host', 'keep-alive', 'te', 'trailer',
                                            'transfer-encoding', 'upgrade', 'user-agent')
                  and lower(p_name) !~ '^(proxy-|x-longlines-)', false);
$$;

-- One row per extra header, its value a Vault secret. RLS on, no policies, no
-- client grants: clients and the API only ever get names
-- (webhook_header_names); values leave Vault only in claim_deliveries,
-- webhook_test_delivery and duplicate_destination (webhook_header_values).
create table webhook_destination_headers (
  id             uuid primary key default gen_random_uuid(),
  destination_id uuid not null references destinations(id) on delete cascade,
  position       smallint not null check (position between 1 and 10),
  name           text not null check (public.webhook_header_name_valid(name)),
  secret_id      uuid not null,
  constraint webhook_destination_headers_position_key unique (destination_id, position) deferrable initially deferred
);
create unique index webhook_destination_headers_name_key on webhook_destination_headers (destination_id, lower(name));
alter table webhook_destination_headers enable row level security;
revoke all on webhook_destination_headers from anon, authenticated;

-- A header's Vault secret goes with it: deleted with the row (the
-- destination's delete cascades here, by its owner or with the account) and
-- when a new value replaces it. Security definer because a client's
-- `delete from destinations` reaches this trigger as the client.
create function public.webhook_destination_headers_drop_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' or old.secret_id is distinct from new.secret_id then
    delete from vault.secrets s where s.id = old.secret_id;
  end if;
  return null;
end;
$$;

create trigger webhook_destination_headers_drop_secret
  after delete or update of secret_id on webhook_destination_headers
  for each row execute function public.webhook_destination_headers_drop_secret();

-- A destination's header names, [{name}] in position order.
create function public.webhook_header_names(p_destination_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('name', h.name) order by h.position), '[]'::jsonb)
  from public.webhook_destination_headers h
  where h.destination_id = p_destination_id;
$$;

-- A destination's headers with their values, [{name, value}] in position
-- order. Called only from claim_deliveries and webhook_test_delivery, which
-- run as their owner (duplicate_destination, the third place a value leaves
-- Vault, joins vault.decrypted_secrets itself); nobody else may call it.
create function public.webhook_header_values(p_destination_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('name', h.name, 'value', s.decrypted_secret) order by h.position),
                  '[]'::jsonb)
  from public.webhook_destination_headers h
  join vault.decrypted_secrets s on s.id = h.secret_id
  where h.destination_id = p_destination_id;
$$;

-- A new Vault secret for one header value.
create function public.webhook_header_secret(p_value text)
returns uuid
language sql
volatile
set search_path = ''
as $$
  select vault.create_secret(p_value, 'longlines_webhook_header_' || gen_random_uuid(), 'Long Lines webhook header');
$$;

-- Replaces a destination's headers with p_headers, the full ordered list as
-- [{"name", "value"?}]. Null leaves them as they are; [] removes them all. An
-- item whose value is missing, null or empty keeps the stored value of the
-- header with that name (ignoring case), so the editor sends values only for
-- what was typed; a renamed header needs a value. The whole list is checked
-- before anything is written. The caller has checked that the destination
-- belongs to the user.
create function public.set_webhook_headers(p_destination_id uuid, p_headers jsonb)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_item  jsonb;
  v_ord   bigint;
  v_name  text;
  v_value text;
  v_names text[] := '{}'::text[];
begin
  if p_headers is null then
    return;
  end if;
  if jsonb_typeof(p_headers) <> 'array' then
    raise exception 'Headers must be a list.';
  end if;
  if jsonb_array_length(p_headers) > 10 then
    raise exception 'Up to 10 headers.';
  end if;
  for v_item in select x from jsonb_array_elements(p_headers) x loop
    v_name := case when jsonb_typeof(v_item) = 'object' then btrim(v_item ->> 'name') end;
    if coalesce(v_name, '') = '' then
      raise exception 'Give each header a name.';
    end if;
    if v_name !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$' then
      raise exception 'Header names use letters, digits, - _ and . only.';
    end if;
    if not public.webhook_header_name_valid(v_name) then
      raise exception '% is set by Long Lines.', v_name;
    end if;
    if lower(v_name) = any (v_names) then
      raise exception 'Add each header once.';
    end if;
    v_names := v_names || lower(v_name);
    v_value := nullif(v_item ->> 'value', '');
    if v_value is null then
      if not exists (select 1 from webhook_destination_headers h
                     where h.destination_id = p_destination_id and lower(h.name) = lower(v_name)) then
        raise exception 'Give the % header a value.', v_name;
      end if;
    elsif length(v_value) > 1024 then
      raise exception 'Header values can be up to 1,024 characters.';
    elsif octet_length(v_value) <> length(v_value) or v_value ~ '[[:cntrl:]]' then
      raise exception 'Header values can only use printable ASCII characters.';
    end if;
  end loop;

  -- Rows not in the list go (the trigger deletes their secrets).
  delete from webhook_destination_headers h
  where h.destination_id = p_destination_id and not (lower(h.name) = any (v_names));

  for v_item, v_ord in select x, n from jsonb_array_elements(p_headers) with ordinality as t(x, n) loop
    v_name := btrim(v_item ->> 'name');
    v_value := nullif(v_item ->> 'value', '');
    update webhook_destination_headers h
    set name = v_name, position = v_ord,
        secret_id = case when v_value is null then h.secret_id else public.webhook_header_secret(v_value) end
    where h.destination_id = p_destination_id and lower(h.name) = lower(v_name);
    if not found then
      insert into webhook_destination_headers (destination_id, position, name, secret_id)
      values (p_destination_id, v_ord, v_name, public.webhook_header_secret(v_value));
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Rendering, in SQL only (decision 11)
-- ---------------------------------------------------------------------------

-- A field's key: the field id, except placeName in camelCase and the
-- frequency, whose unit is in its key (frequency_khz, frequencyMhz).
create function public.webhook_field_key(p_field text, p_key_style text, p_frequency_unit text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_field = 'frequency' and p_key_style = 'camel' then 'frequency' || initcap(p_frequency_unit)
    when p_field = 'frequency' then 'frequency_' || p_frequency_unit
    when p_field = 'place_name' and p_key_style = 'camel' then 'placeName'
    else p_field
  end;
$$;

-- A field's value for a spot (delivery_spot_json's keys) as a JSON scalar,
-- or SQL null when the spot has none (an empty string counts as none).
-- reference, place_name and state are push's renderings, so push, Discord
-- and webhooks agree. Stable, not immutable: cty_lookup reads cty.dat.
create function public.webhook_field_value(p_field text, p_spot jsonb, p_time_format text, p_frequency_unit text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select nullif(case p_field
    when 'id' then p_spot -> 'id'
    when 'time' then case p_time_format
      when 'unix_seconds' then to_jsonb(floor(extract(epoch from (p_spot ->> 'spot_time')::timestamptz))::bigint)
      else to_jsonb(to_char((p_spot ->> 'spot_time')::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
    end
    when 'callsign' then to_jsonb(nullif(p_spot ->> 'callsign', ''))
    when 'frequency' then case p_frequency_unit
      when 'mhz' then to_jsonb(trim_scale(round((p_spot ->> 'frequency_khz')::numeric / 1000, 6)))
      when 'hz' then to_jsonb(((p_spot ->> 'frequency_khz')::numeric * 1000)::bigint)
      else to_jsonb(trim_scale((p_spot ->> 'frequency_khz')::numeric))
    end
    when 'mode' then to_jsonb(nullif(lower(p_spot ->> 'mode'), ''))
    when 'band' then to_jsonb(nullif(p_spot ->> 'band', ''))
    when 'source' then to_jsonb(nullif(p_spot ->> 'source', ''))
    when 'reference' then to_jsonb(public.render_push_field('reference', p_spot))
    when 'place_name' then to_jsonb(public.render_push_field('place_name', p_spot))
    when 'state' then to_jsonb(public.render_push_field('state', p_spot))
    when 'spotter' then to_jsonb(nullif(p_spot ->> 'spotter', ''))
    when 'country' then to_jsonb(nullif((select c.name from public.cty_lookup(p_spot ->> 'callsign') c), ''))
    when 'url' then to_jsonb(public.spot_source_url(p_spot))
    when 'comment' then to_jsonb(nullif(p_spot ->> 'comment', ''))
  end, 'null'::jsonb);
$$;

-- The spot as ordered [{key, value}] pairs, the picked fields in order. A
-- field without a value is left out with missing_values 'omit' and sent as
-- null with 'null'. '[]' (never SQL null) when nothing is left. jsonb
-- objects do not keep key order, so the claim hands the pairs and the sender
-- builds the object in this order.
create function public.webhook_spot_fields(p_settings webhook_destination_settings, p_spot jsonb)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'key', public.webhook_field_key(t.f, p_settings.key_style, p_settings.frequency_unit),
           'value', x.v) order by t.ord), '[]'::jsonb)
  from unnest(p_settings.fields) with ordinality as t(f, ord)
  cross join lateral (select public.webhook_field_value(t.f, p_spot, p_settings.time_format,
                                                        p_settings.frequency_unit) as v) x
  where x.v is not null or p_settings.missing_values = 'null';
$$;

-- The same pairs as one object, keys in order ('{}' for none). json, not
-- jsonb, so the preview's text has the order the sender sends.
create function public.webhook_spot_object(p_settings webhook_destination_settings, p_spot jsonb)
returns json
language sql
stable
set search_path = ''
as $$
  select coalesce(json_object_agg(t.p ->> 'key', (t.p -> 'value')::json order by t.ord), '{}'::json)
  from jsonb_array_elements(public.webhook_spot_fields(p_settings, p_spot)) with ordinality as t(p, ord);
$$;

-- A request's body for one spot (decision 1): {delivery_id, connection,
-- spot}, or {"spots": [that]} when the destination groups spots. The preview
-- and the tests use it; the sender builds the same shape from the pairs.
create function public.webhook_request_body(p_settings webhook_destination_settings, p_delivery_id bigint,
                                             p_connection text, p_spot jsonb)
returns json
language sql
stable
set search_path = ''
as $$
  select case when p_settings.batch_seconds > 0 then json_build_object('spots', json_build_array(i.item))
              else i.item end
  from (select json_build_object('delivery_id', p_delivery_id, 'connection', p_connection,
                                 'spot', public.webhook_spot_object(p_settings, p_spot)) as item) i;
$$;

-- ---------------------------------------------------------------------------
-- 5. Delivery policy: mark_deliveries_failed and claim_deliveries
-- ---------------------------------------------------------------------------

-- Same signature, grants and steps as 20261006000010, plus (decisions 4 and
-- 14):
--   2. a webhook with pause_after_failures set that is enabled counts the
--      failure toward its pause, at most once per webhook_pause_spacing():
--      the count restarts at 1 when a delivery succeeded since the last
--      counted failure (or none was counted), else moves on by one when the
--      last counted one is that old, else stays. When it reaches
--      pause_after_failures the destination turns off (enabled = false) with
--      auto_disabled_at. consecutive_failures and health are as before:
--      nothing here sets health 'paused'.
--   3. each message's delay: a webhook row's from its retry policy
--      (webhook_retry_delay after the attempt that just failed), or 0 when
--      its attempts are used up so the next claim's expiry sweep, the only
--      thing that drops a delivery, drops it; p_delay_seconds for every other
--      row (Discord and push keep the sender's backoff).
--   4. every queued message (pending or failed) of a destination in this
--      call that repeated failures turned off (auto_disabled_at set, not
--      enabled) is made visible at once (vt 0), including the row that just
--      failed and rows still waiting out a retry delay, so the next claim's
--      unwanted sweep drops all of them with dropped_at before anyone can
--      turn the destination back on. The sweep stays the only thing that
--      drops; with the one serial sender this destination's marks for the
--      cycle have landed before the next claim.
create or replace function public.mark_deliveries_failed(
  p_delivery_ids bigint[], p_msg_ids bigint[], p_error text, p_delay_seconds int
)
returns void
language plpgsql
security definer
set search_path = public, pgmq
as $$
begin
  update deliveries d
  set status = 'failed', attempts = d.attempts + 1, last_error = p_error
  where d.id = any (p_delivery_ids);

  with target as (
    select dest.id, ws.pause_after_failures as pause_after,
           case
             when ws.pause_after_failures is null or not dest.enabled then null
             when dest.pause_failure_at is null or dest.last_success_at > dest.pause_failure_at then 1
             when dest.pause_failure_at <= now() - public.webhook_pause_spacing() then dest.pause_failures + 1
           end as counted
    from destinations dest
    left join webhook_destination_settings ws on ws.destination_id = dest.id and dest.type = 'webhook'
    where dest.id in (select d.destination_id from deliveries d where d.id = any (p_delivery_ids))
  )
  update destinations dest
  set consecutive_failures = dest.consecutive_failures + 1,
      last_error = p_error,
      last_error_at = now(),
      health = case
        when dest.health = 'paused' then 'paused'
        when dest.consecutive_failures + 1 >= 5 then 'failing'
        else dest.health
      end,
      pause_failures = coalesce(t.counted, dest.pause_failures),
      pause_failure_at = case when t.counted is not null then now() else dest.pause_failure_at end,
      enabled = case when t.counted >= t.pause_after then false else dest.enabled end,
      auto_disabled_at = case when t.counted >= t.pause_after then now() else dest.auto_disabled_at end
  from target t
  where dest.id = t.id;

  perform pgmq.set_vt('deliveries_queue', u.msg_id,
    case
      when ws.destination_id is null then p_delay_seconds
      when public.webhook_retries_exhausted(ws.retry_policy, d.attempts) then 0
      else public.webhook_retry_delay(ws.retry_policy, d.attempts)
    end)
  from unnest(p_delivery_ids, p_msg_ids) as u(delivery_id, msg_id)
  left join deliveries d on d.id = u.delivery_id
  left join destinations dest on dest.id = d.destination_id and dest.type = 'webhook'
  left join webhook_destination_settings ws on ws.destination_id = dest.id
  where u.msg_id is not null;

  perform pgmq.set_vt('deliveries_queue', q.msg_id, 0)
  from pgmq.q_deliveries_queue q
  join deliveries d on d.id = (q.message ->> 'delivery_id')::bigint
  join destinations dest on dest.id = d.destination_id
  where dest.id in (select d2.destination_id from deliveries d2 where d2.id = any (p_delivery_ids))
    and dest.auto_disabled_at is not null
    and not dest.enabled
    and d.status in ('pending', 'failed');
end;
$$;

-- Same signature, result columns, order and grants as 20261018000100, whose
-- sweeps, orphans, ready, hold, budget, rank, claim, debit and return are kept
-- as they are, with these additions only:
--   0a. the unwanted sweep sets dropped_at on the rows of a destination with
--       auto_disabled_at set: a pause after repeated failures lost those
--       spots, where a destination turned off by hand did not want them.
--   0b. the expiry sweep also drops a webhook row whose attempts its retry
--       policy has used up (webhook_retries_exhausted), and `ready` leaves
--       the same rows out, so one is never claimed again when more than the
--       sweep's 500 expire at once.
--   1.  the batch hold covers webhooks too (decision 12): `held` reads
--       batch_seconds from either settings table and releases at
--       destination_batch_full(type) ready rows (Discord 10, webhook 50)
--       instead of the constant ten.
--   1b. a webhook's per-claim cap is webhook_claim_max(batch_seconds): five
--       for one request per spot, none when grouped (decision 13).
--   7.  a webhook destination's jsonb gains `webhook` ({batch_seconds,
--       headers: [{name, value}]}, built once per destination), and its spots
--       `webhook_fields` (webhook_spot_fields' pairs) and
--       `webhook_connection` (the connection's name).
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
           coalesce(ds.batch_seconds, ws.batch_seconds, 0) as batch_seconds
    from pgmq.q_deliveries_queue q
    join deliveries d on d.id = (q.message ->> 'delivery_id')::bigint
    join destinations dest on dest.id = d.destination_id
    join subscriptions s on s.id = d.subscription_id
    join raw_spots r on r.id = d.spot_id
    left join push_destination_settings ps on ps.destination_id = dest.id
    left join discord_destination_settings ds on ds.destination_id = dest.id
    left join webhook_destination_settings ws on ws.destination_id = dest.id
    where q.vt <= v_now
      and d.created_at >= v_now - coalesce(make_interval(secs => ps.ttl_seconds),
                                           public.destination_max_age(dest.type))
      and not public.webhook_retries_exhausted(ws.retry_policy, d.attempts)
      and dest.health <> 'paused'
      and dest.enabled
      and (dest.throttled_until is null or dest.throttled_until <= v_now)
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
    select ready.msg_id, ready.delivery_id, ready.destination_id, ready.spot_time, budget.available, budget.claim_max,
           row_number() over (partition by ready.destination_id
                              order by ready.spot_time desc, ready.delivery_id desc) as rn
    from ready
    join budget on budget.destination_id = ready.destination_id
  ),
  chosen as (
    select ranked.msg_id, ranked.delivery_id, ranked.destination_id, ranked.spot_time, ranked.available, ranked.rn
    from ranked
    where ranked.rn <= floor(ranked.available)
      and (ranked.claim_max is null or ranked.rn <= ranked.claim_max)
    order by ranked.rn, ranked.spot_time desc, ranked.delivery_id desc
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

  -- 7. Return, in the order chosen: every destination's newest spot first.
  -- A push destination's members, settings and quiet flag, a Discord
  -- destination's settings, and a webhook destination's window and headers,
  -- are built once per destination; their spots carry what is rendered from
  -- their fields. A destination somehow without a settings row (the triggers
  -- make one for every insert) is handed the defaults rather than left
  -- undeliverable.
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
    )
    select
      (x ->> 'msg_id')::bigint,
      d.id, d.subscription_id, d.attempts, d.created_at,
      jsonb_build_object(
        'id', dest.id, 'type', dest.type, 'name', dest.name, 'url', dest.url,
        'signing_secret', dest.signing_secret, 'health', dest.health,
        'consecutive_failures', dest.consecutive_failures
      ) || coalesce(pd.p_extra, dd.d_extra, wd.w_extra, '{}'::jsonb),
      public.delivery_spot_json(r)
        || case when pd.p_id is not null then public.push_spot_fields(pd.p_settings, public.delivery_spot_json(r))
                when dd.d_id is not null then public.discord_spot_fields(dd.d_settings, public.delivery_spot_json(r))
                when wd.w_id is not null then jsonb_build_object(
                  'webhook_fields', public.webhook_spot_fields(wd.w_settings, public.delivery_spot_json(r)),
                  'webhook_connection', s.name)
                else '{}'::jsonb end
    from jsonb_array_elements(v_claimed) x
    join deliveries d on d.id = (x ->> 'delivery_id')::bigint
    join destinations dest on dest.id = d.destination_id
    join subscriptions s on s.id = d.subscription_id
    join raw_spots r on r.id = d.spot_id
    left join push_dests pd on pd.p_id = dest.id
    left join discord_dests dd on dd.d_id = dest.id
    left join webhook_dests wd on wd.w_id = dest.id
    order by (x ->> 'rn')::bigint, (x ->> 'spot_time')::timestamptz desc, d.id desc;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Send test (service role)
-- ---------------------------------------------------------------------------

-- Send test for a webhook destination (the send-test and api functions, as
-- the service role, decision 15): its window and header values, and the spot
-- (raw_spots row p_spot_id, else the sample) with the pairs the claim would
-- hand and the connection "Test". The sender marks the request as a test
-- (X-LongLines-Test, delivery_id 0). Null when the destination is not a
-- webhook or the spot is unknown. The caller has already checked that the
-- destination belongs to the user. A test is not a delivery: it writes
-- nothing. Not a sender RPC.
create function public.webhook_test_delivery(p_destination_id uuid, p_spot_id bigint default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_settings webhook_destination_settings;
  v_spot     jsonb;
begin
  select s.* into v_settings
  from webhook_destination_settings s
  join destinations d on d.id = s.destination_id and d.type = 'webhook'
  where s.destination_id = p_destination_id;
  if not found then
    return null;
  end if;
  if p_spot_id is null then
    v_spot := public.push_sample_spot();
  else
    select public.delivery_spot_json(r) into v_spot from raw_spots r where r.id = p_spot_id;
    if v_spot is null then
      return null;
    end if;
  end if;
  return jsonb_build_object(
    'webhook', jsonb_build_object('batch_seconds', v_settings.batch_seconds,
                                  'headers', public.webhook_header_values(p_destination_id)),
    'spot', v_spot || jsonb_build_object('webhook_fields', public.webhook_spot_fields(v_settings, v_spot),
                                         'webhook_connection', 'Test'));
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Client RPCs
-- ---------------------------------------------------------------------------

-- Creates (p_id null) or updates one of the caller's webhook destinations.
-- A new one goes through create_destination (the URL check, the masked
-- display, the name-taken message, the triggers) and returns its signing
-- secret, the one time it is shown. An existing one goes through
-- update_destination, which is not granted to clients and is called here
-- from a definer body on purpose: a null name or enabled keeps what is
-- stored, a null or blank URL keeps the stored URL (Replace URL left empty,
-- decision 8), a new URL is checked and clears failing health, and enabled
-- true resumes a paused webhook (decision 4); it returns a null secret.
-- p_settings is merged key by key over the current settings and checked as
-- a whole; p_headers goes to set_webhook_headers (null leaves them).
create function public.save_webhook_destination(p_id uuid, p_name text, p_enabled boolean, p_url text,
                                                p_settings jsonb, p_headers jsonb)
returns table (id uuid, signing_secret text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user     uuid := auth.uid();
  v_id       uuid := p_id;
  v_secret   text;
  v_settings webhook_destination_settings;
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  if (v_id is null and coalesce(trim(p_name), '') = '') or (p_name is not null and trim(p_name) = '') then
    raise exception 'Give the destination a name.';
  end if;
  perform public.check_webhook_setting_keys(p_settings);
  if v_id is null then
    if coalesce(trim(p_url), '') = '' then
      raise exception 'Use an https URL.';
    end if;
    select c.id, c.signing_secret into v_id, v_secret from public.create_destination('webhook', p_name, p_url) c;
    update destinations d set enabled = coalesce(p_enabled, true) where d.id = v_id;
  else
    if not exists (select 1 from destinations d where d.id = v_id and d.user_id = v_user and d.type = 'webhook') then
      raise exception 'Destination not found.';
    end if;
    perform public.update_destination(v_id, p_name, nullif(trim(p_url), ''), p_enabled);
  end if;
  if p_settings is not null then
    select * into v_settings from jsonb_populate_record(null::webhook_destination_settings,
      coalesce((select to_jsonb(s) from webhook_destination_settings s where s.destination_id = v_id),
               public.webhook_default_settings() || jsonb_build_object('destination_id', v_id))
      || p_settings);
    perform public.validate_webhook_settings(v_settings);
    insert into webhook_destination_settings select (v_settings).*
    on conflict (destination_id) do update
    set fields = excluded.fields, key_style = excluded.key_style, time_format = excluded.time_format,
        frequency_unit = excluded.frequency_unit, missing_values = excluded.missing_values,
        batch_seconds = excluded.batch_seconds, retry_policy = excluded.retry_policy,
        pause_after_failures = excluded.pause_after_failures;
  end if;
  perform public.set_webhook_headers(v_id, p_headers);
  return query select v_id, v_secret;
end;
$$;

-- One of the caller's webhook destinations for the editor: its settings, the
-- masked URL, header names, when the secret was rotated and when a pause
-- turned it off. Never the URL, any part of the secret or a header value.
create function public.get_webhook_destination(p_id uuid)
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
           'settings', to_jsonb(s) - 'destination_id',
           'headers', public.webhook_header_names(d.id),
           'secret_rotated_at', d.secret_rotated_at, 'auto_disabled_at', d.auto_disabled_at)
    into v_result
  from destinations d
  join webhook_destination_settings s on s.destination_id = d.id
  where d.id = p_id and d.user_id = auth.uid() and d.type = 'webhook';
  if v_result is null then
    raise exception 'Destination not found.';
  end if;
  return v_result;
end;
$$;

-- The field count and window of each of the caller's webhooks, for the list
-- cards' type line ("Webhook · 5 fields · grouped every 30 seconds"), so the
-- settings table keeps no client grant.
create function public.list_webhook_destination_settings()
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
             'destination_id', d.id, 'field_count', cardinality(s.fields), 'batch_seconds', s.batch_seconds)
           order by d.created_at, d.id)
    from destinations d
    join webhook_destination_settings s on s.destination_id = d.id
    where d.user_id = auth.uid() and d.type = 'webhook'), '[]'::jsonb);
end;
$$;

-- The editor's preview: the body webhook_request_body builds for the
-- settings (merged over the defaults; null for the defaults, after the same
-- checks a save makes) and raw_spots row p_spot_id, or the sample spot, with
-- delivery_id 0. The connection is the name of the oldest connection that
-- sends to p_destination_id when that is the caller's and has one, else
-- "Example connection". json, so the text keeps the sent key order.
create function public.preview_webhook_request(p_settings jsonb, p_spot_id bigint default null,
                                               p_destination_id uuid default null)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_settings   webhook_destination_settings;
  v_spot       jsonb;
  v_connection text;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;
  perform public.check_webhook_setting_keys(p_settings);
  v_settings := jsonb_populate_record(null::webhook_destination_settings,
                                      public.webhook_default_settings() || coalesce(p_settings, '{}'::jsonb));
  perform public.validate_webhook_settings(v_settings);
  if p_spot_id is null then
    v_spot := public.push_sample_spot();
  else
    select public.delivery_spot_json(r) into v_spot from raw_spots r where r.id = p_spot_id;
    if v_spot is null then
      raise exception 'Spot not found.';
    end if;
  end if;
  select s.name into v_connection
  from subscriptions s
  join subscription_destinations sd on sd.subscription_id = s.id
  join destinations d on d.id = sd.destination_id
  where sd.destination_id = p_destination_id and d.user_id = auth.uid() and s.user_id = auth.uid()
  order by s.created_at, s.id
  limit 1;
  return public.webhook_request_body(v_settings, 0, coalesce(v_connection, 'Example connection'), v_spot);
end;
$$;

-- Same as 20261018000100 for every type (decision 16): the type check goes. A
-- webhook copy has the same URL, signing secret and its rotation time,
-- settings, and headers, each value re-created in Vault so the copy owns its
-- secrets. Every copy is named "Copy of {name}" (with " (2)"... when that is
-- taken) and starts disabled so it never double-sends before it is edited.
-- Fresh throttle, health and pause state, since it is a new row. Returns the
-- new id.
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
  end if;
  return v_id;
end;
$$;

-- Same as 20261016000400 plus decision 4's resume: turning a webhook that
-- repeated failures turned off back on (p_enabled true while
-- auto_disabled_at is set) clears auto_disabled_at and zeroes
-- consecutive_failures and the pause count. Health stays as it is until the
-- next success sets ok.
create or replace function public.update_destination(p_id uuid, p_name text, p_url text, p_enabled boolean default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_type text;
  v_url  text;
  v_new  boolean;
  v_resume boolean;
  v_constraint text;
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  select d.type, d.url, coalesce(p_enabled, false) and d.auto_disabled_at is not null
    into v_type, v_url, v_resume
  from destinations d where d.id = p_id and d.user_id = v_user for update;
  if v_type is null then
    raise exception 'Destination not found.';
  end if;
  if p_name is not null and trim(p_name) = '' then
    raise exception 'Give the destination a name.';
  end if;
  if p_url is not null then
    perform public.validate_destination_url(v_type, p_url);
  end if;
  v_new := p_url is not null and trim(p_url) is distinct from v_url;
  update destinations d
  set name                 = coalesce(trim(p_name), d.name),
      url                  = coalesce(trim(p_url), d.url),
      url_display          = coalesce(public.destination_url_display(v_type, p_url), d.url_display),
      enabled              = coalesce(p_enabled, d.enabled),
      health               = case when v_new and d.health = 'failing' then 'ok' else d.health end,
      consecutive_failures = case when v_new or v_resume then 0 else d.consecutive_failures end,
      last_error           = case when v_new then null else d.last_error end,
      last_error_at        = case when v_new then null else d.last_error_at end,
      auto_disabled_at     = case when v_resume then null else d.auto_disabled_at end,
      pause_failures       = case when v_resume then 0 else d.pause_failures end,
      pause_failure_at     = case when v_resume then null else d.pause_failure_at end
  where d.id = p_id;
exception when unique_violation then
  get stacked diagnostics v_constraint = constraint_name;
  if v_constraint = 'destinations_user_name_key' then
    raise exception 'A destination named % already exists. Choose a different name.', trim(p_name);
  end if;
  raise;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Management API
-- ---------------------------------------------------------------------------

-- Same as 20261018000100 plus, for a webhook, its settings, header names,
-- secret_rotated_at and auto_disabled_at (read only: the API does not change
-- webhook settings or headers, decision 21).
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
     else '{}'::jsonb end;
$$;

-- ---------------------------------------------------------------------------
-- Access. Every function above starts executable by public; revoking that
-- leaves service_role (20261012000120). Clients get the four RPCs the editor
-- and the list call; rotate_signing_secret, duplicate_destination,
-- update_destination, mark_deliveries_failed, claim_deliveries and
-- api_destination_json keep their grants (create or replace keeps them).
-- delivery_sender gets nothing new: its allowlist is unchanged.
-- ---------------------------------------------------------------------------

revoke all on function public.destinations_secret_rotated_at() from public;
revoke all on function public.webhook_fields() from public;
revoke all on function public.webhook_fields_valid(text[]) from public;
revoke all on function public.destination_batch_full(text) from public;
revoke all on function public.webhook_claim_max(int) from public;
revoke all on function public.webhook_retry_max_attempts(text) from public;
revoke all on function public.webhook_retries_exhausted(text, int) from public;
revoke all on function public.webhook_retry_delay(text, int) from public;
revoke all on function public.webhook_pause_spacing() from public;
revoke all on function public.webhook_default_settings() from public;
revoke all on function public.webhook_legacy_settings() from public;
revoke all on function public.webhook_destination_settings_default() from public;
revoke all on function public.check_webhook_setting_keys(jsonb) from public;
revoke all on function public.validate_webhook_fields(text[]) from public;
revoke all on function public.validate_webhook_settings(webhook_destination_settings) from public;
revoke all on function public.webhook_header_name_valid(text) from public;
revoke all on function public.webhook_destination_headers_drop_secret() from public;
revoke all on function public.webhook_header_names(uuid) from public;
revoke all on function public.webhook_header_values(uuid) from public;
revoke all on function public.webhook_header_secret(text) from public;
revoke all on function public.set_webhook_headers(uuid, jsonb) from public;
revoke all on function public.webhook_field_key(text, text, text) from public;
revoke all on function public.webhook_field_value(text, jsonb, text, text) from public;
revoke all on function public.webhook_spot_fields(webhook_destination_settings, jsonb) from public;
revoke all on function public.webhook_spot_object(webhook_destination_settings, jsonb) from public;
revoke all on function public.webhook_request_body(webhook_destination_settings, bigint, text, jsonb) from public;
revoke all on function public.webhook_test_delivery(uuid, bigint) from public;
revoke all on function public.save_webhook_destination(uuid, text, boolean, text, jsonb, jsonb) from public;
revoke all on function public.get_webhook_destination(uuid) from public;
revoke all on function public.list_webhook_destination_settings() from public;
revoke all on function public.preview_webhook_request(jsonb, bigint, uuid) from public;
grant execute on function public.save_webhook_destination(uuid, text, boolean, text, jsonb, jsonb) to authenticated;
grant execute on function public.get_webhook_destination(uuid) to authenticated;
grant execute on function public.list_webhook_destination_settings() to authenticated;
grant execute on function public.preview_webhook_request(jsonb, bigint, uuid) to authenticated;

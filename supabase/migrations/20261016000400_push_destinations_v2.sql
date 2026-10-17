-- Push destinations as canvas page 5 draws them, on the sender: many per
-- account, each with the devices it picks, its own notification fields and its
-- own delivery settings. See the two amendments at the top of
-- docs/superpowers/specs/2026-10-13-push-notifications-design.md (2026-10-15
-- page 5, 2026-10-16 the sender) and
-- docs/superpowers/plans/2026-10-15-push-pwa-and-ui.md, Task 3.
--
-- 20261014000100 is applied to hosted and stays as is; this builds on it.
-- Existing push destinations keep every device of their owner and get the
-- default settings, and duplicate names are renamed before the unique index,
-- so nothing that works today stops working.
--
-- Policy stays in SQL and the sender stays dumb (sender spec, sections 2, 3
-- and 10): claim_deliveries keeps its signature and result columns and hands
-- the sender, inside the jsonb it already returns, the destination's settings
-- (`push`), whether it is quiet hours (`quiet_now`, once per destination in
-- the account time zone), its unblocked member devices, and the notification
-- text built here from the picked fields (`push_title`, `push_body`,
-- `push_url`, `push_source_url`). There is no template: the user picks fields
-- and each field has one fixed rendering (render_push_field), so nothing is
-- parsed and no free text reaches a notification. The editor's preview, Send
-- test and real deliveries all go through push_spot_fields.
--
-- The sender's RPC allowlist, its grants (sender_role.test.sql) and its env do
-- not change; the new tables give delivery_sender nothing.

-- ---------------------------------------------------------------------------
-- 1. Destinations: many push per account, an enabled switch, unique names
-- ---------------------------------------------------------------------------

drop index destinations_one_push_per_user;

alter table destinations add column enabled boolean not null default true;
grant select (enabled) on destinations to authenticated;

-- p_name when the account has no destination by that name (case-insensitive),
-- else the first free "p_name (2)", "p_name (3)"...
create function public.unique_destination_name(p_user uuid, p_name text)
returns text
language plpgsql
stable
set search_path = public
as $$
declare
  v_name text := p_name;
  v_n    int := 1;
begin
  while exists (select 1 from destinations d where d.user_id = p_user and lower(d.name) = lower(v_name)) loop
    v_n := v_n + 1;
    v_name := p_name || ' (' || v_n || ')';
  end loop;
  return v_name;
end;
$$;

-- Renames names an account uses more than once: the oldest keeps its name,
-- the rest become "{name} (2)", "{name} (3)"... Returns how many it renamed.
-- Run once below before the unique index; kept so the tests can run it.
create function public.rename_duplicate_destination_names()
returns int
language plpgsql
set search_path = public
as $$
declare
  r       record;
  v_count int := 0;
begin
  for r in
    select x.id, x.user_id, x.name
    from (select d.id, d.user_id, d.name, d.created_at,
                 row_number() over (partition by d.user_id, lower(d.name) order by d.created_at, d.id) as rn
          from destinations d) x
    where x.rn > 1
    order by x.user_id, lower(x.name), x.created_at, x.id
  loop
    update destinations d set name = public.unique_destination_name(r.user_id, r.name) where d.id = r.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

select public.rename_duplicate_destination_names();
create unique index destinations_user_name_key on destinations (user_id, lower(name));

-- Same as 20261014000100, except a second push destination is fine now and a
-- name the account already uses gets the name-taken message.
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

-- Same as 20261013000320 plus p_enabled (null keeps it) and the name-taken
-- message. The three-argument version goes so calls cannot be ambiguous;
-- api_call, its only caller, is recreated below.
drop function public.update_destination(uuid, text, text);
create function public.update_destination(p_id uuid, p_name text, p_url text, p_enabled boolean default null)
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
  v_constraint text;
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  select d.type, d.url into v_type, v_url from destinations d where d.id = p_id and d.user_id = v_user for update;
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
      consecutive_failures = case when v_new then 0 else d.consecutive_failures end,
      last_error           = case when v_new then null else d.last_error end,
      last_error_at        = case when v_new then null else d.last_error_at end
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
-- 2. The matcher and the watch list skip disabled destinations
-- ---------------------------------------------------------------------------

-- Same as 20261015001200 (the pg_notify, the enabled-subscription and
-- linked-destination checks), except a linked destination counts only while
-- it is enabled: no delivery is created for a disabled one, and a
-- subscription whose destinations are all disabled matches nothing (so its
-- quiet window is not stamped for spots that go nowhere). Queued rows of a
-- destination disabled afterwards are dropped by the claim's unwanted sweep.
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
    select s.id as subscription_id, s.quiet_minutes, r.id as spot_id, r.callsign, r.spot_time
    from raw_spots r
    join subscriptions s on s.enabled and public.spot_matches(s, r)
      and exists (select 1 from subscription_destinations sd
                  join destinations dd on dd.id = sd.destination_id and dd.enabled
                  where sd.subscription_id = s.id)
    where r.id = any (v_spot_ids)
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

-- Same as 20261015000500, with the matcher's linked-destination check: a
-- subscription whose destinations are all disabled watches nothing.
create or replace function public.watched_among(p_source text, p_callsigns text[])
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  with batch as (
    select distinct c, public.base_callsign(c) as b from unnest(p_callsigns) as c
  ),
  watch as materialized (
    select distinct r ->> 'field' as field, v.value
    from subscriptions s
    cross join lateral jsonb_array_elements(s.rules) as g
    cross join lateral jsonb_array_elements(g) as r
    cross join lateral jsonb_array_elements_text(r -> 'values') as v(value)
    where s.enabled
      and exists (select 1 from subscription_destinations sd
                  join destinations dd on dd.id = sd.destination_id and dd.enabled
                  where sd.subscription_id = s.id)
      and public.source_matches(s.sources, p_source)
      and r ->> 'op' = 'is'
      and r ->> 'field' in ('callsign', 'group')
  ),
  members as materialized (
    select m.callsign, m.group_id
    from callsign_group_members m
    where m.callsign in (select x.b from batch x)
  )
  select x.c
  from batch x
  where x.c in (select w.value from watch w where w.field = 'callsign')
     or x.b in (select w.value from watch w where w.field = 'callsign')
     or x.b in (
          select mm.callsign from members mm
          where mm.group_id::text in (select w.value from watch w where w.field = 'group'))
  order by x.c;
$$;

-- ---------------------------------------------------------------------------
-- 3. Devices: a name the user picks, a descriptor, and a blocked state
-- ---------------------------------------------------------------------------

-- label is now the user's name for the device; agent is the "{Browser} on
-- {Platform}" descriptor shown under it; standalone marks a browser opened
-- from the Home Screen or as an installed app; blocked_at is stamped by a
-- browser that finds notifications denied (report_push_device_blocked) and
-- cleared when it registers again.
alter table push_devices
  add column agent      text not null default '',
  add column standalone boolean not null default false,
  add column blocked_at timestamptz;
update push_devices set agent = label;

-- ---------------------------------------------------------------------------
-- 4. Membership and settings (service role only, like push_devices)
-- ---------------------------------------------------------------------------

create table push_destination_devices (
  destination_id uuid not null references destinations(id) on delete cascade,
  device_id      uuid not null references push_devices(id) on delete cascade,
  primary key (destination_id, device_id)
);
create index push_destination_devices_device_id_idx on push_destination_devices (device_id);
alter table push_destination_devices enable row level security;
revoke all on push_destination_devices from anon, authenticated;

-- The fields a notification can show, in the order the editor lists them.
-- Each has one display name (push_field_label) and one rendering
-- (render_push_field); there is no custom text anywhere.
create function public.push_fields()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['callsign', 'frequency', 'band', 'mode', 'source', 'reference', 'place_name',
               'state', 'spotter', 'comment', 'time'];
$$;

-- True when every name is a push field, none twice, and the count is within
-- p_min..p_max. The check constraints below use it; save_push_destination
-- and the preview raise the editor's messages first (validate_push_fields).
create function public.push_fields_valid(p_fields text[], p_min int, p_max int)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_fields is not null
     and cardinality(p_fields) between p_min and p_max
     and p_fields <@ public.push_fields()
     and (select count(distinct f) from unnest(p_fields) f) = cardinality(p_fields);
$$;

create table push_destination_settings (
  destination_id       uuid primary key references destinations(id) on delete cascade,
  title_fields         text[] not null check (public.push_fields_valid(title_fields, 1, 4)),
  body_fields          text[] not null check (public.push_fields_valid(body_fields, 0, 8)),
  show_field_names     boolean not null,
  body_separator       text not null check (body_separator in ('dot', 'comma', 'newline')),
  tap_target           text not null check (tap_target in ('profile', 'source')),
  action_buttons       boolean not null,
  urgency              text not null check (urgency in ('low', 'normal', 'high')),
  ttl_seconds          int not null check (ttl_seconds in (300, 900, 1800, 3600, 14400)),
  replace_same_station boolean not null,
  sound                boolean not null,
  quiet_enabled        boolean not null,
  quiet_from           time not null,
  quiet_until          time not null,
  quiet_mode           text not null check (quiet_mode in ('silent', 'skip'))
);
alter table push_destination_settings enable row level security;
revoke all on push_destination_settings from anon, authenticated;

-- A new push destination's settings (decisions 4 and 7), keyed by column.
-- save_push_destination accepts exactly these keys.
create function public.push_default_settings()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'title_fields', jsonb_build_array('callsign', 'frequency', 'mode'),
    'body_fields', jsonb_build_array('source', 'reference', 'place_name', 'state'),
    'show_field_names', false,
    'body_separator', 'dot',
    'tap_target', 'profile',
    'action_buttons', true,
    'urgency', 'normal',
    'ttl_seconds', 1800,
    'replace_same_station', true,
    'sound', true,
    'quiet_enabled', false,
    'quiet_from', '22:00',
    'quiet_until', '07:00',
    'quiet_mode', 'silent');
$$;

create function public.push_destination_settings_default()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  insert into push_destination_settings
  select * from jsonb_populate_record(null::push_destination_settings,
    public.push_default_settings() || jsonb_build_object('destination_id', new.id));
  return null;
end;
$$;

create trigger destinations_push_settings
  after insert on destinations
  for each row when (new.type = 'push')
  execute function public.push_destination_settings_default();

-- Existing push destinations: every device of the owner, and the defaults.
insert into push_destination_devices (destination_id, device_id)
select d.id, p.id from destinations d join push_devices p on p.user_id = d.user_id where d.type = 'push';
insert into push_destination_settings
select (jsonb_populate_record(null::push_destination_settings,
         public.push_default_settings() || jsonb_build_object('destination_id', d.id))).*
from destinations d
where d.type = 'push'
  and not exists (select 1 from push_destination_settings s where s.destination_id = d.id);

-- ---------------------------------------------------------------------------
-- 5. Rendering, in SQL only
-- ---------------------------------------------------------------------------

-- Raises the editor's message when a field list is not usable: an unknown
-- name, a name twice, or the wrong count. p_what is 'title' or 'body'.
create function public.validate_push_fields(p_fields text[], p_what text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_field text;
begin
  select f into v_field from unnest(coalesce(p_fields, '{}')) f
  where f is null or not (f = any (public.push_fields())) limit 1;
  if found then
    raise exception 'Unknown field %.', coalesce(v_field, 'null');
  end if;
  if p_what = 'title' and (p_fields is null or cardinality(p_fields) not between 1 and 4) then
    raise exception 'Pick 1 to 4 fields for the title.';
  end if;
  if p_what = 'body' and (p_fields is null or cardinality(p_fields) > 8) then
    raise exception 'Pick up to 8 fields for the body.';
  end if;
  if (select count(distinct f) from unnest(p_fields) f) <> cardinality(p_fields) then
    raise exception 'Pick each field once.';
  end if;
end;
$$;

-- The display name of a field, as the editor lists it and as "Show field
-- names" prefixes it.
create function public.push_field_label(p_field text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_field
    when 'callsign' then 'Callsign'
    when 'frequency' then 'Frequency'
    when 'band' then 'Band'
    when 'mode' then 'Mode'
    when 'source' then 'Source'
    when 'reference' then 'Reference'
    when 'place_name' then 'Place name'
    when 'state' then 'State'
    when 'spotter' then 'Spotter'
    when 'comment' then 'Comment'
    when 'time' then 'Time'
  end;
$$;

-- Same labels as sourceLabel in _shared/delivery/format.ts.
create function public.push_source_label(p_source text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_source
    when 'pota' then 'POTA'
    when 'sotawatch' then 'SOTAwatch'
    when 'rbn' then 'RBN'
    when 'dxcluster' then 'DX Cluster'
    when 'wwff' then 'WWFF'
    else p_source
  end;
$$;

-- One field's fixed rendering for a spot (delivery_spot_json shape), or null
-- when the spot lacks it (decision 4): callsign as is; frequency in MHz with
-- three decimals ("14.062 MHz"); band as is; mode upper case; source as its
-- label; reference the POTA, SOTA or WWFF reference; place_name the park or
-- the WWFF reference name; state the part after the dash of each
-- pota_location entry ("US-NC" is "NC", "US-NC,US-SC" is "NC/SC"); spotter
-- and comment as is; time the UTC clock ("13:45Z").
create function public.render_push_field(p_field text, p_spot jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(case p_field
    when 'callsign' then p_spot ->> 'callsign'
    when 'frequency' then to_char((p_spot ->> 'frequency_khz')::numeric / 1000, 'FM9999990.000') || ' MHz'
    when 'band' then p_spot ->> 'band'
    when 'mode' then upper(p_spot ->> 'mode')
    when 'source' then public.push_source_label(p_spot ->> 'source')
    when 'reference' then coalesce(nullif(p_spot ->> 'pota_reference', ''), nullif(p_spot ->> 'sota_summit_ref', ''),
                                   p_spot ->> 'wwff_reference')
    when 'place_name' then coalesce(nullif(p_spot ->> 'pota_park_name', ''), p_spot ->> 'wwff_reference_name')
    when 'state' then (
      select string_agg(coalesce(nullif(split_part(trim(x), '-', 2), ''), trim(x)), '/')
      from regexp_split_to_table(p_spot ->> 'pota_location', ',') x
      where trim(x) <> '')
    when 'spotter' then p_spot ->> 'spotter'
    when 'comment' then p_spot ->> 'comment'
    when 'time' then to_char((p_spot ->> 'spot_time')::timestamptz at time zone 'UTC', 'HH24:MI') || 'Z'
  end, '');
$$;

-- The joiner for a body_separator value; the title always uses 'dot'.
create function public.push_separator(p_separator text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_separator when 'comma' then ', ' when 'newline' then E'\n' else ' · ' end;
$$;

-- Renders a field list in order, skipping fields the spot lacks, prefixing
-- "Label: " when p_labels, joined with p_separator ('dot', 'comma' or
-- 'newline'). Empty when nothing renders.
create function public.render_push_fields(p_fields text[], p_spot jsonb, p_separator text, p_labels boolean)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(string_agg(
           case when p_labels then public.push_field_label(f.name) || ': ' else '' end || f.value,
           public.push_separator(p_separator) order by f.ord), '')
  from (select x.name, x.ord, public.render_push_field(x.name, p_spot) as value
        from unnest(p_fields) with ordinality as x(name, ord)) f
  where f.value is not null;
$$;

-- The source's own page for a spot: the POTA park, the SOTA summit or the
-- WWFF reference, else null (RBN and DX Cluster have none). The reference
-- must be plain characters so nothing a feed sent can shape the URL.
create function public.spot_source_url(p_spot jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_spot ->> 'source' = 'pota' and p_spot ->> 'pota_reference' ~ '^[A-Za-z0-9-]+$'
      then 'https://pota.app/#/park/' || (p_spot ->> 'pota_reference')
    when p_spot ->> 'source' = 'sotawatch' and p_spot ->> 'sota_summit_ref' ~ '^[A-Za-z0-9/-]+$'
      then 'https://summits.sota.org.uk/summit/' || (p_spot ->> 'sota_summit_ref')
    when p_spot ->> 'source' = 'wwff' and p_spot ->> 'wwff_reference' ~ '^[A-Za-z0-9-]+$'
      then 'https://wwff.co/directory/?showRef=' || (p_spot ->> 'wwff_reference')
  end;
$$;

-- /call/<base>, with the base call from SQL (the callsign as spotted when there is none).
create function public.push_profile_url(p_spot jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select '/call/' || replace(coalesce(nullif(p_spot ->> 'base_callsign', ''), p_spot ->> 'callsign'), '/', '%2F');
$$;

-- Whether p_at falls in the destination's quiet hours, in p_timezone (the
-- account's; UTC when it is unknown). A range whose end is before its start
-- crosses midnight; an empty range (from = until) is never quiet.
create function public.push_quiet_now(p_settings push_destination_settings, p_timezone text, p_at timestamptz)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_local time;
begin
  if not p_settings.quiet_enabled or p_settings.quiet_from = p_settings.quiet_until then
    return false;
  end if;
  begin
    v_local := (p_at at time zone coalesce(nullif(p_timezone, ''), 'UTC'))::time;
  exception when invalid_parameter_value then
    v_local := (p_at at time zone 'UTC')::time;
  end;
  if p_settings.quiet_from < p_settings.quiet_until then
    return v_local >= p_settings.quiet_from and v_local < p_settings.quiet_until;
  end if;
  return v_local >= p_settings.quiet_from or v_local < p_settings.quiet_until;
end;
$$;

-- The spot as claim_deliveries hands it to the sender (and webhooks, which
-- document this shape in docs/WEBHOOKS.md).
create function public.delivery_spot_json(r raw_spots)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id, 'source', r.source, 'spot_time', r.spot_time, 'callsign', r.callsign,
    'base_callsign', r.base_callsign,
    'spotter', r.spotter, 'frequency_khz', r.frequency_khz, 'band', r.band, 'mode', r.mode,
    'mode_family', r.mode_family,
    'comment', r.comment, 'pota_reference', r.pota_reference, 'pota_park_name', r.pota_park_name,
    'pota_location', r.pota_location, 'sota_summit_ref', r.sota_summit_ref,
    'wwff_reference', r.wwff_reference, 'wwff_reference_name', r.wwff_reference_name);
$$;

-- The sample spot for previews and Send test, in delivery_spot_json's shape.
-- Clearly labeled so nobody chases it.
create function public.push_sample_spot()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', 0, 'source', 'pota', 'spot_time', now(), 'callsign', 'N0CALL', 'base_callsign', 'N0CALL',
    'spotter', 'LONGLINES', 'frequency_khz', 14062, 'band', '20m', 'mode', 'cw', 'mode_family', 'cw',
    'comment', 'Test spot from Long Lines. Not a real activation.',
    'pota_reference', 'US-0000', 'pota_park_name', 'Test Park', 'pota_location', 'US-TEST',
    'sota_summit_ref', null, 'wwff_reference', null, 'wwff_reference_name', null);
$$;

-- p_text cut to p_max characters with an ellipsis, so a long comment cannot
-- push a notification payload past the push services' limit.
create function public.push_clip(p_text text, p_max int)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when length(p_text) > p_max then rtrim(left(p_text, p_max - 1)) || '…' else p_text end;
$$;

-- What a push destination adds to a spot: the title and body built from its
-- picked fields (the title clipped to 160 characters, the body to 400), the
-- tap URL (the tap target, falling back to the profile when the spot has no
-- source page) and the source URL for the action button. A title that
-- renders empty (every picked field missing) falls back to the callsign, so a
-- notification always has one.
create function public.push_spot_fields(p_settings push_destination_settings, p_spot jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'push_title', public.push_clip(coalesce(nullif(public.render_push_fields(p_settings.title_fields, p_spot, 'dot',
                                                                             p_settings.show_field_names), ''),
                                            p_spot ->> 'callsign'), 160),
    'push_body', public.push_clip(public.render_push_fields(p_settings.body_fields, p_spot, p_settings.body_separator,
                                                            p_settings.show_field_names), 400),
    'push_url', case when p_settings.tap_target = 'source' then coalesce(u.source_url, u.profile_url)
                     else u.profile_url end,
    'push_source_url', u.source_url)
  from (select public.push_profile_url(p_spot) as profile_url, public.spot_source_url(p_spot) as source_url) u;
$$;

-- A push destination's members that can receive, with their keys. Only
-- claim_deliveries and push_test_delivery call this.
create function public.push_member_devices(p_destination_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('endpoint', p.endpoint, 'p256dh', p.p256dh, 'auth', p.auth)
                            order by p.created_at, p.id), '[]'::jsonb)
  from public.push_destination_devices m
  join public.destinations d on d.id = m.destination_id
  join public.push_devices p on p.id = m.device_id and p.user_id = d.user_id
  where m.destination_id = p_destination_id and p.blocked_at is null;
$$;

-- ---------------------------------------------------------------------------
-- 6. claim_deliveries
-- ---------------------------------------------------------------------------

-- Same signature, result columns and order as 20261016000100, whose unwanted
-- sweep, expiry, orphans, budget, rank, claim and debit are kept as they are,
-- with these additions only:
--   0a. the unwanted sweep also drops rows whose destination is not enabled,
--       and `ready` requires it, as for a disabled subscription;
--   0b. the expiry sweep uses the push destination's own "drop if the device
--       is offline for" (push_destination_settings.ttl_seconds) when it has
--       one, else destination_max_age(type);
--   7.  for a push destination, `devices` are its members with blocked_at
--       null, aggregated once per destination (which also fixes #159 for
--       push), the destination jsonb gains `push` (the settings row) and
--       `quiet_now` (push_quiet_now in the owner's time zone, once per
--       destination), and the spot jsonb gains push_title, push_body,
--       push_url and push_source_url (push_spot_fields).
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
  -- destination, or the destination is disabled. Not a loss, so dropped_at
  -- stays null.
  with unwanted as (
    select d.id
    from pgmq.q_deliveries_queue q
    join deliveries d on d.id = (q.message ->> 'delivery_id')::bigint
    join subscriptions s on s.id = d.subscription_id
    join destinations dest on dest.id = d.destination_id
    where q.vt <= v_now
      and d.status in ('pending', 'failed')
      and (not s.enabled
           or not dest.enabled
           or not exists (select 1 from subscription_destinations sd
                          where sd.subscription_id = d.subscription_id
                            and sd.destination_id = d.destination_id))
    order by d.created_at
    limit c_expire_batch
  ),
  dropped as (
    update deliveries d
    set status = 'dropped'
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

  -- 0b. Expire: a push destination's own TTL when it has one, else the type's.
  with old as (
    select d.id
    from pgmq.q_deliveries_queue q
    join deliveries d on d.id = (q.message ->> 'delivery_id')::bigint
    join destinations dest on dest.id = d.destination_id
    left join push_destination_settings ps on ps.destination_id = dest.id
    where q.vt <= v_now
      and d.status in ('pending', 'failed')
      and d.created_at < v_now - coalesce(make_interval(secs => ps.ttl_seconds),
                                          public.destination_max_age(dest.type))
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

  -- 1 to 5. Ready, budget, rank, choose, claim.
  with ready as (
    select q.msg_id, d.id as delivery_id, d.destination_id, r.spot_time
    from pgmq.q_deliveries_queue q
    join deliveries d on d.id = (q.message ->> 'delivery_id')::bigint
    join destinations dest on dest.id = d.destination_id
    join subscriptions s on s.id = d.subscription_id
    join raw_spots r on r.id = d.spot_id
    where q.vt <= v_now
      and dest.health <> 'paused'
      and dest.enabled
      and (dest.throttled_until is null or dest.throttled_until <= v_now)
      and s.enabled
      and exists (select 1 from subscription_destinations sd
                  where sd.subscription_id = d.subscription_id
                    and sd.destination_id = d.destination_id)
  ),
  budget as (
    select dest.id as destination_id,
           least(b.burst,
                 dest.claim_tokens
                 + b.rate_per_minute * greatest(0, extract(epoch from v_now - dest.claim_tokens_at)) / 60) as available
    from destinations dest
    cross join lateral public.destination_budget(dest.type) b
    where dest.id in (select distinct ready.destination_id from ready)
  ),
  ranked as (
    select ready.msg_id, ready.delivery_id, ready.destination_id, ready.spot_time, budget.available,
           row_number() over (partition by ready.destination_id
                              order by ready.spot_time desc, ready.delivery_id desc) as rn
    from ready
    join budget on budget.destination_id = ready.destination_id
  ),
  chosen as (
    select ranked.msg_id, ranked.delivery_id, ranked.destination_id, ranked.spot_time, ranked.available, ranked.rn
    from ranked
    where ranked.rn <= floor(ranked.available)
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
  set claim_tokens = c.available - c.n, claim_tokens_at = v_now
  from (
    select (x ->> 'destination_id')::uuid as destination_id,
           max((x ->> 'available')::numeric) as available,
           count(*) as n
    from jsonb_array_elements(v_claimed) x
    group by 1
  ) c
  where dest.id = c.destination_id;

  -- 7. Return, in the order chosen: every destination's newest spot first.
  -- A push destination's members, settings and quiet flag are built once
  -- per destination; its spots carry the text built from its fields.
  return query
    with push_dests as (
      select dest.id as p_id, ps as p_settings,
             jsonb_build_object(
               'devices', public.push_member_devices(dest.id),
               'push', to_jsonb(ps) - 'destination_id',
               'quiet_now', public.push_quiet_now(ps, pr.timezone, v_now)) as p_extra
      from destinations dest
      join push_destination_settings ps on ps.destination_id = dest.id
      left join profiles pr on pr.id = dest.user_id
      where dest.type = 'push'
        and dest.id in (select distinct (x ->> 'destination_id')::uuid from jsonb_array_elements(v_claimed) x)
    )
    select
      (x ->> 'msg_id')::bigint,
      d.id, d.subscription_id, d.attempts, d.created_at,
      jsonb_build_object(
        'id', dest.id, 'type', dest.type, 'name', dest.name, 'url', dest.url,
        'signing_secret', dest.signing_secret, 'health', dest.health,
        'consecutive_failures', dest.consecutive_failures
      ) || coalesce(pd.p_extra, '{}'::jsonb),
      public.delivery_spot_json(r)
        || case when pd.p_id is null then '{}'::jsonb
                else public.push_spot_fields(pd.p_settings, public.delivery_spot_json(r)) end
    from jsonb_array_elements(v_claimed) x
    join deliveries d on d.id = (x ->> 'delivery_id')::bigint
    join destinations dest on dest.id = d.destination_id
    join raw_spots r on r.id = d.spot_id
    left join push_dests pd on pd.p_id = dest.id
    order by (x ->> 'rn')::bigint, (x ->> 'spot_time')::timestamptz desc, d.id desc;
end;
$$;

-- Send test for a push destination (the send-test and api functions, as the
-- service role): its settings, its unblocked members and the spot (raw_spots
-- row p_spot_id, else the sample) rendered the way claim_deliveries renders
-- it, never quiet. Null when either is missing. The caller has already
-- checked that the destination belongs to the user. Not a sender RPC.
create function public.push_test_delivery(p_destination_id uuid, p_spot_id bigint default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_settings push_destination_settings;
  v_spot     jsonb;
begin
  select * into v_settings from push_destination_settings s where s.destination_id = p_destination_id;
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
    'push', to_jsonb(v_settings) - 'destination_id',
    'quiet_now', false,
    'devices', public.push_member_devices(p_destination_id),
    'spot', v_spot || public.push_spot_fields(v_settings, v_spot));
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Client RPCs
-- ---------------------------------------------------------------------------

-- Turn notifications on for one browser. Upserts by endpoint as in
-- 20261014000100, but never creates a destination: the editor adds the
-- device to destinations. Returns the device id. A null p_label on a browser
-- the caller already has keeps the name they gave it (the app refreshes the
-- subscription on load); a blank one becomes "This browser". Registering
-- clears blocked_at. A browser that moves to another account leaves the old
-- account's destinations.
drop function public.register_push_device(text, text, text, text, text);
create function public.register_push_device(
  p_endpoint text, p_p256dh text, p_auth text, p_label text,
  p_agent text default '', p_standalone boolean default false)
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
      agent           = excluded.agent,
      standalone      = excluded.standalone,
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

-- The caller's devices, newest first: names, descriptors and status, and the
-- push destinations each belongs to. Never the endpoint or the keys.
drop function public.list_push_devices(text);
create function public.list_push_devices(p_current_endpoint text default null)
returns table (id uuid, label text, agent text, standalone boolean, created_at timestamptz,
               last_success_at timestamptz, last_error text, last_error_at timestamptz,
               blocked_at timestamptz, is_current boolean, destination_ids uuid[])
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
    select p.id, p.label, p.agent, p.standalone, p.created_at, p.last_success_at, p.last_error,
           p.last_error_at, p.blocked_at, coalesce(p.endpoint = trim(p_current_endpoint), false),
           array(select m.destination_id from push_destination_devices m
                 where m.device_id = p.id order by m.destination_id)
    from push_devices p
    where p.user_id = auth.uid()
    order by p.created_at desc, p.id;
end;
$$;

create function public.rename_push_device(p_id uuid, p_label text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;
  update push_devices p
  set label = left(coalesce(nullif(trim(p_label), ''), 'This browser'), 60)
  where p.id = p_id and p.user_id = auth.uid();
  if not found then
    raise exception 'Device not found.';
  end if;
end;
$$;

-- A browser that finds notifications denied reports the endpoint it last
-- registered. Silent when the caller has no such device.
create function public.report_push_device_blocked(p_endpoint text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;
  update push_devices p
  set blocked_at = coalesce(p.blocked_at, now())
  where p.user_id = auth.uid() and p.endpoint = trim(p_endpoint);
end;
$$;

-- Creates (p_id null) or updates one of the caller's push destinations. Null
-- arguments keep what is there: p_settings is merged key by key over the
-- current settings (the defaults for a new one), and p_device_ids, when
-- given, replaces the membership. Returns the destination id.
create function public.save_push_destination(p_id uuid, p_name text, p_enabled boolean,
                                             p_settings jsonb, p_device_ids uuid[])
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user     uuid := auth.uid();
  v_id       uuid := p_id;
  v_key      text;
  v_settings push_destination_settings;
  v_devices  uuid[];
  v_constraint text;
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  if (v_id is null and coalesce(trim(p_name), '') = '') or (p_name is not null and trim(p_name) = '') then
    raise exception 'Give the destination a name.';
  end if;
  if p_settings is not null then
    if jsonb_typeof(p_settings) <> 'object' then
      raise exception 'Settings must be an object.';
    end if;
    select k into v_key from jsonb_object_keys(p_settings) k
    where not public.push_default_settings() ? k limit 1;
    if v_key is not null then
      raise exception 'Unknown setting %.', v_key;
    end if;
  end if;

  begin
    if v_id is null then
      insert into destinations (user_id, type, name, url, url_display, enabled)
      values (v_user, 'push', trim(p_name), null, public.destination_url_display('push', null),
              coalesce(p_enabled, true))
      returning id into v_id;
    else
      update destinations d
      set name = coalesce(trim(p_name), d.name), enabled = coalesce(p_enabled, d.enabled)
      where d.id = v_id and d.user_id = v_user and d.type = 'push';
      if not found then
        raise exception 'Destination not found.';
      end if;
    end if;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'destinations_user_name_key' then
      raise exception 'A destination named % already exists. Choose a different name.', trim(p_name);
    end if;
    raise;
  end;

  if p_settings is not null then
    select * into v_settings from jsonb_populate_record(null::push_destination_settings,
      (select to_jsonb(s) from push_destination_settings s where s.destination_id = v_id) || p_settings);
    perform public.validate_push_fields(v_settings.title_fields, 'title');
    perform public.validate_push_fields(v_settings.body_fields, 'body');
    update push_destination_settings s
    set title_fields = v_settings.title_fields, body_fields = v_settings.body_fields,
        show_field_names = v_settings.show_field_names, body_separator = v_settings.body_separator,
        tap_target = v_settings.tap_target, action_buttons = v_settings.action_buttons,
        urgency = v_settings.urgency, ttl_seconds = v_settings.ttl_seconds,
        replace_same_station = v_settings.replace_same_station, sound = v_settings.sound,
        quiet_enabled = v_settings.quiet_enabled, quiet_from = v_settings.quiet_from,
        quiet_until = v_settings.quiet_until, quiet_mode = v_settings.quiet_mode
    where s.destination_id = v_id;
  end if;

  if p_device_ids is not null then
    v_devices := array(select distinct x from unnest(p_device_ids) x where x is not null);
    if (select count(*) from push_devices p where p.id = any (v_devices) and p.user_id = v_user)
       <> cardinality(v_devices) then
      raise exception 'Device not found.';
    end if;
    delete from push_destination_devices m where m.destination_id = v_id and not (m.device_id = any (v_devices));
    insert into push_destination_devices (destination_id, device_id)
    select v_id, x from unnest(v_devices) x
    on conflict do nothing;
  end if;
  return v_id;
end;
$$;

-- One of the caller's push destinations for the editor: settings and member
-- device ids. Never an endpoint or a key.
create function public.get_push_destination(p_id uuid)
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
           'id', d.id, 'name', d.name, 'enabled', d.enabled,
           'settings', to_jsonb(s) - 'destination_id',
           'device_ids', coalesce((select jsonb_agg(m.device_id order by m.device_id)
                                   from push_destination_devices m where m.destination_id = d.id), '[]'::jsonb))
    into v_result
  from destinations d
  join push_destination_settings s on s.destination_id = d.id
  where d.id = p_id and d.user_id = auth.uid() and d.type = 'push';
  if v_result is null then
    raise exception 'Destination not found.';
  end if;
  return v_result;
end;
$$;

-- Copies one of the caller's push destinations: same settings and devices,
-- named "Copy of {name}" (with " (2)"... when that is taken), and disabled
-- so the copy never double-sends before it is edited. Fresh throttle and
-- health state, since it is a new row. Returns the new id.
create function public.duplicate_destination(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_src  destinations;
  v_id   uuid;
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  select * into v_src from destinations d where d.id = p_id and d.user_id = v_user;
  if not found then
    raise exception 'Destination not found.';
  end if;
  if v_src.type <> 'push' then
    raise exception 'Only push destinations can be duplicated.';
  end if;
  -- One account's copies at a time, so two can't pick the same free name.
  perform pg_advisory_xact_lock(hashtextextended('destination_names:' || v_user::text, 0));
  insert into destinations (user_id, type, name, url, url_display, enabled)
  values (v_user, 'push', public.unique_destination_name(v_user, 'Copy of ' || v_src.name), null,
          v_src.url_display, false)
  returning id into v_id;
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
  return v_id;
end;
$$;

-- The editor's preview: the picked fields (null for the defaults) rendered
-- against raw_spots row p_spot_id, or the sample spot, through the same
-- push_spot_fields that claim_deliveries calls, after the same field checks.
-- url is the profile; source_url the source page or null, so the editor can
-- show either tap target.
create function public.preview_push_notification(
  p_title_fields text[], p_body_fields text[], p_show_field_names boolean, p_body_separator text,
  p_spot_id bigint default null)
returns table (title text, body text, url text, source_url text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_settings push_destination_settings;
  v_spot     jsonb;
  v_fields   jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;
  v_settings := jsonb_populate_record(null::push_destination_settings, public.push_default_settings()
    || jsonb_strip_nulls(jsonb_build_object(
         'title_fields', to_jsonb(p_title_fields), 'body_fields', to_jsonb(p_body_fields),
         'show_field_names', p_show_field_names, 'body_separator', p_body_separator)));
  perform public.validate_push_fields(v_settings.title_fields, 'title');
  perform public.validate_push_fields(v_settings.body_fields, 'body');
  if v_settings.body_separator not in ('dot', 'comma', 'newline') then
    raise exception 'Pick a separator.';
  end if;
  if p_spot_id is null then
    v_spot := public.push_sample_spot();
  else
    select public.delivery_spot_json(r) into v_spot from raw_spots r where r.id = p_spot_id;
    if v_spot is null then
      raise exception 'Spot not found.';
    end if;
  end if;
  v_fields := public.push_spot_fields(v_settings, v_spot);
  return query select v_fields ->> 'push_title', v_fields ->> 'push_body', v_fields ->> 'push_url',
                      v_fields ->> 'push_source_url';
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Management API
-- ---------------------------------------------------------------------------

-- Same as 20261013000300 plus enabled and, for push, the settings and how
-- many devices it has (never the devices).
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
     else '{}'::jsonb end;
$$;

-- api_call: as in 20261014000500, except PATCH /destinations passes enabled.
create or replace function public.api_call(p_token_id uuid, p_op text, p_args jsonb)
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
                  'patch_subscription', 'delete_subscription', 'create_group', 'update_group',
                  'delete_group', 'add_group_members', 'remove_group_members')
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
      perform public.update_destination(v_id, p_args ->> 'name', p_args ->> 'url',
                                        (p_args ->> 'enabled')::boolean);
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
-- Access. Every function above starts executable by public; revoking that
-- leaves service_role (20261012000120). Clients get the RPCs the editor
-- calls. delivery_sender gets nothing new: its allowlist is unchanged.
-- ---------------------------------------------------------------------------

revoke all on function public.unique_destination_name(uuid, text) from public;
revoke all on function public.rename_duplicate_destination_names() from public;
revoke all on function public.update_destination(uuid, text, text, boolean) from public;
revoke all on function public.push_fields() from public;
revoke all on function public.push_fields_valid(text[], int, int) from public;
revoke all on function public.push_default_settings() from public;
revoke all on function public.push_destination_settings_default() from public;
revoke all on function public.validate_push_fields(text[], text) from public;
revoke all on function public.push_field_label(text) from public;
revoke all on function public.push_source_label(text) from public;
revoke all on function public.render_push_field(text, jsonb) from public;
revoke all on function public.push_separator(text) from public;
revoke all on function public.render_push_fields(text[], jsonb, text, boolean) from public;
revoke all on function public.spot_source_url(jsonb) from public;
revoke all on function public.push_profile_url(jsonb) from public;
revoke all on function public.push_quiet_now(push_destination_settings, text, timestamptz) from public;
revoke all on function public.delivery_spot_json(raw_spots) from public;
revoke all on function public.push_sample_spot() from public;
revoke all on function public.push_clip(text, int) from public;
revoke all on function public.push_spot_fields(push_destination_settings, jsonb) from public;
revoke all on function public.push_member_devices(uuid) from public;
revoke all on function public.push_test_delivery(uuid, bigint) from public;
revoke all on function public.register_push_device(text, text, text, text, text, boolean) from public;
revoke all on function public.list_push_devices(text) from public;
revoke all on function public.rename_push_device(uuid, text) from public;
revoke all on function public.report_push_device_blocked(text) from public;
revoke all on function public.save_push_destination(uuid, text, boolean, jsonb, uuid[]) from public;
revoke all on function public.get_push_destination(uuid) from public;
revoke all on function public.duplicate_destination(uuid) from public;
revoke all on function public.preview_push_notification(text[], text[], boolean, text, bigint) from public;
grant execute on function public.register_push_device(text, text, text, text, text, boolean) to authenticated;
grant execute on function public.list_push_devices(text) to authenticated;
grant execute on function public.rename_push_device(uuid, text) to authenticated;
grant execute on function public.report_push_device_blocked(text) to authenticated;
grant execute on function public.save_push_destination(uuid, text, boolean, jsonb, uuid[]) to authenticated;
grant execute on function public.get_push_destination(uuid) to authenticated;
grant execute on function public.duplicate_destination(uuid) to authenticated;
grant execute on function public.preview_push_notification(text[], text[], boolean, text, bigint) to authenticated;

-- Discord destinations as canvas page 8 draws them: per-destination message
-- settings (a card or a plain line, ordered field picks, separator, field
-- names, footer, title link, card color), Replace URL, timed grouping of
-- spots, a preview and Send test with a chosen spot. See
-- docs/superpowers/specs/2026-10-18-discord-destination-design.md.
--
-- The model is push's (20261016000400): a settings table with a defaults
-- trigger, text rendered here from picked fields (discord_spot_fields) and
-- carried in the jsonb claim_deliveries already returns, a preview RPC and a
-- service-role test RPC that call the same renderer, and a sender that only
-- shapes what SQL rendered. There is no template and no free text: every
-- field has push's one fixed rendering (render_push_field), Comment is left
-- out because the spotter types it, and the sender sends every message with
-- mentions off.
--
-- claim_deliveries keeps its signature and result columns (sender spec,
-- sections 2, 3 and 10). It gains the batch hold (decision 8) and hands a
-- Discord row its settings as `discord` in the destination jsonb and nine
-- discord_* keys in the spot jsonb. Push and webhook rows are unchanged. The
-- sender tolerates a claim without the `discord` key, so this and the sender
-- ship in either order.
--
-- The sender's RPC allowlist, its grants (sender_role.test.sql) and its env do
-- not change; the new table gives delivery_sender nothing.

-- ---------------------------------------------------------------------------
-- 1. Field list and knobs
-- ---------------------------------------------------------------------------

-- The fields a Discord message can show: push's, in the editor's order,
-- without Comment (decision 4).
create function public.discord_fields()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array_remove(public.push_fields(), 'comment');
$$;

-- True when every name is a Discord field, none twice, and the count is
-- within p_min..p_max. The check constraints below use it;
-- save_discord_destination and the preview raise the editor's messages first
-- (validate_discord_fields).
create function public.discord_fields_valid(p_fields text[], p_min int, p_max int)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_fields is not null
     and cardinality(p_fields) between p_min and p_max
     and p_fields <@ public.discord_fields()
     and (select count(distinct f) from unnest(p_fields) f) = cardinality(p_fields);
$$;

-- The web app's address, for links that leave the app (decision 15). Push's
-- tap URL is a path the service worker resolves; a Discord message needs a
-- full URL. The Site URL in docs/OPERATIONS.md.
create function public.app_site_url()
returns text
language sql
immutable
set search_path = ''
as $$
  select 'https://app.longlines.io';
$$;

-- Discord's limits are per webhook: about 5 requests per 2 seconds and 30
-- messages a minute. The sender sends at most DISCORD_MESSAGES_PER_CLAIM (5)
-- messages per claim, so the claim keeps them per minute: a Discord
-- destination is claimed on average at most once every 10 seconds (6 claims,
-- 30 messages a minute) and is handed at most 50 spots a claim
-- (destination_claim_max, 5 messages of 10). Other types have no interval and
-- no per-claim cap.
--
-- The sender claims only when it polls (every SENDER_POLL_MS after a cycle),
-- so claims land 5 s plus a cycle apart, never exactly 10 s. A plain "10 s
-- since the last claim" would take every other poll, 10 s plus two cycles
-- apart, and with 50 a claim sustain only 3000 / (10 + 2c) spots a minute
-- (about 250 at c = 1 s). So the interval is a schedule (claim_due_at, a
-- cell-rate rule): each claim moves the due time on by the interval from
-- where it was (or from now, when it was in the past), and a destination may
-- be claimed from half an interval before it is due. Claims then average one
-- per interval whatever the poll, never closer than 5 s, and a minute holds
-- six, now and then seven (35 messages), which a 429 throttles like any other
-- rate limit.
create function public.destination_claim_interval(p_type text)
returns interval
language sql
immutable
set search_path = ''
as $$
  select case when p_type = 'discord' then interval '10 seconds' else interval '0' end;
$$;

-- The most spots one claim hands a destination, null for no cap beyond the
-- bucket: Discord 50 (one claim's 5 messages of 10).
create function public.destination_claim_max(p_type text)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case when p_type = 'discord' then 50::numeric end;
$$;

-- Same as 20261015000400 except Discord's burst, 100 instead of 300. A claim
-- takes at most 50 (destination_claim_max), and the bucket banks up to two
-- claims' worth, so a claim that p_limit cut short, or a gap between claims
-- longer than the interval, keeps its tokens for the next claim instead of
-- losing them to the cap. The rate is unchanged, 300 spots a minute: six
-- claims of 50.
create or replace function public.destination_budget(p_type text)
returns table (rate_per_minute numeric, burst numeric)
language sql
immutable
set search_path = ''
as $$
  select r, b
  from (values ('discord', 300::numeric, 100::numeric), ('push', 3::numeric, 3::numeric),
               ('webhook', 1000::numeric, 1000::numeric)) as k (t, r, b)
  where k.t = p_type;
$$;

-- When a destination is next due a claim (destination_claim_interval).
-- '-infinity' is never claimed yet. Not in the client column grant.
alter table destinations add column claim_due_at timestamptz not null default '-infinity';

-- ---------------------------------------------------------------------------
-- 2. Settings (service role only, like push_destination_settings)
-- ---------------------------------------------------------------------------

-- One row per Discord destination. The two styles share separator and
-- show_field_names and keep their own field lists, so switching styles loses
-- nothing (decision 3). batch_seconds is the claim's hold (decision 8).
create table discord_destination_settings (
  destination_id   uuid primary key references destinations(id) on delete cascade,
  style            text not null check (style in ('card', 'plain')),
  title_fields     text[] not null check (public.discord_fields_valid(title_fields, 1, 4)),
  detail_fields    text[] not null check (public.discord_fields_valid(detail_fields, 0, 8)),
  grid_fields      text[] not null check (public.discord_fields_valid(grid_fields, 0, 6)),
  title_link       text not null check (title_link in ('profile', 'source', 'none')),
  card_color       text not null check (card_color in ('source', 'blue', 'green', 'purple', 'orange', 'red', 'grey')),
  footer           boolean not null,
  line_fields      text[] not null check (public.discord_fields_valid(line_fields, 1, 8)),
  bold_first       boolean not null,
  link_preview     text not null check (link_preview in ('hidden', 'shown')),
  show_field_names boolean not null,
  separator        text not null check (separator in ('dot', 'comma', 'newline')),
  batch_seconds    int not null check (batch_seconds in (0, 10, 30, 60))
);
alter table discord_destination_settings enable row level security;
revoke all on discord_destination_settings from anon, authenticated;

-- A new Discord destination's settings, keyed by column.
-- save_discord_destination and the preview accept exactly these keys.
create function public.discord_default_settings()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'style', 'card',
    'title_fields', jsonb_build_array('callsign', 'frequency', 'mode'),
    'detail_fields', jsonb_build_array('source', 'reference', 'place_name', 'state'),
    'grid_fields', jsonb_build_array('band', 'spotter'),
    'title_link', 'profile',
    'card_color', 'source',
    'footer', true,
    'line_fields', jsonb_build_array('callsign', 'frequency', 'mode', 'source', 'reference', 'place_name'),
    'bold_first', true,
    'link_preview', 'hidden',
    'show_field_names', false,
    'separator', 'dot',
    'batch_seconds', 0);
$$;

-- Not security definer, like push's: destinations are inserted only inside
-- definer RPCs or by the service role.
create function public.discord_destination_settings_default()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  insert into discord_destination_settings
  select * from jsonb_populate_record(null::discord_destination_settings,
    public.discord_default_settings() || jsonb_build_object('destination_id', new.id));
  return null;
end;
$$;

create trigger destinations_discord_settings
  after insert on destinations
  for each row when (new.type = 'discord')
  execute function public.discord_destination_settings_default();

-- Existing Discord destinations get the defaults. Idempotent.
insert into discord_destination_settings
select (jsonb_populate_record(null::discord_destination_settings,
         public.discord_default_settings() || jsonb_build_object('destination_id', d.id))).*
from destinations d
where d.type = 'discord'
  and not exists (select 1 from discord_destination_settings s where s.destination_id = d.id);

-- ---------------------------------------------------------------------------
-- 3. Validation, with the editor's messages
-- ---------------------------------------------------------------------------

-- Raises the editor's message when a field list is not usable. p_what is
-- 'title', 'details', 'grid' or 'line'. Comment gets its own message, ahead
-- of the unknown-field one, since it is a push field the editor leaves out.
create function public.validate_discord_fields(p_fields text[], p_what text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_field text;
  v_count int := coalesce(cardinality(p_fields), 0);
begin
  if 'comment' = any (coalesce(p_fields, '{}')) then
    raise exception 'Comment is not available here.';
  end if;
  select f into v_field from unnest(coalesce(p_fields, '{}')) f
  where f is null or not (f = any (public.discord_fields())) limit 1;
  if found then
    raise exception 'Unknown field %.', coalesce(v_field, 'null');
  end if;
  if p_what = 'title' and (p_fields is null or v_count not between 1 and 4) then
    raise exception 'Pick 1 to 4 fields for the title.';
  end if;
  if p_what = 'details' and (p_fields is null or v_count > 8) then
    raise exception 'Pick up to 8 fields for the details.';
  end if;
  if p_what = 'grid' and (p_fields is null or v_count > 6) then
    raise exception 'Pick up to 6 fields for the grid.';
  end if;
  if p_what = 'line' and (p_fields is null or v_count not between 1 and 8) then
    raise exception 'Pick 1 to 8 fields for the message.';
  end if;
  if (select count(distinct f) from unnest(p_fields) f) <> v_count then
    raise exception 'Pick each field once.';
  end if;
end;
$$;

-- Every check of the table's constraints, with a message, so the preview
-- (which writes nothing) refuses what a save would refuse, and a save says
-- why instead of failing a constraint.
create function public.validate_discord_settings(p_settings discord_destination_settings)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_settings.style is null or p_settings.style not in ('card', 'plain') then
    raise exception 'Pick a message style.';
  end if;
  perform public.validate_discord_fields(p_settings.title_fields, 'title');
  perform public.validate_discord_fields(p_settings.detail_fields, 'details');
  perform public.validate_discord_fields(p_settings.grid_fields, 'grid');
  perform public.validate_discord_fields(p_settings.line_fields, 'line');
  if p_settings.title_link is null or p_settings.title_link not in ('profile', 'source', 'none') then
    raise exception 'Pick what the title links to.';
  end if;
  if p_settings.card_color is null
     or p_settings.card_color not in ('source', 'blue', 'green', 'purple', 'orange', 'red', 'grey') then
    raise exception 'Pick a card color.';
  end if;
  if p_settings.link_preview is null or p_settings.link_preview not in ('hidden', 'shown') then
    raise exception 'Pick a link preview.';
  end if;
  if p_settings.separator is null or p_settings.separator not in ('dot', 'comma', 'newline') then
    raise exception 'Pick a separator.';
  end if;
  if p_settings.batch_seconds is null or p_settings.batch_seconds not in (0, 10, 30, 60) then
    raise exception 'Pick a batch window.';
  end if;
  if p_settings.footer is null or p_settings.bold_first is null or p_settings.show_field_names is null then
    raise exception 'Turn each switch on or off.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Rendering, in SQL only (decision 5)
-- ---------------------------------------------------------------------------

-- The card color by source (decision 7): POTA green, SOTA purple, WWFF teal,
-- DX Cluster blue, RBN orange, anything else grey. discord.py's palette.
create function public.discord_source_color(p_source text)
returns int
language sql
immutable
set search_path = ''
as $$
  select case p_source
    when 'pota' then 3066993
    when 'sotawatch' then 10181046
    when 'wwff' then 1752220
    when 'dxcluster' then 3447003
    when 'rbn' then 15105570
    else 9807270
  end;
$$;

-- The card color for a spot: by source, or the one named color for every spot.
create function public.discord_color(p_settings discord_destination_settings, p_spot jsonb)
returns int
language sql
immutable
set search_path = ''
as $$
  select case p_settings.card_color
    when 'source' then public.discord_source_color(p_spot ->> 'source')
    when 'blue' then 3447003
    when 'green' then 3066993
    when 'purple' then 10181046
    when 'orange' then 15105570
    when 'red' then 15158332
    else 9807270
  end;
$$;

-- "POTA · 17:42 UTC". Deliberately not render_push_field('time'), which is
-- "17:42Z": the footer reads as a sentence.
create function public.discord_footer(p_spot jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select public.push_source_label(p_spot ->> 'source') || ' · '
      || to_char((p_spot ->> 'spot_time')::timestamptz at time zone 'UTC', 'HH24:MI') || ' UTC';
$$;

-- Discord renders markdown in embed titles, descriptions, field values and
-- message content, and a feed's callsign, spotter or park name is whatever
-- the upstream sent (DX Cluster takes any run without spaces as a call). So
-- every value is escaped once (discord_field_values) before it goes in a
-- message: a backslash before each markdown character, including the masked
-- link's brackets and parentheses, mentions, timestamps and custom emoji
-- (< @ #), and before a list marker at the start of a line, indented or not
-- (Discord takes spaces or tabs before a marker as a nested list). Push keeps
-- render_push_field unescaped: a notification is plain text.
create function public.discord_escape(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(regexp_replace(regexp_replace(p_text,
           '([\\`*_~|<>@#()\[\]])', '\\\1', 'g'),
           '^([ \t]*)-(\s)', '\1\\-\2', 'gn'),
           '^([ \t]*)([0-9]+)\.(\s)', '\1\2\\.\3', 'gn');
$$;

-- push_clip for escaped text: never leaves a lone backslash before the
-- ellipsis, which would show as a backslash.
create function public.discord_clip(p_text text, p_max int)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when length(p_text) > p_max
    then rtrim(regexp_replace(rtrim(left(p_text, p_max - 1)), '(^|[^\\])((\\\\)*)\\$', '\1\2')) || '…'
    else p_text end;
$$;

-- The profile as a full URL, or null when the call it would name is not
-- letters, digits, '/' and '-' (spot_source_url's rule): a call from a feed
-- could otherwise end the link or put markup in it. Both the title link and
-- the plain line's masked link use this.
create function public.discord_profile_url(p_spot jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when coalesce(nullif(p_spot ->> 'base_callsign', ''), p_spot ->> 'callsign') ~ '^[A-Za-z0-9/-]+$'
              then public.app_site_url() || public.push_profile_url(p_spot) end;
$$;

-- Every Discord field a spot has, rendered once by push's fixed renderer
-- (render_push_field) and escaped (discord_escape), as {field: text}; fields
-- the spot lacks are left out.
-- The functions below pick from this instead of rendering per list: a claim
-- renders up to 300 Discord spots a minute, and plpgsql loops over one
-- rendering cost a fraction of render_push_fields per list.
--
-- This, discord_grid and discord_spot_fields are stable, not immutable,
-- because jsonb_build_object is (plpgsql_check flags it in an immutable
-- body). No index or check constraint uses them.
create function public.discord_field_values(p_spot jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_out   jsonb := '{}'::jsonb;
  v_field text;
  v_value text;
begin
  foreach v_field in array public.discord_fields() loop
    v_value := public.discord_escape(public.render_push_field(v_field, p_spot));
    if v_value is not null then
      v_out := v_out || jsonb_build_object(v_field, v_value);
    end if;
  end loop;
  return v_out;
end;
$$;

-- render_push_fields over discord_field_values: the picked fields in order,
-- skipping those the spot lacks, "Label: " first when p_labels, joined by
-- p_separator ('dot', 'comma' or 'newline'). Empty when nothing renders.
create function public.discord_join(p_fields text[], p_values jsonb, p_separator text, p_labels boolean)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_out   text;
  v_field text;
  v_value text;
begin
  foreach v_field in array coalesce(p_fields, '{}') loop
    v_value := p_values ->> v_field;
    if v_value is not null then
      if p_labels then
        v_value := public.push_field_label(v_field) || ': ' || v_value;
      end if;
      v_out := case when v_out is null then v_value else v_out || public.push_separator(p_separator) || v_value end;
    end if;
  end loop;
  return coalesce(v_out, '');
end;
$$;

-- The card's small grid: [{name, value}] per field in order, the name its
-- display name, the (escaped) value clipped to Discord's 1,024; fields the
-- spot lacks are skipped.
create function public.discord_grid(p_fields text[], p_values jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_out   jsonb := '[]'::jsonb;
  v_field text;
begin
  foreach v_field in array coalesce(p_fields, '{}') loop
    if p_values ? v_field then
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'name', public.push_field_label(v_field), 'value', public.discord_clip(p_values ->> v_field, 1024)));
    end if;
  end loop;
  return v_out;
end;
$$;

-- What the card title links to: the profile, the spot on the source site
-- (the profile when the source has no page), or nothing. Null too when the
-- call is not safe in a URL (discord_profile_url).
create function public.discord_title_url(p_settings discord_destination_settings, p_spot jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_settings.title_link
    when 'profile' then public.discord_profile_url(p_spot)
    when 'source' then coalesce(public.spot_source_url(p_spot), public.discord_profile_url(p_spot))
  end;
$$;

-- The plain line (decision 12): line_fields in order, labels when
-- show_field_names, the callsign a masked link to its profile (plain text
-- when the call is not safe in a URL), the first field bold when bold_first,
-- joined by the separator. The callsign alone when nothing renders. At most
-- p_max characters (190, so ten lines fit Discord's 2,000-character content;
-- Send test passes less to make room for its marker). The budget counts the
-- markup, and a cut falls only inside a value: the item that does not fit is
-- clipped inside its bold and link (without the link when even that does not
-- fit) and the rest are left out, so no cut opens a '**' or a '[..](..)'.
create function public.discord_plain_line(p_settings discord_destination_settings, p_values jsonb, p_spot jsonb,
                                          p_max int default 190)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_out    text := '';
  v_url    text := public.discord_profile_url(p_spot);
  v_field  text;
  v_value  text;
  v_prefix text;
  v_link   text;
  v_bold   text;
  v_lead   text;
  v_room   int;
  v_cut    boolean := false;
begin
  foreach v_field in array coalesce(p_settings.line_fields, '{}') loop
    v_value := p_values ->> v_field;
    continue when v_value is null;
    v_prefix := case when p_settings.show_field_names then public.push_field_label(v_field) || ': ' else '' end;
    v_link := case when v_field = 'callsign' then v_url end;
    v_bold := case when v_out = '' and p_settings.bold_first then '**' else '' end;
    v_lead := case when v_out = '' then '' else public.push_separator(p_settings.separator) end;
    -- Room for the value once the separator, bold, label and link are counted.
    v_room := p_max - length(v_out) - length(v_lead) - 2 * length(v_bold) - length(v_prefix)
              - coalesce(length(v_link) + 4, 0);
    if v_room < 2 and v_link is not null then
      v_room := v_room + length(v_link) + 4;
      v_link := null;
    end if;
    if v_room < 2 then
      -- Not even a clipped value fits: mark the cut after the last whole item.
      if v_out <> '' and length(v_out) < p_max then
        v_out := v_out || '…';
      end if;
      exit;
    end if;
    if length(v_value) > v_room then
      v_value := public.discord_clip(v_value, v_room);
      v_cut := true;
    end if;
    v_out := v_out || v_lead || v_bold || v_prefix
             || case when v_link is null then v_value else '[' || v_value || '](' || v_link || ')' end
             || v_bold;
    exit when v_cut;
  end loop;
  if v_out = '' then
    return public.discord_clip(public.discord_escape(p_spot ->> 'callsign'), p_max);
  end if;
  return v_out;
end;
$$;

-- What a Discord destination adds to a spot: always these nine keys, which
-- the sender turns into an embed or a content line without joining or
-- formatting anything. The title never takes field names and falls back to
-- the callsign when every picked field is missing, so a card always has one;
-- the description may be empty. Embeds are suppressed only for the plain
-- style with link preview hidden: on a card, SUPPRESS_EMBEDS would hide the
-- card itself.
create function public.discord_spot_fields(p_settings discord_destination_settings, p_spot jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_values jsonb := public.discord_field_values(p_spot);
begin
  return jsonb_build_object(
    'discord_style', p_settings.style,
    'discord_title', public.discord_clip(coalesce(nullif(public.discord_join(p_settings.title_fields, v_values,
                                                                             p_settings.separator, false), ''),
                                                  public.discord_escape(p_spot ->> 'callsign')), 256),
    'discord_description', public.discord_clip(public.discord_join(p_settings.detail_fields, v_values,
                                                                   p_settings.separator, p_settings.show_field_names),
                                               4096),
    'discord_grid', public.discord_grid(p_settings.grid_fields, v_values),
    'discord_footer', case when p_settings.footer then public.discord_footer(p_spot) end,
    'discord_color', public.discord_color(p_settings, p_spot),
    'discord_url', public.discord_title_url(p_settings, p_spot),
    'discord_line', public.discord_plain_line(p_settings, v_values, p_spot),
    'discord_suppress_embeds', p_settings.style = 'plain' and p_settings.link_preview = 'hidden');
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. claim_deliveries
-- ---------------------------------------------------------------------------

-- Same signature, result columns, order and grants as 20261017001010, whose
-- sweeps, orphans, ready, budget, rank, claim and debit are kept as they are,
-- with these additions only:
--   1.  the batch hold (decision 8): `ready` also selects the delivery's
--       created_at, and `held` lists the Discord destinations with a window
--       (batch_seconds > 0) whose ready rows are all younger than it and
--       fewer than ten. `budget` leaves them out, so their rows never reach
--       `ranked`: their vt is untouched, nothing is dropped, no tokens are
--       debited and they take no share of p_limit. Only ready rows count, so
--       a row in flight, backed off, throttled or paused never starts or
--       fills a window, and once a throttle lifts its rows are older than
--       the window and go out at once. The sweeps read deliveries directly
--       and never treat a held row differently (24 hours is far beyond 60 s).
--   1b. the claim interval: `budget` also leaves out a destination more than
--       half a destination_claim_interval (10 seconds for Discord) before its
--       claim_due_at, so its messages stay within Discord's per-minute limit
--       however often the sender polls. Like a hold, it debits nothing and
--       touches no vt. A destination's share is also capped at
--       destination_claim_max (Discord 50) as well as its tokens.
--   6.  the debit also moves claim_due_at on by the interval from where it
--       was, or from now when that is in the past.
--   7.  a Discord destination's jsonb gains `discord` (its settings row, the
--       defaults when it somehow has none), and its spots the nine discord_*
--       keys (discord_spot_fields), built once per destination as for push.
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
  c_batch_full   constant int := 10;
  v_now       timestamptz := clock_timestamp();
  v_unwanted  bigint[];
  v_expired   bigint[];
  v_orphans   bigint[];
  v_claimed   jsonb;
begin
  -- 0a. Unwanted: the subscription is disabled, no longer sends to this
  -- destination, or the destination is disabled or paused by hand. Not a
  -- loss, so dropped_at stays null.
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
           or dest.health = 'paused'
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

  -- 1 to 5. Ready, hold, budget, rank, choose, claim. Ready leaves out what
  -- 0b would expire, with the same limit, for rows past its 500.
  with ready as (
    select q.msg_id, d.id as delivery_id, d.destination_id, r.spot_time, d.created_at
    from pgmq.q_deliveries_queue q
    join deliveries d on d.id = (q.message ->> 'delivery_id')::bigint
    join destinations dest on dest.id = d.destination_id
    join subscriptions s on s.id = d.subscription_id
    join raw_spots r on r.id = d.spot_id
    left join push_destination_settings ps on ps.destination_id = dest.id
    where q.vt <= v_now
      and d.created_at >= v_now - coalesce(make_interval(secs => ps.ttl_seconds),
                                           public.destination_max_age(dest.type))
      and dest.health <> 'paused'
      and dest.enabled
      and (dest.throttled_until is null or dest.throttled_until <= v_now)
      and s.enabled
      and exists (select 1 from subscription_destinations sd
                  where sd.subscription_id = d.subscription_id
                    and sd.destination_id = d.destination_id)
  ),
  -- A Discord destination with a window waits until its oldest ready row is
  -- that old or ten are ready.
  held as (
    select ready.destination_id
    from ready
    join discord_destination_settings ds on ds.destination_id = ready.destination_id
    where ds.batch_seconds > 0
    group by ready.destination_id, ds.batch_seconds
    having min(ready.created_at) > v_now - make_interval(secs => ds.batch_seconds)
       and count(*) < c_batch_full
  ),
  budget as (
    select dest.id as destination_id,
           least(b.burst,
                 dest.claim_tokens
                 + b.rate_per_minute * greatest(0, extract(epoch from v_now - dest.claim_tokens_at)) / 60) as available,
           public.destination_claim_max(dest.type) as claim_max
    from destinations dest
    cross join lateral public.destination_budget(dest.type) b
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
  -- A push destination's members, settings and quiet flag, and a Discord
  -- destination's settings, are built once per destination; their spots
  -- carry the text built from their fields. A destination somehow without a
  -- settings row (the triggers make one for every insert) is handed the
  -- defaults rather than left undeliverable.
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
    )
    select
      (x ->> 'msg_id')::bigint,
      d.id, d.subscription_id, d.attempts, d.created_at,
      jsonb_build_object(
        'id', dest.id, 'type', dest.type, 'name', dest.name, 'url', dest.url,
        'signing_secret', dest.signing_secret, 'health', dest.health,
        'consecutive_failures', dest.consecutive_failures
      ) || coalesce(pd.p_extra, dd.d_extra, '{}'::jsonb),
      public.delivery_spot_json(r)
        || case when pd.p_id is not null then public.push_spot_fields(pd.p_settings, public.delivery_spot_json(r))
                when dd.d_id is not null then public.discord_spot_fields(dd.d_settings, public.delivery_spot_json(r))
                else '{}'::jsonb end
    from jsonb_array_elements(v_claimed) x
    join deliveries d on d.id = (x ->> 'delivery_id')::bigint
    join destinations dest on dest.id = d.destination_id
    join raw_spots r on r.id = d.spot_id
    left join push_dests pd on pd.p_id = dest.id
    left join discord_dests dd on dd.d_id = dest.id
    order by (x ->> 'rn')::bigint, (x ->> 'spot_time')::timestamptz desc, d.id desc;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Send test (service role)
-- ---------------------------------------------------------------------------

-- Send test for a Discord destination (the send-test and api functions, as
-- the service role): its settings and the spot (raw_spots row p_spot_id, else
-- the sample) rendered the way claim_deliveries renders it, then marked as a
-- test (decision 14): the footer becomes "Test message from Long Lines · POTA
-- · 17:42 UTC" (the label alone when the footer is off) and the plain line
-- starts "Test message from Long Lines · " and stays within the line's 190
-- characters. Null when the destination is not
-- a Discord one or the spot is unknown. The caller has already checked that
-- the destination belongs to the user. Not a sender RPC.
create function public.discord_test_delivery(p_destination_id uuid, p_spot_id bigint default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c_marker   constant text := 'Test message from Long Lines';
  v_settings discord_destination_settings;
  v_spot     jsonb;
  v_fields   jsonb;
begin
  select s.* into v_settings
  from discord_destination_settings s
  join destinations d on d.id = s.destination_id and d.type = 'discord'
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
  v_fields := public.discord_spot_fields(v_settings, v_spot);
  -- The marked line keeps the line's 190: the line is rendered with the
  -- marker's length taken off its budget.
  v_fields := v_fields || jsonb_build_object(
    'discord_footer', c_marker || coalesce(' · ' || (v_fields ->> 'discord_footer'), ''),
    'discord_line', c_marker || ' · '
                    || public.discord_plain_line(v_settings, public.discord_field_values(v_spot), v_spot,
                                                 190 - length(c_marker || ' · ')));
  return jsonb_build_object(
    'discord', to_jsonb(v_settings) - 'destination_id',
    'spot', v_spot || v_fields);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Client RPCs
-- ---------------------------------------------------------------------------

-- Raises "Unknown setting {key}." for a key that is not a settings column.
create function public.check_discord_setting_keys(p_settings jsonb)
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
  where not public.discord_default_settings() ? k
  order by k limit 1;
  if v_key is not null then
    raise exception 'Unknown setting %.', v_key;
  end if;
end;
$$;

-- Creates (p_id null) or updates one of the caller's Discord destinations.
-- A new one goes through create_destination (the URL check, the masked
-- display, the name-taken message, the trigger's defaults); an existing one
-- through update_destination, which is not granted to clients and is called
-- here from a definer body on purpose: a null name or enabled keeps what is
-- stored, a null or blank URL keeps the stored URL (Replace URL left empty,
-- decision 10), and a new URL is checked and clears failing health.
-- p_settings is merged key by key over the current settings and checked as
-- a whole. Returns the destination id.
create function public.save_discord_destination(p_id uuid, p_name text, p_enabled boolean, p_url text,
                                                p_settings jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user     uuid := auth.uid();
  v_id       uuid := p_id;
  v_settings discord_destination_settings;
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  if (v_id is null and coalesce(trim(p_name), '') = '') or (p_name is not null and trim(p_name) = '') then
    raise exception 'Give the destination a name.';
  end if;
  perform public.check_discord_setting_keys(p_settings);
  if v_id is null then
    if coalesce(trim(p_url), '') = '' then
      raise exception 'Use a Discord webhook URL.';
    end if;
    select c.id into v_id from public.create_destination('discord', p_name, p_url) c;
    update destinations d set enabled = coalesce(p_enabled, true) where d.id = v_id;
  else
    if not exists (select 1 from destinations d where d.id = v_id and d.user_id = v_user and d.type = 'discord') then
      raise exception 'Destination not found.';
    end if;
    perform public.update_destination(v_id, p_name, nullif(trim(p_url), ''), p_enabled);
  end if;
  if p_settings is not null then
    select * into v_settings from jsonb_populate_record(null::discord_destination_settings,
      coalesce((select to_jsonb(s) from discord_destination_settings s where s.destination_id = v_id),
               public.discord_default_settings() || jsonb_build_object('destination_id', v_id))
      || p_settings);
    perform public.validate_discord_settings(v_settings);
    insert into discord_destination_settings select (v_settings).*
    on conflict (destination_id) do update
    set style = excluded.style, title_fields = excluded.title_fields, detail_fields = excluded.detail_fields,
        grid_fields = excluded.grid_fields, title_link = excluded.title_link, card_color = excluded.card_color,
        footer = excluded.footer, line_fields = excluded.line_fields, bold_first = excluded.bold_first,
        link_preview = excluded.link_preview, show_field_names = excluded.show_field_names,
        separator = excluded.separator, batch_seconds = excluded.batch_seconds;
  end if;
  return v_id;
end;
$$;

-- One of the caller's Discord destinations for the editor: its settings and
-- the masked URL. Never the URL itself.
create function public.get_discord_destination(p_id uuid)
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
           'settings', to_jsonb(s) - 'destination_id')
    into v_result
  from destinations d
  join discord_destination_settings s on s.destination_id = d.id
  where d.id = p_id and d.user_id = auth.uid() and d.type = 'discord';
  if v_result is null then
    raise exception 'Destination not found.';
  end if;
  return v_result;
end;
$$;

-- The style and field count of each of the caller's Discord destinations,
-- for the list cards' type line ("Discord channel · Card · 9 fields"), so the
-- settings table keeps no client grant. A card counts its title, details and
-- grid; a plain line its line.
create function public.list_discord_destination_settings()
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
             'destination_id', d.id, 'style', s.style,
             'field_count', case when s.style = 'plain' then cardinality(s.line_fields)
                                 else cardinality(s.title_fields) + cardinality(s.detail_fields)
                                      + cardinality(s.grid_fields) end)
           order by d.created_at, d.id)
    from destinations d
    join discord_destination_settings s on s.destination_id = d.id
    where d.user_id = auth.uid() and d.type = 'discord'), '[]'::jsonb);
end;
$$;

-- The editor's preview: the settings (merged over the defaults; null for the
-- defaults) rendered against raw_spots row p_spot_id, or the sample spot,
-- through the same discord_spot_fields that claim_deliveries calls, after the
-- same checks a save makes.
create function public.preview_discord_message(p_settings jsonb, p_spot_id bigint default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_settings discord_destination_settings;
  v_spot     jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;
  perform public.check_discord_setting_keys(p_settings);
  v_settings := jsonb_populate_record(null::discord_destination_settings,
                                      public.discord_default_settings() || coalesce(p_settings, '{}'::jsonb));
  perform public.validate_discord_settings(v_settings);
  if p_spot_id is null then
    v_spot := public.push_sample_spot();
  else
    select public.delivery_spot_json(r) into v_spot from raw_spots r where r.id = p_spot_id;
    if v_spot is null then
      raise exception 'Spot not found.';
    end if;
  end if;
  return public.discord_spot_fields(v_settings, v_spot);
end;
$$;

-- Same as 20261016000400, for Discord too (decision 11): a Discord copy has
-- the same URL (so it posts to the same channel) and settings. Every copy is
-- named "Copy of {name}" (with " (2)"... when that is taken) and starts
-- disabled so it never double-sends before it is edited. Fresh throttle and
-- health state, since it is a new row. Returns the new id.
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
  if v_src.type not in ('push', 'discord') then
    raise exception 'Only push and Discord destinations can be duplicated.';
  end if;
  v_name := public.unique_destination_name(v_user, 'Copy of ' || v_src.name);
  begin
    insert into destinations (user_id, type, name, url, url_display, enabled)
    values (v_user, v_src.type, v_name, v_src.url, v_src.url_display, false)
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
  else
    update discord_destination_settings s
    set style = o.style, title_fields = o.title_fields, detail_fields = o.detail_fields,
        grid_fields = o.grid_fields, title_link = o.title_link, card_color = o.card_color, footer = o.footer,
        line_fields = o.line_fields, bold_first = o.bold_first, link_preview = o.link_preview,
        show_field_names = o.show_field_names, separator = o.separator, batch_seconds = o.batch_seconds
    from discord_destination_settings o
    where s.destination_id = v_id and o.destination_id = p_id;
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Management API
-- ---------------------------------------------------------------------------

-- Same as 20261016000400 plus, for Discord, its settings (read only: the API
-- does not change them, as for push).
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
     else '{}'::jsonb end;
$$;

-- ---------------------------------------------------------------------------
-- Access. Every function above starts executable by public; revoking that
-- leaves service_role (20261012000120). Clients get the four RPCs the editor
-- and the list call; duplicate_destination, claim_deliveries and
-- api_destination_json keep their grants (create or replace keeps them).
-- delivery_sender gets nothing new: its allowlist is unchanged.
-- ---------------------------------------------------------------------------

revoke all on function public.discord_fields() from public;
revoke all on function public.discord_fields_valid(text[], int, int) from public;
revoke all on function public.app_site_url() from public;
revoke all on function public.destination_claim_interval(text) from public;
revoke all on function public.destination_claim_max(text) from public;
revoke all on function public.discord_escape(text) from public;
revoke all on function public.discord_clip(text, int) from public;
revoke all on function public.discord_profile_url(jsonb) from public;
revoke all on function public.discord_default_settings() from public;
revoke all on function public.discord_destination_settings_default() from public;
revoke all on function public.validate_discord_fields(text[], text) from public;
revoke all on function public.validate_discord_settings(discord_destination_settings) from public;
revoke all on function public.discord_source_color(text) from public;
revoke all on function public.discord_color(discord_destination_settings, jsonb) from public;
revoke all on function public.discord_footer(jsonb) from public;
revoke all on function public.discord_field_values(jsonb) from public;
revoke all on function public.discord_join(text[], jsonb, text, boolean) from public;
revoke all on function public.discord_grid(text[], jsonb) from public;
revoke all on function public.discord_title_url(discord_destination_settings, jsonb) from public;
revoke all on function public.discord_plain_line(discord_destination_settings, jsonb, jsonb, int) from public;
revoke all on function public.discord_spot_fields(discord_destination_settings, jsonb) from public;
revoke all on function public.discord_test_delivery(uuid, bigint) from public;
revoke all on function public.check_discord_setting_keys(jsonb) from public;
revoke all on function public.save_discord_destination(uuid, text, boolean, text, jsonb) from public;
revoke all on function public.get_discord_destination(uuid) from public;
revoke all on function public.list_discord_destination_settings() from public;
revoke all on function public.preview_discord_message(jsonb, bigint) from public;
grant execute on function public.save_discord_destination(uuid, text, boolean, text, jsonb) to authenticated;
grant execute on function public.get_discord_destination(uuid) to authenticated;
grant execute on function public.list_discord_destination_settings() to authenticated;
grant execute on function public.preview_discord_message(jsonb, bigint) to authenticated;

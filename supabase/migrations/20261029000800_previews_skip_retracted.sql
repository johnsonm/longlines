-- The destination previews and Send test leave retracted logged contacts out.
--
-- Every reader of raw_spots for spots leaves a retracted row out (CLAUDE.md,
-- "Logged contacts rules"), but these six looked a spot up by id with no
-- retracted_at check, so any signed-in user could walk the sequential ids
-- through the three client previews and read contacts their operators had
-- retracted, and send them to their own destination with Send test.
-- preview_local_cluster_line already filters. Each body is its previous
-- definition with "and r.retracted_at is null" on the lookup, so a retracted
-- spot reads as missing ("Spot not found.", which send-test answers with 404).
-- No signature, result column or grant changes.

-- As in 20261016000400, plus the retracted_at check.
create or replace function public.push_test_delivery(p_destination_id uuid, p_spot_id bigint default null)
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
    select public.delivery_spot_json(r) into v_spot from raw_spots r
      where r.id = p_spot_id and r.retracted_at is null;
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

-- As in 20261016000400, plus the retracted_at check.
create or replace function public.preview_push_notification(
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
    select public.delivery_spot_json(r) into v_spot from raw_spots r
      where r.id = p_spot_id and r.retracted_at is null;
    if v_spot is null then
      raise exception 'Spot not found.';
    end if;
  end if;
  v_fields := public.push_spot_fields(v_settings, v_spot);
  return query select v_fields ->> 'push_title', v_fields ->> 'push_body', v_fields ->> 'push_url',
                      v_fields ->> 'push_source_url';
end;
$$;

-- As in 20261018000100, plus the retracted_at check.
create or replace function public.discord_test_delivery(p_destination_id uuid, p_spot_id bigint default null)
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
    select public.delivery_spot_json(r) into v_spot from raw_spots r
      where r.id = p_spot_id and r.retracted_at is null;
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

-- As in 20261018000100, plus the retracted_at check.
create or replace function public.preview_discord_message(p_settings jsonb, p_spot_id bigint default null)
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
    select public.delivery_spot_json(r) into v_spot from raw_spots r
      where r.id = p_spot_id and r.retracted_at is null;
    if v_spot is null then
      raise exception 'Spot not found.';
    end if;
  end if;
  return public.discord_spot_fields(v_settings, v_spot);
end;
$$;

-- As in 20261018000300, plus the retracted_at check.
create or replace function public.webhook_test_delivery(p_destination_id uuid, p_spot_id bigint default null)
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
    select public.delivery_spot_json(r) into v_spot from raw_spots r
      where r.id = p_spot_id and r.retracted_at is null;
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

-- As in 20261018000300, plus the retracted_at check.
create or replace function public.preview_webhook_request(p_settings jsonb, p_spot_id bigint default null,
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
    select public.delivery_spot_json(r) into v_spot from raw_spots r
      where r.id = p_spot_id and r.retracted_at is null;
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

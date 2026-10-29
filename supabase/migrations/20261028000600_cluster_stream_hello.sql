-- The sender's spots stream (contract v2, section 9) needs two values 20261028000500 left out:
--
-- 1. set_cluster_stream answers the stream's `hello` event, {relay_id, device_name} (the same
--    values as GET /v2/me), instead of a boolean, so the sender learns the device name in the
--    call that marks the relay connected. Null still means nothing changed: an unknown token, or
--    one without spots:read asked to connect.
-- 2. local_cluster_spot_fields adds cluster_spot_time, the spot event's spot_time in the
--    contract's `YYYY-MM-DDTHH:MM:SSZ` form, so the sender names every event value and formats
--    none.

drop function public.set_cluster_stream(uuid, boolean);

-- The sender, when a relay's spots stream opens (p_connected true) or closes. The stream's hello,
-- {relay_id, device_name}, when the token exists (and, to connect, carries spots:read); null
-- otherwise, and nothing changes. A stream that replaces an older one for the same token is
-- already connected: the sender clears presence only when the stream that closes is the token's
-- current one.
create function public.set_cluster_stream(p_token_id uuid, p_connected boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hello jsonb;
begin
  if p_token_id is null or p_connected is null then
    raise exception 'set_cluster_stream needs a token and a state.' using errcode = '22023';
  end if;
  update relay_tokens t
  set cluster_connected_at = case when p_connected then now() end
  where t.id = p_token_id
    and (not p_connected or 'spots:read' = any (t.scopes))
  returning jsonb_build_object('relay_id', t.id, 'device_name', t.device_name) into v_hello;
  return v_hello;
end;
$$;

-- As in 20261028000500, plus cluster_spot_time.
create or replace function public.local_cluster_spot_fields(p_settings local_cluster_destination_settings, p_spot jsonb)
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
    'cluster_source_label', public.push_source_label(p_spot ->> 'source'),
    'cluster_spot_time', to_char((p_spot ->> 'spot_time')::timestamptz at time zone 'UTC',
                                 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
$$;

revoke all on function public.set_cluster_stream(uuid, boolean) from public;
grant execute on function public.set_cluster_stream(uuid, boolean) to service_role, delivery_sender;

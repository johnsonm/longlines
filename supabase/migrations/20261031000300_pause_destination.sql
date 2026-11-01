-- The permanent-failure pause.
-- Spec: docs/superpowers/specs/2026-10-31-outbound-sender-phase-2.md, Piece 2.
--
-- A webhook that answers HTTP 410 and a Discord webhook that Discord says no
-- longer exists (404 with code 10015, 401 with code 50027) will never take a
-- spot again, so the sender pauses the destination at once instead of failing
-- every batch until the expiry sweep. The pause is the one the webhook count
-- pause already uses (20261018000300): enabled = false plus auto_disabled_at,
-- never health. The claim's unwanted sweep then drops the queue with
-- dropped_at, and update_destination(..., true) (or a save with Enabled on)
-- resumes it, as today.
--
-- 1. pause_destination(destination, delivery ids, msg ids, error): a sender
--    RPC modelled on mark_deliveries_failed (20261021000600). The rows are
--    marked failed; the destination pauses only when one of them was claimed
--    at its current url_generation, so a gone reply from the old URL never
--    pauses the URL the owner put in its place (those rows only become
--    visible again, for the new URL).
-- 2. get_discord_destination returns auto_disabled_at, for the Discord
--    editor's paused alert.
-- 3. api_destination_json's discord object carries auto_disabled_at, as the
--    webhook object does.
--
-- No change to claim_deliveries, update_destination, mark_deliveries_failed
-- or the save RPCs.

-- ---------------------------------------------------------------------------
-- 1. pause_destination
-- ---------------------------------------------------------------------------

-- The destination's URL is gone for good: mark the failed rows and turn the
-- destination off with auto_disabled_at, making every queued row of it
-- visible so the next claim drops them as lost. Rows of another destination
-- in p_delivery_ids are ignored. Health follows the failure count as in
-- mark_deliveries_failed and is never set to 'paused'.
create function public.pause_destination(
  p_destination_id uuid, p_delivery_ids bigint[], p_msg_ids bigint[], p_error text
)
returns void
language plpgsql
security definer
set search_path = public, pgmq
as $$
declare
  v_generation int;
begin
  select dest.url_generation into v_generation
  from destinations dest where dest.id = p_destination_id for update;
  if not found then
    raise exception 'Destination not found.';
  end if;

  update deliveries d
  set status = 'failed', attempts = d.attempts + 1, last_error = p_error
  where d.id = any (p_delivery_ids) and d.destination_id = p_destination_id;

  -- Claimed before a URL change: the reply was about the old URL. The rows
  -- go to the new one at the next claim and the destination is left alone.
  if not exists (select 1 from deliveries d
                 where d.id = any (p_delivery_ids) and d.destination_id = p_destination_id
                   and (d.url_generation is null or d.url_generation = v_generation)) then
    perform pgmq.set_vt('deliveries_queue', u.msg_id, 0)
    from unnest(p_delivery_ids, p_msg_ids) as u(delivery_id, msg_id)
    join deliveries d on d.id = u.delivery_id and d.destination_id = p_destination_id
    where u.msg_id is not null;
    return;
  end if;

  update destinations dest
  set enabled = false,
      auto_disabled_at = coalesce(dest.auto_disabled_at, now()),
      consecutive_failures = dest.consecutive_failures + 1,
      last_error = p_error,
      last_error_at = now(),
      health = case
        when dest.health = 'paused' then 'paused'
        when dest.consecutive_failures + 1 >= 5 then 'failing'
        else dest.health
      end
  where dest.id = p_destination_id;

  perform pgmq.set_vt('deliveries_queue', q.msg_id, 0)
  from pgmq.q_deliveries_queue q
  join deliveries d on d.id = (q.message ->> 'delivery_id')::bigint
  where d.destination_id = p_destination_id
    and d.status in ('pending', 'failed');
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. get_discord_destination
-- ---------------------------------------------------------------------------

-- As in 20261018000100, plus auto_disabled_at.
create or replace function public.get_discord_destination(p_id uuid)
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
           'auto_disabled_at', d.auto_disabled_at,
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

-- ---------------------------------------------------------------------------
-- 3. api_destination_json
-- ---------------------------------------------------------------------------

-- As in 20261028000500, plus auto_disabled_at in the discord object (still
-- null as a whole for a Discord destination without a settings row).
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
       (select (to_jsonb(s) - 'destination_id') || jsonb_build_object('auto_disabled_at', d.auto_disabled_at)
        from discord_destination_settings s where s.destination_id = d.id))
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
-- 4. Access. pause_destination starts executable by public; revoking that
-- leaves service_role (20261012000120), and the sender's role gets it. The
-- redefined functions keep their grants (create or replace keeps them).
-- ---------------------------------------------------------------------------

revoke all on function public.pause_destination(uuid, bigint[], bigint[], text) from public;
grant execute on function public.pause_destination(uuid, bigint[], bigint[], text) to service_role, delivery_sender;

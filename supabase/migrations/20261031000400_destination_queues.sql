-- Queue backlog and Clear queue.
-- Spec: docs/superpowers/specs/2026-10-31-outbound-sender-phase-2.md, Piece 3.
--
-- The owner and the operator see how many spots wait for each destination,
-- SQL decides when a destination is backed up, and the owner can clear the
-- spots waiting to be sent.
--
-- 1. Knobs: destination_backlog_waiting() (100 rows) and
--    destination_backlog_age() (10 minutes).
-- 2. destination_queue_status: the operator's view, one row per destination
--    with waiting (pending or failed rows), oldest_waiting_seconds and
--    dropped_24h (rows whose dropped_at is in the last 24 hours: loss, since
--    unwanted and cleared rows keep dropped_at null). service_role only.
-- 3. list_destination_queues(): the caller's rows of the view with
--    backed_up, for the Destinations page.
-- 4. clear_destination_queue(id): drops the destination's waiting rows whose
--    queue message is visible now, with dropped_at null, and archives their
--    messages, the shape of the claim's unwanted sweep (20261028000500). Rows
--    whose vt is ahead are left: they are in flight in the sender, in webhook
--    retry backoff or held by a throttle, and dropping an in-flight row before
--    its mark_deliveries_failed would leave a failed row with no message.
-- 5. api_call: as in 20261029001300, with clear_destination_queue in the write
--    list and the path's destination checked first (LL404).
--
-- No change to claim_deliveries or the sender's RPCs.

-- ---------------------------------------------------------------------------
-- 1. Knobs
-- ---------------------------------------------------------------------------

-- A destination with at least this many spots waiting is backed up.
create function public.destination_backlog_waiting()
returns int
language sql
immutable
set search_path = ''
as $$
  select 100;
$$;

-- A destination whose oldest waiting spot is at least this old is backed up.
create function public.destination_backlog_age()
returns interval
language sql
immutable
set search_path = ''
as $$
  select interval '10 minutes';
$$;

-- ---------------------------------------------------------------------------
-- 2. destination_queue_status
-- ---------------------------------------------------------------------------

-- waiting and oldest_waiting_seconds read deliveries_destination_status_idx;
-- dropped_24h reads deliveries_destination_dropped_at_idx. oldest_waiting_seconds
-- is null when nothing waits.
create view destination_queue_status with (security_invoker = true) as
select dest.id as destination_id, dest.user_id, dest.type, dest.name, dest.enabled, dest.health,
       dest.auto_disabled_at, dest.throttled_until,
       w.waiting, w.oldest_waiting_seconds, x.dropped_24h
from destinations dest
cross join lateral (
  select count(*)::int as waiting,
         floor(extract(epoch from now() - min(d.created_at)))::int as oldest_waiting_seconds
  from deliveries d
  where d.destination_id = dest.id and d.status in ('pending', 'failed')
) w
cross join lateral (
  select count(*)::int as dropped_24h
  from deliveries d
  where d.destination_id = dest.id and d.dropped_at > now() - interval '24 hours'
) x;

-- ---------------------------------------------------------------------------
-- 3. list_destination_queues
-- ---------------------------------------------------------------------------

-- The caller's destinations with their queue figures. backed_up is SQL's: an
-- enabled destination (a pause sets enabled = false) that no operator paused
-- (health = 'paused', whose rows the claim drops as unwanted), at or past
-- either knob. The web only words it.
create function public.list_destination_queues()
returns table (destination_id uuid, waiting int, oldest_waiting_seconds int, dropped_24h int,
               backed_up boolean)
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
  select q.destination_id, q.waiting, q.oldest_waiting_seconds, q.dropped_24h,
         q.enabled and q.health <> 'paused'
           and (q.waiting >= public.destination_backlog_waiting()
                or coalesce(q.oldest_waiting_seconds, 0)
                   >= extract(epoch from public.destination_backlog_age()))
  from destination_queue_status q
  where q.user_id = auth.uid()
  order by q.destination_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. clear_destination_queue
-- ---------------------------------------------------------------------------

-- Drops the caller's destination's waiting rows whose message is visible now
-- and archives those messages; returns how many were dropped. The owner chose
-- to drop them, so dropped_at stays null (not loss). The queue rows are taken
-- for update skip locked, so a message the claim is taking at the same moment
-- is left to the claim, and a claim that commits first moves its vt ahead,
-- which the recheck then leaves out.
create function public.clear_destination_queue(p_destination_id uuid)
returns int
language plpgsql
security definer
set search_path = public, pgmq
as $$
declare
  v_now     timestamptz := clock_timestamp();
  v_msg_ids bigint[];
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;
  if not exists (select 1 from destinations d
                 where d.id = p_destination_id and d.user_id = auth.uid()) then
    raise exception 'Destination not found.';
  end if;

  with visible as (
    select q.msg_id, d.id
    from pgmq.q_deliveries_queue q
    join deliveries d on d.id = (q.message ->> 'delivery_id')::bigint
    where d.destination_id = p_destination_id
      and d.status in ('pending', 'failed')
      and q.vt <= v_now
    for update of q skip locked
  ),
  dropped as (
    update deliveries d
    set status = 'dropped', dropped_at = null
    from visible
    where d.id = visible.id and d.status in ('pending', 'failed')
    returning visible.msg_id
  )
  select array_agg(dropped.msg_id) into v_msg_ids from dropped;

  if v_msg_ids is null then
    return 0;
  end if;
  perform pgmq.archive('deliveries_queue', v_msg_ids);
  return cardinality(v_msg_ids);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. api_call
-- ---------------------------------------------------------------------------

-- api_call: 20261029001300's, with clear_destination_queue.
create or replace function public.api_call(p_token_id uuid, p_op text, p_args jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub    text := current_setting('request.jwt.claim.sub', true);
  v_claims text := current_setting('request.jwt.claims', true);
  v_via    text := current_setting('longlines.via_api', true);
  v_user   uuid;
  v_scope  text;
  v_needs  text;
  v_id     uuid;
  v_item   uuid;
  v_result jsonb;
begin
  select t.user_id, t.scope into v_user, v_scope from api_tokens t
  where t.id = p_token_id and (t.expires_at is null or t.expires_at > now());
  if v_user is null then
    raise exception 'Token not found.' using errcode = 'LL401';
  end if;

  v_needs := case
    when p_op in ('list_destinations', 'get_destination', 'list_subscriptions',
                  'get_subscription', 'list_groups', 'get_group', 'list_goals',
                  'get_goal')
      then 'read'
    when p_op in ('create_destination', 'update_destination', 'delete_destination',
                  'rotate_signing_secret', 'clear_destination_queue',
                  'create_subscription', 'replace_subscription',
                  'patch_subscription', 'delete_subscription', 'create_group', 'update_group',
                  'delete_group', 'add_group_members', 'remove_group_members',
                  'create_goal', 'replace_goal', 'delete_goal',
                  'mark_goal_entry', 'resolve_goal_review')
      then 'write'
  end;
  if v_needs is null then
    raise exception 'Unknown operation.';
  end if;
  if v_needs = 'write' and v_scope <> 'write' then
    raise exception 'This token is read only.' using errcode = 'LL403';
  end if;

  perform set_config('request.jwt.claim.sub', v_user::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  perform set_config('longlines.via_api', 'on', true);

  v_id := nullif(p_args ->> 'id', '')::uuid;

  -- The resource the path names. Only a missing one is a 404 (LL404); a missing row the body
  -- refers to (a destination or group id in a connection) is a 400 from the RPC that reads it.
  if p_op in ('get_destination', 'update_destination', 'delete_destination', 'rotate_signing_secret',
              'clear_destination_queue')
     and not exists (select 1 from destinations d where d.id = v_id and d.user_id = v_user) then
    raise exception 'Destination not found.' using errcode = 'LL404';
  elsif p_op in ('get_subscription', 'replace_subscription', 'patch_subscription', 'delete_subscription')
     and not exists (select 1 from subscriptions s where s.id = v_id and s.user_id = v_user) then
    raise exception 'Connection not found.' using errcode = 'LL404';
  elsif p_op in ('get_group', 'update_group', 'delete_group', 'add_group_members', 'remove_group_members')
     and not exists (select 1 from callsign_groups g where g.id = v_id and g.user_id = v_user) then
    raise exception 'Group not found.' using errcode = 'LL404';
  elsif p_op in ('get_goal', 'replace_goal', 'delete_goal', 'mark_goal_entry',
                 'resolve_goal_review')
     and not exists (select 1 from goals l where l.id = v_id and l.user_id = v_user) then
    raise exception 'Goal not found.' using errcode = 'LL404';
  end if;

  case p_op
    -- Destinations
    when 'list_destinations' then
      select coalesce(jsonb_agg(public.api_destination_json(d) order by d.created_at), '[]')
      into v_result from destinations d where d.user_id = v_user;
    when 'get_destination' then
      select public.api_destination_json(d) into v_result
      from destinations d where d.id = v_id and d.user_id = v_user;
      if v_result is null then
        raise exception 'Destination not found.' using errcode = 'LL404';
      end if;
    when 'create_destination' then
      select to_jsonb(c) into v_result
      from public.create_destination(p_args ->> 'type', p_args ->> 'name', p_args ->> 'url') c;
    when 'update_destination' then
      -- PATCH takes no type, but a destination read back whole and sent again has one; a
      -- different type is refused rather than ignored.
      if p_args ? 'type' and jsonb_typeof(p_args -> 'type') <> 'null' and not exists (
           select 1 from destinations d
           where d.id = v_id and d.user_id = v_user and d.type = p_args ->> 'type') then
        raise exception 'The type can''t change.';
      end if;
      perform public.update_destination(v_id, p_args ->> 'name', p_args ->> 'url',
                                        (p_args ->> 'enabled')::boolean);
      select public.api_destination_json(d) into v_result from destinations d where d.id = v_id;
    when 'delete_destination' then
      perform public.delete_destination(v_id);
      v_result := jsonb_build_object('deleted', true);
    when 'rotate_signing_secret' then
      v_result := jsonb_build_object('signing_secret', public.rotate_signing_secret(v_id));
    when 'clear_destination_queue' then
      v_result := jsonb_build_object('cleared', public.clear_destination_queue(v_id));

    -- Subscriptions
    when 'list_subscriptions' then
      select coalesce(jsonb_agg(public.api_subscription_json(s) order by s.created_at), '[]')
      into v_result from subscriptions s where s.user_id = v_user;
    when 'get_subscription' then
      select public.api_subscription_json(s) into v_result
      from subscriptions s where s.id = v_id and s.user_id = v_user;
      if v_result is null then
        raise exception 'Connection not found.' using errcode = 'LL404';
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
      select coalesce(jsonb_agg(public.api_group_json(to_jsonb(g))), '[]') into v_result
      from public.list_callsign_groups() g;
    when 'get_group' then
      select public.api_group_json(to_jsonb(g)) into v_result from public.callsign_group_rows(v_id) g;
      if v_result is null then
        raise exception 'Group not found.' using errcode = 'LL404';
      end if;
    when 'create_group' then
      v_id := public.save_callsign_group(p_args - 'id');
      select public.api_group_json(to_jsonb(g)) into v_result from public.callsign_group_rows(v_id) g;
    when 'update_group' then
      perform public.patch_callsign_group(v_id, p_args - 'id');
      select public.api_group_json(to_jsonb(g)) into v_result from public.callsign_group_rows(v_id) g;
    when 'delete_group' then
      perform public.delete_callsign_group(v_id);
      v_result := jsonb_build_object('deleted', true);
    when 'add_group_members' then
      perform public.edit_group_callsigns(v_id, p_args -> 'callsigns', null);
      select public.api_group_json(to_jsonb(g)) into v_result from public.callsign_group_rows(v_id) g;
    when 'remove_group_members' then
      perform public.edit_group_callsigns(v_id, null, p_args -> 'callsigns');
      select public.api_group_json(to_jsonb(g)) into v_result from public.callsign_group_rows(v_id) g;

    -- Goals
    when 'list_goals' then
      v_result := public.list_goals();
    when 'get_goal' then
      v_result := public.api_goal_json(public.get_goal(v_id));
    when 'create_goal' then
      v_id := public.save_goal(coalesce(p_args -> 'body', '{}') - 'id');
      v_result := public.api_goal_json(public.get_goal(v_id));
    when 'replace_goal' then
      perform public.save_goal(
        coalesce(p_args -> 'body', '{}') || jsonb_build_object('id', v_id));
      v_result := public.api_goal_json(public.get_goal(v_id));
    when 'delete_goal' then
      perform public.delete_goal(v_id);
      v_result := jsonb_build_object('deleted', true);
    when 'mark_goal_entry' then
      -- mark_goal_entry takes any requirement of the caller's; the API's must be the path's list's.
      select r.id into v_item from goal_requirements r
      where r.list_id = v_id and r.id::text = lower(p_args ->> 'requirement_id');
      if v_item is null then
        raise exception 'Requirement not found.';
      end if;
      perform public.mark_goal_entry(v_item, p_args ->> 'value',
        case jsonb_typeof(p_args -> 'worked') when 'boolean' then (p_args -> 'worked')::boolean end);
      v_result := public.api_goal_json(public.get_goal(v_id));
    when 'resolve_goal_review' then
      select v.id into v_item from goal_reviews v
      where v.list_id = v_id and v.id::text = lower(p_args ->> 'review_id');
      if v_item is null then
        raise exception 'Review not found.';
      end if;
      perform public.resolve_goal_review(v_item, p_args ->> 'reference');
      v_result := public.api_goal_json(public.get_goal(v_id));
  end case;

  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('longlines.via_api', coalesce(v_via, ''), true);
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Access. New functions start executable by public; revoking that leaves
-- service_role (20261012000120). The view's select goes to service_role only.
-- api_call keeps its grants (create or replace keeps them).
-- ---------------------------------------------------------------------------

revoke all on destination_queue_status from anon, authenticated;
grant select on destination_queue_status to service_role;

revoke all on function public.destination_backlog_waiting() from public;
revoke all on function public.destination_backlog_age() from public;
revoke all on function public.list_destination_queues() from public;
revoke all on function public.clear_destination_queue(uuid) from public;
grant execute on function public.list_destination_queues() to authenticated;
grant execute on function public.clear_destination_queue(uuid) to authenticated;

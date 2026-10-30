-- Goals in the management API (docs/superpowers/specs/2026-10-29-goals-design.md,
-- "Management API"): GET/POST /v1/goals, GET/PUT/DELETE /v1/goals/:id, and
-- POST /v1/goals/:id/entries and /reviews. The routes are
-- supabase/functions/_shared/api/routes.ts and the reference docs/openapi.yaml.
--
-- 1. api_goal_json: get_goal's payload as the API shows it, the card's fields at the
--    top level beside requirements, reviews, relay, used_by and first_contact_at. get_goal
--    already says connection (connection_count, used_by), so nothing is renamed.
-- 2. api_call: as in 20261021000500, with the seven goal operations in the allowlist, a
--    missing or foreign list on the path as LL404, and an entry's requirement or a review that is
--    not the path's list's as a plain 400 ("Requirement not found.", "Review not found."), since
--    mark_goal_entry and resolve_goal_review only check that it is the caller's.
--
-- Same signature, so api_call's grants carry over.

create function public.api_goal_json(g jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select (g -> 'list') || (g - 'list');
$$;

revoke all on function public.api_goal_json(jsonb) from public;

-- api_call: 20261021000500's, with the goal operations.
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
                  'rotate_signing_secret', 'create_subscription', 'replace_subscription',
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
  if p_op in ('get_destination', 'update_destination', 'delete_destination', 'rotate_signing_secret')
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

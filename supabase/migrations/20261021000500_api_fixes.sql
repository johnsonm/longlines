-- Management API fixes from the issue backlog (2026-10-21).
--
-- 1. quiet_minutes (#162): save_subscription compares a jsonb number as numeric, which can't
--    overflow, instead of casting text that matched an unbounded digit regex (a 200,000-digit
--    string raised 22003). A string is still taken when it is a short plain number. The allowed set
--    is subscription_quiet_minutes(), which the check and its message both read;
--    supabase/tests/subscriptions.test.sql pins it to subscriptions_quiet_minutes_check, so a
--    migration that widens the constraint fails CI until the helper follows.
-- 2. destinations (#150, #165): a JSON null list reads as left out (empty), as sources and rules
--    already do, and an id that is not a UUID gets "Not a destination id: …" rather than Postgres's
--    "invalid input syntax for type uuid".
-- 3. update_destination through the API (#151): a type that differs from the stored one is refused
--    ("The type can't change.") instead of ignored. The same type, or null, still passes, so a
--    destination read back whole and PATCHed works.
--
-- save_subscription is 20261017003000's and api_call 20261019000400's, with only those changes.
-- Same signatures, so the grants carry over.

create function public.subscription_quiet_minutes()
returns int[]
language sql
immutable
set search_path = ''
as $$ select '{0, 5, 10, 30, 60}'::int[] $$;

revoke all on function public.subscription_quiet_minutes() from public;

-- "0, 5, 10, 30 or 60"
create function public.subscription_quiet_minutes_text()
returns text
language sql
immutable
set search_path = ''
as $$
  select array_to_string(a[1:cardinality(a) - 1], ', ') || ' or ' || a[cardinality(a)]
  from (select public.subscription_quiet_minutes() as a) t
$$;

revoke all on function public.subscription_quiet_minutes_text() from public;

create or replace function public.save_subscription(payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user   uuid := auth.uid();
  v_id     uuid := (payload ->> 'id')::uuid;
  v_name   text := trim(coalesce(payload ->> 'name', ''));
  v_dests  uuid[];
  v_rules  jsonb;
  v_groups uuid[];
  v_owned  int;
  v_quiet  text := payload ->> 'quiet_minutes';
  v_sources text[];
  v_bad    text;
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  if v_name = '' then
    raise exception 'Give the connection a name.';
  end if;
  if payload ?| array['bands', 'modes', 'callsigns', 'reference', 'group_ids'] then
    raise exception 'Filters are rules now: send rules instead of bands, modes, callsigns, reference or group_ids.';
  end if;
  -- A jsonb number is already numeric, so comparing it can't fail; 7.5 and 3000000000 get this
  -- message rather than a cast error, and the check constraint's name never reaches an API client.
  -- A string is compared only when it is a short plain number, so its cast can't overflow either.
  if v_quiet is not null and not coalesce(case
       when jsonb_typeof(payload -> 'quiet_minutes') = 'number'
         then (payload -> 'quiet_minutes')::numeric = any (public.subscription_quiet_minutes())
       when v_quiet ~ '^-?[0-9]{1,9}(\.[0-9]{1,9})?$'
         then v_quiet::numeric = any (public.subscription_quiet_minutes())
     end, false) then
    raise exception 'quiet_minutes must be %.', public.subscription_quiet_minutes_text();
  end if;

  v_sources := public.normalize_subscription_sources(payload -> 'sources');

  -- A JSON null list reads as left out, like a missing one; an id that is not a UUID gets a message
  -- rather than Postgres's cast error.
  if jsonb_typeof(payload -> 'destinations') not in ('array', 'null') then
    raise exception 'destinations must be a list.';
  end if;
  select x into v_bad
  from jsonb_array_elements_text(case jsonb_typeof(payload -> 'destinations')
                                   when 'array' then payload -> 'destinations' else '[]' end) as x
  where not pg_input_is_valid(x, 'uuid')
  limit 1;
  if v_bad is not null then
    raise exception 'Not a destination id: %.', v_bad;
  end if;
  select coalesce(array_agg(distinct x::uuid), '{}') into v_dests
  from jsonb_array_elements_text(case jsonb_typeof(payload -> 'destinations')
                                   when 'array' then payload -> 'destinations' else '[]' end) as x;
  select count(*) into v_owned from destinations d where d.id = any (v_dests) and d.user_id = v_user;
  if v_owned <> cardinality(v_dests) then
    raise exception 'Destination not found.';
  end if;

  if payload ? 'rules' and jsonb_typeof(payload -> 'rules') <> 'null' then
    v_rules := public.normalize_subscription_rules(payload -> 'rules', v_user, true);
    select coalesce(array_agg(distinct v::uuid), '{}') into v_groups
    from jsonb_array_elements(v_rules) as g
    cross join lateral jsonb_array_elements(g) as r
    cross join lateral jsonb_array_elements_text(r -> 'values') as v
    where r ->> 'field' = 'group';
    -- Held until commit, so a group can't be deleted between this check and the save.
    select count(*) into v_owned
    from (select 1 from callsign_groups g where g.id = any (v_groups) and g.user_id = v_user for key share of g) t;
    if v_owned <> cardinality(v_groups) then
      raise exception 'Group not found.';
    end if;
  end if;

  if v_id is null then
    insert into subscriptions (user_id, name, enabled, sources, rules, quiet_minutes, group_ids)
    values (
      v_user, v_name,
      coalesce((payload ->> 'enabled')::boolean, true),
      v_sources,
      coalesce(v_rules, '[]'::jsonb),
      coalesce(v_quiet::numeric::int, 10),
      coalesce(v_groups, '{}')
    )
    returning id into v_id;
  else
    update subscriptions s
    set name          = v_name,
        enabled       = coalesce((payload ->> 'enabled')::boolean, s.enabled),
        sources       = v_sources,
        rules         = coalesce(v_rules, s.rules),
        quiet_minutes = coalesce(v_quiet::numeric::int, s.quiet_minutes),
        group_ids     = coalesce(v_groups, s.group_ids)
    where s.id = v_id and s.user_id = v_user;
    if not found then
      raise exception 'Connection not found.';
    end if;
    delete from subscription_destinations sd where sd.subscription_id = v_id;
  end if;

  insert into subscription_destinations (subscription_id, destination_id)
  select v_id, d from unnest(v_dests) as d;

  return v_id;
end;
$$;

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
  perform set_config('longlines.via_api', 'on', true);

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
      -- PATCH takes no type, but a destination read back whole and sent again has one; a
      -- different type is refused rather than ignored.
      if p_args ? 'type' and jsonb_typeof(p_args -> 'type') <> 'null' and not exists (
           select 1 from destinations d
           where d.id = v_id and d.user_id = v_user and d.type = p_args ->> 'type') then
        if not exists (select 1 from destinations d where d.id = v_id and d.user_id = v_user) then
          raise exception 'Destination not found.';
        end if;
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
        raise exception 'Connection not found.';
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
      select public.api_group_json(to_jsonb(g)) into v_result from public.list_callsign_groups() g where g.id = v_id;
      if v_result is null then
        raise exception 'Group not found.';
      end if;
    when 'create_group' then
      v_id := public.save_callsign_group(p_args - 'id');
      select public.api_group_json(to_jsonb(g)) into v_result from public.list_callsign_groups() g where g.id = v_id;
    when 'update_group' then
      perform public.patch_callsign_group(v_id, p_args - 'id');
      select public.api_group_json(to_jsonb(g)) into v_result from public.list_callsign_groups() g where g.id = v_id;
    when 'delete_group' then
      perform public.delete_callsign_group(v_id);
      v_result := jsonb_build_object('deleted', true);
    when 'add_group_members' then
      perform public.edit_group_callsigns(v_id, p_args -> 'callsigns', null);
      select public.api_group_json(to_jsonb(g)) into v_result from public.list_callsign_groups() g where g.id = v_id;
    when 'remove_group_members' then
      perform public.edit_group_callsigns(v_id, null, p_args -> 'callsigns');
      select public.api_group_json(to_jsonb(g)) into v_result from public.list_callsign_groups() g where g.id = v_id;
  end case;

  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('longlines.via_api', coalesce(v_via, ''), true);
  return v_result;
end;
$$;

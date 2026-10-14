-- quiet_minutes is checked here, with a message that names the allowed values.
--
-- It used to be cast with ::int and left to the check constraint, so through the
-- management API {"quiet_minutes": 7} came back as 'new row for relation
-- "subscriptions" violates check constraint "subscriptions_quiet_minutes_check"',
-- and 7.5 or 3000000000 as a cast error. The api function now only checks that
-- the value is a JSON number; this is the one place that knows which numbers are
-- allowed, for the web app and the API alike.
--
-- Otherwise the same as 20261013000100. Same signature, so the grants carry over.

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
  v_groups uuid[];
  v_owned  int;
  v_quiet  text := payload ->> 'quiet_minutes';
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  if v_name = '' then
    raise exception 'Give the subscription a name.';
  end if;
  -- Compared as numeric, so 7.5 and 3000000000 get this message rather than a cast error and the
  -- check constraint's name never reaches an API client. The CASE keeps the cast off text that is
  -- not a number, and the capped exponent keeps it from overflowing numeric.
  if v_quiet is not null and not coalesce(
       case when v_quiet ~ '^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]{1,3})?$'
            then v_quiet::numeric in (0, 5, 10, 30, 60) end, false) then
    raise exception 'quiet_minutes must be 0, 5, 10, 30 or 60.';
  end if;

  select coalesce(array_agg(distinct x::uuid), '{}') into v_dests
  from jsonb_array_elements_text(coalesce(payload -> 'destinations', '[]'::jsonb)) as x;
  if cardinality(v_dests) = 0 then
    raise exception 'Pick at least one destination.';
  end if;
  select count(*) into v_owned from destinations d where d.id = any (v_dests) and d.user_id = v_user;
  if v_owned <> cardinality(v_dests) then
    raise exception 'Destination not found.';
  end if;

  if payload ? 'group_ids' then
    select coalesce(array_agg(distinct x::uuid), '{}') into v_groups
    from jsonb_array_elements_text(payload -> 'group_ids') as x;
    select count(*) into v_owned
    from (select 1 from callsign_groups g where g.id = any (v_groups) and g.user_id = v_user for key share of g) t;
    if v_owned <> cardinality(v_groups) then
      raise exception 'Group not found.';
    end if;
  end if;

  if v_id is null then
    insert into subscriptions (user_id, name, enabled, sources, bands, modes, callsigns, reference, quiet_minutes, group_ids)
    values (
      v_user, v_name,
      coalesce((payload ->> 'enabled')::boolean, true),
      public.jsonb_text_array(payload -> 'sources', 'lower'),
      public.jsonb_text_array(payload -> 'bands', 'none'),
      public.jsonb_text_array(payload -> 'modes', 'lower'),
      public.jsonb_text_array(payload -> 'callsigns', 'upper'),
      trim(coalesce(payload ->> 'reference', '')),
      coalesce(v_quiet::numeric::int, 10),
      coalesce(v_groups, '{}')
    )
    returning id into v_id;
  else
    update subscriptions s
    set name          = v_name,
        enabled       = coalesce((payload ->> 'enabled')::boolean, s.enabled),
        sources       = public.jsonb_text_array(payload -> 'sources', 'lower'),
        bands         = public.jsonb_text_array(payload -> 'bands', 'none'),
        modes         = public.jsonb_text_array(payload -> 'modes', 'lower'),
        callsigns     = public.jsonb_text_array(payload -> 'callsigns', 'upper'),
        reference     = trim(coalesce(payload ->> 'reference', '')),
        quiet_minutes = coalesce(v_quiet::numeric::int, s.quiet_minutes),
        group_ids     = coalesce(v_groups, s.group_ids)
    where s.id = v_id and s.user_id = v_user;
    if not found then
      raise exception 'Subscription not found.';
    end if;
    delete from subscription_destinations sd where sd.subscription_id = v_id;
  end if;

  insert into subscription_destinations (subscription_id, destination_id)
  select v_id, d from unnest(v_dests) as d;

  return v_id;
end;
$$;

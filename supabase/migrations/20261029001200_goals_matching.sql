-- Goals, part 2: the goal rule and the preview.
-- Design: docs/superpowers/specs/2026-10-29-goals-design.md (the schema and the marking are
-- 20261029001100).
--
-- A connection names a goal in its rules: {field: 'goal', op: 'is', values: [id]}, one
-- list of the owner's. It combines with the other rules like any rule.
--
-- 1. normalize_subscription_rules: as in 20261029000200, with the goal field (op is only,
--    exactly one list, the caller's own: strict raises "Goal not found.", the preview keeps
--    the owned one).
-- 2. spot_us_states and goal_matches. A spot passes the rule when the list is missing,
--    complete or ended (the rule is off, so the connection alerts for everything its other rules
--    allow), or when some requirement that is not complete has a needed entry the spot matches:
--    its band, its POTA park, or its US state (a POTA spot's by goal_park_state over its
--    location and the spotted base call's license state, as marking gives a contact with one
--    park; the license state alone only for a spot without a POTA reference). How a list
--    is marked (relay or by hand) has no effect on matching. A goal names no stations, so
--    rules_name_stations, watched_among and the RBN guard are unchanged.
-- 3. rule_matches: as in 20261027001200, with the goal field.
-- 4. save_subscription: as in 20261021000500, taking a key-share lock on the lists its rules name,
--    as it does on groups, so delete_goal (for update, then the connections check) can't
--    pass between the check and the save.
-- 5. preview_subscription: as in 20261028000300 (20261029000800 did not change it), with one more
--    column, skipped_worked: how many of the recent spots that pass every other rule the goal rule kept out because of work already done (goal_skips_worked), never a spot the
--    list does not chase; null when the rules name no list. A new return type, so it is dropped,
--    recreated and granted again.

-- ---------------------------------------------------------------------------
-- 1. Validating the rule
-- ---------------------------------------------------------------------------

-- normalize_subscription_rules: as in 20261029000200, with the goal field.
create or replace function public.normalize_subscription_rules(p_rules jsonb, p_user uuid, p_strict boolean)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_out    jsonb := '[]'::jsonb;
  v_group  jsonb;
  v_conds  jsonb;
  v_rule   jsonb;
  v_field  text;
  v_op     text;
  v_values jsonb;
  v_text   text;
  v_ids    text[];
  v_owned  text[];
  v_count  int := 0;
  v_total  int := 0;
  v_rule_name text;
begin
  if p_rules is null or jsonb_typeof(p_rules) = 'null' then
    return '[]'::jsonb;
  end if;
  if jsonb_typeof(p_rules) <> 'array' then
    raise exception 'rules must be a list of rule lists.';
  end if;

  for v_group in select x from jsonb_array_elements(p_rules) as x loop
    if jsonb_typeof(v_group) <> 'array' then
      raise exception 'rules must be a list of rule lists.';
    end if;
    if jsonb_array_length(v_group) = 0 then
      raise exception 'Each list in rules needs at least one rule.';
    end if;
    v_conds := '[]'::jsonb;

    for v_rule in select x from jsonb_array_elements(v_group) as x loop
      v_count := v_count + 1;
      if v_count > 50 then
        raise exception 'A connection can have at most 50 rules.';
      end if;
      if jsonb_typeof(v_rule) <> 'object' then
        raise exception 'Each rule needs a field, an op and values.';
      end if;
      v_field := v_rule ->> 'field';
      v_op := v_rule ->> 'op';
      v_values := v_rule -> 'values';

      if v_field is null or v_field not in ('callsign', 'group', 'band', 'mode', 'reference', 'frequency', 'island', 'goal') then
        raise exception 'Unknown rule field: %.', coalesce(v_field, 'none');
      end if;
      -- The subject of the messages below: "A band rule", but "An IOTA island rule" and "A goal rule".
      v_rule_name := case v_field when 'island' then 'An IOTA island' when 'goal' then 'A goal'
                                  else 'A ' || v_field end;
      if not coalesce(case v_field
           when 'reference' then v_op in ('is', 'is_not', 'contains', 'not_contains')
           when 'frequency' then v_op in ('is', 'is_not', 'gt', 'lt')
           when 'goal' then v_op = 'is'
           else v_op in ('is', 'is_not') end, false) then
        raise exception '% rule can''t use %.', v_rule_name, coalesce(v_op, 'no op');
      end if;
      if jsonb_typeof(v_values) is distinct from 'array' then
        raise exception '% rule''s values must be a list.', v_rule_name;
      end if;
      if jsonb_array_length(v_values) > 1000 then
        raise exception 'A rule can have at most 1,000 values.';
      end if;

      if v_field = 'frequency' then
        v_text := trim(v_values ->> 0);
        if jsonb_array_length(v_values) <> 1 or v_text is null
           or v_text !~ '^[0-9]{1,7}(\.[0-9]{1,3})?$' or v_text::numeric <= 0 then
          raise exception 'A frequency rule takes one number in kHz.';
        end if;
        v_values := jsonb_build_array(v_text::numeric);
      elsif v_field = 'group' then
        v_ids := public.jsonb_text_array(v_values, 'lower');
        if cardinality(v_ids) = 0 then
          raise exception 'Give the group rule a value.';
        end if;
        select coalesce(array_agg(g.id::text order by g.id::text), '{}') into v_owned
        from public.callsign_groups g
        where g.user_id = p_user and g.id::text = any (v_ids);
        if p_strict and cardinality(v_owned) <> cardinality(v_ids) then
          raise exception 'Group not found.';
        end if;
        v_values := to_jsonb(v_owned);
      elsif v_field = 'goal' then
        -- One list, the caller's own. Strict (a save) refuses any other; the preview keeps the
        -- owned one, so another account's id becomes an empty rule, which passes every spot like
        -- a missing list.
        v_ids := public.jsonb_text_array(v_values, 'lower');
        if cardinality(v_ids) <> 1 then
          raise exception 'A goal rule takes one goal.';
        end if;
        select coalesce(array_agg(l.id::text), '{}') into v_owned
        from public.goals l
        where l.user_id = p_user and l.id::text = any (v_ids);
        if p_strict and cardinality(v_owned) <> 1 then
          raise exception 'Goal not found.';
        end if;
        v_values := to_jsonb(v_owned);
      else
        v_values := to_jsonb(public.jsonb_text_array(v_values,
          case v_field when 'callsign' then 'upper' when 'island' then 'upper' when 'mode' then 'lower'
                       when 'band' then 'lower'
                       when 'reference' then case when v_op in ('is', 'is_not') then 'upper' else 'none' end
                       else 'none' end));
        if jsonb_array_length(v_values) = 0 then
          raise exception 'Give the % rule a value.', case v_field when 'island' then 'IOTA island' else v_field end;
        end if;
        if v_field = 'island' and exists (
             select 1 from jsonb_array_elements_text(v_values) as v
             where v !~ '^(AF|AN|AS|EU|NA|OC|SA)(-[0-9]{3})?$') then
          raise exception 'An IOTA island rule takes references such as EU-005 or continents such as EU.';
        end if;
        if v_field = 'reference' and v_op in ('is', 'is_not') and exists (
             select 1 from jsonb_array_elements_text(v_values) as v where length(v) > 64) then
          raise exception 'A reference can be at most 64 characters.';
        end if;
        -- reference_profile's shape: a comma-joined list ("US-1000, US-1001") would never equal
        -- a spot's reference, so is would never pass and is_not would exclude nothing.
        if v_field = 'reference' and v_op in ('is', 'is_not') and exists (
             select 1 from jsonb_array_elements_text(v_values) as v where v !~ '^[A-Z0-9/-]+$') then
          raise exception 'A reference takes letters, digits, / and -, such as US-2763 or W4C/CM-001.';
        end if;
      end if;

      -- Counted after normalising, so duplicates the rule drops do not count.
      v_total := v_total + jsonb_array_length(v_values);
      if v_total > 5000 then
        raise exception 'A connection can have up to 5,000 values across its rules.';
      end if;

      v_conds := v_conds || jsonb_build_array(jsonb_build_object('field', v_field, 'op', v_op, 'values', v_values));
    end loop;

    v_out := v_out || jsonb_build_array(v_conds);
  end loop;

  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Matching a spot against a list
-- ---------------------------------------------------------------------------

-- The US state a spot is in, as zero or one us_states() code. A spot with a POTA reference is
-- where its park is, by marking's rule for a contact with one park (goal_park_state over its
-- pota_location and the FCC license state of the spotted base call): a park in one US state gives
-- that state; a park on a state line gives the license state only when it is one of the park's,
-- else none; a park outside the US, or a spot without a location, gives none. Only a spot without
-- a POTA reference takes the license state alone. So a connection alerts only for a state that
-- working the station could mark. DC and territories never match.
create function public.spot_us_states(spot raw_spots)
returns text[]
language sql
stable
set search_path = ''
as $$
  select coalesce(array_remove(array[
           case when spot.pota_reference is not null
                then public.goal_park_state(spot.pota_location, lic.state)
                else lic.state end], null),
         '{}'::text[])
  from (select (select l.state
                from public.callsign_licenses l
                where l.callsign = spot.base_callsign and l.country = 'US' and l.state = any (public.us_states()))
               as state) lic
$$;

revoke all on function public.spot_us_states(raw_spots) from public;

-- The goal entries a spot could work, as (kind, value): its band, its upper-cased POTA park
-- and its US states (spot_us_states). The one statement of what a spot hits, for
-- goal_matches and goal_skips_worked.
create function public.goal_spot_values(spot raw_spots)
returns table (kind text, value text)
language sql
stable
set search_path = ''
as $$
  select c.kind, c.value
  from (select 'band' as kind, spot.band as value
        union all
        select 'park', upper(spot.pota_reference)
        union all
        select 'state', s from unnest(public.spot_us_states(spot)) as s) c
  where c.value is not null
$$;

revoke all on function public.goal_spot_values(raw_spots) from public;

-- Whether a spot passes a goal rule naming p_list_id. True when the list is missing,
-- complete or ended. Otherwise true when an entry the spot matches is still needed in a
-- requirement that is not complete: under "at least", once at_least entries are worked the rest
-- stop passing too. The spot's (kind, value) pairs probe goal_entries' primary key, so a list of
-- 500 parks costs one lookup per requirement. Invoker: its callers (match_pending_spots,
-- preview_subscription) are definer functions.
create function public.goal_matches(p_list_id uuid, spot raw_spots)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((
    select public.goal_status(l) <> 'active'
        or exists (
             select 1
             from public.goal_spot_values(spot) c
             join public.goal_requirements r on r.list_id = l.id and r.kind = c.kind
             join public.goal_entries e on e.requirement_id = r.id and e.value = c.value
             where e.worked_at is null
               and not public.goal_requirement_complete(r.id))
    from public.goals l
    where l.id = p_list_id), true)
$$;

revoke all on function public.goal_matches(uuid, raw_spots) from public;

-- Whether a goal rule naming p_list_id rejects a spot only because of work already done: the
-- list is active, the spot matches no still-needed entry of an incomplete requirement (so
-- goal_matches is false), but it matches an entry that is worked or sits in a complete
-- requirement. False for a spot the list never chased (a band, park or state not on it), so the
-- preview's skipped_worked counts only what "You've already worked those." says.
create function public.goal_skips_worked(p_list_id uuid, spot raw_spots)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((
    select public.goal_status(l) = 'active'
       and not public.goal_matches(l.id, spot)
       and exists (
             select 1
             from public.goal_spot_values(spot) c
             join public.goal_requirements r on r.list_id = l.id and r.kind = c.kind
             join public.goal_entries e on e.requirement_id = r.id and e.value = c.value
             where e.worked_at is not null
                or public.goal_requirement_complete(r.id))
    from public.goals l
    where l.id = p_list_id), false)
$$;

revoke all on function public.goal_skips_worked(uuid, raw_spots) from public;

-- ---------------------------------------------------------------------------
-- 3. rule_matches
-- ---------------------------------------------------------------------------

-- rule_matches: as in 20261027001200, with the goal field (op is only, so the is_not arm
-- never applies to it).
create or replace function public.rule_matches(p_rule jsonb, spot raw_spots)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case when p_rule ->> 'op' in ('is_not', 'not_contains') then not coalesce(h.hit, false)
              else coalesce(h.hit, false) end
  from (
    select case p_rule ->> 'field'
      when 'callsign' then public.callsign_matches(
        array(select jsonb_array_elements_text(p_rule -> 'values')), spot.callsign, spot.base_callsign)
      when 'group' then public.group_matches(
        array(select x::uuid from jsonb_array_elements_text(p_rule -> 'values') as x), spot.base_callsign)
      when 'band' then spot.band in (select jsonb_array_elements_text(p_rule -> 'values'))
      when 'mode' then spot.mode in (select jsonb_array_elements_text(p_rule -> 'values'))
                    or spot.mode_family in (select jsonb_array_elements_text(p_rule -> 'values'))
      when 'reference' then case when p_rule ->> 'op' in ('is', 'is_not') then exists (
          select 1 from jsonb_array_elements_text(p_rule -> 'values') as v
          where v in (upper(spot.pota_reference), upper(spot.sota_summit_ref), upper(spot.wwff_reference),
                      upper(spot.iota_reference))
             or exists (select 1 from unnest(spot.wwbota_references) as b where upper(b) = v))
        else exists (
          select 1 from jsonb_array_elements_text(p_rule -> 'values') as v
          where position(lower(v) in
            lower(concat_ws(',', spot.pota_reference, spot.pota_location, spot.sota_summit_ref,
                            spot.wwff_reference, array_to_string(spot.wwbota_references, ','),
                            spot.iota_reference))) > 0) end
      when 'island' then spot.iota_reference is not null and exists (
        select 1 from jsonb_array_elements_text(p_rule -> 'values') as v
        where spot.iota_reference = v or (length(v) = 2 and left(spot.iota_reference, 3) = v || '-'))
      when 'frequency' then case p_rule ->> 'op'
        when 'gt' then spot.frequency_khz > (p_rule -> 'values' ->> 0)::numeric
        when 'lt' then spot.frequency_khz < (p_rule -> 'values' ->> 0)::numeric
        else spot.frequency_khz = (p_rule -> 'values' ->> 0)::numeric end
      when 'goal' then public.goal_matches((p_rule -> 'values' ->> 0)::uuid, spot)
    end as hit
  ) h;
$$;

-- ---------------------------------------------------------------------------
-- 4. save_subscription
-- ---------------------------------------------------------------------------

-- save_subscription: as in 20261021000500, locking the goals the rules name. Same
-- signature, so the grants carry over.
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
  v_lists  uuid[];
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
    -- The same for goals: delete_goal takes the row for update before it looks for
    -- connections that name it.
    v_lists := public.rules_goal_ids(v_rules);
    select count(*) into v_owned
    from (select 1 from goals l where l.id = any (v_lists) and l.user_id = v_user for key share of l) t;
    if v_owned <> cardinality(v_lists) then
      raise exception 'Goal not found.';
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

-- ---------------------------------------------------------------------------
-- 5. preview_subscription
-- ---------------------------------------------------------------------------

-- preview_subscription: as in 20261028000300, with skipped_worked. The precedent for a new return
-- type is 20261013000330: drop, recreate, grant again.
drop function public.preview_subscription(jsonb);

create function public.preview_subscription(filter jsonb)
returns table (count bigint, spots jsonb, station_count bigint, window_size bigint, skipped_worked int)
language sql
stable
security definer
set search_path = public
as $$
  with sub as (
    select jsonb_populate_record(null::subscriptions, jsonb_build_object(
      'id', gen_random_uuid(), 'user_id', auth.uid(), 'name', '', 'enabled', true,
      'sources', to_jsonb(public.normalize_subscription_sources(filter -> 'sources')),
      'rules', public.normalize_subscription_rules(filter -> 'rules', auth.uid(), false),
      'quiet_minutes', 0, 'created_at', now(), 'updated_at', now(), 'group_ids', '[]'::jsonb
    )) as s
  ),
  positive as (
    select r ->> 'field' as field, v.value
    from sub
    cross join lateral jsonb_array_elements((sub.s).rules) as g
    cross join lateral jsonb_array_elements(g) as r
    cross join lateral jsonb_array_elements_text(r -> 'values') as v(value)
    where r ->> 'op' = 'is' and r ->> 'field' in ('callsign', 'group')
  ),
  stations as (
    select count(distinct t.b) as n
    from (
      select public.base_callsign(p.value) as b from positive p where p.field = 'callsign'
      union all
      select m.callsign
      from positive p
      join callsign_group_members m on m.group_id::text = p.value
      where p.field = 'group'
    ) t
  ),
  recent as (
    select r.* from raw_spots r, sub
    where r.spot_time > now() - interval '24 hours'
      and r.retracted_at is null
      and public.source_matches((sub.s).sources, r.source)
    order by r.spot_time desc
    limit 200
  ),
  matched as (
    select r.* from recent r, sub where public.spot_matches(sub.s, r)
  ),
  -- Each group of the connection with its goal rules taken out (a group left empty passes,
  -- as [[]] does) as a one-group connection, beside the goal rules it held; only when the
  -- rules name a list.
  unlisted as (
    select jsonb_populate_record(sub.s, jsonb_build_object('rules', jsonb_build_array(coalesce((
             select jsonb_agg(r order by rn)
             from jsonb_array_elements(g) with ordinality as x(r, rn)
             where r ->> 'field' <> 'goal'), '[]'::jsonb)))) as s,
           coalesce((select jsonb_agg(r) from jsonb_array_elements(g) as r where r ->> 'field' = 'goal'),
                    '[]'::jsonb) as lists
    from sub
    cross join lateral jsonb_array_elements((sub.s).rules) as g
    where cardinality(public.rules_goal_ids((sub.s).rules)) > 0
  )
  select
    (select count(*) from matched),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'spot_time', m.spot_time, 'callsign', m.callsign, 'spotter', m.spotter,
        'frequency_khz', m.frequency_khz, 'band', m.band, 'mode', m.mode, 'mode_family', m.mode_family,
        'comment', m.comment,
        'pota_reference', m.pota_reference, 'pota_park_name', m.pota_park_name,
        'pota_location', m.pota_location, 'sota_summit_ref', m.sota_summit_ref,
        'wwff_reference', m.wwff_reference, 'wwff_reference_name', m.wwff_reference_name,
        'wwbota_references', m.wwbota_references, 'wwbota_reference_name', m.wwbota_reference_name,
        'iota_reference', m.iota_reference, 'iota_reference_name', m.iota_reference_name,
        'source', m.source
      ) order by m.spot_time desc)
      from matched m
    ), '[]'::jsonb),
    (select n from stations),
    (select count(*) from recent),
    -- The spots skipped only for work already done: not matched, but in some group whose other
    -- rules pass, every goal rule that rejects the spot rejects it by
    -- goal_skips_worked. Null when the rules name no list.
    case when exists (select 1 from unlisted) then (
      select count(*)::int
      from recent r
      where not exists (select 1 from matched m where m.id = r.id)
        and exists (
              select 1 from unlisted u
              where public.spot_matches(u.s, r)
                and not exists (
                      select 1 from jsonb_array_elements(u.lists) as n
                      where not public.rule_matches(n, r)
                        and not public.goal_skips_worked((n -> 'values' ->> 0)::uuid, r)))) end
  where auth.uid() is not null;
$$;

revoke all on function public.preview_subscription(jsonb) from public;
grant execute on function public.preview_subscription(jsonb) to authenticated;

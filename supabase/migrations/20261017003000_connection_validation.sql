-- Connection validation (code review, 2026-10-17).
--
-- 1. Sources: save_subscription and preview_subscription refuse a source that is not one of
--    raw_spots' sources a connection can follow (raw_spots_source_check, 20261015001000), through
--    one helper, normalize_subscription_sources. Before this, "sota" saved and matched nothing.
--    Rows already holding an unknown source are left as they are and keep matching as before; a
--    later save of such a row (including an API PATCH) asks for a known source.
-- 2. Band values are stored lowercase, as spots store them ("20m"); "20M" matched nothing.
--    Stored rules are lowercased below, so they match what their owners typed.
-- 3. A rule takes at most 1,000 values, the callsign group cap.
-- 4. preview_subscription's recent window uses source_matches, so with no sources listed it leaves
--    out DX Cluster and WWFF spots exactly as the matcher does.
--
-- normalize_subscription_rules and save_subscription are 20261016000500's, preview_subscription
-- 20261015001000's, with only those changes. Same signatures, so the grants carry over.

create function public.normalize_subscription_sources(p_sources jsonb)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_out     text[];
  v_unknown text;
begin
  if p_sources is null or jsonb_typeof(p_sources) = 'null' then
    return '{}'::text[];
  end if;
  if jsonb_typeof(p_sources) <> 'array' then
    raise exception 'sources must be a list.';
  end if;
  v_out := public.jsonb_text_array(p_sources, 'lower');
  -- raw_spots_source_check without aprs, which never reaches matching.
  select s into v_unknown
  from unnest(v_out) as s
  where s not in ('pota', 'sotawatch', 'wwff', 'rbn', 'dxcluster')
  order by s
  limit 1;
  if v_unknown is not null then
    raise exception 'Unknown source: %.', v_unknown;
  end if;
  return v_out;
end;
$$;

revoke all on function public.normalize_subscription_sources(jsonb) from public;

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

      if v_field is null or v_field not in ('callsign', 'group', 'band', 'mode', 'reference', 'frequency') then
        raise exception 'Unknown rule field: %.', coalesce(v_field, 'none');
      end if;
      if not coalesce(case v_field
           when 'reference' then v_op in ('contains', 'not_contains')
           when 'frequency' then v_op in ('is', 'is_not', 'gt', 'lt')
           else v_op in ('is', 'is_not') end, false) then
        raise exception 'A % rule can''t use %.', v_field, coalesce(v_op, 'no op');
      end if;
      if jsonb_typeof(v_values) is distinct from 'array' then
        raise exception 'A % rule''s values must be a list.', v_field;
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
      else
        v_values := to_jsonb(public.jsonb_text_array(v_values,
          case v_field when 'callsign' then 'upper' when 'mode' then 'lower' when 'band' then 'lower' else 'none' end));
        if jsonb_array_length(v_values) = 0 then
          raise exception 'Give the % rule a value.', v_field;
        end if;
      end if;

      v_conds := v_conds || jsonb_build_array(jsonb_build_object('field', v_field, 'op', v_op, 'values', v_values));
    end loop;

    v_out := v_out || jsonb_build_array(v_conds);
  end loop;

  return v_out;
end;
$$;

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
  -- Compared as numeric, so 7.5 and 3000000000 get this message rather than a cast error and the
  -- check constraint's name never reaches an API client. The CASE keeps the cast off text that is
  -- not a number, and the capped exponent keeps it from overflowing numeric.
  if v_quiet is not null and not coalesce(
       case when v_quiet ~ '^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]{1,3})?$'
            then v_quiet::numeric in (0, 5, 10, 30, 60) end, false) then
    raise exception 'quiet_minutes must be 0, 5, 10, 30 or 60.';
  end if;

  v_sources := public.normalize_subscription_sources(payload -> 'sources');

  select coalesce(array_agg(distinct x::uuid), '{}') into v_dests
  from jsonb_array_elements_text(coalesce(payload -> 'destinations', '[]'::jsonb)) as x;
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

-- preview_subscription: as in 20261015001000, with sources through
-- normalize_subscription_sources and the recent window through source_matches.
create or replace function public.preview_subscription(filter jsonb)
returns table (count bigint, spots jsonb, station_count bigint, window_size bigint)
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
      and public.source_matches((sub.s).sources, r.source)
    order by r.spot_time desc
    limit 200
  ),
  matched as (
    select r.* from recent r, sub where public.spot_matches(sub.s, r)
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
        'source', m.source
      ) order by m.spot_time desc)
      from matched m
    ), '[]'::jsonb),
    (select n from stations),
    (select count(*) from recent)
  where auth.uid() is not null;
$$;

-- Stored band values to lowercase. Only rows with an uppercase band value change.
update subscriptions s
set rules = (
  select coalesce(jsonb_agg((
    select coalesce(jsonb_agg(case when r ->> 'field' = 'band'
                                   then jsonb_set(r, '{values}', to_jsonb(public.jsonb_text_array(r -> 'values', 'lower')))
                                   else r end order by ri), '[]'::jsonb)
    from jsonb_array_elements(g) with ordinality as x(r, ri)
  ) order by gi), '[]'::jsonb)
  from jsonb_array_elements(s.rules) with ordinality as y(g, gi)
)
where exists (
  select 1
  from jsonb_array_elements(s.rules) as g
  cross join lateral jsonb_array_elements(g) as r
  cross join lateral jsonb_array_elements_text(r -> 'values') as v
  where r ->> 'field' = 'band' and v <> lower(v)
);

-- Subscription rules: a condition per rule and And/Or between rules.
--
-- A subscription's filter was one column per field (bands, modes, callsigns,
-- reference, group_ids), ANDed together, each matching "is one of" (or
-- "contains"). It is now `rules`: a list of AND groups, ORed together, in
-- disjunctive normal form. The builder shows them as one list of rows where
-- each row after the first says And or Or, and And binds tighter:
-- "A and B or C" is stored as [[A, B], [C]].
--
-- Each rule is {"field", "op", "values"}:
--
--   callsign   is | is_not            values: calls (exact or by base call)
--   group      is | is_not            values: callsign group ids (members)
--   band       is | is_not            values: bands
--   mode       is | is_not            values: modes or mode families
--   reference  contains | not_contains values: text in the POTA reference,
--                                      location or SOTA summit code
--   frequency  is | is_not | gt | lt  values: one number, in kHz
--
-- "is" passes a spot that has any of the values, "is_not" one that has none
-- of them, so a spot with no band passes "band is_not 20m". `rules = []` has
-- no conditions and passes every spot, as all-empty columns did.
--
-- The source stays its own column: it is the builder's first step, not a rule.
-- The RBN guard moves into each AND group: an RBN spot passes a group only if
-- the group has a positive callsign or group rule, so "callsign is K1ABC or
-- mode is CW" passes K1ABC on RBN but not every CW spot.
--
-- group_ids stays, now derived: every group the rules name, written only by
-- save_subscription. delete_callsign_group and list_callsign_groups read it
-- unchanged, so a group a rule names (in either sense) cannot be deleted.

alter table subscriptions add column rules jsonb not null default '[]'::jsonb;

comment on column subscriptions.rules is
  'AND groups, ORed. Written only by save_subscription through normalize_subscription_rules.';
comment on column subscriptions.group_ids is
  'Every group the rules name. Derived from rules by save_subscription.';

-- ---------------------------------------------------------------------------
-- 1. Existing filters become rules
-- ---------------------------------------------------------------------------

-- Bands, modes and the reference become one AND group. Callsigns and groups
-- were one filter (typed calls OR group members), so a subscription with both
-- becomes two AND groups that differ only in that rule.
update subscriptions s
set rules = (
  with base as (
    select coalesce(jsonb_agg(c order by n), '[]'::jsonb) as conds
    from (values
      (1, case when cardinality(s.bands) > 0
               then jsonb_build_object('field', 'band', 'op', 'is', 'values', to_jsonb(s.bands)) end),
      (2, case when cardinality(s.modes) > 0
               then jsonb_build_object('field', 'mode', 'op', 'is', 'values', to_jsonb(s.modes)) end),
      (3, case when s.reference <> ''
               then jsonb_build_object('field', 'reference', 'op', 'contains', 'values', jsonb_build_array(s.reference)) end)
    ) v(n, c)
    where c is not null
  )
  select coalesce(jsonb_agg(g.conds order by g.n), '[]'::jsonb)
  from (
    select 1 as n, jsonb_build_array(jsonb_build_object('field', 'callsign', 'op', 'is', 'values', to_jsonb(s.callsigns)))
                   || b.conds as conds
    from base b where cardinality(s.callsigns) > 0
    union all
    select 2, jsonb_build_array(jsonb_build_object('field', 'group', 'op', 'is', 'values', to_jsonb(s.group_ids::text[])))
              || b.conds
    from base b where cardinality(s.group_ids) > 0
    union all
    select 3, b.conds
    from base b
    where cardinality(s.callsigns) = 0 and cardinality(s.group_ids) = 0 and jsonb_array_length(b.conds) > 0
  ) g
);

-- ---------------------------------------------------------------------------
-- 2. Normalizing rules
-- ---------------------------------------------------------------------------

-- The one place that knows the rule shape: checks it, normalizes values as the
-- columns were (calls upper, modes lower, group ids lower, frequency a number)
-- and returns the stored form. p_strict (save) raises on a group that isn't the
-- user's; otherwise (preview) such ids are dropped, so preview cannot probe
-- another user's groups, and a group rule may end up with no values: "group is"
-- then passes nothing and "group is_not" everything, as group_matches reads it.
-- Stable and unlocked: save_subscription locks the groups it keeps.
create function public.normalize_subscription_rules(p_rules jsonb, p_user uuid, p_strict boolean)
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
        raise exception 'A subscription can have at most 50 rules.';
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
          case v_field when 'callsign' then 'upper' when 'mode' then 'lower' else 'none' end));
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

-- Does every AND group name stations (a positive callsign or group rule)?
-- False for no rules. The RBN guard, as the trigger and the web state it.
create function public.rules_name_stations(p_rules jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_array_length(p_rules) > 0
     and not exists (
       select 1 from jsonb_array_elements(p_rules) as g
       where not exists (
         select 1 from jsonb_array_elements(g) as c
         where c ->> 'field' in ('callsign', 'group') and c ->> 'op' = 'is'));
$$;

-- ---------------------------------------------------------------------------
-- 3. Matching
-- ---------------------------------------------------------------------------

-- One rule against one spot. `hit` is the positive test; the negative ops pass
-- when it doesn't hit, so a spot without the field passes them.
create function public.rule_matches(p_rule jsonb, spot raw_spots)
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
      when 'reference' then exists (
        select 1 from jsonb_array_elements_text(p_rule -> 'values') as v
        where position(lower(v) in
          lower(concat_ws(',', spot.pota_reference, spot.pota_location, spot.sota_summit_ref))) > 0)
      when 'frequency' then case p_rule ->> 'op'
        when 'gt' then spot.frequency_khz > (p_rule -> 'values' ->> 0)::numeric
        when 'lt' then spot.frequency_khz < (p_rule -> 'values' ->> 0)::numeric
        else spot.frequency_khz = (p_rule -> 'values' ->> 0)::numeric end
    end as hit
  ) h;
$$;

-- spot_matches: the source as before, then any AND group whose rules all pass.
-- No rules is one empty group. The RBN guard is per group (see the top).
-- Pinned now: its subqueries keep Postgres from inlining it anyway.
create or replace function public.spot_matches(sub subscriptions, spot raw_spots)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(
        public.source_matches(sub.sources, spot.source)
    and exists (
          select 1
          from jsonb_array_elements(
                 case when jsonb_array_length(sub.rules) = 0 then '[[]]'::jsonb else sub.rules end) as g
          where (spot.source <> 'rbn' or public.rules_name_stations(jsonb_build_array(g)))
            and not exists (
                  select 1 from jsonb_array_elements(g) as c
                  where not public.rule_matches(c, spot))),
    false);
$$;

-- watched_among: the calls in p_callsigns that a positive callsign or group
-- rule of an enabled subscription accepting p_source names. Only those can
-- pass the RBN guard; spot_matches decides the rest. One probe of the member
-- index per distinct base call in the batch, as in 20261013000330.
create or replace function public.watched_among(p_source text, p_callsigns text[])
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  with batch as (
    select distinct c, public.base_callsign(c) as b from unnest(p_callsigns) as c
  ),
  watch as materialized (
    select distinct r ->> 'field' as field, v.value
    from subscriptions s
    cross join lateral jsonb_array_elements(s.rules) as g
    cross join lateral jsonb_array_elements(g) as r
    cross join lateral jsonb_array_elements_text(r -> 'values') as v(value)
    where s.enabled
      and public.source_matches(s.sources, p_source)
      and r ->> 'op' = 'is'
      and r ->> 'field' in ('callsign', 'group')
  ),
  members as materialized (
    select m.callsign, m.group_id
    from callsign_group_members m
    where m.callsign in (select x.b from batch x)
  )
  select x.c
  from batch x
  where x.c in (select w.value from watch w where w.field = 'callsign')
     or x.b in (select w.value from watch w where w.field = 'callsign')
     or x.b in (
          select mm.callsign from members mm
          where mm.group_id::text in (select w.value from watch w where w.field = 'group'))
  order by x.c;
$$;

-- An RBN-only subscription needs stations to watch in every AND group.
create or replace function public.subscriptions_rbn_needs_callsign()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.sources = array['rbn'] and not public.rules_name_stations(new.rules) then
    if jsonb_array_length(new.rules) > 1 then
      raise exception 'RBN reports stations by callsign. Each Or needs its own callsign or group rule.';
    end if;
    raise exception 'RBN reports stations by callsign. Add at least one callsign.';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Saving and previewing
-- ---------------------------------------------------------------------------

-- save_subscription: as in 20261014000300, with rules in place of the filter
-- columns. Rules left out of an update keep their value, so a PUT that forgets
-- them can't widen a subscription to every spot. The old filter keys are
-- refused rather than ignored for the same reason.
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
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  if v_name = '' then
    raise exception 'Give the subscription a name.';
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
      public.jsonb_text_array(payload -> 'sources', 'lower'),
      coalesce(v_rules, '[]'::jsonb),
      coalesce(v_quiet::numeric::int, 10),
      coalesce(v_groups, '{}')
    )
    returning id into v_id;
  else
    update subscriptions s
    set name          = v_name,
        enabled       = coalesce((payload ->> 'enabled')::boolean, s.enabled),
        sources       = public.jsonb_text_array(payload -> 'sources', 'lower'),
        rules         = coalesce(v_rules, s.rules),
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

-- patch_subscription: as in 20261013000340, without the derived group_ids,
-- which save_subscription now refuses.
create or replace function public.patch_subscription(p_id uuid, p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;
  if jsonb_typeof(p_patch) is distinct from 'object' then
    raise exception 'Send the fields to change as a JSON object.';
  end if;
  select to_jsonb(s) - 'user_id' - 'created_at' - 'updated_at' - 'group_ids'
         || jsonb_build_object('destinations', coalesce(
              (select jsonb_agg(sd.destination_id) from subscription_destinations sd
               where sd.subscription_id = s.id), '[]'::jsonb))
  into v_current
  from subscriptions s
  where s.id = p_id and s.user_id = auth.uid()
  for update;
  if v_current is null then
    raise exception 'Subscription not found.';
  end if;
  perform public.save_subscription(v_current || (jsonb_strip_nulls(p_patch) - 'id'));
end;
$$;

-- preview_subscription: as in 20261014000300, with the filter's rules. Only the
-- caller's own groups survive normalization. station_count is the distinct
-- base calls across positive callsign rules and the members of positive group
-- rules. Same return type, so the grants carry over.
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
      'sources', to_jsonb(public.jsonb_text_array(filter -> 'sources', 'lower')),
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
      and (cardinality((sub.s).sources) = 0 or r.source = any ((sub.s).sources))
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
        'pota_location', m.pota_location, 'sota_summit_ref', m.sota_summit_ref, 'source', m.source
      ) order by m.spot_time desc)
      from matched m
    ), '[]'::jsonb),
    (select n from stations),
    (select count(*) from recent)
  where auth.uid() is not null;
$$;

-- ---------------------------------------------------------------------------
-- 5. Management API
-- ---------------------------------------------------------------------------

-- The API shows rules; group_ids is derived from them.
create or replace function public.api_subscription_json(s subscriptions)
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(s) - 'user_id' - 'group_ids'
    || jsonb_build_object('destinations', coalesce(
         (select jsonb_agg(sd.destination_id order by sd.destination_id)
          from subscription_destinations sd where sd.subscription_id = s.id), '[]'::jsonb));
$$;

-- api_call: as in 20261013000300, without add_subscription_callsigns and
-- remove_subscription_callsigns. A subscription has no single callsign list
-- any more; the callsigns are values of rules, changed with PATCH.
create or replace function public.api_call(p_token_id uuid, p_op text, p_args jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub    text := current_setting('request.jwt.claim.sub', true);
  v_claims text := current_setting('request.jwt.claims', true);
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
      perform public.update_destination(v_id, p_args ->> 'name', p_args ->> 'url');
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
        raise exception 'Subscription not found.';
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
      select coalesce(jsonb_agg(to_jsonb(g)), '[]') into v_result
      from public.list_callsign_groups() g;
    when 'get_group' then
      select to_jsonb(g) into v_result from public.list_callsign_groups() g where g.id = v_id;
      if v_result is null then
        raise exception 'Group not found.';
      end if;
    when 'create_group' then
      v_id := public.save_callsign_group(p_args - 'id');
      select to_jsonb(g) into v_result from public.list_callsign_groups() g where g.id = v_id;
    when 'update_group' then
      perform public.patch_callsign_group(v_id, p_args - 'id');
      select to_jsonb(g) into v_result from public.list_callsign_groups() g where g.id = v_id;
    when 'delete_group' then
      perform public.delete_callsign_group(v_id);
      v_result := jsonb_build_object('deleted', true);
    when 'add_group_members' then
      perform public.edit_group_callsigns(v_id, p_args -> 'callsigns', null);
      select to_jsonb(g) into v_result from public.list_callsign_groups() g where g.id = v_id;
    when 'remove_group_members' then
      perform public.edit_group_callsigns(v_id, null, p_args -> 'callsigns');
      select to_jsonb(g) into v_result from public.list_callsign_groups() g where g.id = v_id;
  end case;

  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return v_result;
end;
$$;

drop function public.edit_subscription_callsigns(uuid, jsonb, jsonb);

-- ---------------------------------------------------------------------------
-- 6. The old filter columns go
-- ---------------------------------------------------------------------------

alter table subscriptions
  drop column bands,
  drop column modes,
  drop column callsigns,
  drop column reference;

revoke all on function public.normalize_subscription_rules(jsonb, uuid, boolean) from public;
revoke all on function public.rules_name_stations(jsonb) from public;
revoke all on function public.rule_matches(jsonb, raw_spots) from public;

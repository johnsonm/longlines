-- Per-account caps (review 4, database: connections, finding 2).
--
-- Nothing limited how many connections, destinations or groups an account held, or how many
-- values a connection's rules held in all (50 rules of 1,000 each). The matcher joins every live
-- connection to every spot of a batch and expands each rule's values, so one account could make
-- every run outlast its statement timeout and stop deliveries for everyone.
--
-- 1. account_object_cap(): a before-insert trigger on subscriptions (100 per account),
--    destinations (50) and callsign_groups (50). It counts the owner's rows under a per-user
--    advisory lock, as create_api_token does for its 10 tokens, and raises a plain message (a 400
--    from the API). A trigger rather than a check in each RPC because destinations are created by
--    six of them (create_destination, save_push_destination, save_discord_destination,
--    save_webhook_destination, save_local_cluster_destination, duplicate_destination). Only
--    inserts are refused: an account already over a cap keeps every row and can edit them.
-- 2. normalize_subscription_rules: as in 20261027001200, with at most 5,000 values across all of a
--    connection's rules. save_subscription, patch_subscription and preview_subscription all go
--    through it.

create function public.account_object_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count bigint;
begin
  -- Serializes one user's creates per table, so two at once cannot pass the cap together.
  perform pg_advisory_xact_lock(hashtextextended(tg_table_name || ':' || new.user_id::text, 0));
  if tg_table_name = 'subscriptions' then
    select count(*) into v_count from subscriptions t where t.user_id = new.user_id;
    if v_count >= 100 then
      raise exception 'You can have up to 100 connections.';
    end if;
  elsif tg_table_name = 'destinations' then
    select count(*) into v_count from destinations t where t.user_id = new.user_id;
    if v_count >= 50 then
      raise exception 'You can have up to 50 destinations.';
    end if;
  elsif tg_table_name = 'callsign_groups' then
    select count(*) into v_count from callsign_groups t where t.user_id = new.user_id;
    if v_count >= 50 then
      raise exception 'You can have up to 50 groups.';
    end if;
  else
    raise exception 'account_object_cap has no cap for %.', tg_table_name;
  end if;
  return new;
end;
$$;

revoke all on function public.account_object_cap() from public, anon, authenticated;

create trigger subscriptions_account_cap
before insert on subscriptions
for each row execute function public.account_object_cap();

create trigger destinations_account_cap
before insert on destinations
for each row execute function public.account_object_cap();

create trigger callsign_groups_account_cap
before insert on callsign_groups
for each row execute function public.account_object_cap();

-- normalize_subscription_rules: as in 20261027001200, with at most 5,000 values across the rules.
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

      if v_field is null or v_field not in ('callsign', 'group', 'band', 'mode', 'reference', 'frequency', 'island') then
        raise exception 'Unknown rule field: %.', coalesce(v_field, 'none');
      end if;
      -- The subject of the messages below: "A band rule", but "An IOTA island rule".
      v_rule_name := case v_field when 'island' then 'An IOTA island' else 'A ' || v_field end;
      if not coalesce(case v_field
           when 'reference' then v_op in ('is', 'is_not', 'contains', 'not_contains')
           when 'frequency' then v_op in ('is', 'is_not', 'gt', 'lt')
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


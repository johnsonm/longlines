-- IOTA (Islands on the Air) as a tag on DX Cluster spots.
-- Spec: docs/superpowers/specs/2026-10-27-iota-design.md.
--
-- IOTA has no spot feed. The DX Cluster adapter reads an IOTA reference
-- (EU-005) out of each spot's comment into raw_spots.iota_reference, and
-- ingest_spots names the island group from iota_groups, which the
-- import-iota function loads monthly from iota-world.org. A new rule field,
-- island, matches it; the reference rule searches it too. Profiles and group
-- statistics count it as program IOTA, and the Stats snapshot gains its
-- daily and hourly counts for the catalog's rates.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

-- The IOTA groups, replaced whole by load_iota_groups. Only the reference and
-- its name: positions and the rest of groups.json are not kept.
create table iota_groups (
  refno text primary key check (refno ~ '^(AF|AN|AS|EU|NA|OC|SA)-[0-9]{3}$'),
  name  text not null check (name <> '')
);

create table iota_load (
  id        boolean     primary key default true check (id),
  loaded_at timestamptz not null,
  groups    integer     not null
);

alter table iota_groups enable row level security;
alter table iota_load enable row level security;
revoke all on iota_groups, iota_load from anon, authenticated;

comment on table iota_groups is 'IOTA groups from iota-world.org groups.json; written only by load_iota_groups.';

alter table raw_spots
  add column iota_reference      text,
  add column iota_reference_name text;

comment on column raw_spots.iota_reference is 'IOTA reference (EU-005) read from a dxcluster spot''s comment';
comment on column raw_spots.iota_reference_name is 'The IOTA group''s name from iota_groups when the spot was stored';

-- ---------------------------------------------------------------------------
-- 2. The island list
-- ---------------------------------------------------------------------------

-- Replaces the list in one transaction, so a reader sees the old list or the
-- new one. import-iota refuses a short file before calling it.
create function public.load_iota_groups(p_groups jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  delete from iota_groups where true;
  insert into iota_groups (refno, name)
  select x.refno, x.name
  from jsonb_to_recordset(p_groups) as x(refno text, name text);
  get diagnostics v_count = row_count;
  insert into iota_load (id, loaded_at, groups) values (true, now(), v_count)
  on conflict (id) do update set loaded_at = excluded.loaded_at, groups = excluded.groups;
  return v_count;
end;
$$;

revoke all on function public.load_iota_groups(jsonb) from public, anon, authenticated;

-- Monthly: the list changes a few times a year at most.
select cron.schedule('import-iota', '25 4 1 * *',
  $$ select public.cron_call_function('import-iota', 'import-iota', '{}'::jsonb, 60000); $$);

-- ---------------------------------------------------------------------------
-- 3. Ingest
-- ---------------------------------------------------------------------------

-- ingest_spots: as in 20261026001000, plus the IOTA reference, and its name looked up
-- in iota_groups as the spot is stored.
create or replace function public.ingest_spots(p_spots jsonb)
returns table (id bigint, source text, source_spot_id text)
language sql
security definer
set search_path = public, pgmq
as $$
  with ins as (
    insert into raw_spots (
      source, source_spot_id, content_hash, spot_time, callsign, spotter,
      frequency_khz, band, mode, mode_family, comment,
      pota_reference, pota_park_name, pota_location, sota_summit_ref,
      wwff_reference, wwff_reference_name,
      wwbota_references, wwbota_reference_name,
      iota_reference, iota_reference_name,
      raw_payload
    )
    select
      x.source, x.source_spot_id, x.content_hash, x.spot_time, x.callsign, x.spotter,
      x.frequency_khz, x.band, x.mode, x.mode_family, coalesce(x.comment, ''),
      x.pota_reference, x.pota_park_name, x.pota_location, x.sota_summit_ref,
      x.wwff_reference, x.wwff_reference_name,
      x.wwbota_references, x.wwbota_reference_name,
      x.iota_reference, (select g.name from iota_groups g where g.refno = x.iota_reference),
      x.raw_payload
    from jsonb_to_recordset(p_spots) as x(
      source text, source_spot_id text, content_hash text, spot_time timestamptz,
      callsign text, spotter text, frequency_khz numeric, band text, mode text,
      mode_family text, comment text, pota_reference text, pota_park_name text,
      pota_location text, sota_summit_ref text, wwff_reference text,
      wwff_reference_name text, wwbota_references text[], wwbota_reference_name text,
      iota_reference text, raw_payload jsonb
    )
    on conflict (source, source_spot_id, content_hash) do nothing
    returning raw_spots.id, raw_spots.source, raw_spots.source_spot_id
  ),
  sent as (
    select count(*) as message_count
    from pgmq.send_batch(
      'spot_events',
      coalesce(
        (select array_agg(jsonb_build_object('spot_id', ins.id, 'source', ins.source)) from ins),
        '{}'::jsonb[]
      )
    )
  )
  select ins.id, ins.source, ins.source_spot_id
  from ins cross join sent
  order by ins.id;
$$;

-- ---------------------------------------------------------------------------
-- 4. Matching
-- ---------------------------------------------------------------------------

-- normalize_subscription_rules: as in 20261017003000, with the island field: is / is_not, values IOTA
-- references (EU-005) or continents (EU), uppercased.
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
           when 'reference' then v_op in ('contains', 'not_contains')
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
                       when 'band' then 'lower' else 'none' end));
        if jsonb_array_length(v_values) = 0 then
          raise exception 'Give the % rule a value.', case v_field when 'island' then 'IOTA island' else v_field end;
        end if;
        if v_field = 'island' and exists (
             select 1 from jsonb_array_elements_text(v_values) as v
             where v !~ '^(AF|AN|AS|EU|NA|OC|SA)(-[0-9]{3})?$') then
          raise exception 'An IOTA island rule takes references such as EU-005 or continents such as EU.';
        end if;
      end if;

      v_conds := v_conds || jsonb_build_array(jsonb_build_object('field', v_field, 'op', v_op, 'values', v_values));
    end loop;

    v_out := v_out || jsonb_build_array(v_conds);
  end loop;

  return v_out;
end;
$$;

-- rule_matches: as in 20261026001000, with the island field (a reference equal to a
-- value, or on a continent value) and the IOTA reference in the reference
-- rule's haystack. A spot without a reference passes island is_not.
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
      when 'reference' then exists (
        select 1 from jsonb_array_elements_text(p_rule -> 'values') as v
        where position(lower(v) in
          lower(concat_ws(',', spot.pota_reference, spot.pota_location, spot.sota_summit_ref,
                          spot.wwff_reference, array_to_string(spot.wwbota_references, ','),
                          spot.iota_reference))) > 0)
      when 'island' then spot.iota_reference is not null and exists (
        select 1 from jsonb_array_elements_text(p_rule -> 'values') as v
        where spot.iota_reference = v or (length(v) = 2 and left(spot.iota_reference, 3) = v || '-'))
      when 'frequency' then case p_rule ->> 'op'
        when 'gt' then spot.frequency_khz > (p_rule -> 'values' ->> 0)::numeric
        when 'lt' then spot.frequency_khz < (p_rule -> 'values' ->> 0)::numeric
        else spot.frequency_khz = (p_rule -> 'values' ->> 0)::numeric end
    end as hit
  ) h;
$$;

-- preview_subscription: as in 20261026001000, with the IOTA columns in the spot JSON. Same return
-- type, so the grants carry over.
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
        'wwbota_references', m.wwbota_references, 'wwbota_reference_name', m.wwbota_reference_name,
        'iota_reference', m.iota_reference, 'iota_reference_name', m.iota_reference_name,
        'source', m.source
      ) order by m.spot_time desc)
      from matched m
    ), '[]'::jsonb),
    (select n from stations),
    (select count(*) from recent)
  where auth.uid() is not null;
$$;

-- ---------------------------------------------------------------------------
-- 5. Delivery
-- ---------------------------------------------------------------------------

-- delivery_spot_json: as in 20261026001000, with the IOTA keys.
create or replace function public.delivery_spot_json(r raw_spots)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id, 'source', r.source, 'spot_time', r.spot_time, 'callsign', r.callsign,
    'base_callsign', r.base_callsign,
    'spotter', r.spotter, 'frequency_khz', r.frequency_khz, 'band', r.band, 'mode', r.mode,
    'mode_family', r.mode_family,
    'comment', r.comment, 'pota_reference', r.pota_reference, 'pota_park_name', r.pota_park_name,
    'pota_location', r.pota_location, 'sota_summit_ref', r.sota_summit_ref,
    'wwff_reference', r.wwff_reference, 'wwff_reference_name', r.wwff_reference_name,
    'wwbota_references', r.wwbota_references, 'wwbota_reference_name', r.wwbota_reference_name,
    'iota_reference', r.iota_reference, 'iota_reference_name', r.iota_reference_name);
$$;

-- push_sample_spot: as in 20261026001000, with the IOTA keys as null.
create or replace function public.push_sample_spot()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', 0, 'source', 'pota', 'spot_time', now(), 'callsign', 'N0CALL', 'base_callsign', 'N0CALL',
    'spotter', 'LONGLINES', 'frequency_khz', 14062, 'band', '20m', 'mode', 'cw', 'mode_family', 'cw',
    'comment', 'Test spot from Long Lines. Not a real activation.',
    'pota_reference', 'US-0000', 'pota_park_name', 'Test Park', 'pota_location', 'US-TEST',
    'sota_summit_ref', null, 'wwff_reference', null, 'wwff_reference_name', null,
    'wwbota_references', null, 'wwbota_reference_name', null,
    'iota_reference', null, 'iota_reference_name', null);
$$;

-- render_push_field: as in 20261026001000, with IOTA: reference falls back to the island
-- reference and place_name to the group's name. No source URL.
create or replace function public.render_push_field(p_field text, p_spot jsonb)
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(case p_field
    when 'callsign' then p_spot ->> 'callsign'
    when 'first_name' then public.spot_license_name(p_spot, 'first')
    when 'last_name' then public.spot_license_name(p_spot, 'last')
    when 'frequency' then to_char((p_spot ->> 'frequency_khz')::numeric / 1000, 'FM9999990.000') || ' MHz'
    when 'band' then p_spot ->> 'band'
    when 'mode' then upper(p_spot ->> 'mode')
    when 'source' then public.push_source_label(p_spot ->> 'source')
    when 'reference' then coalesce(nullif(p_spot ->> 'pota_reference', ''), nullif(p_spot ->> 'sota_summit_ref', ''),
                                   nullif(p_spot ->> 'wwff_reference', ''),
                                   (select string_agg(x, ', ' order by o)
                                    from jsonb_array_elements_text(
                                           case when jsonb_typeof(p_spot -> 'wwbota_references') = 'array'
                                                then p_spot -> 'wwbota_references' end) with ordinality as t(x, o)),
                                   p_spot ->> 'iota_reference')
    when 'place_name' then coalesce(nullif(p_spot ->> 'pota_park_name', ''), nullif(p_spot ->> 'wwff_reference_name', ''),
                                    nullif(p_spot ->> 'wwbota_reference_name', ''), p_spot ->> 'iota_reference_name')
    when 'state' then (
      select string_agg(coalesce(nullif(split_part(trim(x), '-', 2), ''), trim(x)), '/')
      from regexp_split_to_table(p_spot ->> 'pota_location', ',') x
      where trim(x) <> '')
    when 'spotter' then p_spot ->> 'spotter'
    when 'comment' then p_spot ->> 'comment'
    when 'time' then to_char((p_spot ->> 'spot_time')::timestamptz at time zone 'UTC', 'HH24:MI') || 'Z'
  end, '');
$$;

-- ---------------------------------------------------------------------------
-- 6. Read models
-- ---------------------------------------------------------------------------

-- recent_spots gains the IOTA columns before source; recreate it and
-- list_recent_spots, which returns its row type (see 20261026001000).
drop function public.list_recent_spots(text, int);
drop view recent_spots;

create view recent_spots with (security_invoker = true) as
select
  id, spot_time, callsign, spotter, frequency_khz, band, mode, mode_family, comment,
  pota_reference, pota_park_name, pota_location, sota_summit_ref,
  wwff_reference, wwff_reference_name, wwbota_references, wwbota_reference_name,
  iota_reference, iota_reference_name, source
from raw_spots
where spot_time > now() - interval '24 hours';

revoke all on recent_spots from anon, authenticated;

-- As in 20261026001000, with two more nulls on the RBN branch, and 'iota' reading the
-- DX Cluster spots that name an island (the IOTA catalog page's recent spots).
create function public.list_recent_spots(p_source text, max_rows int)
returns setof recent_spots
language sql
stable
security definer
set search_path = public
as $$
  (select * from recent_spots
   where (p_source not in ('rbn', 'iota') and source = p_source)
      or (p_source = 'iota' and source = 'dxcluster' and iota_reference is not null)
   order by spot_time desc
   limit least(greatest(coalesce(max_rows, 50), 0), 200))
  union all
  (select null::bigint, r.spot_time, r.callsign, r.spotter, r.frequency_khz, r.band, r.mode, r.mode_family,
          format('%s dB %s %s %s', r.snr, r.speed, r.speed_unit, r.spot_type),
          null, null, null, null, null, null, null, null, null, null, 'rbn'
   from rbn_spots r
   where p_source = 'rbn' and r.spot_time > now() - interval '24 hours'
   order by r.spot_time desc
   limit least(greatest(coalesce(max_rows, 50), 0), 200));
$$;

revoke all on function public.list_recent_spots(text, int) from public, anon, authenticated;
grant execute on function public.list_recent_spots(text, int) to authenticated;

-- callsign_group_rows: as in 20261026001000, with the IOTA reference as the last fallback
-- for the on-air spot's reference.
create or replace function public.callsign_group_rows(p_id uuid)
returns table (id uuid, name text, callsigns text[], member_count bigint, subscription_count bigint,
               updated_at timestamptz, on_air jsonb)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  return query
  select
    g.id,
    g.name,
    m.calls,
    cardinality(m.calls)::bigint,
    (select count(*) from subscriptions s where s.user_id = v_user and g.id = any (s.group_ids)),
    g.updated_at,
    jsonb_build_object('count', a.n, 'latest', a.latest)
  from callsign_groups g
  cross join lateral (
    select coalesce(array_agg(cm.callsign order by cm.callsign), '{}') as calls
    from callsign_group_members cm
    where cm.group_id = g.id
  ) m
  cross join lateral (
    select count(distinct r.base_callsign) as n,
           (array_agg(jsonb_build_object(
              'callsign', r.callsign, 'frequency_khz', r.frequency_khz, 'band', r.band, 'mode', r.mode,
              'source', r.source, 'reference', coalesce(r.pota_reference, r.sota_summit_ref, r.wwff_reference, r.wwbota_references[1],
                                                 r.iota_reference),
              'spot_time', r.spot_time)
            order by r.spot_time desc, r.id desc))[1] as latest
    from callsign_group_members cm
    join raw_spots r on r.base_callsign = cm.callsign and r.spot_time > now() - interval '30 minutes'
    where cm.group_id = g.id
  ) a
  where g.user_id = v_user and (p_id is null or g.id = p_id)
  order by lower(g.name);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Archive
-- ---------------------------------------------------------------------------

-- archive_columns: as in 20261026001000, with the two IOTA columns in every raw_spots
-- source's files.
create or replace function public.archive_columns(p_source text, p_from timestamptz, p_to timestamptz)
returns table (row_count int, columns json)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_source = 'rbn' then
    return query
      select count(*)::int,
             case when count(*) > 0 then json_build_object(
               'spot_time', json_agg((extract(epoch from r.spot_time) * 1000)::bigint order by r.o),
               'received_at', json_agg((extract(epoch from r.received_at) * 1000)::bigint order by r.o),
               'spotter', json_agg(r.spotter order by r.o),
               'callsign', json_agg(r.callsign order by r.o),
               'frequency_khz', json_agg(r.frequency_khz order by r.o),
               'band', json_agg(r.band order by r.o),
               'mode', json_agg(r.mode order by r.o),
               'mode_family', json_agg(r.mode_family order by r.o),
               'snr', json_agg(r.snr order by r.o),
               'speed', json_agg(r.speed order by r.o),
               'speed_unit', json_agg(r.speed_unit order by r.o),
               'spot_type', json_agg(r.spot_type order by r.o),
               'line', json_agg(r.line order by r.o)
             ) end
      from (
        select x.*,
               row_number() over (order by x.spot_time, x.spotter, x.callsign, x.frequency_khz) as o
        from rbn_spots x
        where x.spot_time >= p_from and x.spot_time < p_to
      ) r;
  elsif p_source = 'aprs' then
    -- Every column but line_md5, which only orders packets received in the same instant.
    return query
      select count(*)::int,
             case when count(*) > 0 then json_build_object(
               'received_at', json_agg((extract(epoch from r.received_at) * 1000)::bigint order by r.o),
               'source_call', json_agg(r.source_call order by r.o),
               'destination', json_agg(r.destination order by r.o),
               'path', json_agg(r.path order by r.o),
               'q_construct', json_agg(r.q_construct order by r.o),
               'igate', json_agg(r.igate order by r.o),
               'packet_type', json_agg(r.packet_type order by r.o),
               'line', json_agg(r.line order by r.o)
             ) end
      from (
        select x.*, row_number() over (order by x.received_at, x.line_md5) as o
        from aprs_packets x
        where x.received_at >= p_from and x.received_at < p_to
      ) r;
  elsif p_source in ('pota', 'sotawatch', 'dxcluster', 'wwff', 'wwbota') then
    return query
      select count(*)::int,
             case when count(*) > 0 then json_build_object(
               'source', json_agg(r.source order by r.o),
               'source_spot_id', json_agg(r.source_spot_id order by r.o),
               'content_hash', json_agg(r.content_hash order by r.o),
               'spot_time', json_agg((extract(epoch from r.spot_time) * 1000)::bigint order by r.o),
               'ingested_at', json_agg((extract(epoch from r.ingested_at) * 1000)::bigint order by r.o),
               'callsign', json_agg(r.callsign order by r.o),
               'spotter', json_agg(r.spotter order by r.o),
               'frequency_khz', json_agg(r.frequency_khz order by r.o),
               'band', json_agg(r.band order by r.o),
               'mode', json_agg(r.mode order by r.o),
               'mode_family', json_agg(r.mode_family order by r.o),
               'comment', json_agg(r.comment order by r.o),
               'pota_reference', json_agg(r.pota_reference order by r.o),
               'pota_park_name', json_agg(r.pota_park_name order by r.o),
               'pota_location', json_agg(r.pota_location order by r.o),
               'sota_summit_ref', json_agg(r.sota_summit_ref order by r.o),
               'wwff_reference', json_agg(r.wwff_reference order by r.o),
               'wwff_reference_name', json_agg(r.wwff_reference_name order by r.o),
               'wwbota_references', json_agg(array_to_string(r.wwbota_references, ',') order by r.o),
               'wwbota_reference_name', json_agg(r.wwbota_reference_name order by r.o),
               'iota_reference', json_agg(r.iota_reference order by r.o),
               'iota_reference_name', json_agg(r.iota_reference_name order by r.o),
               'raw_payload', json_agg(r.raw_payload::text order by r.o)
             ) end
      from (
        select x.*,
               row_number() over (order by x.spot_time, x.source_spot_id, x.content_hash) as o
        from raw_spots x
        where x.source = p_source and x.spot_time >= p_from and x.spot_time < p_to
      ) r;
  else
    raise exception 'unknown archive source: %', p_source;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Profiles and group statistics
-- ---------------------------------------------------------------------------

-- spot_stream: as in 20261026001000, with an IOTA arm after WWBOTA. Days
-- already rolled up are never re-rolled.
create or replace view spot_stream with (security_invoker = true) as
select r.source,
       r.spot_time,
       r.callsign,
       r.base_callsign,
       r.spotter,
       public.base_callsign(r.spotter)          as spotter_base,
       r.frequency_khz,
       r.band,
       r.mode,
       public.mode_bucket(r.mode, r.mode_family) as mode_bucket,
       null::smallint                            as snr,
       case when r.pota_reference is not null then 'POTA'
            when r.sota_summit_ref is not null then 'SOTA'
            when r.wwff_reference is not null then 'WWFF'
            when r.wwbota_references[1] is not null then 'WWBOTA'
            when r.iota_reference is not null then 'IOTA' end as program,
       coalesce(r.pota_reference, r.sota_summit_ref, r.wwff_reference, r.wwbota_references[1],
                r.iota_reference) as reference,
       case when r.pota_reference is not null then r.pota_park_name
            when r.sota_summit_ref is not null then null
            when r.wwff_reference is not null then r.wwff_reference_name
            when r.wwbota_references[1] is not null then r.wwbota_reference_name
            else r.iota_reference_name end as reference_name,
       case when r.pota_reference is not null then r.pota_location end  as reference_location
from raw_spots r
where r.source <> 'rbn'
union all
select 'rbn',
       s.spot_time,
       s.callsign,
       public.base_callsign(s.callsign),
       s.spotter,
       public.base_callsign(s.spotter),
       s.frequency_khz,
       s.band,
       s.mode,
       public.mode_bucket(s.mode, s.mode_family),
       s.snr,
       null, null, null, null
from rbn_spots s;

-- group_statistics_at: as in 20261026001000, with IOTA in the KPIs the way WWBOTA is: an iota
-- activations count and an islands places count.
create or replace function public.group_statistics_at(p_group_id uuid, p_period text, p_now timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set plan_cache_mode = force_custom_plan
as $$
declare
  v_days      int := case p_period when '7d' then 7 when '30d' then 30 end;
  v_today     date := (p_now at time zone 'utc')::date;
  v_year      date := (p_now at time zone 'utc')::date - 364;
  v_from      date;
  v_prev      date;
  v_live_from date;
  v_bases     text[];
begin
  if v_days is null then
    raise exception 'Not a valid period.';
  end if;
  if not exists (select 1 from callsign_groups g where g.id = p_group_id) then
    return null;
  end if;
  v_from := v_today - (v_days - 1);
  v_prev := v_from - v_days;

  v_bases := public.group_member_bases(p_group_id);

  -- callsign_profile's live window: the oldest of the last 14 days without a
  -- marker, never before the first marker. Today never has one.
  select min(g.d)::date into v_live_from
  from generate_series(greatest(v_today - 14, (select min(day) from callsign_rollup_days)), v_today,
                       interval '1 day') as g(d)
  where not exists (select 1 from callsign_rollup_days r where r.day = g.d::date);

  return (
    with live as materialized (
      select s.base_callsign as base, (s.spot_time at time zone 'utc')::date as day, s.spot_time,
             s.band, s.mode_bucket
      from spot_stream s
      where s.base_callsign = any (v_bases)
        and s.spot_time >= v_live_from::timestamp at time zone 'utc'
        and s.spot_time < (v_today + 1)::timestamp at time zone 'utc'
        and not exists (select 1 from callsign_rollup_days d
                        where d.day = (s.spot_time at time zone 'utc')::date)
    ),
    day_spots as (
      select base, day, sum(n)::bigint as spots
      from (
        select d.base, d.day, d.spots::bigint as n
        from callsign_days d
        where d.base = any (v_bases) and d.day >= v_year and d.day <= v_today
        union all
        -- Days rolled up before callsign_days existed and not yet filled by
        -- backfill_callsign_days: their day-grain activity rows, which
        -- compaction keeps until the fill (20261019000200).
        select a.base, a.period, a.spots::bigint
        from callsign_activity a
        join callsign_rollup_days r on r.day = a.period and r.days_filled_at is null
        where a.base = any (v_bases) and a.role = 'heard' and a.grain = 'day'
          and a.period >= v_year and a.period <= v_today
        union all
        select l.base, l.day, count(*) from live l group by l.base, l.day
      ) x
      group by base, day
    ),
    mix as (
      select base, band, mode_bucket, sum(n)::bigint as n
      from (
        select a.base, a.band, a.mode_bucket, a.spots::bigint as n
        from callsign_activity a
        where a.base = any (v_bases) and a.role = 'heard' and a.grain = 'day'
          and a.period >= v_from and a.period <= v_today
        union all
        select l.base, l.band, l.mode_bucket, count(*) from live l where l.day >= v_from group by 1, 2, 3
      ) x
      group by base, band, mode_bucket
    ),
    refs as materialized (
      select s.base_callsign as base, s.program, s.reference, (s.spot_time at time zone 'utc')::date as day,
             s.reference_name, s.spot_time
      from spot_stream s
      where s.base_callsign = any (v_bases) and s.program is not null
        and s.spot_time >= v_from::timestamp at time zone 'utc'
        and s.spot_time < (v_today + 1)::timestamp at time zone 'utc'
    ),
    activations as (
      select distinct base, program, reference, day from refs
    ),
    per_member as (
      select b.base,
             coalesce(sum(d.spots), 0)::bigint as spots,
             count(d.day) filter (where d.spots > 0) as days
      from unnest(v_bases) as b(base)
      left join day_spots d on d.base = b.base and d.day >= v_from
      group by b.base
    ),
    main_mode as (
      select distinct on (base) base, mode_bucket
      from (select base, mode_bucket, sum(n) as n from mix group by base, mode_bucket) x
      order by base, n desc, array_position(array['CW', 'SSB', 'FT8/FT4', 'FM', 'Other'], mode_bucket)
    ),
    live_last as (
      select base, max(spot_time) as t from live group by base
    ),
    last_heard as (
      select b.base, greatest(s.last_spot, ll.t) as t
      from unnest(v_bases) as b(base)
      left join callsign_seen s on s.base = b.base
      left join live_last ll on ll.base = b.base
    ),
    kpis as (
      select jsonb_build_object(
        'spots', (select coalesce(sum(spots), 0)::bigint from day_spots where day >= v_from),
        'previousSpots', (select coalesce(sum(spots), 0)::bigint from day_spots where day >= v_prev and day < v_from),
        'membersHeard', (select count(*) from per_member where spots > 0),
        'activations', (select jsonb_build_object(
                          'pota', count(*) filter (where program = 'POTA'),
                          'sota', count(*) filter (where program = 'SOTA'),
                          'wwff', count(*) filter (where program = 'WWFF'),
                          'wwbota', count(*) filter (where program = 'WWBOTA'),
                          'iota', count(*) filter (where program = 'IOTA'))
                        from activations),
        'places', (select jsonb_build_object(
                     'parks', count(distinct program || ':' || reference) filter (where program in ('POTA', 'WWFF')),
                     'summits', count(distinct reference) filter (where program = 'SOTA'),
                     'bunkers', count(distinct reference) filter (where program = 'WWBOTA'),
                     'islands', count(distinct reference) filter (where program = 'IOTA'))
                   from activations)) as v
    ),
    daily as (
      select jsonb_agg(jsonb_build_object('day', to_char(g.d, 'YYYY-MM-DD'), 'spots', coalesce(x.n, 0))
                       order by g.d) as v
      from generate_series(v_from, v_today, interval '1 day') as g(d)
      left join (select day, sum(spots)::bigint as n from day_spots group by day) x on x.day = g.d::date
    ),
    calendar as (
      select coalesce(jsonb_agg(jsonb_build_object('day', to_char(c.day, 'YYYY-MM-DD'), 'spots', c.n,
                                                   'members', c.m) order by c.day), '[]') as v
      from (select day, sum(spots)::bigint as n, count(*) filter (where spots > 0) as m
            from day_spots group by day having sum(spots) > 0) c
    ),
    top_rows as (
      select 'spots' as list, base, spots as value from per_member
      union all select 'days', base, days from per_member
      union all select 'cw', base, sum(n)::bigint from mix where mode_bucket = 'CW' group by base
      union all select 'ssb', base, sum(n)::bigint from mix where mode_bucket = 'SSB' group by base
      union all select 'digital', base, sum(n)::bigint from mix where mode_bucket = 'FT8/FT4' group by base
      union all select 'parks', base, count(distinct reference) from activations where program = 'POTA' group by base
    ),
    top_ranked as (
      select list, base, value, row_number() over (partition by list order by value desc, base) as r
      from top_rows
      where value > 0
    ),
    top_json as (
      select jsonb_object_agg(l.list, coalesce(
               (select jsonb_agg(jsonb_build_object('callsign', t.base, 'value', t.value) order by t.r)
                from top_ranked t where t.list = l.list and t.r <= 3), '[]')) as v
      from unnest(array['spots', 'days', 'cw', 'ssb', 'digital', 'parks']) as l(list)
    ),
    members_json as (
      select coalesce(jsonb_agg(jsonb_build_object(
               'callsign', p.base, 'spots', p.spots, 'days', p.days, 'mainMode', mm.mode_bucket,
               'lastHeard', to_char(lh.t at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
             order by p.spots desc, p.days desc, p.base), '[]') as v
      from per_member p
      left join main_mode mm on mm.base = p.base
      left join last_heard lh on lh.base = p.base
    ),
    -- callsign_profile's bands: fixed order, zero-filled, other bands left out.
    bands as (
      select jsonb_agg(jsonb_build_object(
               'band', bo.band, 'spots', coalesce((select sum(m.n) from mix m where m.band = bo.band), 0)::bigint)
             order by bo.ord) as v
      from (values ('160m', 1), ('80m', 2), ('60m', 3), ('40m', 4), ('30m', 5), ('20m', 6),
                   ('17m', 7), ('15m', 8), ('12m', 9), ('10m', 10), ('6m', 11), ('2m', 12)) as bo(band, ord)
    ),
    modes as (
      select coalesce(jsonb_agg(jsonb_build_object('label', ml.label, 'spots', c.n) order by ml.ord), '[]') as v
      from (values ('CW', 1), ('SSB', 2), ('FT8/FT4', 3), ('FM', 4), ('Other', 5)) as ml(label, ord)
      join (select mode_bucket, sum(n)::bigint as n from mix group by mode_bucket) c on c.mode_bucket = ml.label
      where c.n > 0
    ),
    -- Each reference's newest name in the period (SOTA summits have none).
    place_names as (
      select distinct on (program, reference) program, reference, reference_name as name
      from refs
      where reference_name is not null
      order by program, reference, spot_time desc
    ),
    places as (
      select coalesce(jsonb_agg(jsonb_build_object(
               'reference', p.reference, 'name', p.name, 'program', p.program, 'times', p.times,
               'by', to_jsonb(p.by_calls))
             order by p.times desc, p.reference), '[]') as v
      from (
        select t.program, t.reference, t.times, t.by_calls, n.name
        from (
          select a.program, a.reference, count(*) as times, array_agg(distinct a.base order by a.base) as by_calls
          from activations a
          group by a.program, a.reference
          order by times desc, a.reference
          limit 10
        ) t
        left join place_names n on n.program = t.program and n.reference = t.reference
      ) p
    )
    select jsonb_build_object(
             'period', p_period,
             'generatedAt', to_char(p_now at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
             'memberCount', cardinality(v_bases),
             'kpis', kpis.v,
             'daily', daily.v,
             'calendar', calendar.v,
             'top', top_json.v,
             'members', members_json.v,
             'bands', bands.v,
             'modes', modes.v,
             'places', places.v)
    from kpis, daily, calendar, top_json, members_json, bands, modes, places
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Stats: daily and hourly counts only
-- ---------------------------------------------------------------------------

-- build_stats_snapshot_at: as in 20261026001000, with daily[].iota and hourly[].iota (DX Cluster
-- spots that name an island), for the catalog's rates, from their own CTEs
-- like dx and wwbota. Same signature, so the grants carry over.
create or replace function public.build_stats_snapshot_at(p_now timestamptz)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_end   timestamptz := date_trunc('day', p_now at time zone 'utc') at time zone 'utc';
  v_window_start timestamptz := (date_trunc('day', p_now at time zone 'utc') - interval '7 days') at time zone 'utc';
  v_first_day    date        := (p_now at time zone 'utc')::date - 7;
  v_end_day      date        := (p_now at time zone 'utc')::date;
  v_hour_end     timestamptz := date_trunc('hour', p_now at time zone 'utc') at time zone 'utc';
  v_hour_start   timestamptz := (date_trunc('hour', p_now at time zone 'utc') - interval '7 days') at time zone 'utc';
  v_from         timestamptz;
begin
  -- RBN hours of today for the hourly series: every complete hour without a
  -- count, and any hour counted within an hour of its end, recounted from the
  -- oldest such hour up to now in one range scan (see the header). Hours of
  -- earlier days belong to the day rollups.
  select min(h) into v_from
  from generate_series(v_window_end, v_hour_end - interval '1 hour', interval '1 hour') as h
  left join rbn_rollup_hours l on l.hour = h
  where l.hour is null or l.rolled_at < h + interval '2 hours';
  if v_from is not null then
    perform public.rollup_rbn_hours(v_from, v_hour_end);
  end if;
  delete from rbn_rollup_hours where hour < v_window_end;

  insert into stats_snapshots (window_start, window_end, payload)
  with
  -- Every in-window row.
  in_window as (
    select r.*
    from raw_spots r
    where r.spot_time >= v_window_start
      and r.spot_time <  v_window_end
      -- The page describes POTA, SOTA and WWFF activity. Any other source (RBN
      -- skimmer reports of watched callsigns, DX Cluster) is not an activation
      -- and stays out.
      and r.source in ('pota', 'sotawatch', 'wwff')
  ),
  -- base_callsign() once per distinct spotter, not per row (see the header).
  spotter_bases as materialized (
    select d.spotter, public.base_callsign(d.spotter) as base
    from (select distinct spotter from in_window where spotter is not null) as d
  ),
  -- Every in-window row with its UTC day and hour.
  spots as (
    select r.id, r.source, r.spot_time, r.callsign, r.spotter, r.band, r.mode, r.mode_family,
           r.pota_reference, r.pota_park_name, r.pota_location, r.sota_summit_ref,
           r.wwff_reference, r.wwff_reference_name,
           to_char(r.spot_time at time zone 'utc', 'YYYY-MM-DD') as day,
           extract(hour from r.spot_time at time zone 'utc')::int as hour,
           -- A chaser spot has a spotter who is not the activator: is_self_spot's
           -- rule, on base calls already resolved.
           (r.spotter is not null and not coalesce(sb.base = r.base_callsign, false)) as chased
    from in_window r
    left join spotter_bases sb on sb.spotter = r.spotter
  ),
  totals as (
    select count(*)                                                         as spots,
           count(*) filter (where source = 'pota')                          as pota_spots,
           count(*) filter (where source = 'sotawatch')                     as sota_spots,
           count(*) filter (where source = 'wwff')                          as wwff_spots,
           count(distinct callsign)                                         as activators,
           count(distinct pota_reference) + count(distinct sota_summit_ref)
             + count(distinct wwff_reference)                               as references,
           -- Activations: distinct (callsign, reference, UTC day) per program.
           count(distinct (callsign, pota_reference, day)) filter (where pota_reference is not null)  as pota_activations,
           count(distinct (callsign, sota_summit_ref, day)) filter (where sota_summit_ref is not null) as sota_activations,
           count(distinct (callsign, wwff_reference, day)) filter (where wwff_reference is not null)   as wwff_activations,
           -- Chasers: distinct spotters on chased spots, overall and per source.
           count(distinct spotter) filter (where chased)                            as chasers,
           count(distinct spotter) filter (where chased and source = 'pota')        as pota_chasers,
           count(distinct spotter) filter (where chased and source = 'sotawatch')   as sota_chasers,
           count(distinct spotter) filter (where chased and source = 'wwff')        as wwff_chasers
    from spots
  ),
  -- Hour of day with the most spots summed over all seven days.
  peak_hour as (
    select hour from spots
    group by hour
    order by count(*) desc, hour asc
    limit 1
  ),
  -- The single busiest (day, hour) bucket.
  busiest_slot as (
    select day, hour from spots
    group by day, hour
    order by count(*) desc, day asc, hour asc
    limit 1
  ),
  -- daily: exactly seven days, oldest first, zero-filled. Day arithmetic is
  -- done on a date so a DST change in the session zone cannot skip a day.
  days as (
    select to_char((v_window_start at time zone 'utc')::date + i, 'YYYY-MM-DD') as day
    from generate_series(0, 6) as i
  ),
  daily_counts as (
    select day,
           count(*) filter (where source = 'pota')      as pota,
           count(*) filter (where source = 'sotawatch') as sota,
           count(*) filter (where source = 'wwff')      as wwff
    from spots
    group by day
  ),
  daily_rbn as (
    select to_char(hour at time zone 'utc', 'YYYY-MM-DD') as day, sum(spots) as rbn
    from rbn_hourly
    where hour >= v_window_start and hour < v_window_end
    group by 1
  ),
  daily_aprs as (
    select to_char(hour_start at time zone 'utc', 'YYYY-MM-DD') as day, sum(packets) as aprs
    from aprs_packet_hours
    where hour_start >= v_window_start and hour_start < v_window_end
    group by 1
  ),
  daily_dx as (
    select to_char(spot_time at time zone 'utc', 'YYYY-MM-DD') as day, count(*) as dx
    from raw_spots
    where source = 'dxcluster'
      and spot_time >= v_window_start
      and spot_time <  v_window_end
    group by 1
  ),
  daily_wwbota as (
    select to_char(spot_time at time zone 'utc', 'YYYY-MM-DD') as day, count(*) as wwbota
    from raw_spots
    where source = 'wwbota'
      and spot_time >= v_window_start
      and spot_time <  v_window_end
    group by 1
  ),
  daily_iota as (
    select to_char(spot_time at time zone 'utc', 'YYYY-MM-DD') as day, count(*) as iota
    from raw_spots
    where source = 'dxcluster' and iota_reference is not null
      and spot_time >= v_window_start
      and spot_time <  v_window_end
    group by 1
  ),
  daily as (
    select jsonb_agg(
             jsonb_build_object('day', d.day, 'pota', coalesce(c.pota, 0), 'sota', coalesce(c.sota, 0),
                                'wwff', coalesce(c.wwff, 0), 'rbn', coalesce(r.rbn, 0), 'aprs', coalesce(a.aprs, 0), 'dx', coalesce(x.dx, 0),
                                'wwbota', coalesce(w.wwbota, 0), 'iota', coalesce(io.iota, 0))
             order by d.day
           ) as v
    from days d
    left join daily_counts c using (day)
    left join daily_rbn r using (day)
    left join daily_aprs a using (day)
    left join daily_dx x using (day)
    left join daily_wwbota w using (day)
    left join daily_iota io using (day)
  ),
  -- hourly: exactly 168 hours, oldest first, zero-filled, ending at the last
  -- complete hour rather than at window_end (see the header). POTA,
  -- SOTAwatch and WWFF come from raw_spots over those hours, RBN from the rollups.
  slots as (
    select generate_series(v_hour_start, v_hour_end - interval '1 hour', interval '1 hour') as slot
  ),
  slot_counts as (
    select date_bin(interval '1 hour', r.spot_time, timestamptz '2000-01-01 00:00+00') as slot,
           count(*) filter (where r.source = 'pota')      as pota,
           count(*) filter (where r.source = 'sotawatch') as sota,
           count(*) filter (where r.source = 'wwff')      as wwff
    from raw_spots r
    where r.spot_time >= v_hour_start
      and r.spot_time <  v_hour_end
      and r.source in ('pota', 'sotawatch', 'wwff')
    group by 1
  ),
  slot_dx as (
    select date_bin(interval '1 hour', r.spot_time, timestamptz '2000-01-01 00:00+00') as slot,
           count(*) as dx
    from raw_spots r
    where r.source = 'dxcluster'
      and r.spot_time >= v_hour_start
      and r.spot_time <  v_hour_end
    group by 1
  ),
  slot_wwbota as (
    select date_bin(interval '1 hour', r.spot_time, timestamptz '2000-01-01 00:00+00') as slot,
           count(*) as wwbota
    from raw_spots r
    where r.source = 'wwbota'
      and r.spot_time >= v_hour_start
      and r.spot_time <  v_hour_end
    group by 1
  ),
  slot_iota as (
    select date_bin(interval '1 hour', r.spot_time, timestamptz '2000-01-01 00:00+00') as slot,
           count(*) as iota
    from raw_spots r
    where r.source = 'dxcluster' and r.iota_reference is not null
      and r.spot_time >= v_hour_start
      and r.spot_time <  v_hour_end
    group by 1
  ),
  hourly as (
    select jsonb_agg(
             jsonb_build_object(
               'hour', to_char(s.slot at time zone 'utc', 'YYYY-MM-DD"T"HH24":00:00Z"'),
               'pota', coalesce(c.pota, 0), 'sota', coalesce(c.sota, 0), 'wwff', coalesce(c.wwff, 0),
               'rbn', coalesce(h.spots, 0),
               'aprs', coalesce(ah.packets, 0), 'dx', coalesce(sx.dx, 0),
               'wwbota', coalesce(sw.wwbota, 0), 'iota', coalesce(si.iota, 0)
             )
             order by s.slot
           ) as v
    from slots s
    left join slot_counts c using (slot)
    left join rbn_hourly h on h.hour = s.slot
    left join aprs_packet_hours ah on ah.hour_start = s.slot
    left join slot_dx sx on sx.slot = s.slot
    left join slot_wwbota sw on sw.slot = s.slot
    left join slot_iota si on si.slot = s.slot
  ),
  -- potaByState: 50 states + DC, zero-filled. pota_location is a raw
  -- comma-separated list ("US-NC,US-VA"); a park spanning two states counts
  -- once in each. Entries are trimmed because upstream sometimes pads after
  -- the comma. Non-US entries and US territories (US-PR, US-GU, ...) fall out
  -- of the join and are ignored.
  states as (
    select unnest(array[
      'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME',
      'MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI',
      'SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'
    ]) as code
  ),
  state_counts as (
    select substr(trim(x), 4, 2) as code, count(*) as n
    from spots s, regexp_split_to_table(s.pota_location, ',') as x
    where trim(x) ~ '^US-[A-Z]{2}$'
    group by 1
  ),
  pota_by_state as (
    select jsonb_object_agg(st.code, coalesce(sc.n, 0)) as v
    from states st
    left join state_counts sc using (code)
  ),
  -- countries: every country with a spot in the window, from the day rollups,
  -- busiest first. A country is ISO 3166-1 alpha-2 through
  -- cty_entity_countries, so England and Scotland are both GB and Alaska is
  -- US; an entity with no country (Spratly Islands) is left out.
  country_counts as (
    select c.country as code,
           coalesce(sum(d.spots) filter (where d.source = 'pota'), 0)      as pota,
           coalesce(sum(d.spots) filter (where d.source = 'sotawatch'), 0) as sota,
           coalesce(sum(d.spots) filter (where d.source = 'wwff'), 0)      as wwff,
           coalesce(sum(d.spots) filter (where d.source = 'dxcluster'), 0) as dx,
           coalesce(sum(d.spots) filter (where d.source = 'rbn'), 0)       as rbn
    from country_daily_spots d
    join cty_entity_countries c using (entity)
    where d.day >= v_first_day and d.day < v_end_day
    group by c.country
  ),
  countries as (
    select coalesce(
             jsonb_agg(jsonb_build_object('code', code, 'pota', pota, 'sota', sota, 'wwff', wwff,
                                          'dx', dx, 'rbn', rbn)
                       order by pota + sota + wwff + dx + rbn desc, code asc),
             '[]'::jsonb
           ) as v
    from country_counts
  ),
  -- sotaAssociations: top 10 by spots; the association is the part before
  -- the first '/', so refs without a '/' are skipped.
  sota_association_counts as (
    select split_part(sota_summit_ref, '/', 1) as code, count(*) as n
    from spots
    where sota_summit_ref like '%/%'
    group by 1
    order by n desc, code asc
    limit 10
  ),
  sota_associations as (
    select coalesce(
             jsonb_agg(jsonb_build_object('code', code, 'spots', n) order by n desc, code asc),
             '[]'::jsonb
           ) as v
    from sota_association_counts
  ),
  -- wwffPrograms: top 10 by spots; the national program is the part before
  -- the first '-' (KFF-5268 is KFF), so refs without a '-' are skipped.
  wwff_program_counts as (
    select split_part(wwff_reference, '-', 1) as code, count(*) as n
    from spots
    where wwff_reference like '%-%'
    group by 1
    order by n desc, code asc
    limit 10
  ),
  wwff_programs as (
    select coalesce(
             jsonb_agg(jsonb_build_object('code', code, 'spots', n) order by n desc, code asc),
             '[]'::jsonb
           ) as v
    from wwff_program_counts
  ),
  -- bands: fixed order, zero-filled; other bands and null are excluded here
  -- but still counted in totals.
  band_order as (
    select * from (values
      ('160m', 1), ('80m', 2), ('60m', 3), ('40m', 4), ('30m', 5), ('20m', 6),
      ('17m', 7), ('15m', 8), ('12m', 9), ('10m', 10), ('6m', 11), ('2m', 12)
    ) as b(band, ord)
  ),
  band_counts as (
    select band,
           count(*) filter (where source = 'pota')      as pota,
           count(*) filter (where source = 'sotawatch') as sota,
           count(*) filter (where source = 'wwff')      as wwff
    from spots
    where band is not null
    group by band
  ),
  bands as (
    select jsonb_agg(
             jsonb_build_object('band', bo.band, 'pota', coalesce(c.pota, 0), 'sota', coalesce(c.sota, 0),
                                'wwff', coalesce(c.wwff, 0))
             order by bo.ord
           ) as v
    from band_order bo
    left join band_counts c using (band)
  ),
  -- modes: five fixed labels, integer percents that sum to exactly 100.
  -- The labels are mode_bucket() (20261012000040), which profiles use too;
  -- a null mode is Other.
  -- Each share is rounded (round() is half away from zero), then whatever is
  -- left over after rounding (100 - sum, possibly negative) is added to the
  -- bucket with the most spots. With no spots every percent is 0.
  mode_labels as (
    select * from (values ('CW', 1), ('SSB', 2), ('FT8/FT4', 3), ('FM', 4), ('Other', 5)) as l(label, ord)
  ),
  mode_counts as (
    select public.mode_bucket(mode, mode_family) as label, count(*) as n
    from spots
    group by 1
  ),
  mode_rounded as (
    select l.label, l.ord, coalesce(c.n, 0) as n,
           case when t.spots = 0 then 0
                else round(100.0 * coalesce(c.n, 0) / t.spots)::int
           end as pct
    from mode_labels l
    left join mode_counts c using (label)
    cross join totals t
  ),
  mode_fixed as (
    select label, ord,
           case when sum(pct) over () = 0 then 0
                when row_number() over (order by n desc, ord asc) = 1
                  then pct + (100 - sum(pct) over ())::int
                else pct
           end as percent
    from mode_rounded
  ),
  modes as (
    select jsonb_agg(jsonb_build_object('label', label, 'percent', percent) order by ord) as v
    from mode_fixed
  ),
  -- topActivators: top 8 by distinct references, then spots, then callsign.
  -- activations is per (reference, UTC day) within the callsign; base is the
  -- profile the Stats page links to.
  activators as (
    select callsign,
           count(distinct pota_reference) + count(distinct sota_summit_ref)
             + count(distinct wwff_reference) as refs,
           count(distinct (pota_reference, day)) filter (where pota_reference is not null)
             + count(distinct (sota_summit_ref, day)) filter (where sota_summit_ref is not null)
             + count(distinct (wwff_reference, day)) filter (where wwff_reference is not null) as activations,
           count(*) as n
    from spots
    group by callsign
    order by refs desc, n desc, callsign asc
    limit 8
  ),
  activator_bands as (
    select callsign, band,
           row_number() over (partition by callsign order by count(*) desc, band asc) as rn
    from spots
    where band is not null
      and callsign in (select callsign from activators)
    group by callsign, band
  ),
  top_activators as (
    select coalesce(
             jsonb_agg(
               jsonb_build_object('callsign', a.callsign, 'base', public.base_callsign(a.callsign),
                                  'references', a.refs, 'activations', a.activations,
                                  'spots', a.n, 'topBand', ab.band)
               order by a.refs desc, a.n desc, a.callsign asc
             ),
             '[]'::jsonb
           ) as v
    from activators a
    left join activator_bands ab on ab.callsign = a.callsign and ab.rn = 1
  ),
  -- topReferences: top 8 across the three programs by spots.
  -- activations is per (callsign, UTC day) within the reference.
  reference_counts as (
    select pota_reference as reference, 'POTA' as program, count(*) as n,
           count(distinct (callsign, day)) as activations
    from spots
    where pota_reference is not null
    group by pota_reference
    union all
    select sota_summit_ref, 'SOTA', count(*), count(distinct (callsign, day))
    from spots
    where sota_summit_ref is not null
    group by sota_summit_ref
    union all
    select wwff_reference, 'WWFF', count(*), count(distinct (callsign, day))
    from spots
    where wwff_reference is not null
    group by wwff_reference
  ),
  top_reference_rows as (
    select * from reference_counts
    order by n desc, reference asc
    limit 8
  ),
  -- The name is looked up only for the eight kept rows: the most recent
  -- non-null pota_park_name or wwff_reference_name by spot_time; SOTA has no name.
  top_reference_names as (
    select r.reference, r.program, r.n, r.activations,
           case when r.program = 'POTA' then (
             select s.pota_park_name
             from spots s
             where s.pota_reference = r.reference and s.pota_park_name is not null
             order by s.spot_time desc
             limit 1
           ) when r.program = 'WWFF' then (
             select s.wwff_reference_name
             from spots s
             where s.wwff_reference = r.reference and s.wwff_reference_name is not null
             order by s.spot_time desc
             limit 1
           ) end as name
    from top_reference_rows r
  ),
  top_references as (
    select coalesce(
             jsonb_agg(
               jsonb_build_object('reference', reference, 'name', name, 'program', program,
                                  'activations', activations, 'spots', n)
               order by n desc, reference asc
             ),
             '[]'::jsonb
           ) as v
    from top_reference_names
  ),
  -- rbn: everything below reads the rollup tables, never rbn_spots. Skimmers
  -- are distinct callsigns over the whole week, counted as stored.
  rbn_skimmer_rows as (
    select spotter, band, spots from rbn_daily_skimmers
    where day >= v_first_day and day < v_end_day
  ),
  rbn_totals as (
    select (select coalesce(sum(spots), 0) from rbn_hourly
             where hour >= v_window_start and hour < v_window_end) as spots,
           (select count(distinct spotter) from rbn_skimmer_rows)  as skimmers
  ),
  -- RBN bands: the same fixed order as bands, zero-filled, so the three band
  -- charts share an axis. Other bands and null are counted in spots only.
  rbn_band_counts as (
    select band, sum(spots) as n from rbn_skimmer_rows where band is not null group by band
  ),
  rbn_bands as (
    select jsonb_agg(jsonb_build_object('band', bo.band, 'spots', coalesce(c.n, 0)) order by bo.ord) as v
    from band_order bo
    left join rbn_band_counts c using (band)
  ),
  rbn as (
    select jsonb_build_object(
             'spots', t.spots, 'skimmers', t.skimmers,
             'bands', b.v,
             'topStations', coalesce(
               (select jsonb_agg(
                         jsonb_build_object('callsign', callsign, 'spots', spots, 'skimmers', skimmers)
                         order by spots desc, callsign asc
                       )
                from rbn_top_stations
                where window_start = v_window_start),
               '[]'::jsonb
             )
           ) as v
    from rbn_totals t
    cross join rbn_bands b
  ),
  -- aprs: packets from aprs_packet_hours, the rest from the day rollups; never
  -- aprs_packets. Stations and igates are distinct over the whole week.
  aprs_type_order as (
    select unnest(array[
      'position', 'mic_e', 'object', 'item', 'message', 'status', 'weather',
      'telemetry', 'nmea', 'third_party', 'capabilities', 'query', 'user_defined', 'other'
    ]) as type
  ),
  aprs_type_counts as (
    select packet_type as type, sum(packets) as n
    from aprs_daily_types
    where day >= v_first_day and day < v_end_day
    group by 1
  ),
  aprs as (
    select jsonb_build_object(
             'packets', (select coalesce(sum(packets), 0) from aprs_packet_hours
                         where hour_start >= v_window_start and hour_start < v_window_end),
             'stations', (select count(distinct base) from aprs_daily_stations
                          where day >= v_first_day and day < v_end_day),
             'igates', (select count(distinct igate) from aprs_daily_igates
                        where day >= v_first_day and day < v_end_day),
             'types', (select jsonb_agg(jsonb_build_object('type', o.type, 'packets', coalesce(c.n, 0))
                                        order by coalesce(c.n, 0) desc, o.type asc)
                       from aprs_type_order o
                       left join aprs_type_counts c using (type))
           ) as v
  )
  -- Every CTE above is a single-row aggregate, so the cross joins yield one row.
  select
    v_window_start,
    v_window_end,
    jsonb_build_object(
      'totals', jsonb_build_object(
        'spots', t.spots, 'potaSpots', t.pota_spots, 'sotaSpots', t.sota_spots, 'wwffSpots', t.wwff_spots,
        'activators', t.activators, 'references', t.references,
        'activations', t.pota_activations + t.sota_activations + t.wwff_activations,
        'potaActivations', t.pota_activations, 'sotaActivations', t.sota_activations,
        'wwffActivations', t.wwff_activations,
        'chasers', t.chasers, 'potaChasers', t.pota_chasers, 'sotaChasers', t.sota_chasers,
        'wwffChasers', t.wwff_chasers
      ),
      'peakHour', coalesce((select hour from peak_hour), 0),
      'busiestSlot', coalesce(
        (select jsonb_build_object('day', day, 'hour', hour) from busiest_slot),
        jsonb_build_object('day', to_char(v_window_start at time zone 'utc', 'YYYY-MM-DD'), 'hour', 0)
      ),
      'daily',            d.v,
      'hourly',           h.v,
      'potaByState',      ps.v,
      'countries',        co.v,
      'sotaAssociations', sa.v,
      'wwffPrograms',     wp.v,
      'bands',            b.v,
      'modes',            m.v,
      'topActivators',    ta.v,
      'topReferences',    tr.v,
      'rbn',              r.v,
      'aprs',             ap.v
    )
  from totals t
  cross join daily d
  cross join hourly h
  cross join pota_by_state ps
  cross join countries co
  cross join sota_associations sa
  cross join wwff_programs wp
  cross join bands b
  cross join modes m
  cross join top_activators ta
  cross join top_references tr
  cross join rbn r
  cross join aprs ap;

  -- Keep the 48 most recent snapshots (two days at one per hour).
  delete from stats_snapshots
  where id not in (
    select id from stats_snapshots
    order by generated_at desc, id desc
    limit 48
  );
end;
$$;

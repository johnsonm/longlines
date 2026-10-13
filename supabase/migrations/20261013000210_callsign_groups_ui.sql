-- Callsign groups, revised to the UI mocks (docs/superpowers/specs/
-- 2026-10-13-callsign-groups-design.md, Section 1b):
--
-- - Members are stored as base calls, so KK4PWJ also matches KK4PWJ/P.
-- - normalize_group_callsigns() is the one normaliser: the dialog's Type, Paste
--   and CSV tabs call it to show what will be stored, and the save uses it.
-- - save_callsign_group() replaces the name and the whole member list in one
--   call, up to 1,000 calls. It replaces create, rename, add and remove, which
--   no client ever shipped.
-- - list_callsign_groups() returns every member and who is on the air now, so
--   the web needs no paged member read.

-- Rewrites members to base calls. A group keeps one row per base call, and a
-- call whose base fails the callsign rule goes (W1AW/12345 has base 12345). Run
-- here over the rows written before this migration, and again by any migration
-- that changes base_callsign() (CLAUDE.md, "Callsign rollup rules"), before the
-- base-call check can hold.
create function public.rebase_callsign_group_members()
returns void
language sql
set search_path = public
as $$
  with ranked as (
    select m.group_id, m.callsign, public.base_callsign(m.callsign) as base,
           row_number() over (partition by m.group_id, public.base_callsign(m.callsign)
                              order by m.callsign = public.base_callsign(m.callsign) desc, m.callsign) as n
    from callsign_group_members m
  )
  delete from callsign_group_members m
  using ranked r
  where m.group_id = r.group_id and m.callsign = r.callsign
    and (r.n > 1 or r.base !~ '^[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}[A-Z](/[A-Z0-9]+)?$');

  update callsign_group_members m set callsign = public.base_callsign(m.callsign)
  where m.callsign <> public.base_callsign(m.callsign);
$$;

revoke all on function public.rebase_callsign_group_members() from public;

select public.rebase_callsign_group_members();

alter table callsign_group_members
  add constraint callsign_group_members_base_call check (callsign = public.base_callsign(callsign));

drop function public.create_callsign_group(text);
drop function public.rename_callsign_group(uuid, text);
drop function public.add_group_callsigns(uuid, text[]);
drop function public.remove_group_callsigns(uuid, text[]);

-- Trims any whitespace (trim() alone strips only spaces; pastes and CSV cells
-- bring tabs, line ends and non-breaking spaces) and uppercases, then checks
-- the value as typed against the profiles.callsign rule (CALLSIGN_RE in
-- web/src/lib/callsign.ts). A valid call maps to its base call; one whose base
-- fails the rule is rejected too, since it could not be stored. Blanks are
-- skipped. "callsigns" is de-duplicated and alphabetical; "rejected" keeps the
-- order given, once each. Definer because base_callsign() is not granted to
-- clients.
create function public.normalize_group_callsigns(p_calls text[])
returns jsonb
language sql
immutable
security definer
set search_path = public
as $$
  with given as (
    select upper(btrim(x, E' \t\n\r\f\x0b ')) as c, min(i) as i
    from unnest(coalesce(p_calls, '{}')) with ordinality as t(x, i)
    group by 1
  ),
  checked as (
    select c, i, public.base_callsign(c) as base,
           c ~ re and public.base_callsign(c) ~ re as valid
    from given, (select '^[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}[A-Z](/[A-Z0-9]+)?$' as re) r
    where c <> ''
  )
  select jsonb_build_object(
    'callsigns', to_jsonb(array(select distinct base from checked where valid order by base)),
    'rejected', to_jsonb(array(select c from checked where not valid order by i)));
$$;

-- Creates the group when payload has no id, otherwise replaces its name and
-- members. The list is the whole list: a missing "callsigns" means none. Any
-- rejected call refuses the save, naming the first. Members change by diff, so
-- rows that stay are not rewritten. The update locks the group row, which
-- delete_callsign_group also takes.
create function public.save_callsign_group(payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_id    uuid := (payload ->> 'id')::uuid;
  v_name  text := trim(coalesce(payload ->> 'name', ''));
  v_norm  jsonb;
  v_calls text[];
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  if v_name = '' then
    raise exception 'Give the group a name.';
  end if;

  v_norm := public.normalize_group_callsigns(
    array(select jsonb_array_elements_text(coalesce(payload -> 'callsigns', '[]'::jsonb))));
  if jsonb_array_length(v_norm -> 'rejected') > 0 then
    raise exception 'Not a callsign: %.', v_norm -> 'rejected' ->> 0;
  end if;
  v_calls := array(select jsonb_array_elements_text(v_norm -> 'callsigns'));
  if cardinality(v_calls) > 1000 then
    raise exception 'A group can hold up to 1,000 callsigns.';
  end if;

  if v_id is null then
    insert into callsign_groups (user_id, name) values (v_user, v_name) returning id into v_id;
  else
    -- set_updated_at bumps updated_at even when only members change.
    update callsign_groups g set name = v_name where g.id = v_id and g.user_id = v_user;
    if not found then
      raise exception 'Group not found.';
    end if;
  end if;

  delete from callsign_group_members m where m.group_id = v_id and m.callsign <> all (v_calls);
  insert into callsign_group_members (group_id, callsign)
  select v_id, c from unnest(v_calls) as c
  on conflict do nothing;

  return v_id;
exception
  when unique_violation then
    raise exception 'You already have a group with that name.';
end;
$$;

-- New return type, so drop and recreate. on_air counts the members with a
-- raw_spots row (POTA, SOTAwatch, DX Cluster, and RBN copies of watched calls)
-- in the last 30 minutes, matched on base_callsign, and carries the newest of
-- those spots. Both sides are indexed: a small group probes
-- raw_spots_base_callsign_time_idx per member, and a large one reads the
-- 30-minute window through raw_spots_spot_time_idx instead.
drop function public.list_callsign_groups();

create function public.list_callsign_groups()
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
              'source', r.source, 'reference', coalesce(r.pota_reference, r.sota_summit_ref),
              'spot_time', r.spot_time)
            order by r.spot_time desc, r.id desc))[1] as latest
    from callsign_group_members cm
    join raw_spots r on r.base_callsign = cm.callsign and r.spot_time > now() - interval '30 minutes'
    where cm.group_id = g.id
  ) a
  where g.user_id = v_user
  order by lower(g.name);
end;
$$;

revoke all on function public.normalize_group_callsigns(text[]) from public;
revoke all on function public.save_callsign_group(jsonb) from public;
revoke all on function public.list_callsign_groups() from public;
grant execute on function public.normalize_group_callsigns(text[]) to authenticated;
grant execute on function public.save_callsign_group(jsonb) to authenticated;
grant execute on function public.list_callsign_groups() to authenticated;

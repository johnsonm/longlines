-- Callsign groups: a user's named lists of callsigns, which subscriptions can
-- point at instead of retyping calls (docs/superpowers/specs/
-- 2026-10-13-callsign-groups-design.md, Section 1).
--
-- Clients read groups and members directly (own rows only) and write only
-- through the RPCs below, like subscriptions and destinations.
--
-- subscriptions.group_ids is stored and ownership-checked here but not yet
-- matched: spot_matches, watched_among and preview_subscription ignore it until
-- 20261013000110.

create table callsign_groups (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null check (name = trim(name) and name <> ''),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Names are unique per account regardless of case. Also serves lookups by user.
create unique index callsign_groups_user_name_key on callsign_groups (user_id, lower(name));

create trigger callsign_groups_set_updated_at
  before update on callsign_groups
  for each row execute function public.set_updated_at();

-- Callsigns follow the profiles.callsign rule (CALLSIGN_RE in
-- web/src/lib/callsign.ts), which also means uppercase and trimmed.
create table callsign_group_members (
  group_id  uuid not null references callsign_groups(id) on delete cascade,
  callsign  text not null check (callsign ~ '^[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}[A-Z](/[A-Z0-9]+)?$'),
  primary key (group_id, callsign)
);

-- The matcher probes members by callsign.
create index callsign_group_members_callsign_idx on callsign_group_members (callsign, group_id);

-- An array rather than a join table: preview_subscription matches an unsaved
-- row built from the dialog's filter, the same way as sources and bands. With
-- no foreign key, save_subscription checks ownership and delete_callsign_group
-- refuses a group still in use.
alter table subscriptions add column group_ids uuid[] not null default '{}';

-- Access: read own rows; every write goes through an RPC.
alter table callsign_groups enable row level security;
alter table callsign_group_members enable row level security;

revoke all on callsign_groups from anon, authenticated;
revoke all on callsign_group_members from anon, authenticated;
grant select on callsign_groups to authenticated;
grant select on callsign_group_members to authenticated;

-- (select auth.uid()) runs once per query rather than once per row; a group
-- can hold tens of thousands of members.
create policy callsign_groups_select_own on callsign_groups
  for select to authenticated using (user_id = (select auth.uid()));
create policy callsign_group_members_select_own on callsign_group_members
  for select to authenticated
  using (exists (select 1 from callsign_groups g where g.id = group_id and g.user_id = (select auth.uid())));

create function public.create_callsign_group(p_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_name text := trim(coalesce(p_name, ''));
  v_id   uuid;
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  if v_name = '' then
    raise exception 'Give the group a name.';
  end if;
  insert into callsign_groups (user_id, name) values (v_user, v_name) returning id into v_id;
  return v_id;
exception
  when unique_violation then
    raise exception 'You already have a group with that name.';
end;
$$;

create function public.rename_callsign_group(p_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_name text := trim(coalesce(p_name, ''));
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  if v_name = '' then
    raise exception 'Give the group a name.';
  end if;
  update callsign_groups g set name = v_name where g.id = p_id and g.user_id = v_user;
  if not found then
    raise exception 'Group not found.';
  end if;
exception
  when unique_violation then
    raise exception 'You already have a group with that name.';
end;
$$;

-- Refused while any subscription still lists the group. The row lock pairs
-- with the key-share lock in save_subscription, so a subscription saved
-- concurrently either sees the group gone or is seen by the check.
create function public.delete_callsign_group(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  perform 1 from callsign_groups g where g.id = p_id and g.user_id = v_user for update;
  if not found then
    raise exception 'Group not found.';
  end if;
  if exists (select 1 from subscriptions s where p_id = any (s.group_ids)) then
    raise exception 'Remove it from its subscriptions first.';
  end if;
  delete from callsign_groups g where g.id = p_id;
end;
$$;

-- One RPC for typing, pasting and CSV import; the client sends large imports
-- in chunks of 2,000. Values are trimmed of any whitespace (trim() alone
-- strips only spaces; pastes and CSV cells bring tabs, line ends and
-- non-breaking spaces) and uppercased. Blanks are skipped; values that fail
-- the callsign rule come back in "rejected" rather than raising. "already"
-- counts valid calls that were in the group before this call.
create function public.add_group_callsigns(p_id uuid, p_calls text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user     uuid := auth.uid();
  v_valid    text[];
  v_rejected text[];
  v_added    int;
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  -- Ownership check, row lock and updated_at bump in one statement.
  update callsign_groups g set updated_at = now() where g.id = p_id and g.user_id = v_user;
  if not found then
    raise exception 'Group not found.';
  end if;

  select
    coalesce(array_agg(c order by c) filter (where c ~ '^[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}[A-Z](/[A-Z0-9]+)?$'), '{}'),
    coalesce(array_agg(c order by c) filter (where c !~ '^[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}[A-Z](/[A-Z0-9]+)?$'), '{}')
  into v_valid, v_rejected
  from (
    select distinct upper(btrim(x, E' \t\n\r\f\x0b\u00a0')) as c
    from unnest(coalesce(p_calls, '{}')) as x
    where btrim(x, E' \t\n\r\f\x0b\u00a0') <> ''
  ) t;

  insert into callsign_group_members (group_id, callsign)
  select p_id, c from unnest(v_valid) as c
  on conflict do nothing;
  get diagnostics v_added = row_count;

  return jsonb_build_object(
    'added', v_added,
    'already', cardinality(v_valid) - v_added,
    'rejected', to_jsonb(v_rejected));
end;
$$;

create function public.remove_group_callsigns(p_id uuid, p_calls text[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user    uuid := auth.uid();
  v_removed int;
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  update callsign_groups g set updated_at = now() where g.id = p_id and g.user_id = v_user;
  if not found then
    raise exception 'Group not found.';
  end if;

  delete from callsign_group_members m
  where m.group_id = p_id
    and m.callsign = any (select upper(btrim(x, E' \t\n\r\f\x0b\u00a0')) from unnest(coalesce(p_calls, '{}')) as x);
  get diagnostics v_removed = row_count;
  return v_removed;
end;
$$;

create function public.list_callsign_groups()
returns table (id uuid, name text, member_count bigint, subscription_count bigint, updated_at timestamptz)
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
    (select count(*) from callsign_group_members m where m.group_id = g.id),
    (select count(*) from subscriptions s where s.user_id = v_user and g.id = any (s.group_ids)),
    g.updated_at
  from callsign_groups g
  where g.user_id = v_user
  order by lower(g.name);
end;
$$;

revoke all on function public.create_callsign_group(text) from public;
revoke all on function public.rename_callsign_group(uuid, text) from public;
revoke all on function public.delete_callsign_group(uuid) from public;
revoke all on function public.add_group_callsigns(uuid, text[]) from public;
revoke all on function public.remove_group_callsigns(uuid, text[]) from public;
revoke all on function public.list_callsign_groups() from public;
grant execute on function public.create_callsign_group(text) to authenticated;
grant execute on function public.rename_callsign_group(uuid, text) to authenticated;
grant execute on function public.delete_callsign_group(uuid) to authenticated;
grant execute on function public.add_group_callsigns(uuid, text[]) to authenticated;
grant execute on function public.remove_group_callsigns(uuid, text[]) to authenticated;
grant execute on function public.list_callsign_groups() to authenticated;

-- save_subscription: same as 20261006000003 plus group_ids, each of which must
-- be the caller's. The key-share lock keeps a group from being deleted between
-- this check and the commit (see delete_callsign_group). An update without a
-- group_ids key keeps the subscription's groups, so a client that predates
-- groups cannot drop them.
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
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  if v_name = '' then
    raise exception 'Give the subscription a name.';
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
      coalesce((payload ->> 'quiet_minutes')::int, 10),
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
        quiet_minutes = coalesce((payload ->> 'quiet_minutes')::int, s.quiet_minutes),
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

-- An RBN-only subscription needs stations to watch: typed callsigns or a group
-- (20261011000001 required callsigns). Matching groups comes in 20261013000110.
create or replace function public.subscriptions_rbn_needs_callsign()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.sources = array['rbn'] and cardinality(new.callsigns) = 0 and cardinality(new.group_ids) = 0 then
    raise exception 'RBN reports stations by callsign. Add at least one callsign.';
  end if;
  return new;
end;
$$;

-- preview_subscription: same as 20261006000014; the row it builds gains the
-- new last column. Groups are not read from the filter until 20261013000110.
create or replace function public.preview_subscription(filter jsonb)
returns table (count bigint, spots jsonb)
language sql
stable
security definer
set search_path = public
as $$
  with sub as (
    select (
      gen_random_uuid(), auth.uid(), '', true,
      public.jsonb_text_array(filter -> 'sources', 'lower'),
      public.jsonb_text_array(filter -> 'bands', 'none'),
      public.jsonb_text_array(filter -> 'modes', 'lower'),
      public.jsonb_text_array(filter -> 'callsigns', 'upper'),
      trim(coalesce(filter ->> 'reference', '')),
      0, now(), now(),
      '{}'::uuid[]
    )::subscriptions as s
  ),
  recent as (
    select r.* from raw_spots r
    where r.spot_time > now() - interval '24 hours'
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
    ), '[]'::jsonb)
  where auth.uid() is not null;
$$;

-- Callsign groups, part 2: matching
-- (docs/superpowers/specs/2026-10-13-callsign-groups-design.md, Section 2).
--
-- A subscription's callsign filter is the union of its typed calls and the
-- members of its groups. The filter is off only when it has neither, so a
-- subscription whose groups are all empty matches nothing, never every
-- station. Membership is an exists test: a call in two of a subscription's
-- groups is still one match, and match_pending_spots (unchanged) makes one
-- delivery per (destination, spot) as before.

-- Members are stored as base calls, so the spot's base call is the only probe
-- and the (callsign, group_id) index serves it. The subquery means Postgres
-- never inlines this function, so spot_matches calls it last and only for a
-- subscription that has groups. Invoker: its callers are definer functions.
create function public.group_matches(p_group_ids uuid[], p_base text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select cardinality(p_group_ids) > 0
     and exists (
       select 1 from public.callsign_group_members m
       where m.callsign = p_base and m.group_id = any (p_group_ids));
$$;
revoke all on function public.group_matches(uuid[], text) from public;

-- spot_matches: as in 20261012000010, plus groups. Stable now that it reads a
-- table through group_matches; it still has one expression and calls only
-- functions, so it stays inlinable (and unpinned, see 20261012000120). The
-- RBN guard counts groups: a group is a list of callsigns. The callsign clause
-- moves last so the cheap checks run before any group lookup.
create or replace function public.spot_matches(sub subscriptions, spot raw_spots)
returns boolean
language sql
stable
as $$
  select coalesce(
        public.source_matches(sub.sources, spot.source)
    and (spot.source <> 'rbn' or cardinality(sub.callsigns) > 0 or cardinality(sub.group_ids) > 0)
    and (cardinality(sub.bands)     = 0 or spot.band     = any (sub.bands))
    and (cardinality(sub.modes)     = 0 or spot.mode     = any (sub.modes)
                                        or spot.mode_family = any (sub.modes))
    and (sub.reference = '' or position(lower(sub.reference) in
           lower(concat_ws(',', spot.pota_reference, spot.pota_location, spot.sota_summit_ref))) > 0)
    and ((cardinality(sub.callsigns) = 0 and cardinality(sub.group_ids) = 0)
         or public.callsign_matches(sub.callsigns, spot.callsign, spot.base_callsign)
         or (cardinality(sub.group_ids) > 0 and public.group_matches(sub.group_ids, spot.base_callsign))),
    false);
$$;

-- watched_among: as in 20261012000010, plus group members. It runs on every
-- RBN firehose batch, so the group arm starts from the member index: one probe
-- per distinct base call in the batch, then a hashed check against the groups
-- that enabled subscriptions accepting p_source use. `members` is materialized
-- because, left to the planner, it probed the index once per (call, watched
-- group) pair: 560k probes and ~800 ms for 1,000 calls in the Section 2
-- check, against ~65 ms this way. A GIN index on group_ids would not help:
-- subscriptions are read once per call here, not searched by group.
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
  members as materialized (
    select m.callsign, m.group_id
    from callsign_group_members m
    where m.callsign in (select x.b from batch x)
  ),
  watched_bases as (
    select distinct mm.callsign
    from members mm
    where mm.group_id in (
      select g.id
      from subscriptions s
      cross join lateral unnest(s.group_ids) as g(id)
      where s.enabled and public.source_matches(s.sources, p_source))
  )
  select x.c
  from batch x
  where x.b in (select w.callsign from watched_bases w)
     or exists (
          select 1 from subscriptions s
          where s.enabled
            and public.source_matches(s.sources, p_source)
            and public.callsign_matches(s.callsigns, x.c, x.b))
  order by x.c;
$$;

-- preview_subscription: as in 20261013000100, plus groups and station_count,
-- so it is dropped and recreated for the new return type. Only the caller's
-- own group ids reach the row it builds; any other id, malformed ones
-- included, is ignored, so preview cannot probe another user's groups.
-- station_count is the number of distinct base calls across the typed calls
-- and the members of those groups.
drop function public.preview_subscription(jsonb);

create function public.preview_subscription(filter jsonb)
returns table (count bigint, spots jsonb, station_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  with own_groups as (
    select coalesce(array_agg(g.id), '{}'::uuid[]) as ids
    from callsign_groups g
    where g.user_id = auth.uid()
      and g.id::text = any (public.jsonb_text_array(filter -> 'group_ids', 'lower'))
  ),
  sub as (
    select (
      gen_random_uuid(), auth.uid(), '', true,
      public.jsonb_text_array(filter -> 'sources', 'lower'),
      public.jsonb_text_array(filter -> 'bands', 'none'),
      public.jsonb_text_array(filter -> 'modes', 'lower'),
      public.jsonb_text_array(filter -> 'callsigns', 'upper'),
      trim(coalesce(filter ->> 'reference', '')),
      0, now(), now(),
      o.ids
    )::subscriptions as s
    from own_groups o
  ),
  stations as (
    select count(distinct t.b) as n
    from (
      select public.base_callsign(c) as b
      from unnest(public.jsonb_text_array(filter -> 'callsigns', 'upper')) as c
      union all
      select m.callsign
      from own_groups o
      join callsign_group_members m on m.group_id = any (o.ids)
    ) t
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
    ), '[]'::jsonb),
    (select n from stations)
  where auth.uid() is not null;
$$;

revoke all on function public.preview_subscription(jsonb) from public;
grant execute on function public.preview_subscription(jsonb) to authenticated;

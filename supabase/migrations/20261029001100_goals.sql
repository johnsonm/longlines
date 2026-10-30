-- Goals: what a ham is still chasing (US states, POTA parks, bands), and the marking that
-- works an entry off from the contacts the operator logs through Long Lines Relay.
-- Design: docs/superpowers/specs/2026-10-29-goals-design.md (Brad's canvas "Connection with
-- goal", Page 1). This migration is the data model and the marking; the goal rule
-- (matching, the preview) and the management API come in later migrations.
--
-- 1. Tables: goals, goal_requirements, goal_entries, goal_reviews. Clients read their own
--    rows (RLS, select only); every write goes through the RPCs below. A list's status is derived
--    (goal_status): complete when completed_at is set, ended when today (UTC) is after
--    ends_on, else active. Dates are UTC days and ends_on is inclusive; every day comparison is
--    (x at time zone 'utc')::date, never ::date or current_date.
-- 2. logged_contacts gains us_state and gridsquare, sent by newer relays and kept out of the
--    content hash (logged_contacts.state already means live or retracted, hence us_state).
-- 3. subscriptions gains no column. A connection names a list in a rule ({field: 'goal',
--    op: 'is', values: [id]}); rules_goal_ids reads them for the delete guard and the counts.
--    group_ids is a cache from before rules existed, and a goal_ids column would need
--    patch_subscription, api_subscription_json and the preview's unsaved record to strip it too.
-- 4. account_object_cap: as in 20261029000200, with 50 goals per account.
-- 5. Marking, in SQL only: goal_contact_facts (what one contact proves: its band, the park of
--    the POTA spot that station had within 30 minutes either side, its state), goal_mark,
--    goal_sync_reviews, goal_apply_contact (one new contact) and goal_recheck (a whole list,
--    from scratch, set-based).
-- 6. The client RPCs: list_goals, get_goal, save_goal, delete_goal,
--    mark_goal_entry, resolve_goal_review, copy_goal.
-- 7. apply_logged_contacts: as in 20261029000600, storing us_state and gridsquare, applying each
--    stored contact to the account's lists and rechecking the lists a retracted spot had marked.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

-- The 50 states by name (no DC: "All 50 states"), the order the web lists them in.
create function public.us_states()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN',
               'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV',
               'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN',
               'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY']
$$;

revoke all on function public.us_states() from public;

-- The band names raw_spots.band can hold: BANDS in supabase/functions/_shared/bands.ts, in its
-- order (bands.test.ts compares the two).
create function public.goal_bands()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['2200m', '600m', '160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m',
               '11m', '10m', '8m', '6m', '4m', '2m', '1.25m', '70cm', '23cm', '13cm', '9cm', '6cm',
               '3cm_qo100', '3cm']
$$;

revoke all on function public.goal_bands() from public;

create table goals (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references auth.users (id) on delete cascade,
  name         text        not null check (name = trim(name) and name <> ''),
  starts_on    date,
  ends_on      date,
  marking      text        not null default 'relay' check (marking in ('relay', 'hand')),
  completed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check ((starts_on is null) = (ends_on is null)),
  check (ends_on >= starts_on)
);

-- Names are unique per account regardless of case, as callsign_groups_user_name_key. Also serves
-- lookups by user.
create unique index goals_user_name_key on goals (user_id, lower(name));

create trigger goals_set_updated_at
  before update on goals
  for each row execute function public.set_updated_at();

comment on table goals is
  'What an account is still chasing. Written only by the goal RPCs; clients read their own rows.';
comment on column goals.starts_on is
  'First UTC day whose contacts count; null with ends_on for no end date.';
comment on column goals.ends_on is
  'Last UTC day whose contacts count (inclusive); the list is ended once today (UTC) is after it.';
comment on column goals.marking is
  'relay: logged contacts mark entries worked (and hand marks still count); hand: only hand marks.';
comment on column goals.completed_at is
  'Set by goal_refresh_completion when every requirement is complete, cleared when one is not.';

create table goal_requirements (
  id            uuid not null primary key default gen_random_uuid(),
  list_id       uuid not null references goals (id) on delete cascade,
  position      int  not null,
  kind          text not null check (kind in ('state', 'park', 'band')),
  complete_when text not null check (complete_when in ('all', 'at_least')),
  at_least      int  check (at_least >= 1),
  check ((complete_when = 'at_least') = (at_least is not null))
);

create index goal_requirements_list_idx on goal_requirements (list_id, position);

comment on table goal_requirements is
  'One kind of entry a goal chases and when it is complete: all entries worked, or at_least of them.';

-- value is a us_states() code (state), an upper-cased POTA reference (park, not necessarily in
-- reference_catalog) or a goal_bands() name (band); save_goal checks it by kind.
create table goal_entries (
  requirement_id  uuid        not null references goal_requirements (id) on delete cascade,
  value           text        not null,
  position        int         not null,
  worked_at       timestamptz,
  worked_how      text        check (worked_how in ('contact', 'hand')),
  contact_spot_id bigint      references raw_spots (id),
  matched_spot_id bigint      references raw_spots (id),
  hand_needed_at  timestamptz,
  primary key (requirement_id, value),
  check ((worked_at is null) = (worked_how is null)),
  check ((worked_how = 'contact') = (contact_spot_id is not null)),
  check (matched_spot_id is null or worked_how = 'contact')
);

-- The retraction hook finds the lists a spot marked.
create index goal_entries_contact_spot_idx on goal_entries (contact_spot_id) where contact_spot_id is not null;
create index goal_entries_matched_spot_idx on goal_entries (matched_spot_id) where matched_spot_id is not null;

comment on column goal_entries.contact_spot_id is
  'The logged contact (raw_spots, source logged) that worked the entry; null for a hand mark.';
comment on column goal_entries.matched_spot_id is
  'The POTA spot a park, or a state from its location, came from; null otherwise.';
comment on column goal_entries.hand_needed_at is
  'When the entry was set back to needed by hand: only a contact logged after it marks the entry again.';

create table goal_reviews (
  id               uuid        primary key default gen_random_uuid(),
  list_id          uuid        not null references goals (id) on delete cascade,
  contact_spot_id  bigint      not null references raw_spots (id),
  candidates       text[]      not null default '{}',
  status           text        not null default 'open' check (status in ('open', 'picked', 'not_park')),
  picked_reference text,
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz,
  unique (list_id, contact_spot_id),
  check ((status = 'picked') = (picked_reference is not null)),
  check ((status = 'open') = (resolved_at is null))
);

create index goal_reviews_contact_spot_idx on goal_reviews (contact_spot_id);

comment on table goal_reviews is
  'A logged contact whose park could not be told (no POTA spot of that station within 30 minutes, '
  'or spots at two parks) while the station had a POTA spot that UTC day. Resolved rows are kept '
  'so a recheck never opens them again.';

alter table goals enable row level security;
alter table goal_requirements enable row level security;
alter table goal_entries enable row level security;
alter table goal_reviews enable row level security;

revoke all on goals, goal_requirements, goal_entries, goal_reviews from anon, authenticated;
grant select on goals, goal_requirements, goal_entries, goal_reviews to authenticated;

create policy goals_select_own on goals
  for select to authenticated using (user_id = (select auth.uid()));
create policy goal_requirements_select_own on goal_requirements
  for select to authenticated
  using (exists (select 1 from goals l where l.id = list_id and l.user_id = (select auth.uid())));
create policy goal_entries_select_own on goal_entries
  for select to authenticated
  using (exists (select 1 from goal_requirements r join goals l on l.id = r.list_id
                 where r.id = requirement_id and l.user_id = (select auth.uid())));
create policy goal_reviews_select_own on goal_reviews
  for select to authenticated
  using (exists (select 1 from goals l where l.id = list_id and l.user_id = (select auth.uid())));

-- ---------------------------------------------------------------------------
-- 2. logged_contacts: state and grid from the relay
-- ---------------------------------------------------------------------------

alter table logged_contacts
  add column us_state text check (us_state ~ '^[A-Z]{2}$'),
  add column gridsquare text check (gridsquare ~ '^[A-R]{2}[0-9]{2}([A-X]{2}([0-9]{2})?)?$');

comment on column logged_contacts.us_state is
  'The worked station''s state as the relay sent it (two letters, upper case), or null. Not content: '
  'it stays out of the hash. Marking uses it when it is one of us_states().';
comment on column logged_contacts.gridsquare is
  'The worked station''s Maidenhead locator as the relay sent it (4 to 8 characters, upper case), '
  'or null. Stored only; nothing reads it yet.';

-- ---------------------------------------------------------------------------
-- 3. Connections that name a list
-- ---------------------------------------------------------------------------

-- The goals a connection's rules name. Tolerates any jsonb, so a reader never raises on a
-- stored rule set.
create function public.rules_goal_ids(p_rules jsonb)
returns uuid[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(distinct v::uuid), '{}')
  from jsonb_array_elements(case jsonb_typeof(p_rules) when 'array' then p_rules else '[]' end) as g
  cross join lateral jsonb_array_elements(case jsonb_typeof(g) when 'array' then g else '[]' end) as r
  cross join lateral jsonb_array_elements_text(
    case when jsonb_typeof(r) = 'object' and jsonb_typeof(r -> 'values') = 'array' then r -> 'values' else '[]' end) as v
  where r ->> 'field' = 'goal'
    and v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;

revoke all on function public.rules_goal_ids(jsonb) from public;

-- ---------------------------------------------------------------------------
-- 4. Account caps
-- ---------------------------------------------------------------------------

-- account_object_cap: as in 20261029000200, with a goals branch.
create or replace function public.account_object_cap()
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
  elsif tg_table_name = 'goals' then
    select count(*) into v_count from goals t where t.user_id = new.user_id;
    if v_count >= 50 then
      raise exception 'You can have up to 50 goals.';
    end if;
  else
    raise exception 'account_object_cap has no cap for %.', tg_table_name;
  end if;
  return new;
end;
$$;

create trigger goals_account_cap
before insert on goals
for each row execute function public.account_object_cap();

-- ---------------------------------------------------------------------------
-- 5. Status, progress and marking
-- ---------------------------------------------------------------------------

-- complete, ended (today in UTC is after ends_on) or active. Before starts_on a list is active:
-- its rule filters, and contacts before the start do not count.
create function public.goal_status(p goals)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p.completed_at is not null then 'complete'
    when p.ends_on is not null and (now() at time zone 'utc')::date > p.ends_on then 'ended'
    else 'active'
  end
$$;

revoke all on function public.goal_status(goals) from public;

-- Each requirement of a list with its counts. target is the entry count for "all" and at_least
-- otherwise; complete is worked >= target.
create function public.goal_requirement_progress(p_list_id uuid)
returns table (id uuid, kind text, complete_when text, at_least int, "position" int,
               entries int, worked int, target int, complete boolean)
language sql
stable
set search_path = public
as $$
  select r.id, r.kind, r.complete_when, r.at_least, r.position,
         t.entries, t.worked, t.target, t.worked >= t.target
  from goal_requirements r
  cross join lateral (
    select count(*)::int as entries, count(e.worked_at)::int as worked,
           coalesce(r.at_least, count(*)::int) as target
    from goal_entries e
    where e.requirement_id = r.id
  ) t
  where r.list_id = p_list_id
$$;

revoke all on function public.goal_requirement_progress(uuid) from public;

-- All entries worked, or at least at_least of them.
create function public.goal_requirement_complete(p_requirement_id uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select count(e.worked_at) >= coalesce(r.at_least, count(e.requirement_id))
  from goal_requirements r
  left join goal_entries e on e.requirement_id = r.id
  where r.id = p_requirement_id
  group by r.id, r.at_least
$$;

revoke all on function public.goal_requirement_complete(uuid) from public;

-- Sets completed_at when every requirement is complete and clears it otherwise; a list that stays
-- complete keeps its first completed_at.
create function public.goal_refresh_completion(p_list_id uuid)
returns void
language sql
set search_path = public
as $$
  update goals l
  set completed_at = case when d.done then coalesce(l.completed_at, now()) end
  from (select coalesce(bool_and(q.complete), false) as done
        from public.goal_requirement_progress(p_list_id) q) d
  where l.id = p_list_id and (l.completed_at is not null) <> d.done
$$;

revoke all on function public.goal_refresh_completion(uuid) from public;

-- What each of an account's live logged contacts proves, or only p_spot_id's when it is given:
--   band           the contact's band
--   candidates     the distinct POTA references of POTA spots of the worked base call within 30
--                  minutes either side of the contact (raw_spots_base_callsign_time_idx)
--   park           the one candidate when there is exactly one, and park_spot_id the nearest of
--                  its spots
--   pota_that_day  whether the station had any POTA spot on the contact's UTC day
--   state          logged_contacts.us_state when it is a state; else the single US state in the
--                  matched POTA spot's pota_location (state_spot_id is that spot); else the FCC
--                  license state of the worked base call. A park in several states gives none of
--                  them, so one contact never marks two states.
create function public.goal_contact_facts(p_user uuid, p_spot_id bigint)
returns table (spot_id bigint, spot_time timestamptz, band text, park text, park_spot_id bigint,
               candidates text[], pota_that_day boolean, state text, state_spot_id bigint)
language sql
stable
set search_path = public
as $$
  select c.id, c.spot_time, c.band, m.reference, m.id, w.candidates, d.pota_that_day,
         coalesce(c.us_state, loc.state, lic.state),
         case when c.us_state is null and loc.state is not null then m.id end
  from (
    select r.id, r.spot_time, r.band, r.base_callsign,
           case when lc.us_state = any (public.us_states()) then lc.us_state end as us_state
    from logged_contacts lc
    join raw_spots r on r.id = lc.spot_id
    where lc.user_id = p_user
      and lc.state = 'live'
      and r.retracted_at is null
      and (p_spot_id is null or lc.spot_id = p_spot_id)
  ) c
  cross join lateral (
    select coalesce(array_agg(distinct upper(p.pota_reference) order by upper(p.pota_reference)), '{}') as candidates
    from raw_spots p
    where p.base_callsign = c.base_callsign
      and p.spot_time between c.spot_time - interval '30 minutes' and c.spot_time + interval '30 minutes'
      and p.source = 'pota'
      and p.pota_reference is not null
      and p.retracted_at is null
  ) w
  left join lateral (
    select p.id, upper(p.pota_reference) as reference, p.pota_location
    from raw_spots p
    where cardinality(w.candidates) = 1
      and p.base_callsign = c.base_callsign
      and p.spot_time between c.spot_time - interval '30 minutes' and c.spot_time + interval '30 minutes'
      and p.source = 'pota'
      and upper(p.pota_reference) = w.candidates[1]
      and p.retracted_at is null
    order by abs(extract(epoch from p.spot_time - c.spot_time)), p.spot_time, p.id
    limit 1
  ) m on true
  cross join lateral (
    select exists (
      select 1 from raw_spots p
      where p.base_callsign = c.base_callsign
        and p.spot_time >= ((c.spot_time at time zone 'utc')::date)::timestamp at time zone 'utc'
        and p.spot_time < ((c.spot_time at time zone 'utc')::date + 1)::timestamp at time zone 'utc'
        and p.source = 'pota'
        and p.retracted_at is null) as pota_that_day
  ) d
  left join lateral (
    select case when count(*) = 1 then min(s.code) end as state
    from (select distinct x[1] as code from regexp_matches(m.pota_location, 'US-([A-Z]{2})', 'g') as x) s
    where s.code = any (public.us_states())
  ) loc on true
  left join lateral (
    select l.state from callsign_licenses l
    where l.callsign = c.base_callsign and l.country = 'US' and l.state = any (public.us_states())
  ) lic on true
$$;

revoke all on function public.goal_contact_facts(uuid, bigint) from public;

-- Marks the needed entries of p_lists (relay lists only) that the account's contacts work: all of
-- its live contacts, or only p_spot_id. A contact counts toward a list when its UTC day is in the
-- list's window, and an entry set back to needed by hand only from a contact logged after that.
-- Each entry takes its earliest contact; under "at least", only as many entries as the
-- requirement still lacks, earliest contacts first. A picked review gives its contact's park.
create function public.goal_mark(p_lists uuid[], p_user uuid, p_spot_id bigint)
returns void
language sql
set search_path = public
as $$
  with f as materialized (
    select * from public.goal_contact_facts(p_user, p_spot_id)
  ),
  fl as (
    select l.id as list_id, f.*
    from goals l
    join f on l.starts_on is null
           or (f.spot_time at time zone 'utc')::date between l.starts_on and l.ends_on
    where l.id = any (p_lists) and l.user_id = p_user and l.marking = 'relay'
  ),
  cand as (
    select r.id as requirement_id, e.value, fl.spot_id, fl.spot_time, null::bigint as matched
    from fl
    join goal_requirements r on r.list_id = fl.list_id and r.kind = 'band'
    join goal_entries e on e.requirement_id = r.id and e.value = fl.band
    union all
    select r.id, e.value, fl.spot_id, fl.spot_time, fl.park_spot_id
    from fl
    join goal_requirements r on r.list_id = fl.list_id and r.kind = 'park'
    join goal_entries e on e.requirement_id = r.id and e.value = fl.park
    union all
    select r.id, e.value, fl.spot_id, fl.spot_time, null::bigint
    from fl
    join goal_reviews v on v.list_id = fl.list_id and v.contact_spot_id = fl.spot_id and v.status = 'picked'
    join goal_requirements r on r.list_id = fl.list_id and r.kind = 'park'
    join goal_entries e on e.requirement_id = r.id and e.value = v.picked_reference
    union all
    select r.id, e.value, fl.spot_id, fl.spot_time, fl.state_spot_id
    from fl
    join goal_requirements r on r.list_id = fl.list_id and r.kind = 'state'
    join goal_entries e on e.requirement_id = r.id and e.value = fl.state
  ),
  earliest as (
    select distinct on (c.requirement_id, c.value) c.*, e.position
    from cand c
    join goal_entries e on e.requirement_id = c.requirement_id and e.value = c.value
    where e.worked_at is null
      and (e.hand_needed_at is null or c.spot_time > e.hand_needed_at)
    order by c.requirement_id, c.value, c.spot_time, c.spot_id
  ),
  ranked as (
    select k.*, row_number() over (partition by k.requirement_id order by k.spot_time, k.spot_id, k.position) as rn
    from earliest k
  ),
  room as (
    select q.id, case when q.complete_when = 'at_least' then q.target - q.worked end as room
    from goals l
    cross join lateral public.goal_requirement_progress(l.id) q
    where l.id = any (p_lists)
  )
  update goal_entries e
  set worked_at = k.spot_time, worked_how = 'contact', contact_spot_id = k.spot_id, matched_spot_id = k.matched
  from ranked k
  join room on room.id = k.requirement_id
  where e.requirement_id = k.requirement_id and e.value = k.value
    and (room.room is null or k.rn <= room.room)
$$;

revoke all on function public.goal_mark(uuid[], uuid, bigint) from public;

-- Opens a review for each contact in a relay list's window whose park can't be told (no POTA spot
-- of that station within 30 minutes but one that UTC day, or spots at two parks) while the list
-- has a park requirement that isn't complete. An open review's candidates follow the spots; a
-- resolved one is never touched. With p_spot_id null (a recheck), open reviews that no longer
-- qualify go.
create function public.goal_sync_reviews(p_lists uuid[], p_user uuid, p_spot_id bigint)
returns void
language sql
set search_path = public
as $$
  with f as materialized (
    select * from public.goal_contact_facts(p_user, p_spot_id)
  ),
  due as (
    select l.id as list_id, f.spot_id, f.candidates
    from goals l
    join f on l.starts_on is null
           or (f.spot_time at time zone 'utc')::date between l.starts_on and l.ends_on
    where l.id = any (p_lists) and l.user_id = p_user and l.marking = 'relay'
      and (cardinality(f.candidates) > 1 or (cardinality(f.candidates) = 0 and f.pota_that_day))
      and exists (select 1 from public.goal_requirement_progress(l.id) q where q.kind = 'park' and not q.complete)
  ),
  gone as (
    delete from goal_reviews v
    where p_spot_id is null
      and v.list_id = any (p_lists)
      and v.status = 'open'
      and not exists (select 1 from due where due.list_id = v.list_id and due.spot_id = v.contact_spot_id)
  )
  insert into goal_reviews (list_id, contact_spot_id, candidates)
  select due.list_id, due.spot_id, due.candidates from due
  on conflict (list_id, contact_spot_id) do update
    set candidates = excluded.candidates
    where goal_reviews.status = 'open'
$$;

revoke all on function public.goal_sync_reviews(uuid[], uuid, bigint) from public;

-- One contact the account just logged (stored or revived by apply_logged_contacts), against
-- every relay list of the account that isn't complete. A list counts it when the contact's UTC
-- day is in its window, so a contact logged late on the last day still counts after midnight.
create function public.goal_apply_contact(p_user uuid, p_spot_id bigint)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_lists uuid[];
  v_list  uuid;
begin
  select array_agg(l.id) into v_lists
  from goals l
  where l.user_id = p_user and l.marking = 'relay' and l.completed_at is null;
  if v_lists is null then
    return;
  end if;
  perform public.goal_mark(v_lists, p_user, p_spot_id);
  perform public.goal_sync_reviews(v_lists, p_user, p_spot_id);
  foreach v_list in array v_lists loop
    perform public.goal_refresh_completion(v_list);
  end loop;
end;
$$;

revoke all on function public.goal_apply_contact(uuid, bigint) from public;

-- Rebuilds a list's contact marks from scratch: clears them (hand marks and hand_needed_at stay),
-- marks again from the account's live contacts in the window, re-applies picked reviews, syncs
-- the open reviews and refreshes completion. Set-based, so save_goal can run it inside the
-- web's statement timeout. Run after a save, a hand mark and a retraction that touched the list.
create function public.goal_recheck(p_list_id uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_user uuid;
begin
  select l.user_id into v_user from goals l where l.id = p_list_id for update;
  if v_user is null then
    return;
  end if;
  update goal_entries e
  set worked_at = null, worked_how = null, contact_spot_id = null, matched_spot_id = null
  from goal_requirements r
  where r.id = e.requirement_id and r.list_id = p_list_id and e.worked_how = 'contact';
  perform public.goal_mark(array[p_list_id], v_user, null);
  perform public.goal_sync_reviews(array[p_list_id], v_user, null);
  perform public.goal_refresh_completion(p_list_id);
end;
$$;

revoke all on function public.goal_recheck(uuid) from public;

-- The lists a spot marked an entry of or holds a review for: what a retraction must recheck.
create function public.goals_for_spot(p_spot_id bigint)
returns uuid[]
language sql
stable
set search_path = public
as $$
  select coalesce(array_agg(distinct t.list_id), '{}')
  from (
    select r.list_id from goal_entries e join goal_requirements r on r.id = e.requirement_id
    where e.contact_spot_id = p_spot_id
    union all
    select r.list_id from goal_entries e join goal_requirements r on r.id = e.requirement_id
    where e.matched_spot_id = p_spot_id
    union all
    select v.list_id from goal_reviews v where v.contact_spot_id = p_spot_id
  ) t
$$;

revoke all on function public.goals_for_spot(bigint) from public;

-- ---------------------------------------------------------------------------
-- 6. Client RPCs
-- ---------------------------------------------------------------------------

-- An entry value checked and normalised for its kind: a state code, a POTA reference (upper
-- case, any reference of that shape) or a band name (lower case, spaces dropped: "20 m" is 20m).
create function public.goal_entry_value(p_kind text, p_value text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_typed text := btrim(coalesce(p_value, ''), E' \t\r\n');
  v       text;
begin
  if p_kind = 'state' then
    v := upper(v_typed);
    if not (v = any (public.us_states())) then
      raise exception 'Not a US state: %.', v_typed;
    end if;
  elsif p_kind = 'park' then
    v := upper(v_typed);
    if v !~ '^[A-Z]{1,4}-[0-9]{3,6}$' then
      raise exception 'Not a POTA reference: %.', v_typed;
    end if;
  elsif p_kind = 'band' then
    v := lower(replace(v_typed, ' ', ''));
    if not (v = any (public.goal_bands())) then
      raise exception 'Not a band: %.', v_typed;
    end if;
  else
    raise exception 'Not a requirement kind: %.', coalesce(p_kind, '');
  end if;
  return v;
end;
$$;

revoke all on function public.goal_entry_value(text, text) from public;

-- A window date as typed: YYYY-MM-DD, or null for none. Stable, as text to date is.
create function public.goal_date(p_value text)
returns date
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_value is null then
    return null;
  end if;
  if p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'Not a date: %.', p_value;
  end if;
  return p_value::date;
exception
  when invalid_datetime_format or datetime_field_overflow then
    raise exception 'Not a date: %.', p_value;
end;
$$;

revoke all on function public.goal_date(text) from public;

-- A list as the index card shows it. worked and total add up the requirements, each counted up
-- to its target ("18 of 64 worked"); needed_by_kind is what incomplete requirements still lack,
-- by kind; connection_count is the owner's connections whose rules name the list.
create function public.goal_card(p goals)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'id', p.id,
    'name', p.name,
    'starts_on', p.starts_on,
    'ends_on', p.ends_on,
    'marking', p.marking,
    'status', public.goal_status(p),
    'completed_at', p.completed_at,
    'requirement_count', t.requirements,
    'worked', t.worked,
    'total', t.total,
    'needed_by_kind', jsonb_build_object('state', t.state, 'park', t.park, 'band', t.band),
    'connection_count', (select count(*) from subscriptions s
                         where s.user_id = p.user_id and p.id = any (public.rules_goal_ids(s.rules))),
    'updated_at', p.updated_at)
  from (
    select count(*)::int as requirements,
           coalesce(sum(least(q.worked, q.target)), 0)::int as worked,
           coalesce(sum(q.target), 0)::int as total,
           coalesce(sum(q.target - least(q.worked, q.target)) filter (where q.kind = 'state'), 0)::int as state,
           coalesce(sum(q.target - least(q.worked, q.target)) filter (where q.kind = 'park'), 0)::int as park,
           coalesce(sum(q.target - least(q.worked, q.target)) filter (where q.kind = 'band'), 0)::int as band
    from public.goal_requirement_progress(p.id) q
  ) t
$$;

revoke all on function public.goal_card(goals) from public;

-- The caller's lists, as cards, by name.
create function public.list_goals()
returns jsonb
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
  return (select coalesce(jsonb_agg(public.goal_card(l) order by lower(l.name), l.id), '[]'::jsonb)
          from goals l where l.user_id = v_user);
end;
$$;

revoke all on function public.list_goals() from public;
grant execute on function public.list_goals() to authenticated;

-- The progress page: the card, each requirement with its entries (park names from the catalog,
-- how each worked entry was marked), the open reviews while a park requirement isn't complete,
-- the relay's state, the connections using the list and the account's first contact.
-- Shape: GoalProgress in web/src/goals/types.ts, pinned by goals.test.sql.
create function public.get_goal(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user   uuid := auth.uid();
  v_list   goals%rowtype;
  v_last   logged_contacts%rowtype;
  v_relays int;
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  select * into v_list from goals l where l.id = p_id and l.user_id = v_user;
  if not found then
    raise exception 'Goal not found.';
  end if;
  select * into v_last from logged_contacts c where c.user_id = v_user order by c.updated_at desc limit 1;
  select count(*) into v_relays from relay_tokens t where t.user_id = v_user;

  return jsonb_build_object(
    'list', public.goal_card(v_list),
    'requirements', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', q.id,
        'kind', q.kind,
        'complete_when', q.complete_when,
        'at_least', q.at_least,
        'position', q.position,
        'complete', q.complete,
        'worked', least(q.worked, q.target),
        'target', q.target,
        'entries', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'value', e.value,
            'label', rc.name,
            'position', e.position,
            'worked_at', e.worked_at,
            'worked_how', e.worked_how,
            'evidence', case when e.worked_how = 'contact' then jsonb_build_object(
              'worked_call', cs.callsign,
              'contact_time', cs.spot_time,
              'logger_app', lc.logger_app,
              'matched_spot_time', ms.spot_time) end)
            order by e.position), '[]'::jsonb)
          from goal_entries e
          left join reference_catalog rc on q.kind = 'park' and rc.program = 'pota' and rc.reference = e.value
          left join raw_spots cs on cs.id = e.contact_spot_id
          left join logged_contacts lc on lc.spot_id = e.contact_spot_id and lc.user_id = v_user
          left join raw_spots ms on ms.id = e.matched_spot_id
          where e.requirement_id = q.id))
        order by q.position, q.id)
      from public.goal_requirement_progress(p_id) q), '[]'::jsonb),
    'reviews', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', v.id,
        'worked_call', s.callsign,
        'band', s.band,
        'mode', s.mode,
        'contact_time', s.spot_time,
        'candidates', (
          select coalesce(jsonb_agg(jsonb_build_object('reference', c.reference, 'name', rc.name) order by c.n), '[]'::jsonb)
          from unnest(v.candidates) with ordinality as c(reference, n)
          left join reference_catalog rc on rc.program = 'pota' and rc.reference = c.reference))
        order by s.spot_time desc, v.id)
      from goal_reviews v
      join raw_spots s on s.id = v.contact_spot_id
      where v.list_id = p_id and v.status = 'open' and s.retracted_at is null
        and exists (select 1 from public.goal_requirement_progress(p_id) q where q.kind = 'park' and not q.complete)),
      '[]'::jsonb),
    'relay', jsonb_build_object(
      'status', case
        when v_last.updated_at > now() - interval '7 days' then 'recent'
        when v_last.updated_at is null and v_relays = 0 then 'never'
        else 'stale' end,
      'last_contact_at', v_last.updated_at,
      'logger_app', v_last.logger_app,
      'relay_count', v_relays),
    'used_by', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id,
        'name', s.name,
        'sources', to_jsonb(s.sources),
        'destination_count', (select count(*) from subscription_destinations sd where sd.subscription_id = s.id))
        order by lower(s.name), s.id)
      from subscriptions s
      where s.user_id = v_user and p_id = any (public.rules_goal_ids(s.rules))), '[]'::jsonb),
    'first_contact_at', (select min(c.created_at) from logged_contacts c where c.user_id = v_user));
end;
$$;

revoke all on function public.get_goal(uuid) from public;
grant execute on function public.get_goal(uuid) to authenticated;

-- A whole list, created (no id) or replaced: {id?, name, starts_on, ends_on, marking,
-- requirements: [{id?, kind, complete_when, at_least, entries: [value]}]}. Entries that stay keep
-- their worked state (by requirement id and value), removed ones go, and the list is rechecked.
-- Returns the list's id.
create function public.save_goal(payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uuid     constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_user     uuid := auth.uid();
  v_id       uuid;
  v_name     text;
  v_starts   date;
  v_ends     date;
  v_marking  text;
  v_reqs     jsonb;
  v_req      jsonb;
  v_req_id   uuid;
  v_kind     text;
  v_when     text;
  v_at_least int;
  v_count    text;
  v_values   text[];
  v_keep     uuid[] := '{}'::uuid[];
  v_pos      int := 0;
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  if jsonb_typeof(payload) is distinct from 'object' then
    raise exception 'Not a goal.';
  end if;

  v_name := trim(coalesce(payload ->> 'name', ''));
  if v_name = '' then
    raise exception 'Give the goal a name.';
  end if;

  v_starts := public.goal_date(payload ->> 'starts_on');
  v_ends := public.goal_date(payload ->> 'ends_on');
  if (v_starts is null) <> (v_ends is null) then
    raise exception 'Give the time window a start and an end date.';
  end if;
  if v_ends < v_starts then
    raise exception 'The end date can''t be before the start date.';
  end if;

  v_marking := coalesce(payload ->> 'marking', 'relay');
  if v_marking not in ('relay', 'hand') then
    raise exception 'Not a way to mark entries: %.', v_marking;
  end if;

  v_reqs := payload -> 'requirements';
  if jsonb_typeof(v_reqs) is distinct from 'array' or jsonb_array_length(v_reqs) = 0 then
    raise exception 'Add at least one requirement.';
  end if;
  if jsonb_array_length(v_reqs) > 10 then
    raise exception 'A goal takes at most 10 requirements.';
  end if;

  if payload ->> 'id' is not null then
    if payload ->> 'id' !~ v_uuid then
      raise exception 'Goal not found.';
    end if;
    v_id := (payload ->> 'id')::uuid;
    update goals l
    set name = v_name, starts_on = v_starts, ends_on = v_ends, marking = v_marking
    where l.id = v_id and l.user_id = v_user;
    if not found then
      raise exception 'Goal not found.';
    end if;
  else
    insert into goals (user_id, name, starts_on, ends_on, marking)
    values (v_user, v_name, v_starts, v_ends, v_marking)
    returning id into v_id;
  end if;

  for v_req in
    select e.value from jsonb_array_elements(v_reqs) with ordinality as e(value, n) order by e.n
  loop
    v_pos := v_pos + 1;
    if jsonb_typeof(v_req) is distinct from 'object' then
      raise exception 'Not a requirement.';
    end if;
    v_kind := v_req ->> 'kind';
    if v_kind is null or v_kind not in ('state', 'park', 'band') then
      raise exception 'Not a requirement kind: %.', coalesce(v_kind, '');
    end if;
    v_when := coalesce(v_req ->> 'complete_when', 'all');
    if v_when not in ('all', 'at_least') then
      raise exception 'Not a "Complete when" rule: %.', v_when;
    end if;

    -- Values normalised, once each, in the order first given.
    select coalesce(array_agg(t.v order by t.n), '{}') into v_values
    from (
      select public.goal_entry_value(v_kind, x.value) as v, min(x.n) as n
      from jsonb_array_elements_text(case jsonb_typeof(v_req -> 'entries')
                                       when 'array' then v_req -> 'entries' else '[]' end)
           with ordinality as x(value, n)
      group by 1
    ) t;
    if cardinality(v_values) = 0 then
      raise exception 'Add at least one entry to each requirement.';
    end if;
    if cardinality(v_values) > 500 then
      raise exception 'A requirement takes at most 500 entries.';
    end if;

    v_at_least := null;
    if v_when = 'at_least' then
      v_count := v_req ->> 'at_least';
      if v_count is null or v_count !~ '^[0-9]{1,6}$' or v_count::int < 1 then
        raise exception '"At least" must be a whole number of 1 or more.';
      end if;
      v_at_least := v_count::int;
      if v_at_least >= cardinality(v_values) then
        raise exception '"At least" must be smaller than the number of entries.';
      end if;
    end if;

    v_req_id := null;
    if v_req ->> 'id' ~ v_uuid and not ((v_req ->> 'id')::uuid = any (v_keep)) then
      update goal_requirements r
      set position = v_pos, kind = v_kind, complete_when = v_when, at_least = v_at_least
      where r.id = (v_req ->> 'id')::uuid and r.list_id = v_id
      returning r.id into v_req_id;
    end if;
    if v_req_id is null then
      insert into goal_requirements (list_id, position, kind, complete_when, at_least)
      values (v_id, v_pos, v_kind, v_when, v_at_least)
      returning id into v_req_id;
    end if;
    v_keep := v_keep || v_req_id;

    delete from goal_entries e where e.requirement_id = v_req_id and not (e.value = any (v_values));
    insert into goal_entries (requirement_id, value, position)
    select v_req_id, u.v, u.n from unnest(v_values) with ordinality as u(v, n)
    on conflict (requirement_id, value) do update set position = excluded.position;
  end loop;

  delete from goal_requirements r where r.list_id = v_id and not (r.id = any (v_keep));
  perform public.goal_recheck(v_id);
  return v_id;
exception
  when unique_violation then
    raise exception 'You already have a goal with that name.';
end;
$$;

revoke all on function public.save_goal(jsonb) from public;
grant execute on function public.save_goal(jsonb) to authenticated;

-- Refused while any of the caller's connections names the list. The row lock pairs with the
-- key-share lock save_subscription takes on the lists its rules name (the matching migration),
-- as delete_callsign_group does with groups.
create function public.delete_goal(p_id uuid)
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
  perform 1 from goals l where l.id = p_id and l.user_id = v_user for update;
  if not found then
    raise exception 'Goal not found.';
  end if;
  if exists (select 1 from subscriptions s
             where s.user_id = v_user and p_id = any (public.rules_goal_ids(s.rules))) then
    raise exception 'Remove it from its connections first.' using errcode = 'LL409';
  end if;
  delete from goals l where l.id = p_id;
end;
$$;

revoke all on function public.delete_goal(uuid) from public;
grant execute on function public.delete_goal(uuid) to authenticated;

-- Marks one entry by hand. Worked: a hand mark now (an entry already worked keeps its mark).
-- Needed: clears the mark and records hand_needed_at, so only a contact logged later marks it
-- again. Then rechecks the list, since "at least" may now take another contact's entry.
create function public.mark_goal_entry(p_requirement_id uuid, p_value text, p_worked boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_kind  text;
  v_list  uuid;
  v_value text;
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  if p_worked is null then
    raise exception 'Say whether the entry is worked.';
  end if;
  select r.kind, r.list_id into v_kind, v_list
  from goal_requirements r join goals l on l.id = r.list_id
  where r.id = p_requirement_id and l.user_id = v_user;
  if v_list is null then
    raise exception 'Goal not found.';
  end if;
  v_value := public.goal_entry_value(v_kind, p_value);
  perform 1 from goals l where l.id = v_list for update;
  perform 1 from goal_entries e where e.requirement_id = p_requirement_id and e.value = v_value;
  if not found then
    raise exception 'Not on this goal: %.', v_value;
  end if;

  if p_worked then
    update goal_entries e
    set worked_at = now(), worked_how = 'hand', contact_spot_id = null, matched_spot_id = null,
        hand_needed_at = null
    where e.requirement_id = p_requirement_id and e.value = v_value and e.worked_at is null;
  else
    update goal_entries e
    set worked_at = null, worked_how = null, contact_spot_id = null, matched_spot_id = null,
        hand_needed_at = now()
    where e.requirement_id = p_requirement_id and e.value = v_value;
  end if;
  perform public.goal_recheck(v_list);
end;
$$;

revoke all on function public.mark_goal_entry(uuid, text, boolean) from public;
grant execute on function public.mark_goal_entry(uuid, text, boolean) to authenticated;

-- Resolves an open review: a reference picks the park (marking it where the list still needs
-- it, the contact as evidence); null is "Not a park contact".
create function public.resolve_goal_review(p_id uuid, p_reference text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_list uuid;
  v_spot bigint;
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  select v.list_id, v.contact_spot_id into v_list, v_spot
  from goal_reviews v join goals l on l.id = v.list_id
  where v.id = p_id and l.user_id = v_user and v.status = 'open'
  for update of v;
  if v_list is null then
    raise exception 'Review not found.';
  end if;
  if p_reference is null then
    update goal_reviews v set status = 'not_park', resolved_at = now() where v.id = p_id;
  else
    update goal_reviews v
    set status = 'picked', picked_reference = public.goal_entry_value('park', p_reference), resolved_at = now()
    where v.id = p_id;
    perform public.goal_mark(array[v_list], v_user, v_spot);
    perform public.goal_refresh_completion(v_list);
  end if;
end;
$$;

revoke all on function public.resolve_goal_review(uuid, text) from public;
grant execute on function public.resolve_goal_review(uuid, text) to authenticated;

-- "Copy for next year": the same requirements and entries, all needed, the dates a year later,
-- and the name's first four-digit year bumped ("2026 chase" -> "2027 chase"), else " copy"
-- appended; a number follows until the name is free. The copy is checked against the contacts
-- already in its window. Returns its id.
create function public.copy_goal(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_src  goals%rowtype;
  v_year text;
  v_base text;
  v_name text;
  v_n    int := 1;
  v_id   uuid;
  v_req  goal_requirements%rowtype;
  v_new  uuid;
begin
  if v_user is null then
    raise exception 'Not signed in.';
  end if;
  select * into v_src from goals l where l.id = p_id and l.user_id = v_user;
  if not found then
    raise exception 'Goal not found.';
  end if;

  v_year := substring(v_src.name from '(?:^|[^0-9])([0-9]{4})(?:[^0-9]|$)');
  if v_year is not null then
    v_base := regexp_replace(v_src.name, '(^|[^0-9])' || v_year || '([^0-9]|$)',
                             '\1' || (v_year::int + 1)::text || '\2');
  else
    v_base := v_src.name || ' copy';
  end if;
  v_name := v_base;
  while exists (select 1 from goals l where l.user_id = v_user and lower(l.name) = lower(v_name)) loop
    v_n := v_n + 1;
    v_name := v_base || ' ' || v_n::text;
  end loop;

  insert into goals (user_id, name, starts_on, ends_on, marking)
  values (v_user, v_name, (v_src.starts_on + interval '1 year')::date, (v_src.ends_on + interval '1 year')::date,
          v_src.marking)
  returning id into v_id;

  for v_req in select * from goal_requirements r where r.list_id = p_id order by r.position, r.id loop
    insert into goal_requirements (list_id, position, kind, complete_when, at_least)
    values (v_id, v_req.position, v_req.kind, v_req.complete_when, v_req.at_least)
    returning id into v_new;
    insert into goal_entries (requirement_id, value, position)
    select v_new, e.value, e.position from goal_entries e where e.requirement_id = v_req.id;
  end loop;

  perform public.goal_recheck(v_id);
  return v_id;
end;
$$;

revoke all on function public.copy_goal(uuid) from public;
grant execute on function public.copy_goal(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Logged contacts: state, grid and the goal hook
-- ---------------------------------------------------------------------------

-- apply_logged_contacts: as in 20261029000600, with three changes.
-- 1. An upsert's us_state and gridsquare (item level, out of the hash; null from a relay-api
--    deployed before this) are stored on every created or updated contact. An unchanged resend
--    whose us_state or gridsquare differs updates the columns, and a new us_state re-applies the
--    contact (rechecking the lists it had marked).
-- 2. Every stored or revived contact goes through goal_apply_contact.
-- 3. Before a spot is retracted (a delete, or an update's old spot), the lists it marked or holds
--    a review for are collected, and each is rechecked once after the loop. The advisory lock
--    already serialises an account's batches.
create or replace function public.apply_logged_contacts(p_user_id uuid, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pgmq
as $$
declare
  v_base    text;
  v_since   timestamptz;
  v_item    jsonb;
  v_op      text;
  v_ext     text;
  v_spot    jsonb;
  v_hash    text;
  v_row     logged_contacts%rowtype;
  v_found   boolean;
  v_spot_id bigint;
  v_status  text;
  v_stored  int := 0;
  v_results jsonb := '[]'::jsonb;
  v_state   text;
  v_grid    text;
  v_recheck uuid[] := '{}'::uuid[];
  v_list    uuid;
begin
  if p_user_id is null or jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'apply_logged_contacts needs a user and a list of items.' using errcode = '22023';
  end if;

  -- One account's batches apply one at a time. The row lock below cannot cover a contact that has
  -- no row yet, so two requests storing different content for one new contact at once (a retry
  -- racing the request it retries) would each store a live spot and leave one never retracted.
  perform pg_advisory_xact_lock(hashtextextended('logged_contacts:' || p_user_id::text, 0));

  select public.base_callsign(p.callsign), p.callsign_since into v_base, v_since
  from profiles p where p.id = p_user_id;
  -- Profiles may share a base call: only the one that has held it longest posts as that base, so
  -- every other gets mycall_mismatch.
  if v_base is not null and exists (
       select 1 from profiles o
       where o.id <> p_user_id
         and public.base_callsign(o.callsign) = v_base
         and (o.callsign_since, o.id) < (v_since, p_user_id)) then
    v_base := null;
  end if;

  for v_item in
    select e.value from jsonb_array_elements(p_items) with ordinality as e(value, n) order by e.n
  loop
    v_op := v_item ->> 'op';
    v_ext := v_item ->> 'external_id';
    if v_op is null or v_op not in ('upsert', 'delete')
       or v_ext is null or char_length(v_ext) not between 1 and 256 then
      raise exception 'Not a logged contact item.' using errcode = '22023';
    end if;

    select * into v_row
    from logged_contacts c
    where c.user_id = p_user_id and c.external_id = v_ext
    for update;
    v_found := found;

    if v_op = 'delete' then
      if v_found and v_row.state = 'live' then
        v_recheck := v_recheck || public.goals_for_spot(v_row.spot_id);
        update raw_spots set retracted_at = now() where id = v_row.spot_id;
        update logged_contacts
        set state = 'retracted', retracted_at = now(), updated_at = now()
        where user_id = p_user_id and external_id = v_ext;
        v_status := 'retracted';
      else
        v_status := 'unknown';
      end if;
      v_results := v_results || jsonb_build_array(jsonb_build_object('external_id', v_ext, 'status', v_status));
      continue;
    end if;

    v_spot := v_item -> 'spot';
    v_hash := v_spot ->> 'content_hash';
    if jsonb_typeof(v_spot) is distinct from 'object'
       or v_spot ->> 'source' is distinct from 'logged'
       or v_spot ->> 'source_spot_id' is distinct from p_user_id::text || '|' || v_ext
       or coalesce(v_hash, '') = '' then
      raise exception 'Not a logged contact spot.' using errcode = '22023';
    end if;

    if v_base is null or public.base_callsign(v_spot ->> 'spotter') is distinct from v_base then
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'external_id', v_ext, 'status', 'rejected', 'reason', 'mycall_mismatch'));
      continue;
    end if;

    -- relay-api has checked both; anything else reads as not sent.
    v_state := v_item ->> 'us_state';
    if v_state !~ '^[A-Z]{2}$' then
      v_state := null;
    end if;
    v_grid := v_item ->> 'gridsquare';
    if v_grid !~ '^[A-R]{2}[0-9]{2}([A-X]{2}([0-9]{2})?)?$' then
      v_grid := null;
    end if;

    if v_found and v_row.state = 'live' and v_row.content_hash = v_hash then
      if v_row.us_state is distinct from v_state or v_row.gridsquare is distinct from v_grid then
        update logged_contacts
        set us_state = v_state, gridsquare = v_grid
        where user_id = p_user_id and external_id = v_ext;
        if v_row.us_state is distinct from v_state then
          v_recheck := v_recheck || public.goals_for_spot(v_row.spot_id);
          perform public.goal_apply_contact(p_user_id, v_row.spot_id);
        end if;
      end if;
      v_results := v_results || jsonb_build_array(jsonb_build_object('external_id', v_ext, 'status', 'unchanged'));
      continue;
    end if;

    if v_found and v_row.state = 'live' then
      v_recheck := v_recheck || public.goals_for_spot(v_row.spot_id);
      update raw_spots set retracted_at = now() where id = v_row.spot_id;
      v_status := 'updated';
    else
      v_status := 'created';
    end if;

    v_spot_id := null;
    select i.id into v_spot_id from public.ingest_spots(jsonb_build_array(v_spot)) as i;
    if v_spot_id is null then
      update raw_spots r
      set retracted_at = null
      where r.source = 'logged' and r.source_spot_id = v_spot ->> 'source_spot_id' and r.content_hash = v_hash
      returning r.id into v_spot_id;
      if v_spot_id is null then
        raise exception 'Logged contact spot neither stored nor found.';
      end if;
      perform pgmq.send('spot_events', jsonb_build_object('spot_id', v_spot_id, 'source', 'logged'));
    end if;
    v_stored := v_stored + 1;

    insert into logged_contacts (user_id, external_id, spot_id, content_hash, state, logger_app, relay_version,
                                 us_state, gridsquare)
    values (p_user_id, v_ext, v_spot_id, v_hash, 'live', v_item ->> 'logger_app', v_item ->> 'relay_version',
            v_state, v_grid)
    on conflict (user_id, external_id) do update
      set spot_id = excluded.spot_id, content_hash = excluded.content_hash, state = 'live',
          logger_app = excluded.logger_app, relay_version = excluded.relay_version,
          us_state = excluded.us_state, gridsquare = excluded.gridsquare,
          updated_at = now(), retracted_at = null;

    perform public.goal_apply_contact(p_user_id, v_spot_id);

    v_results := v_results || jsonb_build_array(jsonb_build_object('external_id', v_ext, 'status', v_status));
  end loop;

  for v_list in select distinct x from unnest(v_recheck) as x loop
    perform public.goal_recheck(v_list);
  end loop;

  -- Every applied request counts as a run; the count is the spots stored. The catalog reads
  -- last_success_at as "last contact".
  perform public.record_ingest_success('logged', v_stored);
  return v_results;
end;
$$;

-- Callsign profiles, part 1 (docs/superpowers/specs/2026-10-12-callsign-lookup-design.md).
--
-- One base-callsign rule for everything that groups a station's spots:
-- portable and prefixed forms (KK4PWJ/P, KK4PWJ/QRP, W4/G4OBK, VE3/KK4PWJ)
-- belong to the same profile. base_callsign() existed for self-spots
-- (20261011000006); it now drops known suffixes before picking the longest
-- part, and everything that called it follows. A designator written after the
-- call with a callsign shape (KA1A/VP2E) ties on length and goes to the later
-- part; the usual prefix form (VP2E/KA1A) resolves correctly.
--
-- raw_spots gains a stored base_callsign column with a (base_callsign,
-- spot_time) index, so a profile reads one station's rows without a scan. The
-- column depends on the function body: if base_callsign() ever changes again,
-- rewrite the column (update raw_spots set callsign = callsign) in the same
-- migration. rbn_spots gets its base-callsign index with the profile queries
-- that read it, not here: building it locks RBN inserts.
--
-- Matching: a subscription callsign now matches a spot when it equals the
-- spotted call or its base call. KK4PWJ catches KK4PWJ/P; a KK4PWJ/P
-- subscription still catches only /P. The rule lives in callsign_matches(),
-- used by spot_matches and by watched_among, which ingest-rbn now asks which
-- of a batch's stations are watched. watched_callsigns() stays until the
-- deployed ingest-rbn no longer calls it, so database and function can be
-- deployed in either order; a later migration drops it.
--
-- Retention guard: an RBN day is retired once callsign rollups have recorded
-- it in callsign_rollup_days, or once it is 14 days old regardless, so a late
-- rollup release cannot stop retention altogether. The rollups arrive in a
-- later migration.

create or replace function public.base_callsign(p_call text)
returns text
language sql
immutable
as $$
  with parts as (
    select part, i
    from unnest(string_to_array(upper(trim(p_call)), '/')) with ordinality as t(part, i)
  ),
  kept as (
    select part, i from parts
    where part <> ''
      and part not in ('P', 'M', 'MM', 'AM', 'QRP', 'R')
      and part !~ '^[0-9]$'
  )
  -- Longest part; on a tie the one with a digit after a letter (a callsign
  -- rather than a bare prefix), then the later one (VP2V/W1AW -> W1AW).
  select coalesce(
    (select part from kept
     order by length(part) desc, (part ~ '[A-Z][0-9]') desc, i desc
     limit 1),
    upper(trim(p_call)));
$$;

alter table raw_spots
  add column base_callsign text generated always as (public.base_callsign(callsign)) stored;

create index raw_spots_base_callsign_time_idx on raw_spots (base_callsign, spot_time desc);

-- The subscription filter rules shared by spot_matches and watched_among.
-- Empty sources means any source.
create function public.source_matches(p_sources text[], p_source text)
returns boolean
language sql
immutable
as $$
  select cardinality(p_sources) = 0 or p_source = any (p_sources);
$$;

-- A subscription callsign matches the spotted call or its base call.
create function public.callsign_matches(p_callsigns text[], p_call text, p_base text)
returns boolean
language sql
immutable
as $$
  select p_call = any (p_callsigns) or p_base = any (p_callsigns);
$$;

revoke all on function public.source_matches(text[], text) from public, anon, authenticated;
revoke all on function public.callsign_matches(text[], text, text) from public, anon, authenticated;

-- spot_matches: as in 20261011000001, with sources and callsigns through the
-- shared rules and callsigns matched exactly or by base call.
create or replace function public.spot_matches(sub subscriptions, spot raw_spots)
returns boolean
language sql
immutable
as $$
  select coalesce(
        public.source_matches(sub.sources, spot.source)
    and (spot.source <> 'rbn' or cardinality(sub.callsigns) > 0)
    and (cardinality(sub.bands)     = 0 or spot.band     = any (sub.bands))
    and (cardinality(sub.modes)     = 0 or spot.mode     = any (sub.modes)
                                        or spot.mode_family = any (sub.modes))
    and (cardinality(sub.callsigns) = 0
         or public.callsign_matches(sub.callsigns, spot.callsign, spot.base_callsign))
    and (sub.reference = '' or position(lower(sub.reference) in
           lower(concat_ws(',', spot.pota_reference, spot.pota_location, spot.sota_summit_ref))) > 0),
    false);
$$;

revoke all on function public.spot_matches(subscriptions, raw_spots) from public;

-- The stations in p_callsigns that an enabled subscription accepting p_source
-- names, by the matcher's rules. ingest-rbn forwards only these to raw_spots.
create function public.watched_among(p_source text, p_callsigns text[])
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select x.c
  from (select distinct c, public.base_callsign(c) as b from unnest(p_callsigns) as c) x
  where exists (
    select 1 from subscriptions s
    where s.enabled
      and public.source_matches(s.sources, p_source)
      and public.callsign_matches(s.callsigns, x.c, x.b))
  order by x.c;
$$;

revoke all on function public.watched_among(text, text[]) from public, anon, authenticated;
grant execute on function public.watched_among(text, text[]) to service_role;

-- One row per UTC day the callsign rollups have recorded. Service-role only.
create table callsign_rollup_days (
  day       date        primary key,
  rolled_at timestamptz not null
);

alter table callsign_rollup_days enable row level security;
revoke all on callsign_rollup_days from anon, authenticated;

-- maintain_rbn_spots: as in 20261011000005, except an archived day is retired
-- only when callsign_rollup_days has it or it is older than 14 days.
-- rbn_day_archived still runs for every eligible day first: it also deletes
-- mismatched archive_log rows so their slices are archived again.
create or replace function public.maintain_rbn_spots()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'utc')::date;
  v_day   date;
  v_drop  date[] := '{}'::date[];
begin
  for v_day in select (v_today + i) from generate_series(0, 3) as i loop
    perform public.create_rbn_spots_partition(v_day);
  end loop;

  for v_day in
    select to_date(substr(c.relname, 11), 'YYYYMMDD')
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'public.rbn_spots'::regclass and c.relname ~ '^rbn_spots_[0-9]{8}$'
    union
    select distinct (d.spot_time at time zone 'utc')::date from partitions.rbn_spots_default d
    order by 1
  loop
    continue when v_day >= v_today - 7;
    continue when not public.rbn_day_archived(v_day);
    if v_day < v_today - 14 or exists (select 1 from callsign_rollup_days r where r.day = v_day) then
      v_drop := v_drop || v_day;
    end if;
  end loop;

  perform set_config('lock_timeout', '5s', true);
  foreach v_day in array v_drop loop
    begin
      perform public.retire_rbn_day(v_day);
    exception when lock_not_available then
      raise warning 'rbn retention: % not dropped (lock timeout); retrying tomorrow', v_day;
    end;
  end loop;
end;
$$;

revoke all on function public.maintain_rbn_spots() from public, anon, authenticated;
grant execute on function public.maintain_rbn_spots() to service_role;

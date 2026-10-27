-- Reference profiles, PR 4: the profile of one POTA park, SOTA summit or WWFF reference
-- (docs/superpowers/specs/2026-10-26-reference-profiles-design.md, decisions 4 to 8 and 12 to 14).
--
-- reference_profile(program, reference) builds the whole page in SQL. Its shape is
-- ReferenceProfile in web/src/references/types.ts, read by the reference-profile function's Zod
-- schema and pinned by supabase/tests/reference_profile.test.sql; change the SQL, the type, the
-- schema and the test together. It is not granted to clients: the public reference-profile
-- function reads it through cached_reference_profile after record_profile_lookup, the callsign
-- profile's rate limit.
--
-- An activation is one activator (base call) spotted at the reference on one UTC day (decision 4).
-- History is reference_days (PR 3) plus the live days, read from spot_stream by reference and time
-- (decision 6): the unmarked days of the last 14, never before the first marker, the callsign
-- profile's window. A marked day is read only from reference_days and an unmarked one only live,
-- so a day is never counted twice. The live read goes through spot_stream's reference column, which
-- raw_spots_reference_time_idx serves (pgTAP checks the plan), filtered to the program and to the
-- three sources that write reference_days, as rollup_callsign_day writes them.
--
-- reference_days keeps per activator and day a spot count and the distinct modes and bands, not a
-- count per band or mode, and only the base call. So the same index read, over all time, gives the
-- per-spot figures: bands and modes count the spots of the activations history counts (a late spot
-- for a day already rolled up stays out, so the mode shares add up to totals.spots), the call as
-- most recently spotted here for each base, and who was spotted first on the first day. raw_spots
-- is never pruned and RBN spots carry no reference, so that read is exact.
--
-- Hidden calls count nowhere (decision 7, group statistics' rule): an activator in
-- hidden_callsigns is left out of every list and total, and a spot whose spotter is hidden is left
-- out of recentSpots. A reference outside the program's list still gets a page when a visible
-- activator was spotted there (decision 8); in neither, or with a program other than pota, sota and
-- wwff, or a reference that is not letters, digits, "/" and "-" (at most 64), it is null, which the
-- function answers with a 404.
--
-- cached_reference_profile serves reference_profile_cache for profile_cache_ttl() (15 minutes),
-- single-flight under a per-reference advisory lock with the callsign profile's 2 s wait. Hiding a
-- call makes every older entry a miss, so it takes effect at once; prune_callsign_lookups deletes
-- expired entries with the callsign ones.
--
-- spot_stream gains comment (raw_spots.comment; null for RBN) at the end, for recentSpots:
-- profiles read spot_stream, never a source table by name.
--
-- The reference rule gains exact ops (decision 14): is passes a spot when one of its references
-- (pota_reference, sota_summit_ref, wwff_reference, any of wwbota_references, iota_reference)
-- equals one of the values, case-insensitively; is_not passes a spot with none of them, including
-- one with no reference. Values are trimmed and upper-cased, at most 64 characters of letters,
-- digits, / and - (reference_profile's shape), and need not be in the catalog (decision 8). contains and not_contains are unchanged, for partial text. The
-- reference rule's ops are now is, is_not, contains and not_contains.

-- ---------------------------------------------------------------------------
-- 1. spot_stream: as in 20261027001000, with comment at the end
-- ---------------------------------------------------------------------------

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
       case when r.pota_reference is not null then r.pota_location end  as reference_location,
       r.comment
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
       null, null, null, null,
       null
from rbn_spots s;

revoke all on spot_stream from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The cache
-- ---------------------------------------------------------------------------

create table reference_profile_cache (
  program      text        not null,                -- pota, sota, wwff
  reference    text        not null,                -- upper case
  payload      jsonb       not null,
  generated_at timestamptz not null,
  primary key (program, reference)
);

alter table reference_profile_cache enable row level security;
revoke all on reference_profile_cache from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. reference_profile
-- ---------------------------------------------------------------------------

create function public.reference_profile(p_program text, p_reference text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_program     text := lower(trim(p_program));
  v_ref         text := upper(trim(p_reference));
  v_label       text;
  v_today       date := (now() at time zone 'utc')::date;
  v_week_from   timestamptz := now() - interval '7 days';
  v_recent_from timestamptz;
  v_live_from   date;
  v_catalog     jsonb;
  v_source_url  text;
  v_payload     jsonb;
begin
  if v_program is null or v_program not in ('pota', 'sota', 'wwff') then
    return null;
  end if;
  if v_ref is null or v_ref !~ '^[A-Z0-9/-]{1,64}$' then
    return null;
  end if;
  -- spot_stream's program column for it.
  v_label := upper(v_program);
  -- The live read's 14 days, today included, as the callsign profile's window.
  v_recent_from := (v_today - 14)::timestamp at time zone 'utc';

  -- The catalog header. SOTA's region is stored "<AssociationName>, <RegionName>" (association
  -- names have no comma; region names may); the page shows the association code and RegionName.
  select jsonb_build_object(
           'name', c.name,
           'active', c.active,
           'location', c.location,
           'association', case when c.program = 'sota' then split_part(c.reference, '/', 1) end,
           'region', case when c.program = 'sota' and strpos(c.region, ', ') > 0
                          then substr(c.region, strpos(c.region, ', ') + 2)
                          else c.region end,
           'country', c.country,
           'latitude', c.latitude,
           'longitude', c.longitude,
           'grid', c.grid,
           'altitudeM', c.altitude_m,
           'points', c.points,
           'validFrom', to_char(c.valid_from, 'YYYY-MM-DD'),
           'validTo', to_char(c.valid_to, 'YYYY-MM-DD')),
         -- The program's page for it, as deliveries link it (spot_source_url).
         public.spot_source_url(jsonb_build_object(
           'source', case c.program when 'sota' then 'sotawatch' else c.program end,
           case c.program when 'pota' then 'pota_reference' when 'sota' then 'sota_summit_ref'
                          else 'wwff_reference' end, c.reference))
    into v_catalog, v_source_url
  from reference_catalog c
  where c.program = v_program and c.reference = v_ref;

  -- The oldest day of the last 14 without a marker; today never has one.
  -- Days before the first marker stay out: the rollups start at the first spot.
  select min(g.d)::date into v_live_from
  from generate_series(greatest(v_today - 14, (select min(day) from callsign_rollup_days)), v_today,
                       interval '1 day') as g(d)
  where not exists (select 1 from callsign_rollup_days r where r.day = g.d::date);

  with
  -- Every visible spot at the reference, through raw_spots_reference_time_idx: the program's
  -- spots from the sources rollup_callsign_day writes reference_days for, hidden activators left
  -- out. RBN's arm has a null reference and drops out of the plan. The roll-up upper-cases a
  -- reference; the adapters store them upper case (POTA's as the API sends them), and a lower-case
  -- spelling is matched too, without giving up the index.
  spots as materialized (
    select s.source, s.spot_time, (s.spot_time at time zone 'utc')::date as day,
           s.callsign, s.base_callsign as base, s.spotter, s.frequency_khz, s.band, s.mode,
           s.mode_bucket, s.comment
    from spot_stream s
    where s.reference = any (array[v_ref, lower(v_ref)]) and s.program = v_label
      and s.source in ('pota', 'sotawatch', 'wwff')
      and s.base_callsign is not null
      and not exists (select 1 from hidden_callsigns h where h.callsign = s.base_callsign)
  ),
  -- The Stats page's bands, in order; other bands follow alphabetically in lists and stay out of
  -- the bands chart.
  band_order (band, ord) as (
    values ('160m', 1), ('80m', 2), ('60m', 3), ('40m', 4), ('30m', 5), ('20m', 6),
           ('17m', 7), ('15m', 8), ('12m', 9), ('10m', 10), ('6m', 11), ('2m', 12)
  ),
  -- The live days, grouped as reference_days rows are.
  live as (
    select s.day, s.base, s.source, count(*)::int as spots,
           coalesce(array_agg(distinct s.mode order by s.mode) filter (where s.mode is not null), '{}') as modes,
           coalesce(array_agg(distinct s.band order by s.band) filter (where s.band is not null), '{}') as bands
    from spots s
    where s.day >= v_live_from
      and not exists (select 1 from callsign_rollup_days d where d.day = s.day)
    group by s.day, s.base, s.source
  ),
  hist as materialized (
    select d.day, d.base, d.source, d.spots, d.modes, d.bands
    from reference_days d
    where d.program = v_program and d.reference = v_ref
      and not exists (select 1 from hidden_callsigns h where h.callsign = d.base)
    union all
    select l.day, l.base, l.source, l.spots, l.modes, l.bands from live l
  ),
  -- One row per activation.
  acts as materialized (
    select h.day, h.base, sum(h.spots)::bigint as spots
    from hist h
    group by h.day, h.base
  ),
  -- The spots of the activations counted above.
  counted as materialized (
    select s.band, s.mode_bucket
    from spots s
    where exists (select 1 from acts a where a.day = s.day and a.base = s.base)
  ),
  -- Each activator's call as most recently spotted here (an ISO timestamp sorts in time order).
  calls as (
    select s.base,
           (max(array[to_char(s.spot_time at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS.US'), s.callsign]))[2] as callsign
    from spots s
    group by s.base
  ),
  totals as (
    select count(*)::bigint as activations, count(distinct base)::bigint as activators,
           coalesce(sum(spots), 0)::bigint as spots
    from acts
  ),
  -- The first day's activator spotted first that day.
  first_act as (
    select a.day, a.base
    from acts a
    where a.day = (select min(day) from acts)
    order by (select min(s.spot_time) from spots s where s.day = a.day and s.base = a.base) nulls last, a.base
    limit 1
  ),
  last_spot as (
    select s.*
    from spots s
    where s.spot_time >= v_recent_from
    order by s.spot_time desc, s.frequency_khz desc, s.source, s.callsign
    limit 1
  ),
  -- The heat map: activators per day.
  cal as (
    select a.day, count(*)::bigint as activators, array_agg(a.base order by a.base) as bases
    from acts a
    group by a.day
  ),
  -- The past 365 days ending today, then each calendar year from the first activation through
  -- this one, newest first. A year's grid runs to 31 December; its day count only to today.
  cal_periods as (
    select 'past' as period, 0 as ord, v_today - 364 as from_day, v_today as to_day
    union all
    select y::text, 1 + extract(year from v_today)::int - y, make_date(y, 1, 1), make_date(y, 12, 31)
    from generate_series(extract(year from (select min(day) from cal))::int, extract(year from v_today)::int) as y
  ),
  cal_summary as (
    select p.period, p.ord, p.from_day, p.to_day, least(p.to_day, v_today) - p.from_day + 1 as days,
           t.activations, t.days_activated, k.streak, b.day as busiest_day, b.activators as busiest_activators
    from cal_periods p
    cross join lateral (
      select coalesce(sum(c.activators), 0)::bigint as activations, count(*)::int as days_activated
      from cal c where c.day between p.from_day and p.to_day) t
    -- Consecutive days share day minus their rank.
    cross join lateral (
      select coalesce(max(n), 0)::int as streak
      from (select count(*) as n
            from (select c.day - (row_number() over (order by c.day))::int as run
                  from cal c where c.day between p.from_day and p.to_day) r
            group by run) q) k
    left join lateral (
      select c.day, c.activators from cal c where c.day between p.from_day and p.to_day
      order by c.activators desc, c.day desc limit 1) b on true
  ),
  by_month as (
    select date_trunc('month', a.day::timestamp)::date as month, count(*)::bigint as n
    from acts a group by 1
  ),
  -- The Stats page's mode shares over the counted spots: each rounded, the remainder to the biggest.
  mode_rounded as (
    select ml.label, ml.ord, coalesce(c.n, 0) as n,
           case when t.n = 0 then 0 else round(100.0 * coalesce(c.n, 0) / t.n)::int end as pct
    from (values ('CW', 1), ('SSB', 2), ('FT8/FT4', 3), ('FM', 4), ('Other', 5)) as ml(label, ord)
    left join (select mode_bucket, count(*) as n from counted group by 1) c on c.mode_bucket = ml.label
    cross join (select count(*) as n from counted) t
  ),
  top_activators as (
    select a.base, count(*)::bigint as activations, max(a.day) as last_day
    from acts a
    group by a.base
    order by activations desc, last_day desc, a.base
    limit 10
  ),
  recent_acts as (
    select a.day, a.base, a.spots
    from acts a
    order by a.day desc, a.spots desc, a.base
    limit 10
  )
  select case
    when v_catalog is null and not exists (select 1 from acts) and not exists (select 1 from spots) then null
    else jsonb_build_object(
      'program', v_program,
      'reference', v_ref,
      'sourceUrl', v_source_url,
      'catalog', v_catalog,
      'totals', (select jsonb_build_object('activations', t.activations, 'activators', t.activators,
                                           'spots', t.spots)
                 from totals t),
      'firstActivation', (
        select jsonb_build_object('day', to_char(f.day, 'YYYY-MM-DD'),
                                  'callsign', coalesce(c.callsign, f.base), 'base', f.base)
        from first_act f left join calls c on c.base = f.base),
      'last', (
        select jsonb_build_object(
                 'callsign', l.callsign, 'base', l.base,
                 'time', to_char(l.spot_time at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                 'frequencyKhz', l.frequency_khz, 'mode', l.mode, 'band', l.band, 'source', l.source,
                 'today', case when l.day = v_today then (
                   select jsonb_build_object(
                            'spots', count(*),
                            'bands', coalesce((
                              select jsonb_agg(x.band order by coalesce(o.ord, 100), x.band)
                              from (select distinct s2.band from spots s2
                                    where s2.base = l.base and s2.day = v_today and s2.band is not null) x
                              left join band_order o on o.band = x.band), '[]'))
                   from spots s
                   where s.base = l.base and s.day = v_today) end)
        from last_spot l),
      'calendar', jsonb_build_object(
        'days', (
          select coalesce(jsonb_agg(jsonb_build_object('day', to_char(c.day, 'YYYY-MM-DD'),
                                                       'activators', to_jsonb(c.bases))
                                    order by c.day), '[]')
          from cal c),
        'periods', (
          select coalesce(jsonb_agg(jsonb_build_object(
                   'period', period, 'from', to_char(from_day, 'YYYY-MM-DD'), 'to', to_char(to_day, 'YYYY-MM-DD'),
                   'days', days, 'activations', activations, 'daysActivated', days_activated,
                   'longestStreak', streak,
                   'busiest', case when busiest_day is null then null
                                   else jsonb_build_object('day', to_char(busiest_day, 'YYYY-MM-DD'),
                                                           'activators', busiest_activators) end)
                 order by ord), '[]')
          from cal_summary)),
      -- The first activation's month through this one, zero-filled; [] without activations.
      'monthly', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'month', to_char(m.m, 'YYYY-MM'),
                 'activations', coalesce((select b.n from by_month b where b.month = m.m::date), 0))
               order by m.m), '[]')
        from generate_series((select min(month) from by_month)::timestamp, date_trunc('month', v_today::timestamp),
                             interval '1 month') as m(m)),
      'bands', (
        select coalesce(jsonb_agg(jsonb_build_object('band', o.band, 'spots', b.n) order by o.ord), '[]')
        from band_order o
        join (select band, count(*) as n from counted group by band) b on b.band = o.band),
      'modes', (
        select jsonb_agg(jsonb_build_object('label', label, 'spots', n, 'percent', percent) order by ord)
        from (
          select label, ord, n,
                 case when sum(pct) over () = 0 then 0
                      when row_number() over (order by n desc, ord) = 1 then pct + (100 - sum(pct) over ())::int
                      else pct end as percent
          from mode_rounded
        ) m),
      'topActivators', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'callsign', coalesce(c.callsign, t.base), 'base', t.base, 'activations', t.activations,
                 'lastDay', to_char(t.last_day, 'YYYY-MM-DD'))
               order by t.activations desc, t.last_day desc, t.base), '[]')
        from top_activators t left join calls c on c.base = t.base),
      'recentActivations', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'day', to_char(r.day, 'YYYY-MM-DD'), 'callsign', coalesce(c.callsign, r.base), 'base', r.base,
                 'spots', r.spots,
                 'bands', (select coalesce(jsonb_agg(x.band order by coalesce(o.ord, 100), x.band), '[]')
                           from (select distinct unnest(h.bands) as band from hist h
                                 where h.day = r.day and h.base = r.base) x
                           left join band_order o on o.band = x.band),
                 'modes', (select coalesce(jsonb_agg(x.mode order by x.mode), '[]')
                           from (select distinct unnest(h.modes) as mode from hist h
                                 where h.day = r.day and h.base = r.base) x))
               order by r.day desc, r.spots desc, r.base), '[]')
        from recent_acts r left join calls c on c.base = r.base),
      -- The newest 25 of the last 7 days; a spot by a hidden spotter stays out.
      'recentSpots', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'time', to_char(n.spot_time at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                 'callsign', n.callsign, 'base', n.base, 'frequencyKhz', n.frequency_khz, 'mode', n.mode,
                 'band', n.band, 'spotter', coalesce(n.spotter, ''), 'comment', nullif(trim(n.comment), ''),
                 'source', n.source)
               order by n.spot_time desc, n.source, n.callsign, n.spotter, n.frequency_khz), '[]')
        from (select s.*
              from spots s
              where s.spot_time >= v_week_from
                and not exists (select 1 from hidden_callsigns h where h.callsign = public.base_callsign(s.spotter))
              order by s.spot_time desc, s.source, s.callsign, s.spotter, s.frequency_khz
              limit 25) n))
    end
  into v_payload;

  return v_payload;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. cached_reference_profile: cached_callsign_profile's single flight (20261013000310)
-- ---------------------------------------------------------------------------

create function public.cached_reference_profile(p_program text, p_reference text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_program      text := lower(trim(p_program));
  v_ref          text := upper(trim(p_reference));
  v_lock_timeout text := current_setting('lock_timeout');
  v_payload      jsonb;
begin
  -- reference_profile's own refusals, so nothing malformed takes a lock or a cache row.
  if v_program is null or v_program not in ('pota', 'sota', 'wwff')
     or v_ref is null or v_ref !~ '^[A-Z0-9/-]{1,64}$' then
    return null;
  end if;

  for v_pass in 1..2 loop
    -- A call hidden since the entry was built makes it a miss, so hiding takes effect at once.
    select c.payload into v_payload
    from reference_profile_cache c
    where c.program = v_program and c.reference = v_ref
      and c.generated_at > now() - public.profile_cache_ttl()
      and not exists (select 1 from hidden_callsigns h where h.hidden_at > c.generated_at);
    if found then
      return v_payload;
    end if;

    exit when v_pass = 2;

    -- Held until this request commits, after the upsert below. Each statement
    -- takes a new snapshot, so the second pass sees what a builder committed.
    perform set_config('lock_timeout', '2s', true);
    begin
      perform pg_advisory_xact_lock(hashtext('reference_profile_cache'), hashtext(v_program || ' ' || v_ref));
    exception when lock_not_available then
      null;
    end;
    perform set_config('lock_timeout', v_lock_timeout, true);
  end loop;

  v_payload := public.reference_profile(v_program, v_ref);
  if v_payload is null then
    return null;
  end if;
  insert into reference_profile_cache (program, reference, payload, generated_at)
  values (v_program, v_ref, v_payload, now())
  on conflict (program, reference) do update
    set payload = excluded.payload, generated_at = excluded.generated_at;
  return v_payload;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. prune_callsign_lookups: as in 20261021000550, with the reference cache
-- ---------------------------------------------------------------------------

create or replace function public.prune_callsign_lookups()
returns void
language sql
security definer
set search_path = public
as $$
  delete from lookup_rate_limits where window_start < date_trunc('minute', now());
  delete from callsign_profile_cache where generated_at <= now() - public.profile_cache_ttl();
  delete from reference_profile_cache where generated_at <= now() - public.profile_cache_ttl();
$$;

revoke all on function public.reference_profile(text, text) from public, anon, authenticated;
revoke all on function public.cached_reference_profile(text, text) from public, anon, authenticated;
grant execute on function public.cached_reference_profile(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 6. The reference rule's exact ops
-- ---------------------------------------------------------------------------

-- normalize_subscription_rules: as in 20261027001000, with is and is_not for the reference field:
-- values trimmed and upper-cased, at most 64 characters each, of letters, digits, / and -.
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

      v_conds := v_conds || jsonb_build_array(jsonb_build_object('field', v_field, 'op', v_op, 'values', v_values));
    end loop;

    v_out := v_out || jsonb_build_array(v_conds);
  end loop;

  return v_out;
end;
$$;

-- rule_matches: as in 20261027001000, with the reference field's exact ops. is: one of the spot's
-- references, upper-cased, equals a value (stored upper case); is_not negates it, so a spot with no
-- reference passes.
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
    end as hit
  ) h;
$$;

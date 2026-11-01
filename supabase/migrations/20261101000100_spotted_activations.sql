-- Spotted activations: recognising an activation from its spots alone.
-- Design: docs/superpowers/specs/2026-11-01-spotted-activations-design.md (PR 2, the schema and
-- the detection job).
--
-- An activation is a run of one base call's spots at one program's references (POTA, SOTAwatch,
-- WWFF, WWBOTA, and IOTA through DX Cluster) with no gap longer than activation_gap(), closed once
-- the gap has passed. A minute cron job, assemble_spotted_activations(now()), reads raw_spots
-- forward from a (ingested_at, id) watermark, attaches each reference spot to its open activation
-- or opens one, folds two-fers together, and closes what has gone quiet, adding the RBN and DX
-- Cluster spots of the window and the places that heard it. Detection starts when this migration
-- is pushed: there is no backfill.
--
-- Everything here is service role only: RLS on with no policies, nothing granted to clients. The
-- public spotted-activations Edge Function (PR 3) reads spotted_activation(id) and
-- callsign_spotted_activations(call, now).

-- ---------------------------------------------------------------------------
-- 1. Knobs and helpers
-- ---------------------------------------------------------------------------

-- The longest quiet inside one activation. The canvas copy says 45 minutes.
create function public.activation_gap()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '45 minutes' $$;

-- How far behind p_now a pass reads, so a spot's insert has committed before its row is read.
create function public.activation_ingest_lag()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '30 seconds' $$;

-- Reference spots read per pass. A pass that reads this many is capped and closes nothing.
create function public.activation_batch_limit()
returns int
language sql
immutable
set search_path = ''
as $$ select 5000 $$;

-- Activations closed per pass, oldest first.
create function public.activation_close_limit()
returns int
language sql
immutable
set search_path = ''
as $$ select 100 $$;

revoke all on function public.activation_gap() from public;
revoke all on function public.activation_ingest_lag() from public;
revoke all on function public.activation_batch_limit() from public;
revoke all on function public.activation_close_limit() from public;

-- The haversine distance in km on a 6371 km sphere.
create function public.great_circle_km(p_lat1 double precision, p_lon1 double precision,
                                       p_lat2 double precision, p_lon2 double precision)
returns double precision
language sql
immutable
set search_path = ''
as $$
  select 2 * 6371 * asin(least(1, sqrt(
           power(sin(radians(p_lat2 - p_lat1) / 2), 2)
           + cos(radians(p_lat1)) * cos(radians(p_lat2)) * power(sin(radians(p_lon2 - p_lon1) / 2), 2))))
$$;

revoke all on function public.great_circle_km(double precision, double precision, double precision, double precision)
  from public;

-- p_refs and p_names (index-aligned) with p_add_refs appended in order where they are new, each
-- with its name from p_add_names. A name the list lacks is filled from p_add_names.
create function public.activation_merge_references(p_refs text[], p_names text[], p_add_refs text[],
                                                   p_add_names text[], out refs text[], out names text[])
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_pos int;
begin
  refs := p_refs;
  names := p_names;
  for i in 1 .. coalesce(cardinality(p_add_refs), 0) loop
    v_pos := array_position(refs, p_add_refs[i]);
    if v_pos is null then
      refs := array_append(refs, p_add_refs[i]);
      names := array_append(names, p_add_names[i]);
    elsif names[v_pos] is null then
      names[v_pos] := p_add_names[i];
    end if;
  end loop;
end;
$$;

revoke all on function public.activation_merge_references(text[], text[], text[], text[]) from public;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------

create table spotted_activations (
  id              text        primary key check (id ~ '^[a-z2-7]{12}$'),
  base_callsign   text        not null,
  program         text        not null check (program in ('pota', 'sota', 'wwff', 'wwbota', 'iota')),
  "references"    text[]      not null check (cardinality("references") > 0),
  reference_names text[]      not null,
  day             date        not null,
  started_at      timestamptz not null,
  last_spot_at    timestamptz not null,
  closed_at       timestamptz,
  continued_from  text        references spotted_activations (id),
  latitude        numeric,
  longitude       numeric,
  location_states text[],
  spot_count      int,
  source_counts   jsonb,
  bands           text[],
  modes           text[],
  states          text[],
  countries       text[],
  farthest        jsonb,
  created_at      timestamptz not null default now(),
  check (last_spot_at >= started_at),
  check (day = (started_at at time zone 'utc')::date),
  check (cardinality(reference_names) = cardinality("references")),
  check (continued_from <> id)
);

create index spotted_activations_closed_idx on spotted_activations (base_callsign, started_at desc)
  where closed_at is not null;
create index spotted_activations_open_idx on spotted_activations (base_callsign, program)
  where closed_at is null;
create index spotted_activations_continued_from_idx on spotted_activations (continued_from);

comment on table spotted_activations is
  'Activations recognised from spots by assemble_spotted_activations(); read only when closed. '
  'Service role only.';
comment on column spotted_activations.id is
  'Opaque and permanent (new_activation_id()): 12 characters of [a-z2-7], never changed or reused.';
comment on column spotted_activations."references" is
  'Every reference of the activation, upper case, in feed order (a two-fer or a WWBOTA spot has several).';
comment on column spotted_activations.reference_names is
  'Index-aligned with references; null where the feed names none (WWBOTA names only the first bunker).';
comment on column spotted_activations.day is
  'The UTC day of started_at; POTA splits an activation at 00:00 UTC.';
comment on column spotted_activations.continued_from is
  'The earlier half of a POTA midnight split; the only split pointer ("continued by" is derived).';
comment on column spotted_activations.location_states is
  'The first reference''s own US states, from reference_catalog.location, set at close.';
comment on column spotted_activations.countries is
  'cty.dat entity names of the non-self spotters with no US license state, the United States left out.';

create table spotted_activation_redirects (
  old_id text primary key,
  new_id text not null references spotted_activations (id)
);

comment on table spotted_activation_redirects is
  'Old activation ids that keep working. No automatic path writes it; a correction tool would.';

create table spotted_activation_spots (
  id              bigint      generated always as identity primary key,
  activation_id   text        not null references spotted_activations (id) on delete cascade,
  source          text        not null,
  source_spot_id  text,
  spot_time       timestamptz not null,
  callsign        text        not null,
  spotter         text,
  spotter_base    text,
  self_spot       boolean     not null,
  frequency_khz   numeric(12, 3),
  band            text,
  mode            text,
  "references"    text[],
  spotter_state   text,
  spotter_entity  text,
  spotter_country text
);

-- A POTA comment edit re-inserts the spot into raw_spots with a new content_hash and must not
-- count twice; RBN rows have no source_spot_id, so they use rbn_spots' natural key.
create unique index spotted_activation_spots_source_key on spotted_activation_spots (activation_id, source, source_spot_id)
  where source <> 'rbn';
create unique index spotted_activation_spots_rbn_key
  on spotted_activation_spots (activation_id, spot_time, spotter, callsign, frequency_khz)
  where source = 'rbn';
create index spotted_activation_spots_time_idx on spotted_activation_spots (activation_id, spot_time);

comment on table spotted_activation_spots is
  'Every spot that makes up an activation: its reference spots, and the RBN and DX Cluster spots '
  'added at close (copied, because rbn_spots partitions retire). Service role only.';
comment on column spotted_activation_spots."references" is
  'The spot''s references; null for the RBN and DX Cluster rows added at close.';
comment on column spotted_activation_spots.spotter_state is
  'The spotter''s US license state (one of us_states()), resolved at close.';

create table spotted_activation_state (
  id           boolean     primary key default true check (id),
  watermark_at timestamptz not null,
  watermark_id bigint      not null,
  last_run_at  timestamptz
);

comment on table spotted_activation_state is
  'The (ingested_at, id) of the last raw_spots row assemble_spotted_activations() read. One row.';

-- Seeded at migration time: no backfill.
insert into spotted_activation_state (watermark_at, watermark_id)
select now(), coalesce(max(r.id), 0) from raw_spots r;

-- Computed once from us-atlas states-10m.json with d3-geo's geoCentroid, rounded to 4 decimals.
create table us_state_centroids (
  state text    primary key,
  name  text    not null,
  lat   numeric not null,
  lon   numeric not null
);

insert into us_state_centroids (state, name, lat, lon) values
  ('AK', 'Alaska', 63.9244, -152.3794),
  ('AL', 'Alabama', 32.7759, -86.8302),
  ('AR', 'Arkansas', 34.8942, -92.4431),
  ('AZ', 'Arizona', 34.2748, -111.6605),
  ('CA', 'California', 37.1840, -119.4729),
  ('CO', 'Colorado', 38.9973, -105.5480),
  ('CT', 'Connecticut', 41.6205, -72.7271),
  ('DC', 'District of Columbia', 38.9038, -77.0153),
  ('DE', 'Delaware', 38.9905, -75.5002),
  ('FL', 'Florida', 28.6065, -82.4549),
  ('GA', 'Georgia', 32.6378, -83.4359),
  ('HI', 'Hawaii', 20.2525, -156.3372),
  ('IA', 'Iowa', 42.0751, -93.4957),
  ('ID', 'Idaho', 44.3502, -114.6127),
  ('IL', 'Illinois', 40.0421, -89.1969),
  ('IN', 'Indiana', 39.8946, -86.2816),
  ('KS', 'Kansas', 38.4937, -98.3787),
  ('KY', 'Kentucky', 37.5350, -85.3020),
  ('LA', 'Louisiana', 31.0413, -91.9602),
  ('MA', 'Massachusetts', 42.2543, -71.7924),
  ('MD', 'Maryland', 39.0322, -76.7590),
  ('ME', 'Maine', 45.3477, -69.2357),
  ('MI', 'Michigan', 44.3204, -85.3778),
  ('MN', 'Minnesota', 46.2806, -94.3053),
  ('MO', 'Missouri', 38.3565, -92.4579),
  ('MS', 'Mississippi', 32.7343, -89.6671),
  ('MT', 'Montana', 47.0525, -109.6330),
  ('NC', 'North Carolina', 35.5522, -79.3559),
  ('ND', 'North Dakota', 47.4505, -100.4662),
  ('NE', 'Nebraska', 41.5380, -99.7945),
  ('NH', 'New Hampshire', 43.6791, -71.5804),
  ('NJ', 'New Jersey', 40.1786, -74.6636),
  ('NM', 'New Mexico', 34.4073, -106.1124),
  ('NV', 'Nevada', 39.3291, -116.6314),
  ('NY', 'New York', 42.9366, -75.5074),
  ('OH', 'Ohio', 40.2889, -82.7944),
  ('OK', 'Oklahoma', 35.5883, -97.4932),
  ('OR', 'Oregon', 43.9347, -120.5620),
  ('PA', 'Pennsylvania', 40.8783, -77.8001),
  ('RI', 'Rhode Island', 41.6754, -71.5524),
  ('SC', 'South Carolina', 33.9057, -80.8897),
  ('SD', 'South Dakota', 44.4445, -100.2275),
  ('TN', 'Tennessee', 35.8580, -86.3510),
  ('TX', 'Texas', 31.4628, -99.3205),
  ('UT', 'Utah', 39.3056, -111.6701),
  ('VA', 'Virginia', 37.5213, -78.8184),
  ('VT', 'Vermont', 44.0689, -72.6666),
  ('WA', 'Washington', 47.3841, -120.4564),
  ('WI', 'Wisconsin', 44.6258, -89.9932),
  ('WV', 'West Virginia', 38.6398, -80.6251),
  ('WY', 'Wyoming', 42.9957, -107.5514);

comment on table us_state_centroids is
  'The 50 states and DC: postal code, name and the geographic centroid the heard map draws to.';

alter table spotted_activations enable row level security;
alter table spotted_activation_redirects enable row level security;
alter table spotted_activation_spots enable row level security;
alter table spotted_activation_state enable row level security;
alter table us_state_centroids enable row level security;

revoke all on spotted_activations, spotted_activation_redirects, spotted_activation_spots,
              spotted_activation_state, us_state_centroids
  from anon, authenticated;

-- The watermark's tuple comparison is one range scan.
create index raw_spots_ingested_at_id_idx on raw_spots (ingested_at, id);

-- 12 characters of [a-z2-7], the new_group_slug() recipe; never an id in use or redirected.
create function public.new_activation_id()
returns text
language plpgsql
volatile
set search_path = public, extensions
as $$
declare
  v_id text;
begin
  loop
    select string_agg(substr('abcdefghijklmnopqrstuvwxyz234567', (get_byte(r.b, i) & 31) + 1, 1), '' order by i)
    into v_id
    from (select gen_random_bytes(12) as b) r, generate_series(0, 11) as i;
    exit when not exists (select 1 from spotted_activations a where a.id = v_id)
          and not exists (select 1 from spotted_activation_redirects d where d.old_id = v_id);
  end loop;
  return v_id;
end;
$$;

revoke all on function public.new_activation_id() from public;

-- ---------------------------------------------------------------------------
-- 3. Places
-- ---------------------------------------------------------------------------

-- Where an activation was heard: one row per US state (the spotters' license states) and one per
-- country (the cty.dat entity of a spotter with no license state, the United States left out), from
-- its non-self spots whose spotter is not hidden, with the distance from the activation's
-- coordinates (null without them). A spotter with a US state is always a state, never a country:
-- a KL7 with an AK license is Alaska, the state. The close stores these places and the read RPCs
-- recompute them, so a spotter hidden since the close counts nowhere.
create function public.spotted_activation_heard(p_id text)
returns table (kind text, code text, name text, latitude numeric, longitude numeric, spots int, km int)
language sql
stable
set search_path = public
as $$
  with a as (
    select x.latitude, x.longitude from spotted_activations x where x.id = p_id
  ),
  s as (
    select s.spotter_state, s.spotter_entity, s.spotter_country
    from spotted_activation_spots s
    where s.activation_id = p_id
      and not s.self_spot
      and s.spotter is not null
      and not exists (select 1 from hidden_callsigns h where h.callsign = s.spotter_base)
  ),
  p as (
    select 'state' as kind, s.spotter_state as code, null::text as stored_name, count(*)::int as spots
    from s
    where s.spotter_state is not null
    group by s.spotter_state
    union all
    select 'country', s.spotter_entity, max(s.spotter_country), count(*)::int
    from s
    where s.spotter_state is null and s.spotter_entity is not null and s.spotter_entity <> 'K'
    group by s.spotter_entity
  ),
  g as (
    select p.kind, p.code, coalesce(c.name, e.name, p.stored_name) as name,
           coalesce(c.lat, e.lat) as lat, coalesce(c.lon, e.lon) as lon, p.spots
    from p
    left join us_state_centroids c on p.kind = 'state' and c.state = p.code
    left join cty_entities e on p.kind = 'country' and e.prefix = p.code
  )
  select g.kind, g.code, g.name, g.lat, g.lon, g.spots,
         case when a.latitude is not null and a.longitude is not null and g.lat is not null and g.lon is not null
              then round(public.great_circle_km(a.latitude, a.longitude, g.lat, g.lon))::int end
  from g
  cross join a
$$;

revoke all on function public.spotted_activation_heard(text) from public;

-- The farthest of those places, {kind, code, name, km}, or null when none has a distance.
create function public.spotted_activation_farthest(p_id text)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object('kind', h.kind, 'code', h.code, 'name', h.name, 'km', h.km)
  from public.spotted_activation_heard(p_id) h
  where h.km is not null
  order by h.km desc, h.kind desc, h.code
  limit 1
$$;

revoke all on function public.spotted_activation_farthest(text) from public;

-- ---------------------------------------------------------------------------
-- 4. Detection
-- ---------------------------------------------------------------------------

-- One pass (the spec's Detection section, steps 1 to 6). Returns the number of reference spots
-- read; a pass that returns activation_batch_limit() was capped and closed nothing.
create function public.assemble_spotted_activations(p_now timestamptz)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gap     interval := public.activation_gap();
  v_limit   int := public.activation_batch_limit();
  v_state   spotted_activation_state%rowtype;
  v_held    timestamptz;
  v_cutoff  timestamptz;
  v_read    int := 0;
  v_last_at timestamptz;
  v_last_id bigint;
  v_spot    record;
  v_act     spotted_activations%rowtype;
  v_id      text;
  v_day     date;
  v_refs    text[];
  v_names   text[];
  v_pair    record;
  v_touched text[] := '{}'::text[];
  v_cur     text;
  v_bands   text[];
  v_from    timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('spotted_activations', 0));

  select * into v_state from spotted_activation_state for update;

  -- 1. Cutoff: behind p_now by the lag, never past this transaction's start, and before the
  --    oldest other open transaction (v_held), whose inserts (ingested_at is its start) may not
  --    have committed yet. least() ignores the null when no other transaction is visible.
  v_held := (select min(a.xact_start) - interval '1 microsecond'
             from pg_stat_activity a
             where a.pid <> pg_backend_pid()
               and a.backend_type = 'client backend'
               and a.xact_start is not null);
  v_cutoff := least(p_now - public.activation_ingest_lag(), now(), v_held);

  -- 2 and 3. Read the new reference spots in (ingested_at, id) order and attach or open each.
  for v_spot in
    select r.id, r.ingested_at, r.source, r.source_spot_id, r.spot_time, r.callsign, r.base_callsign,
           r.spotter, r.frequency_khz, r.band, r.mode, x.program, x.refs, x.names
    from raw_spots r
    cross join lateral (
      -- spot_stream's program, reference and reference_name expressions, with every WWBOTA bunker.
      select case when r.pota_reference is not null then 'pota'
                  when r.sota_summit_ref is not null then 'sota'
                  when r.wwff_reference is not null then 'wwff'
                  when r.wwbota_references[1] is not null then 'wwbota'
                  when r.iota_reference is not null then 'iota' end as program,
             case when r.pota_reference is not null then array[upper(r.pota_reference)]
                  when r.sota_summit_ref is not null then array[upper(r.sota_summit_ref)]
                  when r.wwff_reference is not null then array[upper(r.wwff_reference)]
                  when r.wwbota_references[1] is not null then w.refs
                  when r.iota_reference is not null then array[upper(r.iota_reference)] end as refs,
             case when r.pota_reference is not null then array[r.pota_park_name]
                  when r.sota_summit_ref is not null then array[null::text]
                  when r.wwff_reference is not null then array[r.wwff_reference_name]
                  when r.wwbota_references[1] is not null
                    then array[r.wwbota_reference_name] || array_fill(null::text, array[cardinality(w.refs) - 1])
                  else array[r.iota_reference_name] end as names
      from (select array_agg(d.ref order by d.ord) as refs
            from (select distinct on (upper(u.ref)) upper(u.ref) as ref, u.ord
                  from unnest(r.wwbota_references) with ordinality as u(ref, ord)
                  where u.ref is not null
                  order by upper(u.ref), u.ord) d) w
    ) x
    where (r.ingested_at, r.id) > (v_state.watermark_at, v_state.watermark_id)
      and r.ingested_at <= v_cutoff
      and r.retracted_at is null
      and (r.source in ('pota', 'sotawatch', 'wwff', 'wwbota')
           or (r.source = 'dxcluster' and r.iota_reference is not null))
      and x.program is not null
    order by r.ingested_at, r.id
    limit v_limit
  loop
    v_read := v_read + 1;
    v_last_at := v_spot.ingested_at;
    v_last_id := v_spot.id;
    continue when v_spot.base_callsign is null;

    v_day := (v_spot.spot_time at time zone 'utc')::date;

    select a.* into v_act
    from spotted_activations a
    where a.closed_at is null
      and a.base_callsign = v_spot.base_callsign
      and a.program = v_spot.program
      and a."references" && v_spot.refs
      and v_spot.spot_time between a.started_at - v_gap and a.last_spot_at + v_gap
      and (a.program <> 'pota' or a.day = v_day)
    order by a.started_at, a.id
    limit 1
    for update;

    if found then
      v_id := v_act.id;
      select m.refs, m.names into v_refs, v_names
      from public.activation_merge_references(v_act."references", v_act.reference_names, v_spot.refs, v_spot.names) m;
      update spotted_activations a
         set started_at = least(a.started_at, v_spot.spot_time),
             last_spot_at = greatest(a.last_spot_at, v_spot.spot_time),
             day = (least(a.started_at, v_spot.spot_time) at time zone 'utc')::date,
             "references" = v_refs,
             reference_names = v_names
       where a.id = v_id;
    else
      -- A spot that would have matched a closed activation arrived too late: drop it, so it
      -- never opens a one-spot copy of a finished activation.
      continue when exists (
        select 1
        from spotted_activations a
        where a.closed_at is not null
          and a.base_callsign = v_spot.base_callsign
          and a.started_at <= v_spot.spot_time + v_gap
          and a.program = v_spot.program
          and a."references" && v_spot.refs
          and v_spot.spot_time >= a.started_at - v_gap
          and v_spot.spot_time <= a.last_spot_at + v_gap
          and (a.program <> 'pota' or a.day = v_day));

      v_id := public.new_activation_id();
      insert into spotted_activations (id, base_callsign, program, "references", reference_names, day,
                                       started_at, last_spot_at)
      values (v_id, v_spot.base_callsign, v_spot.program, v_spot.refs, v_spot.names, v_day,
              v_spot.spot_time, v_spot.spot_time);
    end if;

    insert into spotted_activation_spots (activation_id, source, source_spot_id, spot_time, callsign, spotter,
                                          spotter_base, self_spot, frequency_khz, band, mode, "references")
    values (v_id, v_spot.source, v_spot.source_spot_id, v_spot.spot_time, v_spot.callsign, v_spot.spotter,
            public.base_callsign(v_spot.spotter), public.is_self_spot(v_spot.callsign, v_spot.spotter),
            v_spot.frequency_khz, v_spot.band, v_spot.mode, v_spot.refs)
    on conflict do nothing;

    if v_touched[cardinality(v_touched)] is distinct from v_id then
      v_touched := array_append(v_touched, v_id);
    end if;

    -- POTA counts each UTC day as its own activation: link the halves of a run across 00:00 UTC,
    -- looking both ways, since the 00:02 spot can be read before the 23:58 one.
    if v_spot.program = 'pota' then
      select * into v_act from spotted_activations a where a.id = v_id;

      if v_act.continued_from is null then
        update spotted_activations n
           set continued_from = (
                 select p.id
                 from spotted_activations p
                 where p.closed_at is null
                   and p.base_callsign = n.base_callsign
                   and p.program = 'pota'
                   and p.day = n.day - 1
                   and p."references" && n."references"
                   and p.last_spot_at >= n.started_at - v_gap
                 order by p.last_spot_at desc, p.id
                 limit 1)
         where n.id = v_id;
      end if;

      update spotted_activations f
         set continued_from = v_id
       where f.id = (
               select f2.id
               from spotted_activations f2
               where f2.closed_at is null
                 and f2.base_callsign = v_act.base_callsign
                 and f2.program = 'pota'
                 and f2.day = v_act.day + 1
                 and f2.continued_from is null
                 and f2."references" && v_act."references"
                 and f2.started_at <= v_act.last_spot_at + v_gap
               order by f2.started_at, f2.id
               limit 1);
    end if;
  end loop;

  -- The watermark advances to the last row read, never further.
  if v_read > 0 then
    update spotted_activation_state
       set watermark_at = v_last_at, watermark_id = v_last_id;
  end if;

  -- 4. Merge two-fers: two open rows of one base call and program (and UTC day, for POTA) whose
  --    [started_at, last_spot_at] intersect fold into the older. So do two that share a reference
  --    and lie within the gap of each other: a spot read out of order can bridge two runs of one
  --    reference, which in time order would have been one. Only a row this pass touched can have
  --    come to meet another, so the search starts from those, and a survivor is searched again,
  --    since it has grown. No id has been shown yet, so no redirect is written.
  foreach v_cur in array v_touched loop
    loop
      select case when (t.created_at, t.started_at, t.id) < (x.created_at, x.started_at, x.id) then t.id else x.id end
               as older,
             case when (t.created_at, t.started_at, t.id) < (x.created_at, x.started_at, x.id) then x.id else t.id end
               as younger
        into v_pair
      from spotted_activations t
      join spotted_activations x
        on x.closed_at is null
       and x.base_callsign = t.base_callsign
       and x.program = t.program
       and x.id <> t.id
       and (t.program <> 'pota' or x.day = t.day)
       and ((x.started_at <= t.last_spot_at and t.started_at <= x.last_spot_at)
            or (x."references" && t."references"
                and x.started_at <= t.last_spot_at + v_gap
                and t.started_at <= x.last_spot_at + v_gap))
      where t.id = v_cur and t.closed_at is null
      order by x.created_at, x.started_at, x.id
      limit 1;
      exit when not found;

      select * into v_act from spotted_activations a where a.id = v_pair.younger;

      insert into spotted_activation_spots (activation_id, source, source_spot_id, spot_time, callsign, spotter,
                                            spotter_base, self_spot, frequency_khz, band, mode, "references",
                                            spotter_state, spotter_entity, spotter_country)
      select v_pair.older, s.source, s.source_spot_id, s.spot_time, s.callsign, s.spotter, s.spotter_base,
             s.self_spot, s.frequency_khz, s.band, s.mode, s."references", s.spotter_state, s.spotter_entity,
             s.spotter_country
      from spotted_activation_spots s
      where s.activation_id = v_pair.younger
      order by s.id
      on conflict do nothing;

      select m.refs, m.names into v_refs, v_names
      from spotted_activations o
      cross join lateral public.activation_merge_references(o."references", o.reference_names,
                                                            v_act."references", v_act.reference_names) m
      where o.id = v_pair.older;

      update spotted_activations o
         set started_at = least(o.started_at, v_act.started_at),
             last_spot_at = greatest(o.last_spot_at, v_act.last_spot_at),
             day = (least(o.started_at, v_act.started_at) at time zone 'utc')::date,
             "references" = v_refs,
             reference_names = v_names,
             continued_from = coalesce(o.continued_from, v_act.continued_from)
       where o.id = v_pair.older;

      update spotted_activations a set continued_from = v_pair.older where a.continued_from = v_pair.younger;
      delete from spotted_activations a where a.id = v_pair.younger;
      v_cur := v_pair.older;
    end loop;
  end loop;

  -- 5. Close, unless capped: closing against p_now with unread spots behind the watermark would
  --    close too early. For the same reason, while another transaction holds the cutoff back, a
  --    pass closes only what had gone quiet by the held cutoff (plus the usual lag).
  if v_read < v_limit then
    for v_act in
      select a.*
      from spotted_activations a
      where a.closed_at is null
        and a.last_spot_at < least(p_now, v_held + public.activation_ingest_lag()) - v_gap
      order by a.last_spot_at, a.id
      limit public.activation_close_limit()
      for update
    loop
      select array_agg(distinct s.band) into v_bands
      from spotted_activation_spots s
      where s.activation_id = v_act.id and s."references" is not null and s.band is not null;

      -- RBN and DX Cluster times are minute-granular, so the window starts on the minute.
      v_from := date_trunc('minute', v_act.started_at, 'UTC');

      insert into spotted_activation_spots (activation_id, source, source_spot_id, spot_time, callsign, spotter,
                                            spotter_base, self_spot, frequency_khz, band, mode, "references")
      select v_act.id, 'rbn', null, s.spot_time, s.callsign, s.spotter, public.base_callsign(s.spotter),
             public.is_self_spot(s.callsign, s.spotter), s.frequency_khz, s.band, s.mode, null
      from rbn_spots s
      where public.base_callsign(s.callsign) = v_act.base_callsign
        and s.spot_time >= v_from
        and s.spot_time <= v_act.last_spot_at
        and s.spot_type in ('CQ', 'DX')
        and s.band = any (v_bands)
      order by s.spot_time, s.spotter
      on conflict do nothing;

      insert into spotted_activation_spots (activation_id, source, source_spot_id, spot_time, callsign, spotter,
                                            spotter_base, self_spot, frequency_khz, band, mode, "references")
      select v_act.id, 'dxcluster', r.source_spot_id, r.spot_time, r.callsign, r.spotter,
             public.base_callsign(r.spotter), public.is_self_spot(r.callsign, r.spotter), r.frequency_khz,
             r.band, r.mode, null
      from raw_spots r
      where r.base_callsign = v_act.base_callsign
        and r.spot_time >= v_from
        and r.spot_time <= v_act.last_spot_at
        and r.source = 'dxcluster'
        and r.retracted_at is null
        and r.band = any (v_bands)
      order by r.spot_time, r.id
      on conflict do nothing;

      -- Places, once per distinct spotter (rollup_country_day's pattern).
      with sp as (
        select distinct s.spotter, s.spotter_base
        from spotted_activation_spots s
        where s.activation_id = v_act.id and s.spotter is not null
      ),
      geo as (
        select sp.spotter, l.entity, l.name, lic.state
        from sp
        left join lateral public.cty_lookup(sp.spotter) l on true
        left join lateral (
          select c.state
          from callsign_licenses c
          where c.callsign = sp.spotter_base and c.country = 'US' and c.state = any (public.us_states())
        ) lic on true
      )
      update spotted_activation_spots s
         set spotter_state = g.state, spotter_entity = g.entity, spotter_country = g.name
        from geo g
       where s.activation_id = v_act.id and s.spotter = g.spotter;

      -- The first reference's coordinates and own US states (parsed as goal_park_state does), and
      -- the list's name for any reference the feed left unnamed (SOTAwatch names no summit).
      update spotted_activations a
         set latitude = c.latitude,
             longitude = c.longitude,
             location_states = coalesce(
               array(select distinct m[1]
                     from regexp_matches(coalesce(c.location, ''), 'US-([A-Z]{2})', 'g') as m
                     where m[1] = any (public.us_states())
                     order by 1),
               '{}'),
             reference_names = array(
               select coalesce(u.name, (select k.name from reference_catalog k
                                        where k.program = a.program and k.reference = u.ref))
               from unnest(a."references", a.reference_names) with ordinality as u(ref, name, ord)
               order by u.ord)
        from (select 1) one
        left join reference_catalog c on c.program = v_act.program and c.reference = v_act."references"[1]
       where a.id = v_act.id;

      update spotted_activations a
         set spot_count = x.spots,
             source_counts = x.sources,
             bands = x.bands,
             modes = x.modes,
             states = coalesce((select array_agg(h.code order by h.code) from public.spotted_activation_heard(a.id) h
                                where h.kind = 'state'), '{}'),
             countries = coalesce((select array_agg(h.name order by h.name) from public.spotted_activation_heard(a.id) h
                                   where h.kind = 'country'), '{}'),
             farthest = public.spotted_activation_farthest(a.id),
             closed_at = p_now
        from (
          select count(*)::int as spots,
                 (select jsonb_object_agg(c.source, c.n order by c.source)
                  from (select s2.source, count(*)::int as n from spotted_activation_spots s2
                        where s2.activation_id = v_act.id group by s2.source) c) as sources,
                 coalesce((select array_agg(b.band order by b.n desc, array_position(public.goal_bands(), b.band), b.band)
                           from (select s2.band, count(*) as n from spotted_activation_spots s2
                                 where s2.activation_id = v_act.id and s2.band is not null group by s2.band) b), '{}')
                   as bands,
                 coalesce((select array_agg(o.mode order by o.n desc, o.mode)
                           from (select s2.mode, count(*) as n from spotted_activation_spots s2
                                 where s2.activation_id = v_act.id and s2.mode is not null group by s2.mode) o), '{}')
                   as modes
          from spotted_activation_spots s
          where s.activation_id = v_act.id
        ) x
       where a.id = v_act.id;
    end loop;
  end if;

  update spotted_activation_state set last_run_at = now();
  return v_read;
end;
$$;

revoke all on function public.assemble_spotted_activations(timestamptz) from public;

select cron.schedule(
  'assemble-spotted-activations',
  '* * * * *',
  $$ select public.assemble_spotted_activations(now()); $$
);

-- ---------------------------------------------------------------------------
-- 5. Read RPCs
-- ---------------------------------------------------------------------------

create function public.spotted_activation_time(p_at timestamptz)
returns text
language sql
immutable
set search_path = ''
as $$ select to_char(p_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') $$;

revoke all on function public.spotted_activation_time(timestamptz) from public;

-- The id of the closed activation that continues p_id after 00:00 UTC, or null.
create function public.spotted_activation_continued_by(p_id text)
returns text
language sql
stable
set search_path = public
as $$
  select c.id
  from spotted_activations c
  where c.continued_from = p_id and c.closed_at is not null
  order by c.started_at, c.id
  limit 1
$$;

revoke all on function public.spotted_activation_continued_by(text) from public;

-- p_id's continued_from when that activation is closed (the only kind anyone sees), else null.
create function public.spotted_activation_continued_from(p_id text)
returns text
language sql
stable
set search_path = public
as $$
  select f.id
  from spotted_activations a
  join spotted_activations f on f.id = a.continued_from and f.closed_at is not null
  where a.id = p_id
$$;

revoke all on function public.spotted_activation_continued_from(text) from public;

-- One activation as SpottedActivation (web/src/activations/types.ts), following
-- spotted_activation_redirects. Null for an unknown id, an open activation or a hidden activator.
-- A hidden spotter's spots are left out, and the counts, places and farthest are recomputed from
-- the rest.
create function public.spotted_activation(p_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_id text;
  v_a  spotted_activations%rowtype;
begin
  v_id := coalesce((select d.new_id from spotted_activation_redirects d where d.old_id = p_id), p_id);

  select * into v_a from spotted_activations a where a.id = v_id and a.closed_at is not null;
  if not found then
    return null;
  end if;
  if exists (select 1 from hidden_callsigns h where h.callsign = v_a.base_callsign) then
    return null;
  end if;

  return (
    with s as (
      select s.*
      from spotted_activation_spots s
      where s.activation_id = v_a.id
        and (s.spotter_base is null
             or not exists (select 1 from hidden_callsigns h where h.callsign = s.spotter_base))
    ),
    h as (
      select * from public.spotted_activation_heard(v_a.id)
    )
    select jsonb_build_object(
      'id', v_a.id,
      'callsign', v_a.base_callsign,
      'program', v_a.program,
      'references', to_jsonb(v_a."references"),
      'referenceNames', to_jsonb(v_a.reference_names),
      'day', v_a.day,
      'startedAt', public.spotted_activation_time(v_a.started_at),
      'lastSpotAt', public.spotted_activation_time(v_a.last_spot_at),
      'durationSeconds', extract(epoch from v_a.last_spot_at - v_a.started_at)::int,
      'split', jsonb_build_object(
        'continuedFrom', public.spotted_activation_continued_from(v_a.id),
        'continuedBy', public.spotted_activation_continued_by(v_a.id)),
      'location', case when v_a.latitude is not null and v_a.longitude is not null
                       then jsonb_build_object('latitude', v_a.latitude, 'longitude', v_a.longitude,
                                               'states', to_jsonb(coalesce(v_a.location_states, '{}'))) end,
      'spotCount', (select count(*)::int from s),
      'sources', coalesce((select jsonb_object_agg(c.source, c.n order by c.source)
                           from (select s.source, count(*)::int as n from s group by s.source) c), '{}'::jsonb),
      'bands', to_jsonb(coalesce(v_a.bands, '{}')),
      'modes', to_jsonb(coalesce(v_a.modes, '{}')),
      'heard', coalesce((select jsonb_agg(jsonb_build_object(
                                  'kind', h.kind, 'code', h.code, 'name', h.name,
                                  'latitude', h.latitude, 'longitude', h.longitude, 'spots', h.spots)
                                order by h.kind desc, h.spots desc, h.name, h.code)
                         from h), '[]'::jsonb),
      'farthest', public.spotted_activation_farthest(v_a.id),
      'spots', coalesce((select jsonb_agg(jsonb_build_object(
                                  'time', public.spotted_activation_time(s.spot_time),
                                  'source', s.source,
                                  'spotter', s.spotter,
                                  'spotterBase', s.spotter_base,
                                  'selfSpot', s.self_spot,
                                  'place', coalesce(c.name, s.spotter_country),
                                  'frequencyKhz', s.frequency_khz,
                                  'mode', s.mode,
                                  'references', to_jsonb(s."references"))
                                order by s.spot_time, s.id)
                         from s
                         left join us_state_centroids c on c.state = s.spotter_state), '[]'::jsonb))
  );
end;
$$;

revoke all on function public.spotted_activation(text) from public;

-- A callsign's Spotted activations tab as CallsignActivations (web/src/activations/types.ts):
-- the twelve months before p_now summed, and the newest closed activations (at most 200, with
-- more when there were more). Null for a malformed or hidden call.
create function public.callsign_spotted_activations(p_callsign text, p_now timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_base  text := public.base_callsign(p_callsign);
  v_from  timestamptz := ((p_now at time zone 'utc') - interval '12 months') at time zone 'utc';
  v_cap   int := 200;
begin
  if v_base is null or v_base !~ '^[A-Z0-9]+$' then
    return null;
  end if;
  if exists (select 1 from hidden_callsigns h where h.callsign = v_base) then
    return null;
  end if;

  return (
    with y as (
      select a.*
      from spotted_activations a
      where a.base_callsign = v_base
        and a.closed_at is not null
        and a.started_at >= v_from
        and a.started_at <= p_now
    ),
    r as (
      select distinct y.program, u.ref
      from y cross join lateral unnest(y."references") as u(ref)
    ),
    most as (
      select y.program, u.ref, count(*)::int as times, max(y.started_at) as last_at,
             (array_agg(y.reference_names[u.ord] order by y.started_at desc, y.id)
                filter (where y.reference_names[u.ord] is not null))[1] as name
      from y cross join lateral unnest(y."references") with ordinality as u(ref, ord)
      group by y.program, u.ref
      order by count(*) desc, max(y.started_at) desc, u.ref
      limit 1
    ),
    recent as (
      select a.*
      from spotted_activations a
      where a.base_callsign = v_base
        and a.closed_at is not null
      order by a.started_at desc, a.id
      limit v_cap + 1
    )
    select jsonb_build_object(
      'callsign', v_base,
      'summary', jsonb_build_object(
        'activations', (select count(*)::int from y),
        'references', jsonb_build_object(
          'total', (select count(*)::int from r),
          'pota', (select count(*)::int from r where r.program = 'pota'),
          'sota', (select count(*)::int from r where r.program = 'sota'),
          'wwff', (select count(*)::int from r where r.program = 'wwff'),
          'wwbota', (select count(*)::int from r where r.program = 'wwbota'),
          'iota', (select count(*)::int from r where r.program = 'iota')),
        'onAirSeconds', coalesce((select sum(extract(epoch from y.last_spot_at - y.started_at))::bigint from y), 0),
        'mostActivated', (select jsonb_build_object('program', m.program, 'reference', m.ref, 'name', m.name,
                                                    'times', m.times)
                          from most m)),
      'recent', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', c.id,
                 'program', c.program,
                 'references', to_jsonb(c."references"),
                 'referenceNames', to_jsonb(c.reference_names),
                 'day', c.day,
                 'startedAt', public.spotted_activation_time(c.started_at),
                 'lastSpotAt', public.spotted_activation_time(c.last_spot_at),
                 'durationSeconds', extract(epoch from c.last_spot_at - c.started_at)::int,
                 'spotCount', (select count(*)::int
                               from spotted_activation_spots s
                               where s.activation_id = c.id
                                 and (s.spotter_base is null
                                      or not exists (select 1 from hidden_callsigns h
                                                     where h.callsign = s.spotter_base))),
                 'bands', to_jsonb(coalesce(c.bands, '{}')),
                 'modes', to_jsonb(coalesce(c.modes, '{}')),
                 'states', (select count(*)::int from public.spotted_activation_heard(c.id) h where h.kind = 'state'),
                 'countries', (select count(*)::int from public.spotted_activation_heard(c.id) h
                               where h.kind = 'country'),
                 'continuedFrom', public.spotted_activation_continued_from(c.id),
                 'continuedBy', public.spotted_activation_continued_by(c.id))
               order by c.started_at desc, c.id)
        from (select * from recent order by recent.started_at desc, recent.id limit v_cap) c), '[]'::jsonb),
      'more', (select count(*) from recent) > v_cap)
  );
end;
$$;

revoke all on function public.callsign_spotted_activations(text, timestamptz) from public;

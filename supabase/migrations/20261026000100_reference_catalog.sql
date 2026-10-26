-- Reference profiles, PR 2: the programs' reference lists
-- (docs/superpowers/specs/2026-10-26-reference-profiles-design.md, decisions 2 and 3).
--
-- reference_catalog holds every POTA park, SOTA summit and WWFF reference from each program's
-- official list, one row per reference with only what the reference page and its link preview
-- show. The lists load the way the FCC licenses do (20261012000050), from the Fly relay
-- (relay/catalogs.ts), one program at a time:
--   1. load-references -> begin_reference_load: a new reference_catalog_loads row; the program's
--      open staging loads are abandoned and their staged rows deleted
--   2. load-references -> stage_reference_rows, in batches, into reference_catalog_stage
--   3. load-references -> finish_reference_load: the staged count must match what the relay
--      last heard and clear the floor (decision 3), else the load is refused and stays refused
--      (or abandon_reference_load when the relay gives up)
--   4. pg_cron -> apply_reference_loads, hourly: swaps each program's newest finished load into
--      reference_catalog in one statement pair, so a reader sees the old list or the new one.
-- A truncated list never replaces a good one: a load is refused when it is incomplete or holds
-- fewer than 90% of the program's current rows (10,000 on a first load). A refused load newer
-- than the program's last applied one makes apply_reference_loads raise whenever it swaps
-- nothing, so the cron job fails on /health until a good load lands.
--
-- Unlike the license staging tables, the stage is logged: a load is ~35k-180k narrow rows a week,
-- and a stage that a crash emptied between finish and apply would otherwise swap in short.
-- apply_reference_loads checks the count again anyway.

create table reference_catalog (
  program    text    not null check (program in ('pota', 'sota', 'wwff')),
  reference  text    not null check (reference <> '' and reference = upper(reference)),
  name       text,
  active     boolean not null,           -- POTA active = 1, SOTA ValidTo not past, WWFF status active
  location   text,                       -- POTA locationDesc: US-NC,US-VA
  region     text,                       -- SOTA association and region, WWFF state or region
  country    text,                       -- WWFF: cty.dat's entity for its dxcc prefix, else its country
  latitude   numeric,
  longitude  numeric,
  grid       text,                       -- SOTA's derived from its coordinates
  altitude_m integer,                    -- SOTA
  points     integer,                    -- SOTA
  valid_from date,                       -- SOTA, WWFF
  valid_to   date,                       -- SOTA, WWFF; set on a retired reference
  primary key (program, reference)
);

comment on table reference_catalog is
  'The POTA, SOTA and WWFF reference lists, swapped in weekly per program by apply_reference_loads. '
  'Service role only.';

-- One row per load attempt. version is the file's Last-Modified header.
create table reference_catalog_loads (
  id          bigint      generated always as identity primary key,
  program     text        not null check (program in ('pota', 'sota', 'wwff')),
  version     text        not null,
  state       text        not null default 'staging'
                          check (state in ('staging', 'finished', 'applied', 'refused', 'abandoned')),
  staged_rows integer     not null default 0,  -- rows staged so far; after apply, the program's rows
  started_at  timestamptz not null default now(),
  finished_at timestamptz,                     -- when finish (or abandon) ended staging
  applied_at  timestamptz,
  error       text                             -- why it was refused or abandoned
);

create index reference_catalog_loads_program_idx on reference_catalog_loads (program, id desc);

comment on table reference_catalog_loads is
  'One row per reference list load: staging, finished, applied, refused or abandoned. Service role only.';

-- Staging for the loads in flight, keyed by load. A load's rows go when it is applied, refused,
-- abandoned or superseded.
create table reference_catalog_stage (
  load_id    bigint  not null references reference_catalog_loads (id) on delete cascade,
  program    text    not null check (program in ('pota', 'sota', 'wwff')),
  reference  text    not null check (reference <> '' and reference = upper(reference)),
  name       text,
  active     boolean not null,
  location   text,
  region     text,
  country    text,
  latitude   numeric,
  longitude  numeric,
  grid       text,
  altitude_m integer,
  points     integer,
  valid_from date,
  valid_to   date,
  primary key (load_id, reference)
);

comment on table reference_catalog_stage is
  'Rows of the reference list loads in flight (stage_reference_rows). Service role only.';

alter table reference_catalog enable row level security;
alter table reference_catalog_loads enable row level security;
alter table reference_catalog_stage enable row level security;
revoke all on reference_catalog, reference_catalog_loads, reference_catalog_stage from anon, authenticated;
revoke all on sequence reference_catalog_loads_id_seq from anon, authenticated;

-- Per program, the last applied load and the newest load (either null). The relay decides from it
-- whether to download a list: {"pota": {"applied": {version, started_at, applied_at, rows} | null,
-- "newest": {id, version, state, rows, started_at, finished_at} | null}, "sota": ..., "wwff": ...}.
create function public.reference_load_status()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_object_agg(p.program, jsonb_build_object(
           'applied', (select jsonb_build_object('version', l.version, 'started_at', l.started_at,
                                                 'applied_at', l.applied_at, 'rows', l.staged_rows)
                       from reference_catalog_loads l
                       where l.program = p.program and l.state = 'applied'
                       order by l.id desc
                       limit 1),
           'newest', (select jsonb_build_object('id', l.id, 'version', l.version, 'state', l.state,
                                                'rows', l.staged_rows, 'started_at', l.started_at,
                                                'finished_at', l.finished_at)
                      from reference_catalog_loads l
                      where l.program = p.program
                      order by l.id desc
                      limit 1)))
  from unnest(array['pota', 'sota', 'wwff']) as p(program);
$$;

comment on function public.reference_load_status() is
  'Per program, the last applied reference list load and the newest one, for the relay. Service role only.';

-- Starts a load of one program's list: that program's open staging loads are abandoned and their
-- staged rows deleted. Returns the new load's id.
create function public.begin_reference_load(p_program text, p_version text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  if p_program is null or p_program not in ('pota', 'sota', 'wwff') then
    raise exception 'begin_reference_load: unknown program %', p_program;
  end if;
  if coalesce(trim(p_version), '') = '' then
    raise exception 'begin_reference_load: version is required';
  end if;

  with gone as (
    update reference_catalog_loads
       set state = 'abandoned', finished_at = now(),
           error = 'superseded by a load of ' || trim(p_version)
     where program = p_program and state = 'staging'
    returning id
  )
  delete from reference_catalog_stage s using gone where s.load_id = gone.id;

  insert into reference_catalog_loads (program, version)
  values (p_program, trim(p_version))
  returning id into v_id;
  return v_id;
end;
$$;

comment on function public.begin_reference_load(text, text) is
  'Starts a reference list load (load-references): abandons the program''s open staging loads. Service role only.';

-- Stages one batch of rows (ReferenceCatalogRow objects, _shared/reference_catalog.ts) for a
-- staging load. A reference already staged in this load (a retried batch, or a list that names one
-- twice) is skipped. Returns the load's rows staged so far, kept on the load row in the same
-- transaction, so a retry after a lost reply still reports the right total.
--
-- A WWFF row's country is cty.dat's entity for its dxcc prefix (cty_lookup, once per distinct
-- prefix in the batch), and the directory's own country only when that finds none: the directory
-- leaves the column blank for most references and spells the rest several ways (U.S.A., United
-- States). Only a plain prefix is looked up (VP8-SG, SV/A and 3Y/P name entities cty.dat would
-- resolve to their parents), and AN, WWFF's prefix for Antarctica, is Spain's to cty.dat, so it is
-- looked up as CE9, cty.dat's Antarctica. dxcc itself is not stored.
create function public.stage_reference_rows(p_load bigint, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_program text;
  v_inserted integer;
  v_staged integer;
begin
  select program into v_program from reference_catalog_loads
  where id = p_load and state = 'staging'
  for update;
  if not found then
    raise exception 'stage_reference_rows: load % is not staging', p_load;
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'stage_reference_rows: rows must be an array';
  end if;

  with x as (
    select r.*, upper(trim(r.dxcc)) as prefix
    from jsonb_to_recordset(p_rows) as r(
      reference text, name text, active boolean, location text, region text, country text,
      dxcc text, latitude numeric, longitude numeric, grid text, altitude_m integer, points integer,
      valid_from date, valid_to date)
  ),
  entity as (
    select d.prefix,
           (select c.name from cty_lookup(case d.prefix when 'AN' then 'CE9' else d.prefix end) as c) as name
    from (select distinct prefix from x where prefix ~ '^[A-Z0-9]+$') as d
  )
  insert into reference_catalog_stage (load_id, program, reference, name, active, location, region, country,
                                       latitude, longitude, grid, altitude_m, points, valid_from, valid_to)
  select p_load, v_program, upper(trim(x.reference)), x.name, x.active, x.location, x.region,
         coalesce(entity.name, x.country),
         x.latitude, x.longitude, x.grid, x.altitude_m, x.points, x.valid_from, x.valid_to
  from x
  left join entity on entity.prefix = x.prefix
  on conflict (load_id, reference) do nothing;
  get diagnostics v_inserted = row_count;

  update reference_catalog_loads set staged_rows = staged_rows + v_inserted
   where id = p_load
  returning staged_rows into v_staged;
  return v_staged;
end;
$$;

comment on function public.stage_reference_rows(bigint, jsonb) is
  'Stages a batch of reference list rows; returns the load''s rows staged so far. Service role only.';

-- The fewest rows a program's next list may hold (decision 3): 90% of its current rows, or 10,000
-- when it has none yet.
create function public.reference_load_floor(p_program text)
returns integer
language sql
stable
set search_path = public
as $$
  select case when n = 0 then 10000 else ceil(n * 0.9)::integer end
  from (select count(*) as n from reference_catalog where program = p_program) c;
$$;

comment on function public.reference_load_floor(text) is
  'The fewest rows a program''s next reference list may hold: 90% of its current rows, 10,000 on a first load.';

-- Ends staging. p_rows is the rows staged as the relay last heard from stage_reference_rows; a
-- mismatch with the stage means a lost batch. Returns 'finished', or 'refused' when the stage is
-- incomplete or below the floor; a refusal deletes the staged rows and is committed with this call
-- (it does not raise), so it stays on the load for /health and the relay.
create function public.finish_reference_load(p_load bigint, p_rows integer)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_program text;
  v_staged integer;
  v_floor integer;
  v_error text;
begin
  select program into v_program from reference_catalog_loads
  where id = p_load and state = 'staging'
  for update;
  if not found then
    raise exception 'finish_reference_load: load % is not staging', p_load;
  end if;

  select count(*) into v_staged from reference_catalog_stage where load_id = p_load;
  v_floor := reference_load_floor(v_program);
  if p_rows is null or v_staged <> p_rows then
    v_error := format('incomplete: staged %s rows but the relay sent %s', v_staged, coalesce(p_rows::text, 'none'));
  elsif v_staged < v_floor then
    v_error := format('too few rows: staged %s, the floor is %s', v_staged, v_floor);
  end if;

  if v_error is not null then
    update reference_catalog_loads
       set state = 'refused', staged_rows = v_staged, finished_at = now(), error = v_error
     where id = p_load;
    delete from reference_catalog_stage where load_id = p_load;
    return 'refused';
  end if;

  update reference_catalog_loads set state = 'finished', staged_rows = v_staged, finished_at = now()
   where id = p_load;
  return 'finished';
end;
$$;

comment on function public.finish_reference_load(bigint, integer) is
  'Ends a reference list load: finished, or refused when incomplete or below the floor. Service role only.';

-- The relay gave up on a load (a failed batch, a short read, a shutdown): it is abandoned with the
-- relay's reason and its staged rows deleted now. Does nothing unless that load is still staging.
create function public.abandon_reference_load(p_load bigint, p_error text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update reference_catalog_loads
     set state = 'abandoned', finished_at = now(),
         error = left(coalesce(nullif(trim(p_error), ''), 'abandoned'), 1000)
   where id = p_load and state = 'staging';
  if found then
    delete from reference_catalog_stage where load_id = p_load;
  end if;
end;
$$;

comment on function public.abandon_reference_load(bigint, text) is
  'Abandons a staging reference list load and deletes its staged rows. Service role only.';

-- Swaps each program's newest finished load (newer than its last applied one) into
-- reference_catalog (pg_cron, hourly). Each program is its own subtransaction: its rows are
-- deleted and the stage inserted in their place, so a reader sees the old list or the new one,
-- and a program whose swap fails (the stage no longer matching the load, or the floor) is refused
-- without undoing another's. Older finished loads of a swapped program are superseded, and the
-- stage rows of that load and older ones deleted.
--
-- Set-based on purpose: SOTA's ~180k rows go in one delete and one insert, a few seconds. It runs
-- only from pg_cron, under the cron session's 2-minute statement_timeout, never through the API
-- (whose 8 s timeout a swap could outlast), which is why the relay's finish does not swap.
--
-- When a run neither swaps nor refuses anything while some program's newest load was already
-- refused when it started (newer than that program's last applied load), it raises:
-- finish_reference_load committed the refusal, and the failed run shows on /health's job check
-- every hour until a good load lands. A run that refused a load itself does not raise, since the
-- raise would roll that refusal back and leave the load finished (which the relay waits on) for as
-- long as the other program stays refused; the next run raises for both.
create function public.apply_reference_loads()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_program text;
  v_load reference_catalog_loads;
  v_staged integer;
  v_floor integer;
  v_rows integer;
  v_swapped integer := 0;
  v_refused_now boolean := false;
  v_refused text[];
begin
  -- Programs whose newest load is a refusal newer than their last applied load, before this run.
  select array_agg(p.program order by p.program) into v_refused
  from unnest(array['pota', 'sota', 'wwff']) as p(program)
  where (select l.state from reference_catalog_loads l
         where l.program = p.program and l.id > coalesce(
                 (select max(a.id) from reference_catalog_loads a
                  where a.program = p.program and a.state = 'applied'), 0)
         order by l.id desc limit 1) = 'refused';

  foreach v_program in array array['pota', 'sota', 'wwff'] loop
    select * into v_load from reference_catalog_loads l
    where l.program = v_program and l.state = 'finished'
      and l.id > coalesce((select max(a.id) from reference_catalog_loads a
                           where a.program = v_program and a.state = 'applied'), 0)
    order by l.id desc
    limit 1
    for update;
    continue when not found;

    begin
      select count(*) into v_staged from reference_catalog_stage where load_id = v_load.id;
      v_floor := reference_load_floor(v_program);
      if v_staged <> v_load.staged_rows then
        raise exception 'staging no longer matches load % (% rows staged of %)', v_load.id, v_staged,
          v_load.staged_rows;
      end if;
      if v_staged < v_floor then
        raise exception 'too few rows: staged %, the floor is %', v_staged, v_floor;
      end if;

      delete from reference_catalog where program = v_program;
      insert into reference_catalog (program, reference, name, active, location, region, country,
                                     latitude, longitude, grid, altitude_m, points, valid_from, valid_to)
      select program, reference, name, active, location, region, country,
             latitude, longitude, grid, altitude_m, points, valid_from, valid_to
      from reference_catalog_stage
      where load_id = v_load.id;
      get diagnostics v_rows = row_count;

      update reference_catalog_loads set state = 'applied', applied_at = now(), staged_rows = v_rows
       where id = v_load.id;
      v_swapped := v_swapped + 1;
    exception when others then
      update reference_catalog_loads set state = 'refused', error = left(sqlerrm, 1000)
       where id = v_load.id;
      v_refused_now := true;
    end;

    update reference_catalog_loads set state = 'abandoned', error = 'superseded by load ' || v_load.id
     where program = v_program and state = 'finished' and id < v_load.id;
    delete from reference_catalog_stage s
    using reference_catalog_loads l
    where l.id = s.load_id and l.program = v_program and l.id <= v_load.id;
  end loop;

  if v_swapped = 0 and not v_refused_now and v_refused is not null then
    raise exception 'apply_reference_loads: the newest % list load was refused; the old list stays',
      array_to_string(v_refused, ', ');
  end if;
end;
$$;

comment on function public.apply_reference_loads() is
  'Swaps each program''s newest finished reference list load into reference_catalog (pg_cron, hourly). '
  'Raises when it swaps and refuses nothing while a program''s newest load is refused.';

revoke all on function public.reference_load_status() from public, anon, authenticated;
revoke all on function public.begin_reference_load(text, text) from public, anon, authenticated;
revoke all on function public.stage_reference_rows(bigint, jsonb) from public, anon, authenticated;
revoke all on function public.reference_load_floor(text) from public, anon, authenticated;
revoke all on function public.finish_reference_load(bigint, integer) from public, anon, authenticated;
revoke all on function public.abandon_reference_load(bigint, text) from public, anon, authenticated;
revoke all on function public.apply_reference_loads() from public, anon, authenticated;
grant execute on function public.reference_load_status() to service_role;
grant execute on function public.begin_reference_load(text, text) to service_role;
grant execute on function public.stage_reference_rows(bigint, jsonb) to service_role;
grant execute on function public.reference_load_floor(text) to service_role;
grant execute on function public.finish_reference_load(bigint, integer) to service_role;
grant execute on function public.abandon_reference_load(bigint, text) to service_role;
grant execute on function public.apply_reference_loads() to service_role;

-- Hourly at :55, a minute no other job uses (:50 is apply-license-loads, :05 the stats snapshot).
-- Usually a no-op; a program's weekly load is applied within an hour of the relay finishing it.
select cron.schedule('apply-reference-loads', '55 * * * *', $$ select public.apply_reference_loads(); $$);

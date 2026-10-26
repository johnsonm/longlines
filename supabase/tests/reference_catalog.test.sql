-- pgTAP: reference list loads (20261026000100). Batches stage, finish refuses an incomplete stage
-- or one below the floor (decision 3) and commits the refusal, apply swaps a finished stage into
-- reference_catalog per program, raises when it swaps nothing while a program's newest load is
-- refused, and clients can touch none of it.
begin;
create extension if not exists pgtap with schema extensions;
select plan(67);

delete from reference_catalog;
delete from reference_catalog_loads;

-- n made-up references <prefix><i>, lower case so the upper-casing shows.
create function pg_temp.ref_rows(p_prefix text, p_from int, p_to int) returns jsonb language sql as $$
  select jsonb_agg(jsonb_build_object('reference', p_prefix || i, 'name', 'Seed Park ' || i, 'active', true))
  from generate_series(p_from, p_to) as i;
$$;

create temp table loads (name text primary key, id bigint);

-- Status before any load ----------------------------------------------------------------------

select is(reference_load_status(),
  '{"pota": {"applied": null, "newest": null}, "sota": {"applied": null, "newest": null},
    "wwff": {"applied": null, "newest": null}}'::jsonb,
  'status names every program with no loads');

select throws_ok($$select begin_reference_load('iota', 'v')$$, 'P0001',
  'begin_reference_load: unknown program iota', 'an unknown program is refused');
select throws_ok($$select begin_reference_load('pota', ' ')$$, 'P0001',
  'begin_reference_load: version is required', 'a version is required');

-- A first load below 10,000 rows is refused ----------------------------------------------------

insert into loads values ('pota1', begin_reference_load('pota', 'Sun, 25 Oct 2026 04:00:00 GMT'));
select is(reference_load_status() #>> '{pota,newest,state}', 'staging', 'status reports the staging load');
select is(stage_reference_rows((select id from loads where name = 'pota1'), pg_temp.ref_rows('us-', 1, 50)), 50,
  'a batch stages');
select is(finish_reference_load((select id from loads where name = 'pota1'), 50), 'refused',
  'a first load under 10,000 rows is refused');
select is((select (state, staged_rows, error)::text from reference_catalog_loads l join loads using (id)
           where loads.name = 'pota1'),
  '(refused,50,"too few rows: staged 50, the floor is 10000")', 'the refusal says why');
select is((select count(*) from reference_catalog_stage), 0::bigint, 'a refusal deletes the staged rows');
select throws_ok($$select apply_reference_loads()$$, 'P0001',
  'apply_reference_loads: the newest pota list load was refused; the old list stays',
  'apply raises when it swaps nothing and the newest load is refused');

-- A complete stage swaps in -------------------------------------------------------------------

insert into loads values ('pota2', begin_reference_load('pota', 'Mon, 26 Oct 2026 04:00:00 GMT'));
select is(stage_reference_rows((select id from loads where name = 'pota2'), pg_temp.ref_rows('us-', 1, 6000)),
  6000, 'the first batch stages');
select is(stage_reference_rows((select id from loads where name = 'pota2'), pg_temp.ref_rows('us-', 5001, 10000)),
  10000, 'a batch that repeats references stages only the new ones and returns the total');
select is(stage_reference_rows((select id from loads where name = 'pota2'), pg_temp.ref_rows('us-', 9001, 10000)),
  10000, 'a retried batch stages nothing and still returns the total');
select throws_ok($$select stage_reference_rows((select id from loads where name = 'pota2'), '{}')$$, 'P0001',
  'stage_reference_rows: rows must be an array', 'rows must be an array');
select is((select reference from reference_catalog_stage
           where load_id = (select id from loads where name = 'pota2') order by reference limit 1),
  'US-1', 'references are stored upper case');
select lives_ok($$select apply_reference_loads()$$, 'apply with a staging load and an older refusal is a no-op');
select is(finish_reference_load((select id from loads where name = 'pota2'), 10000), 'finished',
  'a complete stage over the floor finishes');
select throws_ok($$select stage_reference_rows((select id from loads where name = 'pota2'), '[]')$$, 'P0001',
  format('stage_reference_rows: load %s is not staging', (select id from loads where name = 'pota2')),
  'a finished load takes no more rows');
select throws_ok($$select finish_reference_load((select id from loads where name = 'pota2'), 10000)$$, 'P0001',
  format('finish_reference_load: load %s is not staging', (select id from loads where name = 'pota2')),
  'a finished load cannot finish again');

select lives_ok($$select apply_reference_loads()$$, 'apply swaps the finished load in');
select is((select count(*) from reference_catalog where program = 'pota'), 10000::bigint,
  'the catalog holds the load''s rows');
select is((select (state, staged_rows, applied_at is not null)::text from reference_catalog_loads
           where id = (select id from loads where name = 'pota2')),
  '(applied,10000,t)', 'the load is applied with its row count');
select is((select count(*) from reference_catalog_stage), 0::bigint, 'apply deletes the applied stage');
select is((reference_load_status() -> 'pota' -> 'applied') - 'applied_at',
  '{"version": "Mon, 26 Oct 2026 04:00:00 GMT", "rows": 10000}'::jsonb, 'status reports the applied load');
select is(reference_load_status() #>> '{pota,newest,state}', 'applied', 'the newest load is the applied one');
select lives_ok($$select apply_reference_loads()$$,
  'apply is a no-op once the newest load is applied (an older refusal does not count)');

-- Apply checks the stage again ----------------------------------------------------------------

insert into loads values ('wwff1', begin_reference_load('wwff', 'w1'));
select stage_reference_rows((select id from loads where name = 'wwff1'), pg_temp.ref_rows('kff-', 1, 10000));
select is(finish_reference_load((select id from loads where name = 'wwff1'), 10000), 'finished',
  'a first WWFF load finishes');
delete from reference_catalog_stage where load_id = (select id from loads where name = 'wwff1') and reference = 'KFF-1';
select lives_ok($$select apply_reference_loads()$$, 'apply survives a stage that lost rows');
select is((select (state, error)::text from reference_catalog_loads where id = (select id from loads where name = 'wwff1')),
  format('(refused,"staging no longer matches load %s (9999 rows staged of 10000)")',
         (select id from loads where name = 'wwff1')),
  'apply refuses a load whose stage no longer matches');
select is((select count(*) from reference_catalog where program = 'wwff'), 0::bigint, 'nothing swapped in for it');
select is((select count(*) from reference_catalog_stage), 0::bigint, 'its stage is deleted');

-- Begin abandons an open load, abandon gives one up -------------------------------------------

insert into loads values ('wwff2', begin_reference_load('wwff', 'w2'));
select stage_reference_rows((select id from loads where name = 'wwff2'), pg_temp.ref_rows('kff-', 1, 5));
insert into loads values ('wwff3', begin_reference_load('wwff', 'w3'));
select is((select (state, error, finished_at is not null)::text from reference_catalog_loads
           where id = (select id from loads where name = 'wwff2')),
  '(abandoned,"superseded by a load of w3",t)', 'begin abandons the program''s open load');
select is((select count(*) from reference_catalog_stage where load_id = (select id from loads where name = 'wwff2')),
  0::bigint, 'and deletes its staged rows');
select throws_ok($$select stage_reference_rows((select id from loads where name = 'wwff2'), '[]')$$, 'P0001',
  format('stage_reference_rows: load %s is not staging', (select id from loads where name = 'wwff2')),
  'an abandoned load takes no more rows');
select is((select state from reference_catalog_loads where id = (select id from loads where name = 'pota2')),
  'applied', 'begin leaves other programs'' loads alone');

select stage_reference_rows((select id from loads where name = 'wwff3'), pg_temp.ref_rows('kff-', 1, 5));
select lives_ok($$select abandon_reference_load((select id from loads where name = 'wwff3'), 'relay stopping')$$,
  'the relay abandons a load');
select is((select (state, error)::text from reference_catalog_loads where id = (select id from loads where name = 'wwff3')),
  '(abandoned,"relay stopping")', 'with its reason');
select is((select count(*) from reference_catalog_stage), 0::bigint, 'abandon deletes the staged rows');
select abandon_reference_load((select id from loads where name = 'wwff2'), 'again');
select is((select error from reference_catalog_loads where id = (select id from loads where name = 'wwff2')),
  'superseded by a load of w3', 'abandoning a load that is no longer staging changes nothing');

-- Incomplete and below-floor loads are refused; the old list stays ----------------------------

insert into loads values ('pota3', begin_reference_load('pota', 'p3'));
select stage_reference_rows((select id from loads where name = 'pota3'), pg_temp.ref_rows('us-', 1, 9500));
select is(finish_reference_load((select id from loads where name = 'pota3'), 9600), 'refused',
  'a stage short of what the relay sent is refused');
select is((select error from reference_catalog_loads where id = (select id from loads where name = 'pota3')),
  'incomplete: staged 9500 rows but the relay sent 9600', 'as incomplete');

insert into loads values ('pota4', begin_reference_load('pota', 'p4'));
select stage_reference_rows((select id from loads where name = 'pota4'), pg_temp.ref_rows('us-', 1, 8999));
select is(finish_reference_load((select id from loads where name = 'pota4'), 8999), 'refused',
  'a stage under 90% of the current list is refused');
select is((select error from reference_catalog_loads where id = (select id from loads where name = 'pota4')),
  'too few rows: staged 8999, the floor is 9000', 'as below the floor');
select is(reference_load_status() -> 'pota' -> 'newest' ->> 'state', 'refused', 'status reports the refusal');
select is(reference_load_status() -> 'pota' -> 'applied' ->> 'version', 'Mon, 26 Oct 2026 04:00:00 GMT',
  'the applied load is still the good one');

select throws_ok($$select apply_reference_loads()$$, 'P0001',
  'apply_reference_loads: the newest pota list load was refused; the old list stays',
  'apply raises while the newest loads are refused');
select is((select count(*) from reference_catalog where program = 'pota'), 10000::bigint, 'the old list stays');

-- A refused program does not block another's swap -----------------------------------------------

insert into loads values ('sota1', begin_reference_load('sota', 's1'));
select stage_reference_rows((select id from loads where name = 'sota1'),
  '[{"reference": "w4c/cm-001", "name": "Mount Mitchell", "active": true, "region": "W4C · Central Mountains",
     "latitude": 35.7650, "longitude": -82.2652, "grid": "EM85", "altitude_m": 2037, "points": 10,
     "valid_from": "2010-07-01", "valid_to": null, "street": "dropped"},
    {"reference": "W4C/WM-099", "name": "Gone Knob", "active": false, "valid_from": "2010-07-01",
     "valid_to": "2019-12-31"}]');
select is(stage_reference_rows((select id from loads where name = 'sota1'), pg_temp.ref_rows('w4c/cm-1', 1000, 10997)),
  10000, 'a SOTA load stages');
select is(finish_reference_load((select id from loads where name = 'sota1'), 10000), 'finished', 'and finishes');
select lives_ok($$select apply_reference_loads()$$, 'apply swaps SOTA in while POTA and WWFF are refused');
select is((select count(*) from reference_catalog where program = 'sota'), 10000::bigint, 'SOTA is swapped in');
select is((select count(*) from reference_catalog where program = 'pota'), 10000::bigint, 'POTA keeps its old list');
select is((select row(name, active, location, region, country, latitude, longitude, grid, altitude_m, points,
                      valid_from, valid_to)::text
           from reference_catalog where program = 'sota' and reference = 'W4C/CM-001'),
  '("Mount Mitchell",t,,"W4C · Central Mountains",,35.7650,-82.2652,EM85,2037,10,2010-07-01,)',
  'every column lands');
select is((select (active, valid_to)::text from reference_catalog where reference = 'W4C/WM-099'),
  '(f,2019-12-31)', 'a retired summit keeps its date');
select throws_ok($$select apply_reference_loads()$$, 'P0001',
  'apply_reference_loads: the newest pota list load was refused; the old list stays',
  'the next run swaps nothing and raises again');

-- The newest of two finished loads wins -------------------------------------------------------

insert into loads values ('sota2', begin_reference_load('sota', 's2'));
select stage_reference_rows((select id from loads where name = 'sota2'), pg_temp.ref_rows('w4c/cm-', 1, 9500));
select finish_reference_load((select id from loads where name = 'sota2'), 9500);
insert into loads values ('sota3', begin_reference_load('sota', 's3'));
select stage_reference_rows((select id from loads where name = 'sota3'), pg_temp.ref_rows('w4c/cm-', 1, 9200));
select is(finish_reference_load((select id from loads where name = 'sota3'), 9200), 'finished',
  'a second finished load waits beside the first');
select lives_ok($$select apply_reference_loads()$$, 'apply swaps');
select is((select array_agg(state order by id)::text from reference_catalog_loads where program = 'sota'),
  '{applied,abandoned,applied}', 'the newest finished load is applied and the older one superseded');
select is((select count(*) from reference_catalog where program = 'sota'), 9200::bigint, 'SOTA holds the newest list');
select is((select count(*) from reference_catalog_stage), 0::bigint, 'no stage is left behind');

-- Clients touch none of it --------------------------------------------------------------------

select ok((select bool_and(c.relrowsecurity) from pg_class c
           where c.oid in ('reference_catalog'::regclass, 'reference_catalog_loads'::regclass,
                           'reference_catalog_stage'::regclass)),
  'the three tables have row level security on');
select is_empty(
  $$select r || ' ' || t from unnest(array['anon', 'authenticated']) as r,
      unnest(array['reference_catalog', 'reference_catalog_loads', 'reference_catalog_stage']) as t
    where has_table_privilege(r, t, 'select, insert, update, delete')$$,
  'clients have no privilege on the tables');
select is_empty(
  $$select r || ' ' || f from unnest(array['anon', 'authenticated']) as r,
      unnest(array['reference_load_status()', 'begin_reference_load(text, text)',
                   'stage_reference_rows(bigint, jsonb)', 'reference_load_floor(text)',
                   'finish_reference_load(bigint, integer)', 'abandon_reference_load(bigint, text)',
                   'apply_reference_loads()']) as f
    where has_function_privilege(r, 'public.' || f, 'execute')$$,
  'clients may execute none of the functions');
select ok(has_function_privilege('service_role', 'public.stage_reference_rows(bigint, jsonb)', 'execute')
          and has_function_privilege('service_role', 'public.reference_load_status()', 'execute'),
  'the service role may');

set local role anon;
select throws_ok($$select * from reference_catalog_stage$$, '42501', null, 'anon cannot read staging');
select throws_ok($$select begin_reference_load('pota', 'x')$$, '42501', null, 'anon cannot start a load');
reset role;

set local role authenticated;
select throws_ok($$select * from reference_catalog$$, '42501', null, 'authenticated cannot read the catalog');
reset role;

select is((select schedule from cron.job where jobname = 'apply-reference-loads'), '55 * * * *',
  'apply-reference-loads runs hourly at :55');

select * from finish();
rollback;

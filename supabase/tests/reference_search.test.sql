-- pgTAP: search_references() (20261027001500). The shape (ReferenceSearch in
-- web/src/references/types.ts, every key and its type), every word matched in the reference or the
-- name, case-insensitively, % and _ taken literally, the program filter, refused queries and
-- programs, the order (activations, then reference), the 25 cap and more, references never
-- activated, retired rows, hidden calls in no count and no last day, the probes and the grouped
-- pass agreeing, the header equal to reference_profile's catalog for each program, and the grants.
begin;
create extension if not exists pgtap with schema extensions;
select plan(57);

create or replace function pg_temp.keys(p jsonb) returns text[] language sql as $$
  select array_agg(k order by k) from jsonb_object_keys(p) as k;
$$;
-- The references of a search, in order.
create or replace function pg_temp.refs(p jsonb) returns text[] language sql as $$
  select coalesce(array_agg(r ->> 'reference' order by n), '{}')
  from jsonb_array_elements(p -> 'results') with ordinality as e(r, n);
$$;
-- One result of a search, by reference.
create or replace function pg_temp.hit(p jsonb, p_ref text) returns jsonb language sql as $$
  select r from jsonb_array_elements(p -> 'results') as e(r) where r ->> 'reference' = p_ref;
$$;

delete from reference_days;
delete from reference_profile_cache;
delete from reference_catalog;
delete from hidden_callsigns;

insert into hidden_callsigns (callsign) values ('N0HIDE');

insert into reference_catalog (program, reference, name, active, location, region, country, latitude, longitude,
                               grid, altitude_m, points, valid_from, valid_to) values
  ('pota', 'US-2747', 'Mount Mitchell State Park', true, 'US-NC', null, null, 35.763, -82.272, 'EM85us',
   null, null, null, null),
  ('pota', 'US-1523', 'Mitchell State Park', true, 'US-MI', null, null, 44.2384, -85.4554, 'EN74gf',
   null, null, null, null),
  ('pota', 'US-0817', 'Half%Way Park', true, 'US-NC,US-VA', null, null, 35.1, -80.1, 'EM95', null, null, null, null),
  ('pota', 'US-0818', 'Halfway Park', true, 'US-NC', null, null, 35.2, -80.2, 'EM95', null, null, null, null),
  ('pota', 'US-0819', 'Under_Score Park', true, 'US-NC', null, null, 35.3, -80.3, 'EM95', null, null, null, null),
  ('pota', 'US-0820', 'UnderXScore Park', true, 'US-NC', null, null, 35.4, -80.4, 'EM95', null, null, null, null),
  ('sota', 'W4C/CM-001', 'Mount Mitchell', true, null, 'USA - Carolinas, NC-Central Mountains', null,
   35.7648, -82.2652, 'EM85rs', 2037, 10, date '2011-02-01', date '2099-12-31'),
  ('sota', 'W4C/CM-002', 'Mount Guyot', false, null, 'USA - Carolinas, NC-Central Mountains', null,
   35.7053, -83.2575, 'EM85', 2018, 10, date '2011-02-01', date '2013-01-31'),
  ('wwff', 'KFF-2747', 'Mount Mitchell', true, null, 'K-NC', 'United States', 35.76297, -82.272, 'EM85US',
   null, null, date '2016-01-01', null),
  ('wwff', 'KFF-1523', 'Mitchell', true, null, 'K-MI', 'United States', 44.23835, -85.45544, 'EN74GF',
   null, null, date '2016-01-01', null);

-- 26 parks for the cap, none activated.
insert into reference_catalog (program, reference, name, active, location)
select 'pota', 'XX-' || lpad(g::text, 4, '0'), 'Capped Park ' || g, true, 'XX-AA'
from generate_series(1, 26) g;

insert into reference_days (program, reference, day, base, source, spots, modes, bands) values
  -- US-2747: A1S on two days, B2S on one; A1S again from a second source on the same day counts once.
  -- N0HIDE (hidden) is there latest and counts nowhere.
  ('pota', 'US-2747', date '2026-10-20', 'A1S', 'pota', 3, '{ssb}', '{20m}'),
  ('pota', 'US-2747', date '2026-10-20', 'A1S', 'wwff', 1, '{ssb}', '{20m}'),
  ('pota', 'US-2747', date '2026-10-18', 'A1S', 'pota', 2, '{cw}', '{40m}'),
  ('pota', 'US-2747', date '2026-10-18', 'B2S', 'pota', 2, '{cw}', '{40m}'),
  ('pota', 'US-2747', date '2026-10-25', 'N0HIDE', 'pota', 9, '{cw}', '{40m}'),
  -- KFF-2747: two activations.
  ('wwff', 'KFF-2747', date '2026-10-10', 'A1S', 'wwff', 1, '{ssb}', '{20m}'),
  ('wwff', 'KFF-2747', date '2026-10-11', 'C3S', 'wwff', 1, '{ssb}', '{20m}'),
  -- W4C/CM-001: one.
  ('sota', 'W4C/CM-001', date '2026-10-05', 'D4S', 'sotawatch', 4, '{cw}', '{20m}'),
  -- KFF-1523: only the hidden call, so none.
  ('wwff', 'KFF-1523', date '2026-10-22', 'N0HIDE', 'wwff', 1, '{cw}', '{40m}'),
  -- Two of the capped parks, so they lead their list.
  ('pota', 'XX-0026', date '2026-10-01', 'A1S', 'pota', 1, '{cw}', '{40m}'),
  ('pota', 'XX-0013', date '2026-10-01', 'A1S', 'pota', 1, '{cw}', '{40m}'),
  ('pota', 'XX-0013', date '2026-10-02', 'A1S', 'pota', 1, '{cw}', '{40m}');

-- Shape ------------------------------------------------------------------------

select is(pg_temp.keys(search_references('mitchell', null)), array['more', 'results'],
  'the payload has results and more');
select is(pg_temp.keys(pg_temp.hit(search_references('mitchell', null), 'US-2747')),
  array['activations', 'active', 'altitudeM', 'association', 'country', 'grid', 'lastDay', 'location', 'name',
        'points', 'program', 'reference', 'region', 'validTo'],
  'a result has exactly the ReferenceSearchResult keys');
select is(pg_temp.hit(search_references('mitchell', null), 'US-2747'),
  '{"program": "pota", "reference": "US-2747", "name": "Mount Mitchell State Park", "active": true,
    "validTo": null, "location": "US-NC", "association": null, "region": null, "country": null,
    "grid": "EM85us", "altitudeM": null, "points": null, "activations": 3, "lastDay": "2026-10-20"}'::jsonb,
  'a POTA result: its list entry, three activations and the last visible day');
select is(pg_temp.hit(search_references('mitchell', null), 'W4C/CM-001'),
  '{"program": "sota", "reference": "W4C/CM-001", "name": "Mount Mitchell", "active": true,
    "validTo": "2099-12-31", "location": null, "association": "W4C", "region": "NC-Central Mountains",
    "country": null, "grid": "EM85rs", "altitudeM": 2037, "points": 10, "activations": 1,
    "lastDay": "2026-10-05"}'::jsonb,
  'a SOTA result: association code, RegionName, altitude and points');
select is(pg_temp.hit(search_references('mitchell', null), 'KFF-2747'),
  '{"program": "wwff", "reference": "KFF-2747", "name": "Mount Mitchell", "active": true,
    "validTo": null, "location": null, "association": null, "region": "K-NC", "country": "United States",
    "grid": "EM85US", "altitudeM": null, "points": null, "activations": 2, "lastDay": "2026-10-11"}'::jsonb,
  'a WWFF result: region and country');
select is(jsonb_typeof(search_references('mitchell', null) -> 'more'), 'boolean', 'more is a boolean');
select is(jsonb_typeof(pg_temp.hit(search_references('mitchell', null), 'W4C/CM-001') -> 'altitudeM'), 'number',
  'altitudeM is a number');
select is(jsonb_typeof(pg_temp.hit(search_references('mitchell', null), 'US-2747') -> 'activations'), 'number',
  'activations is a number');
select is(search_references('nowhere at all', null), '{"results": [], "more": false}'::jsonb,
  'no match is an empty list, not null');

-- Order -------------------------------------------------------------------------

select is(pg_temp.refs(search_references('mitchell', null)),
  array['US-2747', 'KFF-2747', 'W4C/CM-001', 'KFF-1523', 'US-1523'],
  'most activated first, then by reference; never-activated references come last');
select is(search_references('mitchell', null) -> 'more', 'false'::jsonb, 'five matches: no more');

-- Activations -----------------------------------------------------------------

select is(pg_temp.hit(search_references('mitchell', null), 'US-1523') -> 'activations', '0'::jsonb,
  'a reference never activated has 0 activations');
select is(pg_temp.hit(search_references('mitchell', null), 'US-1523') -> 'lastDay', 'null'::jsonb,
  'and no last day');
select is(pg_temp.hit(search_references('mitchell', null), 'KFF-1523') -> 'activations', '0'::jsonb,
  'a reference activated only by a hidden call has 0 activations');
select is(pg_temp.hit(search_references('mitchell', null), 'KFF-1523') -> 'lastDay', 'null'::jsonb,
  'and no last day');
select is(pg_temp.hit(search_references('mitchell', null), 'US-2747') ->> 'lastDay', '2026-10-20',
  'a hidden call''s later day is not the last day');
delete from hidden_callsigns;
select is(pg_temp.hit(search_references('mitchell', null), 'US-2747') -> 'activations', '4'::jsonb,
  'unhidden, the call counts again');
select is(pg_temp.hit(search_references('mitchell', null), 'US-2747') ->> 'lastDay', '2026-10-25',
  'and its day is the last day');
insert into hidden_callsigns (callsign) values ('N0HIDE');

-- Words ----------------------------------------------------------------------

select is(pg_temp.refs(search_references('mount mitchell', null)), array['US-2747', 'KFF-2747', 'W4C/CM-001'],
  'every word must match');
select is(pg_temp.refs(search_references('  MOUNT   Mitchell ', null)), array['US-2747', 'KFF-2747', 'W4C/CM-001'],
  'case and extra whitespace do not matter');
select is(pg_temp.refs(search_references('w4c mitchell', null)), array['W4C/CM-001'],
  'one word in the reference and one in the name');
select is(pg_temp.refs(search_references('us-2747', null)), array['US-2747'],
  'a reference, typed in lower case');
select is(pg_temp.refs(search_references('cm-00', null)), array['W4C/CM-001', 'W4C/CM-002'],
  'part of a reference');
select is(pg_temp.refs(search_references('mitchell nc', null)), '{}'::text[],
  'the location is not searched');
select is(pg_temp.refs(search_references('half%way', null)), array['US-0817'],
  '% is literal');
select is(pg_temp.refs(search_references('under_score', null)), array['US-0819'],
  '_ is literal');
select is(pg_temp.refs(search_references('%%', null)), '{}'::text[], 'a query of % alone matches nothing');
select is(pg_temp.refs(search_references('__', null)), '{}'::text[], 'a query of _ alone matches nothing');

-- Retired --------------------------------------------------------------------

select is(pg_temp.hit(search_references('guyot', null), 'W4C/CM-002') -> 'active', 'false'::jsonb,
  'a retired row is found');
select is(pg_temp.hit(search_references('guyot', null), 'W4C/CM-002') ->> 'validTo', '2013-01-31',
  'with its end date');

-- Programs -------------------------------------------------------------------

select is(pg_temp.refs(search_references('mitchell', 'sota')), array['W4C/CM-001'], 'sota only');
select is(pg_temp.refs(search_references('mitchell', 'pota')), array['US-2747', 'US-1523'], 'pota only');
select is(pg_temp.refs(search_references('mitchell', 'wwff')), array['KFF-2747', 'KFF-1523'], 'wwff only');
select is(pg_temp.refs(search_references('mitchell', 'SOTA')), array['W4C/CM-001'],
  'the program is read case-insensitively, as reference_profile reads it');
select is(search_references('mitchell', 'bota'), null, 'an unknown program is null');
select is(search_references('mitchell', ''), null, 'an empty program is null');
select is(search_references('mitchell', 'iota'), null, 'iota is not a program here');

-- Refused queries ------------------------------------------------------------

select is(search_references('m', null), null, 'one character is null');
select is(search_references('  m  ', null), null, 'one character after trimming is null');
select is(search_references('', null), null, 'an empty query is null');
select is(search_references(null, null), null, 'a null query is null');
select is(search_references(repeat('m', 65), null), null, '65 characters is null');
select isnt(search_references(repeat('m', 64), null), null, '64 characters is a search');
select isnt(search_references('mi', null), null, '2 characters is a search');
select is(search_references('a b c d e f g', null), null, 'seven words is null');
select isnt(search_references('a b c d e f', null), null, 'six words is a search');

-- The cap -----------------------------------------------------------------------

select is(jsonb_array_length(search_references('capped', null) -> 'results'), 25, '26 matches: the first 25');
select is(search_references('capped', null) -> 'more', 'true'::jsonb, 'and more');
select is((pg_temp.refs(search_references('capped', null)))[1:4], array['XX-0013', 'XX-0026', 'XX-0001', 'XX-0002'],
  'the activated ones lead, then by reference');
delete from reference_catalog where reference = 'XX-0025';
select is(search_references('capped', null) -> 'more', 'false'::jsonb, '25 matches: no more');

-- Probes or one grouped pass ----------------------------------------------------

-- search_references_at's last argument is the number of matches from which it reads
-- reference_days in one grouped pass; 0 always does, the largest bigint never does.
select is(
  (select jsonb_agg(jsonb_build_array(v.q, v.p) order by v.q, v.p)
   from (values ('mitchell', null), ('mitchell', 'pota'), ('mitchell', 'wwff'), ('capped', null),
                ('capped', 'pota'), ('- -', null), ('- -', 'sota'), ('cm-00', 'sota'), ('nowhere', null),
                ('us 2747', null)) as v(q, p)
   where search_references_at(v.q, v.p, 0)
         is distinct from search_references_at(v.q, v.p, 9223372036854775807)),
  null,
  'the grouped pass gives the probes'' payload: counts, hidden calls, last days, order, cap and more');
select is(search_references_at('- -', null, 0) -> 'results' -> 0 ->> 'reference', 'US-2747',
  'the grouped pass ranks a query that matches every row');

-- The header is reference_profile's catalog --------------------------------------

select is(
  (select jsonb_agg(public.reference_catalog_header(c) = public.reference_profile(c.program, c.reference) -> 'catalog'
                    order by c.reference)
   from reference_catalog c where c.reference in ('US-2747', 'W4C/CM-001', 'KFF-2747', 'W4C/CM-002')),
  '[true, true, true, true]'::jsonb,
  'reference_catalog_header is reference_profile''s catalog, for each program and a retired row');
select is(
  (select jsonb_agg(pg_temp.hit(search_references(c.reference, c.program), c.reference)
                      - 'program' - 'reference' - 'activations' - 'lastDay'
                    = (public.reference_profile(c.program, c.reference) -> 'catalog')
                      - 'latitude' - 'longitude' - 'validFrom'
                    order by c.reference)
   from reference_catalog c where c.reference in ('US-2747', 'W4C/CM-001', 'KFF-2747')),
  '[true, true, true]'::jsonb,
  'a result''s header equals reference_profile''s catalog for the same reference, one per program');

-- Grants -------------------------------------------------------------------------

select ok(not has_function_privilege('anon', 'public.search_references(text, text)', 'execute')
          and not has_function_privilege('authenticated', 'public.search_references(text, text)', 'execute')
          and has_function_privilege('service_role', 'public.search_references(text, text)', 'execute'),
  'search_references is the service role''s only');
select ok(not has_function_privilege('anon', 'public.reference_catalog_header(public.reference_catalog)', 'execute')
          and not has_function_privilege('authenticated', 'public.reference_catalog_header(public.reference_catalog)', 'execute')
          and not has_function_privilege('anon', 'public.search_references_at(text, text, bigint)', 'execute')
          and not has_function_privilege('authenticated', 'public.search_references_at(text, text, bigint)', 'execute'),
  'reference_catalog_header and search_references_at are not a client''s');
select ok(
  (select bool_and('search_path=public' = any (p.proconfig) or 'search_path=""' = any (p.proconfig))
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('search_references', 'search_references_at', 'reference_catalog_header')),
  'all three pin search_path');

select * from finish();
rollback;

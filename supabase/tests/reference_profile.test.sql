-- pgTAP: reference_profile() and its cache (20261027001200). The shape (ReferenceProfile in
-- web/src/references/types.ts, every key), history as reference_days plus the live days with no
-- day counted twice, hidden calls in no list and no total, a reference with spots and no catalog
-- row, one with neither, malformed input, a retired catalog row, last.today, SOTA's association
-- and region, monthly zero-fill, the live read's index, and the cache's single flight and prune.
begin;
create extension if not exists pgtap with schema extensions;
select plan(73);

create or replace function pg_temp.d(p_offset int) returns date language sql as $$
  select (now() at time zone 'utc')::date + p_offset;
$$;
create or replace function pg_temp.ds(p_offset int) returns text language sql as $$
  select to_char(pg_temp.d(p_offset), 'YYYY-MM-DD');
$$;
create or replace function pg_temp.at(p_offset int, p_hms text) returns timestamptz language sql as $$
  select ((pg_temp.d(p_offset))::text || ' ' || p_hms || '+00')::timestamptz;
$$;
-- A time today, the given share of the way from midnight UTC to now, so it is today and not ahead.
create or replace function pg_temp.today(p_share numeric) returns timestamptz language sql as $$
  select (pg_temp.d(0)::timestamp at time zone 'utc')
         + (now() - (pg_temp.d(0)::timestamp at time zone 'utc')) * p_share;
$$;
create or replace function pg_temp.iso(p_time timestamptz) returns text language sql as $$
  select to_char(p_time at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
$$;
create or replace function pg_temp.raw(
  p_source text, p_id text, p_time timestamptz, p_call text, p_spotter text, p_khz numeric, p_band text,
  p_mode text, p_family text, p_pota text default null, p_sota text default null, p_wwff text default null,
  p_comment text default '') returns void language sql as $$
  insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, spotter, frequency_khz, band,
                         mode, mode_family, comment, pota_reference, sota_summit_ref, wwff_reference, raw_payload)
  values (p_source, p_id, p_id, p_time, p_call, p_spotter, p_khz, p_band, p_mode, p_family, p_comment, p_pota,
          p_sota, p_wwff, '{}');
$$;
create or replace function pg_temp.keys(p jsonb) returns text[] language sql as $$
  select array_agg(k order by k) from jsonb_object_keys(p) as k;
$$;

delete from raw_spots;
delete from rbn_spots;
delete from callsign_rollup_days;
delete from callsign_rollup_failures;
delete from reference_days;
delete from reference_catalog;
delete from reference_profile_cache;
delete from hidden_callsigns;

insert into hidden_callsigns (callsign) values ('N0HIDE');
-- An hour ago, so the cache tests below can tell a call hidden since an entry was built from one before.
update hidden_callsigns set hidden_at = now() - interval '1 hour';

insert into reference_catalog (program, reference, name, active, location, region, country, latitude, longitude,
                               grid, altitude_m, points, valid_from, valid_to) values
  ('pota', 'US-0817', 'Test State Park', true, 'US-NC,US-VA', null, null, 35.7650, -82.2652, 'EM85rs',
   null, null, null, null),
  ('pota', 'US-0900', 'Quiet Park', true, 'US-NC', null, null, 35.1, -80.1, 'EM95', null, null, null, null),
  ('sota', 'W4C/CM-001', 'Mount Mitchell', true, null, 'USA - Carolinas, NC-Central Mountains', null,
   35.7648, -82.2652, 'EM85rs', 2037, 10, date '2011-02-01', date '2099-12-31'),
  ('sota', 'W4C/CM-002', 'Mount Guyot', false, null, 'USA - Carolinas, NC-Central Mountains', null,
   35.7053, -83.2575, 'EM85fq', 2018, 10, date '2011-02-01', date '2013-01-31'),
  ('wwff', 'KFF-1234', 'Falls Lake', true, null, 'K-NC', 'United States', 36.0, -78.7, 'FM06', null, null,
   date '2012-01-01', null);

-- US-0817. Day -20 and day -4 are rolled up (markers, then fill_reference_days); days -1 and 0
-- are live. KK4PWJ activates on days -20, -4 and -1, last spotted as KK4PWJ/P; W1AW on day -4
-- and today. N0HIDE is hidden: it activates on days -4 and -1 and spots W1AW today.
select pg_temp.raw('pota', 'p1', pg_temp.at(-20, '10:00:00'), 'KK4PWJ', 'W1AW', 14062, '20m', 'cw', 'cw', p_pota => 'US-0817');
select pg_temp.raw('pota', 'p2', pg_temp.at(-20, '11:00:00'), 'KK4PWJ', 'W1AW', 7185, '40m', 'ssb', 'phone', p_pota => 'US-0817');
select pg_temp.raw('pota', 'p3', pg_temp.at(-4, '12:30:00'), 'KK4PWJ', 'KK4PWJ', 14062, '20m', 'cw', 'cw', p_pota => 'US-0817',
                   p_comment => 'QRV 20m');
select pg_temp.raw('pota', 'p4', pg_temp.at(-4, '10:00:00'), 'W1AW', 'K4SWL', 7074, '40m', 'ft8', 'digital', p_pota => 'US-0817');
select pg_temp.raw('pota', 'p5', pg_temp.at(-4, '13:00:00'), 'N0HIDE', 'W1AW', 14070, '20m', 'cw', 'cw', p_pota => 'US-0817');
select pg_temp.raw('pota', 'p6', pg_temp.at(-1, '15:00:00'), 'KK4PWJ/P', 'K4SWL', 14062, '20m', 'cw', 'cw', p_pota => 'US-0817');
select pg_temp.raw('pota', 'p7', pg_temp.at(-1, '16:00:00'), 'N0HIDE', 'K4SWL', 14070, '20m', 'cw', 'cw', p_pota => 'US-0817');
select pg_temp.raw('pota', 'p8', pg_temp.today(0.5), 'W1AW', 'N0HIDE', 14062, '20m', 'cw', 'cw', p_pota => 'US-0817');
select pg_temp.raw('pota', 'p9', pg_temp.today(0.75), 'W1AW', 'K4SWL', 18130, '17m', 'ssb', 'phone', p_pota => 'US-0817',
                   p_comment => '  ');
-- A DX Cluster spot never counts for a park (rollup_callsign_day writes none for it either).
select pg_temp.raw('dxcluster', 'x1', pg_temp.at(-1, '12:00:00'), 'K1DX', 'G4OBK', 14250, '20m', 'ssb', 'phone', p_pota => 'US-0817');
-- US-0900: one activation on day -70, rolled up.
select pg_temp.raw('pota', 'q1', pg_temp.at(-70, '09:00:00'), 'K4SWL', 'W1AW', 7040, '40m', 'cw', 'cw', p_pota => 'US-0900');
-- A summit, a WWFF reference spelled in lower case, a park outside the list and one only a hidden
-- call activated, all live.
select pg_temp.raw('sotawatch', 's1', pg_temp.at(-1, '14:00:00'), 'W4/KK4PWJ', 'G4OBK', 7032, '40m', 'cw', 'cw',
                   p_sota => 'W4C/CM-001');
select pg_temp.raw('wwff', 'w1', pg_temp.at(-1, '15:00:00'), 'KK4PWJ', 'W1AW', 14244, '20m', 'ssb', 'phone', p_wwff => 'kff-1234');
select pg_temp.raw('pota', 'u1', pg_temp.at(-1, '17:00:00'), 'W1AW', 'K4SWL', 14062, '20m', 'cw', 'cw', p_pota => 'US-9999');
select pg_temp.raw('pota', 'h1', pg_temp.at(-1, '17:00:00'), 'N0HIDE', 'K4SWL', 14062, '20m', 'cw', 'cw', p_pota => 'US-7777');

insert into callsign_rollup_days (day, rolled_at) values (pg_temp.d(-70), now()), (pg_temp.d(-20), now()), (pg_temp.d(-4), now());
select fill_reference_days(pg_temp.d(-70));
select fill_reference_days(pg_temp.d(-20));
select fill_reference_days(pg_temp.d(-4));

create temp table p as select reference_profile('pota', 'US-0817') as p;

-- ---------------------------------------------------------------------------
-- Shape: every key
-- ---------------------------------------------------------------------------

select is(pg_temp.keys((select p from p)),
  array['bands', 'calendar', 'catalog', 'firstActivation', 'last', 'modes', 'monthly', 'program', 'recentActivations',
        'recentSpots', 'reference', 'sourceUrl', 'topActivators', 'totals'],
  'the payload''s keys');
select is(pg_temp.keys((select p -> 'catalog' from p)),
  array['active', 'altitudeM', 'association', 'country', 'grid', 'latitude', 'location', 'longitude', 'name', 'points',
        'region', 'validFrom', 'validTo'],
  'catalog''s keys');
select is(pg_temp.keys((select p -> 'totals' from p)), array['activations', 'activators', 'spots'], 'totals'' keys');
select is(pg_temp.keys((select p -> 'firstActivation' from p)), array['base', 'callsign', 'day'], 'firstActivation''s keys');
select is(pg_temp.keys((select p -> 'last' from p)),
  array['band', 'base', 'callsign', 'frequencyKhz', 'mode', 'source', 'time', 'today'], 'last''s keys');
select is(pg_temp.keys((select p -> 'last' -> 'today' from p)), array['bands', 'spots'], 'last.today''s keys');
select is(pg_temp.keys((select p -> 'calendar' from p)), array['days', 'periods'], 'calendar''s keys');
select is(pg_temp.keys((select p -> 'calendar' -> 'days' -> 0 from p)), array['activators', 'day'], 'a calendar day''s keys');
select is(pg_temp.keys((select p -> 'calendar' -> 'periods' -> 0 from p)),
  array['activations', 'busiest', 'days', 'daysActivated', 'from', 'longestStreak', 'period', 'to'], 'a period''s keys');
select is(pg_temp.keys((select p -> 'calendar' -> 'periods' -> 0 -> 'busiest' from p)), array['activators', 'day'],
  'busiest''s keys');
select is(pg_temp.keys((select p -> 'monthly' -> 0 from p)), array['activations', 'month'], 'a month''s keys');
select is(pg_temp.keys((select p -> 'bands' -> 0 from p)), array['band', 'spots'], 'a band''s keys');
select is(pg_temp.keys((select p -> 'modes' -> 0 from p)), array['label', 'percent', 'spots'], 'a mode''s keys');
select is(pg_temp.keys((select p -> 'topActivators' -> 0 from p)), array['activations', 'base', 'callsign', 'lastDay'],
  'a top activator''s keys');
select is(pg_temp.keys((select p -> 'recentActivations' -> 0 from p)),
  array['bands', 'base', 'callsign', 'day', 'modes', 'spots'], 'a recent activation''s keys');
select is(pg_temp.keys((select p -> 'recentSpots' -> 0 from p)),
  array['band', 'base', 'callsign', 'comment', 'frequencyKhz', 'mode', 'source', 'spotter', 'time'],
  'a recent spot''s keys');

-- ---------------------------------------------------------------------------
-- A listed park with rolled-up and live days
-- ---------------------------------------------------------------------------

select is((select jsonb_build_object('program', p -> 'program', 'reference', p -> 'reference', 'sourceUrl', p -> 'sourceUrl')
           from p),
  '{"program": "pota", "reference": "US-0817", "sourceUrl": "https://pota.app/#/park/US-0817"}'::jsonb,
  'program, reference and the program''s page');
select is((select p -> 'catalog' from p),
  '{"name": "Test State Park", "active": true, "location": "US-NC,US-VA", "association": null, "region": null,
    "country": null, "latitude": 35.7650, "longitude": -82.2652, "grid": "EM85rs", "altitudeM": null, "points": null,
    "validFrom": null, "validTo": null}'::jsonb,
  'the catalog header');
select is((select p -> 'totals' from p), '{"activations": 5, "activators": 2, "spots": 7}'::jsonb,
  'totals: day -4 is read from reference_days only, never live as well; hidden and DX Cluster spots count nowhere');
select is((select p -> 'firstActivation' from p),
  jsonb_build_object('day', pg_temp.ds(-20), 'callsign', 'KK4PWJ/P', 'base', 'KK4PWJ'),
  'firstActivation: the first day, with the call as most recently spotted');
select is((select p -> 'last' from p),
  jsonb_build_object('callsign', 'W1AW', 'base', 'W1AW', 'time', pg_temp.iso(pg_temp.today(0.75)),
                     'frequencyKhz', 18130.000, 'mode', 'ssb', 'band', '17m', 'source', 'pota',
                     'today', jsonb_build_object('spots', 2, 'bands', jsonb_build_array('20m', '17m'))),
  'last: the newest spot, and that activator''s spots and bands here today, in band order');
select is((select p -> 'calendar' -> 'days' from p),
  jsonb_build_array(
    jsonb_build_object('day', pg_temp.ds(-20), 'activators', jsonb_build_array('KK4PWJ')),
    jsonb_build_object('day', pg_temp.ds(-4), 'activators', jsonb_build_array('KK4PWJ', 'W1AW')),
    jsonb_build_object('day', pg_temp.ds(-1), 'activators', jsonb_build_array('KK4PWJ')),
    jsonb_build_object('day', pg_temp.ds(0), 'activators', jsonb_build_array('W1AW'))),
  'calendar days: every day with an activation, oldest first, base calls alphabetical');
select is((select p -> 'calendar' -> 'periods' -> 0 from p),
  jsonb_build_object('period', 'past', 'from', pg_temp.ds(-364), 'to', pg_temp.ds(0), 'days', 365, 'activations', 5,
                     'daysActivated', 4, 'longestStreak', 2,
                     'busiest', jsonb_build_object('day', pg_temp.ds(-4), 'activators', 2)),
  'the past 365 days: activations, days activated, longest streak, busiest day by activators');
select is((select array_agg(x ->> 'period' order by o) from p, jsonb_array_elements(p -> 'calendar' -> 'periods') with ordinality as e(x, o)),
  (select array['past'] || array_agg(y::text order by y desc)
   from generate_series(extract(year from pg_temp.d(-20))::int, extract(year from pg_temp.d(0))::int) as y),
  'then each year since the first activation, newest first');
select is((select p -> 'bands' from p),
  '[{"band": "40m", "spots": 2}, {"band": "20m", "spots": 4}, {"band": "17m", "spots": 1}]'::jsonb,
  'bands: only bands with spots, in band order');
select is((select p -> 'modes' from p),
  '[{"label": "CW", "spots": 4, "percent": 57}, {"label": "SSB", "spots": 2, "percent": 29},
    {"label": "FT8/FT4", "spots": 1, "percent": 14}, {"label": "FM", "spots": 0, "percent": 0},
    {"label": "Other", "spots": 0, "percent": 0}]'::jsonb,
  'modes: the five labels, shares adding up to 100');
select is((select p -> 'topActivators' from p),
  jsonb_build_array(
    jsonb_build_object('callsign', 'KK4PWJ/P', 'base', 'KK4PWJ', 'activations', 3, 'lastDay', pg_temp.ds(-1)),
    jsonb_build_object('callsign', 'W1AW', 'base', 'W1AW', 'activations', 2, 'lastDay', pg_temp.ds(0))),
  'topActivators: most activations first');
select is((select p -> 'recentActivations' from p),
  jsonb_build_array(
    jsonb_build_object('day', pg_temp.ds(0), 'callsign', 'W1AW', 'base', 'W1AW', 'spots', 2,
                       'bands', jsonb_build_array('20m', '17m'), 'modes', jsonb_build_array('cw', 'ssb')),
    jsonb_build_object('day', pg_temp.ds(-1), 'callsign', 'KK4PWJ/P', 'base', 'KK4PWJ', 'spots', 1,
                       'bands', jsonb_build_array('20m'), 'modes', jsonb_build_array('cw')),
    jsonb_build_object('day', pg_temp.ds(-4), 'callsign', 'KK4PWJ/P', 'base', 'KK4PWJ', 'spots', 1,
                       'bands', jsonb_build_array('20m'), 'modes', jsonb_build_array('cw')),
    jsonb_build_object('day', pg_temp.ds(-4), 'callsign', 'W1AW', 'base', 'W1AW', 'spots', 1,
                       'bands', jsonb_build_array('40m'), 'modes', jsonb_build_array('ft8')),
    jsonb_build_object('day', pg_temp.ds(-20), 'callsign', 'KK4PWJ/P', 'base', 'KK4PWJ', 'spots', 2,
                       'bands', jsonb_build_array('40m', '20m'), 'modes', jsonb_build_array('cw', 'ssb'))),
  'recentActivations: newest first, bands in band order and modes as stored');
select is((select p -> 'recentSpots' from p),
  jsonb_build_array(
    jsonb_build_object('time', pg_temp.iso(pg_temp.today(0.75)), 'callsign', 'W1AW', 'base', 'W1AW',
                       'frequencyKhz', 18130.000, 'mode', 'ssb', 'band', '17m', 'spotter', 'K4SWL', 'comment', null,
                       'source', 'pota'),
    jsonb_build_object('time', pg_temp.iso(pg_temp.at(-1, '15:00:00')), 'callsign', 'KK4PWJ/P', 'base', 'KK4PWJ',
                       'frequencyKhz', 14062.000, 'mode', 'cw', 'band', '20m', 'spotter', 'K4SWL', 'comment', null,
                       'source', 'pota'),
    jsonb_build_object('time', pg_temp.iso(pg_temp.at(-4, '12:30:00')), 'callsign', 'KK4PWJ', 'base', 'KK4PWJ',
                       'frequencyKhz', 14062.000, 'mode', 'cw', 'band', '20m', 'spotter', 'KK4PWJ', 'comment', 'QRV 20m',
                       'source', 'pota'),
    jsonb_build_object('time', pg_temp.iso(pg_temp.at(-4, '10:00:00')), 'callsign', 'W1AW', 'base', 'W1AW',
                       'frequencyKhz', 7074.000, 'mode', 'ft8', 'band', '40m', 'spotter', 'K4SWL', 'comment', null,
                       'source', 'pota')),
  'recentSpots: the last 7 days, newest first, with comments; a hidden spotter''s spot stays out');
select is((select strpos(p::text, 'N0HIDE') from p), 0, 'the hidden call is in no list');
select is((select count(*) from reference_days where reference = 'US-0817' and base = 'N0HIDE')::int, 1,
  'though reference_days stores it (decision 7: hiding is the read''s job)');

-- Input.
select is(reference_profile(' POTA ', 'us-0817'), (select p from p), 'program and reference are matched case-insensitively');
select ok(reference_profile('pota', 'US 0817') is null and reference_profile('pota', 'US_0817') is null
          and reference_profile('pota', '') is null and reference_profile('pota', null) is null
          and reference_profile('pota', repeat('A', 65)) is null,
  'a malformed reference is null');
select ok(reference_profile('iota', 'EU-005') is null and reference_profile(null, 'US-0817') is null,
  'so is a program without a list');
select ok(reference_profile('pota', 'US-8888') is null, 'a reference in neither the list nor any spot is null');
select ok(reference_profile('pota', 'US-7777') is null, 'and so is one only a hidden call was spotted at');
select ok(reference_profile('sota', 'US-0817') is null, 'a reference belongs to one program');

-- ---------------------------------------------------------------------------
-- Outside the list, SOTA, WWFF, retired, never activated, zero-filled months
-- ---------------------------------------------------------------------------

create temp table u as select reference_profile('pota', 'US-9999') as p;
select ok((select p -> 'catalog' = 'null'::jsonb and p -> 'sourceUrl' = 'null'::jsonb from u),
  'a reference outside the list has no catalog and no program page');
select is((select p -> 'totals' from u), '{"activations": 1, "activators": 1, "spots": 1}'::jsonb,
  'but its spots count');
select is((select p -> 'last' -> 'today' from u), 'null'::jsonb, 'last.today is null when the newest spot is not today''s');
select is((select p -> 'last' ->> 'time' from u), pg_temp.iso(pg_temp.at(-1, '17:00:00')), 'and last is still that spot');

create temp table s as select reference_profile('sota', 'w4c/cm-001') as p;
select is((select (p -> 'catalog') - array['name', 'active', 'location', 'country', 'latitude', 'longitude', 'grid'] from s),
  '{"association": "W4C", "region": "NC-Central Mountains", "altitudeM": 2037, "points": 10,
    "validFrom": "2011-02-01", "validTo": "2099-12-31"}'::jsonb,
  'SOTA: the association code and RegionName, altitude, points and validity');
select is((select p ->> 'sourceUrl' from s), 'https://summits.sota.org.uk/summit/W4C/CM-001', 'and the summit''s page');
select is((select p -> 'firstActivation' from s),
  jsonb_build_object('day', pg_temp.ds(-1), 'callsign', 'W4/KK4PWJ', 'base', 'KK4PWJ'), 'a live SOTA activation');

create temp table w as select reference_profile('wwff', 'KFF-1234') as p;
select is((select jsonb_build_object('country', p -> 'catalog' -> 'country', 'region', p -> 'catalog' -> 'region',
                                     'association', p -> 'catalog' -> 'association', 'url', p -> 'sourceUrl',
                                     'spots', p -> 'totals' -> 'spots') from w),
  '{"country": "United States", "region": "K-NC", "association": null,
    "url": "https://wwff.co/directory/?showRef=KFF-1234", "spots": 1}'::jsonb,
  'WWFF: country and region, the directory page, and a live spot spelled in lower case');

create temp table r as select reference_profile('sota', 'W4C/CM-002') as p;
select is((select jsonb_build_object('active', p -> 'catalog' -> 'active', 'validTo', p -> 'catalog' -> 'validTo') from r),
  '{"active": false, "validTo": "2013-01-31"}'::jsonb, 'a retired summit keeps its page, with its end date');
select is((select p - array['program', 'reference', 'sourceUrl', 'catalog'] from r),
  jsonb_build_object(
    'totals', '{"activations": 0, "activators": 0, "spots": 0}'::jsonb,
    'firstActivation', null, 'last', null,
    'calendar', jsonb_build_object('days', '[]'::jsonb, 'periods', jsonb_build_array(jsonb_build_object(
      'period', 'past', 'from', pg_temp.ds(-364), 'to', pg_temp.ds(0), 'days', 365, 'activations', 0,
      'daysActivated', 0, 'longestStreak', 0, 'busiest', null))),
    'monthly', '[]'::jsonb, 'bands', '[]'::jsonb,
    'modes', '[{"label": "CW", "spots": 0, "percent": 0}, {"label": "SSB", "spots": 0, "percent": 0},
               {"label": "FT8/FT4", "spots": 0, "percent": 0}, {"label": "FM", "spots": 0, "percent": 0},
               {"label": "Other", "spots": 0, "percent": 0}]'::jsonb,
    'topActivators', '[]'::jsonb, 'recentActivations', '[]'::jsonb, 'recentSpots', '[]'::jsonb),
  'never activated: zeros, nulls and empty lists, and only the past-year period');

create temp table z as select reference_profile('pota', 'US-0900') as p;
select is((select array_agg(x ->> 'month' order by o) from z, jsonb_array_elements(p -> 'monthly') with ordinality as e(x, o)),
  (select array_agg(to_char(m, 'YYYY-MM') order by m)
   from generate_series(date_trunc('month', pg_temp.d(-70)::timestamp), date_trunc('month', pg_temp.d(0)::timestamp),
                        interval '1 month') as m),
  'monthly runs from the first activation''s month through this one');
select is((select array_agg((x ->> 'activations')::int order by o) from z,
                  jsonb_array_elements(p -> 'monthly') with ordinality as e(x, o)),
  (select array[1] || array_fill(0, array[(count(*) - 1)::int])
   from generate_series(date_trunc('month', pg_temp.d(-70)::timestamp), date_trunc('month', pg_temp.d(0)::timestamp),
                        interval '1 month') as m),
  'zero-filled');
select ok((select p -> 'last' = 'null'::jsonb and p -> 'recentSpots' = '[]'::jsonb from z),
  'a reference last spotted over 14 days ago has no last spot and no recent spots');

-- The live read uses the index on spot_stream's reference (as reference_profile spells it).
create or replace function pg_temp.plan(p_query text) returns text language plpgsql as $$
declare
  v_line text;
  v_plan text := '';
begin
  for v_line in execute 'explain ' || p_query loop
    v_plan := v_plan || v_line || E'\n';
  end loop;
  return v_plan;
end;
$$;
set local enable_seqscan = off;
select ok(pg_temp.plan($q$select s.callsign, s.spot_time from spot_stream s
                           where s.reference = any (array['US-0817', 'us-0817']) and s.program = 'POTA'
                             and s.source in ('pota', 'sotawatch', 'wwff')$q$)
          like '%raw_spots_reference_time_idx%',
  'the read by reference uses raw_spots_reference_time_idx');
reset enable_seqscan;
select has_column('public', 'spot_stream', 'comment', 'spot_stream carries the comment');

-- ---------------------------------------------------------------------------
-- The cache
-- ---------------------------------------------------------------------------

set local lock_timeout = '7s';
select is(cached_reference_profile('POTA', 'us-0817'), (select p from p), 'cached_reference_profile builds the profile');
select is((select array_agg((program, reference)::text) from reference_profile_cache), array['(pota,US-0817)'],
  'and caches it by program and upper-case reference');
select ok(exists (select 1 from pg_locks l
                  where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.objsubid = 2
                    and l.classid = (hashtext('reference_profile_cache')::bigint & 4294967295)::oid
                    and l.objid = (hashtext('pota US-0817')::bigint & 4294967295)::oid),
  'a miss holds the per-reference build lock until commit, so concurrent misses build once');
select is(current_setting('lock_timeout'), '7s', 'a miss caps its wait for that lock but leaves lock_timeout as it was');
update reference_profile_cache set payload = '{"marker": true}';
select is(cached_reference_profile('pota', 'US-0817'), '{"marker": true}'::jsonb, 'a fresh entry is served as is');
update reference_profile_cache set generated_at = now() - interval '16 minutes';
select is(cached_reference_profile('pota', 'US-0817'), (select p from p), 'one older than 15 minutes is rebuilt');
update reference_profile_cache set payload = '{"marker": true}', generated_at = now() - interval '5 minutes';
select is(cached_reference_profile('pota', 'US-0817'), '{"marker": true}'::jsonb,
  'a call hidden before the entry was built leaves it fresh');
insert into hidden_callsigns (callsign, hidden_at) values ('W1AW', now() - interval '1 minute');
select is(cached_reference_profile('pota', 'US-0817') -> 'totals', '{"activations": 3, "activators": 1, "spots": 4}'::jsonb,
  'a call hidden since makes it a miss, so hiding takes effect at once');
delete from hidden_callsigns where callsign = 'W1AW';
select ok(cached_reference_profile('pota', 'US-8888') is null and cached_reference_profile('pota', 'US 1') is null
          and cached_reference_profile('bota', 'B/G-0001') is null
          and (select count(*) from reference_profile_cache) = 1,
  'a null profile is returned as null and never cached');
select ok(not exists (select 1 from pg_locks l
                      where l.locktype = 'advisory' and l.pid = pg_backend_pid()
                        and l.objid = (hashtext('pota US 1')::bigint & 4294967295)::oid),
  'malformed input takes no lock');

-- Prune.
insert into reference_profile_cache (program, reference, payload, generated_at)
values ('pota', 'US-0001', '{}', now() - interval '20 minutes');
select lives_ok('select prune_callsign_lookups()', 'prune_callsign_lookups runs');
select is((select array_agg(reference) from reference_profile_cache), array['US-0817'],
  'and deletes expired reference cache entries too');
select ok((select prosrc like '%reference_profile_cache where generated_at <= now() - public.profile_cache_ttl()%'
                  and prosrc like '%callsign_profile_cache%'
           from pg_proc where proname = 'prune_callsign_lookups'),
  'by profile_cache_ttl(), with the callsign entries');
select ok((select prosrc like '%profile_cache_ttl()%' from pg_proc where proname = 'cached_reference_profile'),
  'the cache reads profile_cache_ttl()');

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

select ok((select relrowsecurity from pg_class where oid = 'public.reference_profile_cache'::regclass)
          and not exists (select 1 from pg_policy where polrelid = 'public.reference_profile_cache'::regclass),
  'reference_profile_cache has RLS on and no policies');
select ok(not has_table_privilege('authenticated', 'public.reference_profile_cache', 'select')
          and not has_table_privilege('anon', 'public.reference_profile_cache', 'select'),
  'clients cannot read the cache');
select ok(not exists (
  select 1 from unnest(array['public.reference_profile(text, text)', 'public.cached_reference_profile(text, text)']) as f
  where has_function_privilege('authenticated', f, 'execute') or has_function_privilege('anon', f, 'execute')),
  'clients cannot run the reference profile functions');
select ok(has_function_privilege('service_role', 'public.cached_reference_profile(text, text)', 'execute'),
  'the Edge Function''s service role can');
select ok((select bool_and(exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
           from pg_proc p where p.proname in ('reference_profile', 'cached_reference_profile')
             and p.pronamespace = 'public'::regnamespace),
  'both pin search_path');
select ok((select prosecdef from pg_proc where proname = 'reference_profile' and pronamespace = 'public'::regnamespace)
          and (select provolatile = 's' from pg_proc where proname = 'reference_profile' and pronamespace = 'public'::regnamespace),
  'reference_profile is a stable security definer');
select ok(not has_table_privilege('authenticated', 'public.spot_stream', 'select')
          and not has_table_privilege('anon', 'public.spot_stream', 'select'),
  'spot_stream stays closed to clients');

select * from finish();
rollback;

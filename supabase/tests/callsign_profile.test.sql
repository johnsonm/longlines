-- pgTAP: callsign_profile() and its cache, rate limit and prune (20261012000060, recentSpots order
-- 20261012000100).
-- Pins the payload shape: CallsignProfile in web/src/profile/types.ts.
begin;
create extension if not exists pgtap with schema extensions;
select plan(73);

create or replace function pg_temp.d(p_offset int) returns date language sql as $$
  select (now() at time zone 'utc')::date + p_offset;
$$;
create or replace function pg_temp.at(p_offset int, p_hms text) returns timestamptz language sql as $$
  select ((pg_temp.d(p_offset))::text || ' ' || p_hms || '+00')::timestamptz;
$$;
create or replace function pg_temp.raw(
  p_source text, p_id text, p_time timestamptz, p_call text, p_spotter text, p_khz numeric, p_band text,
  p_mode text, p_family text, p_pota text default null, p_park text default null, p_loc text default null,
  p_sota text default null) returns void language sql as $$
  insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, spotter, frequency_khz, band,
                         mode, mode_family, comment, pota_reference, pota_park_name, pota_location, sota_summit_ref,
                         raw_payload)
  values (p_source, p_id, p_id, p_time, p_call, p_spotter, p_khz, p_band, p_mode, p_family, '', p_pota, p_park,
          p_loc, p_sota, '{}');
$$;
create or replace function pg_temp.rbn(p_time timestamptz, p_call text, p_spotter text, p_khz numeric, p_band text,
                                       p_snr int) returns jsonb language sql as $$
  select jsonb_build_object(
    'spot_time', p_time, 'received_at', p_time, 'spotter', p_spotter, 'callsign', p_call,
    'frequency_khz', p_khz, 'band', p_band, 'mode', 'cw', 'mode_family', 'cw', 'snr', p_snr,
    'speed', 22, 'speed_unit', 'WPM', 'spot_type', 'CQ', 'line', 'x');
$$;
create or replace function pg_temp.keys(p jsonb) returns text[] language sql as $$
  select array(select jsonb_object_keys(p) order by 1);
$$;
create or replace function pg_temp.plan(p_query text) returns setof text language plpgsql as $$
begin
  return query execute 'explain ' || p_query;
end $$;

delete from deliveries;
delete from raw_spots;
delete from rbn_spots;
delete from callsign_activity;
delete from callsign_reach;
delete from callsign_references;
delete from callsign_seen;
delete from callsign_variants;
delete from callsign_rollup_days;
delete from callsign_licenses;
delete from hidden_callsigns;
delete from callsign_profile_cache;
delete from lookup_rate_limits;

select load_cty('test',
  '[{"prefix":"K","name":"United States","continent":"NA","cq_zone":5,"itu_zone":8,"lat":37.6,"lon":-91.87},
    {"prefix":"G","name":"England","continent":"EU","cq_zone":14,"itu_zone":27,"lat":52.77,"lon":-1.47},
    {"prefix":"SM","name":"Sweden","continent":"EU","cq_zone":14,"itu_zone":18,"lat":61.2,"lon":14.57},
    {"prefix":"DL","name":"Fed. Rep. of Germany","continent":"EU","cq_zone":14,"itu_zone":28,"lat":51.0,"lon":10.0}]',
  '[{"pattern":"K","exact":false,"entity":"K","continent":"NA","cq_zone":5,"itu_zone":8},
    {"pattern":"W","exact":false,"entity":"K","continent":"NA","cq_zone":5,"itu_zone":8},
    {"pattern":"N","exact":false,"entity":"K","continent":"NA","cq_zone":5,"itu_zone":8},
    {"pattern":"G","exact":false,"entity":"G","continent":"EU","cq_zone":14,"itu_zone":27},
    {"pattern":"SM","exact":false,"entity":"SM","continent":"EU","cq_zone":14,"itu_zone":18},
    {"pattern":"DL","exact":false,"entity":"DL","continent":"EU","cq_zone":14,"itu_zone":28}]');

insert into callsign_licenses (callsign, authority, name, operator_class, status, granted_on, expires_on, country,
                               state, grid, loaded_at)
values ('KK4PWJ', 'FCC', 'Jane Q Ham', 'General', 'Active', '2020-01-02', '2030-01-02', 'US', 'NC', null, now()),
       ('K1HID', 'FCC', 'Hidden Ham', 'Extra', 'Active', '2020-01-02', '2030-01-02', 'US', 'MA', null, now());

-- Day -4 (rolled up): KK4PWJ activates a park (a self-spot and a chaser) and, as W4/KK4PWJ, a summit; two
-- skimmers hear it; it spots W1AW on DX Cluster (hunting).
select pg_temp.raw('pota', 'r1', pg_temp.at(-4, '10:05:00'), 'KK4PWJ/P', 'KK4PWJ', 14062, '20m', 'cw', 'cw',
                   'K-0817', 'Old Name', 'US-NC');
select pg_temp.raw('pota', 'r2', pg_temp.at(-4, '10:20:00'), 'KK4PWJ/P', 'W1AW', 14062.5, '20m', 'cw', 'cw',
                   'K-0817', 'Old Name', 'US-NC');
select pg_temp.raw('sotawatch', 'r3', pg_temp.at(-4, '14:00:00'), 'W4/KK4PWJ', 'G4OBK', 7032, '40m', 'cw', 'cw',
                   p_sota => 'W4C/CM-001');
select pg_temp.raw('dxcluster', 'r4', pg_temp.at(-4, '12:00:00'), 'W1AW', 'KK4PWJ', 14250, '20m', 'ssb', 'phone');
-- Day -2 (not rolled up, like a day whose rollup failed): the park again under a new name, a second park
-- in two states.
select pg_temp.raw('pota', 'r6', pg_temp.at(-2, '09:00:00'), 'KK4PWJ', 'W1AW', 14063, '20m', 'ssb', 'phone',
                   'K-0817', 'New Name', 'US-NC');
select pg_temp.raw('pota', 'r7', pg_temp.at(-2, '09:30:00'), 'KK4PWJ', 'W1AW', 14074, '20m', 'ft8', 'digital',
                   'K-1234', 'Park Two', 'US-VA, US-NC');
-- Someone else, and a hidden station.
select pg_temp.raw('pota', 'r8', pg_temp.at(-2, '09:00:00'), 'N0OTHER', 'W1AW', 7185, '40m', 'ssb', 'phone',
                   'K-9999', 'Other Park', 'US-CO');
select pg_temp.raw('pota', 'r9', pg_temp.at(-2, '09:00:00'), 'K1HID', 'W1AW', 7185, '40m', 'ssb', 'phone',
                   'K-9998', 'Hidden Park', 'US-MA');
select ingest_rbn_spots(jsonb_build_array(
  pg_temp.rbn(pg_temp.at(-4, '11:00:00'), 'KK4PWJ', 'SM1HEV', 14035, '20m', 12),
  pg_temp.rbn(pg_temp.at(-4, '11:30:00'), 'KK4PWJ', 'DL1ABC', 14035.5, '20m', 20),
  pg_temp.rbn(pg_temp.at(-2, '08:00:00'), 'KK4PWJ', 'SM1HEV', 14036, '20m', 15),
  pg_temp.rbn(pg_temp.at(0, '00:00:01'), 'KK4PWJ', 'SM1HEV', 14036, '20m', 15)));

select is(rollup_callsign_day(pg_temp.d(-4)), 6::bigint, 'day -4 is rolled up');
select is(rollup_callsign_day(pg_temp.d(-3)), 0::bigint, 'day -3 is rolled up empty');

create temp table p as select callsign_profile('kk4pwj/p') as v;
create or replace function pg_temp.h() returns jsonb language sql as $$ select v -> 'heard' from p $$;

-- Shape.
select is(pg_temp.keys((select v from p)),
  array['callsign', 'country', 'generatedAt', 'heard', 'license', 'usPrefix'], 'profile keys');
select is(pg_temp.keys((select v -> 'license' from p)),
  array['authority', 'expiresOn', 'grantedOn', 'name', 'operatorClass', 'state', 'status'], 'license keys');
select is(pg_temp.keys((select v -> 'country' from p)), array['continent', 'name'], 'country keys');
select is(pg_temp.keys(pg_temp.h()),
  array['activations', 'activationsByLocation', 'bands', 'continents', 'countries', 'daily', 'daysOnAir',
        'firstHeard', 'heardBy', 'hours', 'hunting', 'lastHeard', 'modes', 'monthly', 'reach', 'recentSpots',
        'references', 'sources', 'spots', 'variants'], 'heard keys');
select is(pg_temp.keys(pg_temp.h() -> 'lastHeard'), array['frequencyKhz', 'mode', 'time'], 'lastHeard keys');
select is(pg_temp.keys(pg_temp.h() -> 'monthly' -> 0), array['month', 'sources', 'spots'], 'monthly entry keys');
select is(pg_temp.keys(pg_temp.h() -> 'daily' -> 0), array['day', 'sources', 'spots'], 'daily entry keys');
select is(pg_temp.keys(pg_temp.h() -> 'bands' -> 0), array['band', 'spots'], 'band entry keys');
select is(pg_temp.keys(pg_temp.h() -> 'modes' -> 0), array['label', 'percent', 'spots'], 'mode entry keys');
select is(pg_temp.keys(pg_temp.h() -> 'sources' -> 0), array['source', 'spots'], 'source entry keys');
select is(pg_temp.keys(pg_temp.h() -> 'activations' -> 0), array['activations', 'program', 'references'],
  'activations entry keys');
select is(pg_temp.keys(pg_temp.h() -> 'references' -> 0),
  array['activations', 'lastDay', 'location', 'name', 'program', 'reference', 'spots'], 'reference entry keys');
select is(pg_temp.keys(pg_temp.h() -> 'reach' -> 0), array['continent', 'country', 'spots'], 'reach entry keys');
select is(pg_temp.keys(pg_temp.h() -> 'variants' -> 0), array['callsign', 'spots'], 'variant entry keys');
select is(pg_temp.keys(pg_temp.h() -> 'hunting'), array['sources', 'spots'], 'hunting keys');
select is(pg_temp.keys(pg_temp.h() -> 'heardBy' -> 0), array['bestSnr', 'spots', 'spotter', 'topBand'],
  'heardBy entry keys');
select is(pg_temp.keys(pg_temp.h() -> 'recentSpots' -> 0),
  array['band', 'callsign', 'frequencyKhz', 'mode', 'reference', 'source', 'spotter', 'time'],
  'recentSpots entry keys');

-- Header.
select is((select (v ->> 'callsign', v ->> 'usPrefix', v -> 'country' ->> 'name', v -> 'country' ->> 'continent')::text
           from p), '(KK4PWJ,true,"United States",NA)', 'a lookup of KK4PWJ/P is the base call''s profile');
select ok((select v ->> 'generatedAt' ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$' from p), 'generatedAt is ISO UTC');
select is((select v -> 'license' from p),
  '{"authority": "FCC", "name": "Jane Q Ham", "operatorClass": "General", "status": "Active",
    "grantedOn": "2020-01-02", "expiresOn": "2030-01-02", "state": "NC"}'::jsonb, 'license from callsign_licenses');

-- Rolled-up day -4 plus live days -2 and today.
select is((pg_temp.h() ->> 'spots')::int, 9, 'spots: rollups plus the live days');
select is((pg_temp.h() ->> 'daysOnAir')::int, 3, 'days on the air: rolled and live days');
select is(pg_temp.h() ->> 'firstHeard', to_char(pg_temp.at(-4, '10:05:00') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'firstHeard from the rollups');
select is(pg_temp.h() -> 'lastHeard',
  jsonb_build_object('time', to_char(pg_temp.at(0, '00:00:01') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                     'frequencyKhz', 14036.000, 'mode', 'cw'), 'lastHeard from a live day');
select is(pg_temp.h() -> 'sources',
  '[{"source": "pota", "spots": 4}, {"source": "rbn", "spots": 4}, {"source": "sotawatch", "spots": 1}]'::jsonb,
  'sources, most spots first');
select is(pg_temp.h() -> 'reach',
  '[{"country": "Sweden", "continent": "EU", "spots": 3}, {"country": "United States", "continent": "NA", "spots": 3},
    {"country": "England", "continent": "EU", "spots": 1},
    {"country": "Fed. Rep. of Germany", "continent": "EU", "spots": 1}]'::jsonb,
  'reach: rolled and live spotters by country, without the self-spot');
select is((pg_temp.h() ->> 'countries', pg_temp.h() ->> 'continents')::text, '(4,2)', 'countries and continents');
select is(pg_temp.h() -> 'activations',
  '[{"program": "POTA", "references": 2, "activations": 3}, {"program": "SOTA", "references": 1, "activations": 1}]'::jsonb,
  'activations per program: a reference per UTC day');
select is(pg_temp.h() -> 'references',
  jsonb_build_array(
    jsonb_build_object('reference', 'K-0817', 'name', 'New Name', 'program', 'POTA', 'location', 'US-NC',
                       'activations', 2, 'spots', 3, 'lastDay', pg_temp.d(-2)),
    jsonb_build_object('reference', 'K-1234', 'name', 'Park Two', 'program', 'POTA', 'location', 'US-VA, US-NC',
                       'activations', 1, 'spots', 1, 'lastDay', pg_temp.d(-2)),
    jsonb_build_object('reference', 'W4C/CM-001', 'name', null, 'program', 'SOTA', 'location', null,
                       'activations', 1, 'spots', 1, 'lastDay', pg_temp.d(-4))),
  'references merge rollups and live days, the latest name wins, most recent first');
select is(pg_temp.h() -> 'activationsByLocation', '{"US-NC": 3, "US-VA": 1}'::jsonb,
  'activations by location: a park in two states counts in each');
select is(pg_temp.h() -> 'variants',
  '[{"callsign": "KK4PWJ", "spots": 6}, {"callsign": "KK4PWJ/P", "spots": 2}, {"callsign": "W4/KK4PWJ", "spots": 1}]'::jsonb,
  'variants: each spelling');
select is(pg_temp.h() -> 'hunting', '{"spots": 1, "sources": [{"source": "dxcluster", "spots": 1}]}'::jsonb,
  'hunting: spots posted for others, from the rollups');
select is(pg_temp.h() -> 'heardBy',
  '[{"spotter": "SM1HEV", "spots": 3, "bestSnr": 15, "topBand": "20m"},
    {"spotter": "W1AW", "spots": 3, "bestSnr": null, "topBand": "20m"},
    {"spotter": "DL1ABC", "spots": 1, "bestSnr": 20, "topBand": "20m"},
    {"spotter": "G4OBK", "spots": 1, "bestSnr": null, "topBand": "40m"}]'::jsonb,
  'heard by: spotters over 7 days, without the self-spot');
select is(jsonb_array_length(pg_temp.h() -> 'recentSpots'), 9, 'recent spots: every spot of the week');
select is(pg_temp.h() -> 'recentSpots' -> 0,
  jsonb_build_object('time', to_char(pg_temp.at(0, '00:00:01') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                     'callsign', 'KK4PWJ', 'frequencyKhz', 14036.000, 'band', '20m', 'mode', 'cw',
                     'reference', null, 'source', 'rbn', 'spotter', 'SM1HEV'), 'recent spots: newest first');
select is(pg_temp.h() -> 'hours',
  '[1, 0, 0, 0, 0, 0, 0, 0, 1, 2, 2, 2, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]'::jsonb, 'hours: 24 UTC hours');
select is((select array_agg(e ->> 'band') from jsonb_array_elements(pg_temp.h() -> 'bands') e),
  array['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m', '2m'], 'bands: the Stats order');
select is((select jsonb_object_agg(e ->> 'band', e -> 'spots') from jsonb_array_elements(pg_temp.h() -> 'bands') e
           where (e ->> 'spots')::int > 0), '{"20m": 8, "40m": 1}'::jsonb, 'bands: spots per band');
select is(pg_temp.h() -> 'modes',
  '[{"label": "CW", "spots": 7, "percent": 78}, {"label": "SSB", "spots": 1, "percent": 11},
    {"label": "FT8/FT4", "spots": 1, "percent": 11}, {"label": "FM", "spots": 0, "percent": 0},
    {"label": "Other", "spots": 0, "percent": 0}]'::jsonb, 'modes: five labels, percents sum to 100');
select is(jsonb_array_length(pg_temp.h() -> 'daily'), 30, 'daily: 30 days');
select is((select array_agg(e) from jsonb_array_elements(pg_temp.h() -> 'daily') with ordinality as t(e, i)
           where i in (26, 28, 30)),
  array[jsonb_build_object('day', pg_temp.d(-4), 'spots', 5, 'sources', '{"pota": 2, "rbn": 2, "sotawatch": 1}'::jsonb),
        jsonb_build_object('day', pg_temp.d(-2), 'spots', 3, 'sources', '{"pota": 2, "rbn": 1}'::jsonb),
        jsonb_build_object('day', pg_temp.d(0), 'spots', 1, 'sources', '{"rbn": 1}'::jsonb)],
  'daily: rolled and live days, ending today');
select is((select sum((e ->> 'spots')::int) from jsonb_array_elements(pg_temp.h() -> 'daily') e)::int, 9,
  'daily: zero-filled around them');
select is((select (min(e ->> 'month'), max(e ->> 'month'), sum((e ->> 'spots')::int))::text
           from jsonb_array_elements(pg_temp.h() -> 'monthly') e),
  (to_char(pg_temp.d(-4), 'YYYY-MM'), to_char(pg_temp.d(0), 'YYYY-MM'), 9)::text,
  'monthly: first month heard through this month');

-- Once day -2 is rolled up, the profile reads the same: the live read and the rollup agree.
select is(rollup_callsign_day(pg_temp.d(-2)), 5::bigint, 'day -2 is rolled up');
select is(callsign_profile('KK4PWJ') -> 'heard', (select v -> 'heard' from p),
  'the profile is the same whether day -2 is read live or from the rollups');

-- A station that only spotted others, and one never heard at all.
select is((select (v -> 'heard' ->> 'spots', v -> 'heard' ->> 'firstHeard', v -> 'heard' -> 'lastHeard',
                   v -> 'heard' -> 'hunting' ->> 'spots', v ->> 'usPrefix', v -> 'country' ->> 'name')::text
           from (select callsign_profile('G4OBK') as v) x),
  '(0,,null,1,false,England)', 'a station that only spotted others gets its hunting');
select is(callsign_profile('N0NE') - 'generatedAt',
  '{"callsign": "N0NE", "usPrefix": true, "country": {"name": "United States", "continent": "NA"},
    "license": null, "heard": null}'::jsonb, 'not heard: the header shape, no sections');
select is((callsign_profile('VE3XYZ') ->> 'usPrefix', callsign_profile('VE3XYZ') -> 'country')::text, '(false,null)',
  'a call cty.dat cannot place has no country');

-- Hidden: exactly the not-heard shape, with no license.
insert into hidden_callsigns (callsign) values ('K1HID');
select is(callsign_profile('K1HID/P') - 'generatedAt',
  '{"callsign": "K1HID", "usPrefix": true, "country": {"name": "United States", "continent": "NA"},
    "license": null, "heard": null}'::jsonb, 'a hidden call returns the not-heard shape with no license');
select throws_ok($$insert into hidden_callsigns (callsign) values ('K1HID/P')$$, '23514', null,
  'hidden_callsigns holds base calls');
select ok(callsign_profile('') is null and callsign_profile('P/1') is null,
  'input with no base call is not a callsign: null');
select ok(cached_callsign_profile('P/1') is null
          and not exists (select 1 from callsign_profile_cache where callsign = 'P/1'),
  'cached_callsign_profile returns it as null and caches nothing');

-- Cache: a fresh entry is served as is, a stale one rebuilt, a hidden call never served from it.
select is(cached_callsign_profile('kk4pwj') -> 'heard' ->> 'spots', '9', 'cached_callsign_profile builds a profile');
select is((select count(*) from callsign_profile_cache where callsign = 'KK4PWJ')::int, 1, 'and caches it by base call');
select ingest_rbn_spots(jsonb_build_array(pg_temp.rbn(pg_temp.at(0, '00:00:02'), 'KK4PWJ', 'DL1ABC', 14036, '20m', 9)));
select is(cached_callsign_profile('KK4PWJ/P') -> 'heard' ->> 'spots', '9', 'a fresh cache entry is served');
update callsign_profile_cache set generated_at = now() - interval '16 minutes';
select is(cached_callsign_profile('KK4PWJ') -> 'heard' ->> 'spots', '10', 'one older than 15 minutes is rebuilt');
insert into hidden_callsigns (callsign) values ('KK4PWJ');
select is(cached_callsign_profile('KK4PWJ') -> 'heard', 'null'::jsonb, 'hiding a call takes effect at once');
delete from hidden_callsigns where callsign = 'KK4PWJ';
select is(cached_callsign_profile('KK4PWJ') -> 'heard' ->> 'spots', '10', 'and so does showing it again');

-- Rate limit and prune.
select is(array[record_profile_lookup('a'), record_profile_lookup('a'), record_profile_lookup('b')], array[1, 2, 1],
  'record_profile_lookup counts each client''s lookups in the current minute');
insert into lookup_rate_limits (client, window_start, lookups) values ('a', date_trunc('minute', now()) - interval '1 minute', 40);
insert into callsign_profile_cache (callsign, payload, generated_at) values ('N0OLD', '{}', now() - interval '20 minutes');
select lives_ok('select prune_callsign_lookups()', 'prune_callsign_lookups runs');
select is((select array_agg((client, lookups)::text order by client) from lookup_rate_limits),
  array['(a,2)', '(b,1)'], 'prune drops finished windows only');
select is((select array_agg(callsign) from callsign_profile_cache), array['KK4PWJ'], 'and expired cache entries');
select ok(exists (select 1 from cron.job where jobname = 'prune-callsign-lookups' and schedule = '15 * * * *'),
  'the prune runs hourly');

-- The RBN arm of spot_stream reads one station through the base-callsign index.
set local enable_seqscan = off;
select ok(exists (select 1 from pg_temp.plan($$select * from spot_stream
                                               where base_callsign = 'KK4PWJ' and spot_time > now() - interval '1 day'
                                                 and source = 'rbn'$$) l
                  where l ~ 'Index Cond: \(\(base_callsign\(callsign\) = '),
  'rbn_spots has a base_callsign(callsign), spot_time index that spot_stream uses');
reset enable_seqscan;
select ok((select indisvalid from pg_index where indexrelid = 'rbn_spots_base_callsign_time_idx'::regclass),
  'the parent index is valid: every partition''s index is attached');
select create_rbn_spots_partition(pg_temp.d(30));
select ok(exists (select 1 from pg_inherits i join pg_index x on x.indexrelid = i.inhrelid
                  where i.inhparent = 'rbn_spots_base_callsign_time_idx'::regclass
                    and x.indrelid = to_regclass('partitions.rbn_spots_' || to_char(pg_temp.d(30), 'YYYYMMDD'))),
  'a partition created later gets the index');

-- recentSpots ties: 30 skimmers hear N0TIE in the same second, stored in reverse spotter order. The
-- newest 25 are always the first 25 by spotter, whatever order the rows come back in.
select ingest_rbn_spots((select jsonb_agg(pg_temp.rbn(pg_temp.at(-1, '12:00:00'), 'N0TIE', format('SK%s', lpad(i::text, 2, '0')),
                                                      14030, '20m', 10) order by i desc)
                         from generate_series(1, 30) as i));
select is((select array_agg(e ->> 'spotter' order by o) from jsonb_array_elements(callsign_profile('N0TIE') #> '{heard,recentSpots}')
             with ordinality as t(e, o)),
  (select array_agg(format('SK%s', lpad(i::text, 2, '0')) order by i) from generate_series(1, 25) as i),
  'recentSpots breaks ties at the cutoff by every column it shows, so the same rows give the same 25');
select is(jsonb_array_length(callsign_profile('N0TIE') #> '{heard,recentSpots}'), 25, 'and still keeps 25');

-- Access.
select ok(not exists (
  select 1 from unnest(array['hidden_callsigns', 'callsign_profile_cache', 'lookup_rate_limits']) as t
  where has_table_privilege('authenticated', t, 'select') or has_table_privilege('anon', t, 'select')),
  'clients cannot read the profile tables');
select ok(not exists (
  select 1 from unnest(array['public.callsign_profile(text)', 'public.cached_callsign_profile(text)',
                             'public.record_profile_lookup(text)', 'public.prune_callsign_lookups()']) as f
  where has_function_privilege('authenticated', f, 'execute') or has_function_privilege('anon', f, 'execute')),
  'clients cannot run the profile functions');
select ok(has_function_privilege('service_role', 'public.cached_callsign_profile(text)', 'execute')
          and has_function_privilege('service_role', 'public.record_profile_lookup(text)', 'execute'),
  'the Edge Function''s service role can');

select * from finish();
rollback;

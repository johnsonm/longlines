-- pgTAP: stats_snapshots table, refresh_stats_snapshot() payload shape and
-- numbers, the RBN and APRS rollups, window boundaries, the hourly series
-- moving with the hour, pruning to 48 rows, RLS.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(179);

-- Start from empty tables so every count below is exact. Both are empty on a
-- fresh CI database; locally the cron jobs may have filled them. deliveries
-- references raw_spots without cascade, so it goes first.
delete from deliveries;
delete from raw_spots;
delete from stats_snapshots;
delete from rbn_spots;
delete from rbn_hourly;
delete from rbn_daily_skimmers;
delete from rbn_daily_stations;
delete from rbn_rollup_days;
delete from rbn_rollup_hours;
delete from aprs_packets;
delete from aprs_packet_hours;
delete from aprs_daily_stations;
delete from aprs_daily_igates;
delete from aprs_daily_types;
delete from aprs_rollup_days;
delete from country_daily_spots;
delete from country_rollup_days;
delete from cty_prefixes;
delete from cty_entities;
delete from cty_load;

-- Day k of the window (0 = oldest, 6 = yesterday, 7 = today) at hour h UTC,
-- derived from the current UTC date so the test is stable at any time of day.
-- Arithmetic is on a plain timestamp, exactly as in refresh_stats_snapshot().
create or replace function pg_temp.at_utc(k int, h int) returns timestamptz language sql as $$
  select (date_trunc('day', now() at time zone 'utc') - interval '7 days' + make_interval(days => k, hours => h)) at time zone 'utc';
$$;
create or replace function pg_temp.day_str(k int) returns text language sql as $$
  select to_char(date_trunc('day', now() at time zone 'utc') - interval '7 days' + make_interval(days => k), 'YYYY-MM-DD');
$$;
-- Refreshes as of p_at, by default 00:30 UTC today: the hourly series then ends
-- at window_end, like every other figure, so the numbers below hold at any
-- time of day. The rolling hours have their own section at the end.
create or replace function pg_temp.refresh(p_at timestamptz default null) returns void language sql as $$
  select refresh_stats_snapshot_at(coalesce(p_at, pg_temp.at_utc(7, 0) + interval '30 minutes'));
$$;
-- Payload of the newest snapshot.
create or replace function pg_temp.snap() returns jsonb language sql as $$
  select payload from stats_snapshots order by generated_at desc, id desc limit 1;
$$;
-- One APRS packet for ingest_aprs_packets (null igate: no q-construct).
create or replace function pg_temp.aprs(p_time timestamptz, p_call text, p_type text, p_igate text)
returns jsonb language sql as $$
  select jsonb_build_object(
    'received_at', p_time, 'source_call', p_call, 'destination', 'APRS', 'path', 'WIDE1-1',
    'q_construct', case when p_igate is not null then 'qAR' end, 'igate', p_igate,
    'packet_type', p_type, 'line', p_call || '>APRS,WIDE1-1:' || p_type);
$$;

insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, spotter, frequency_khz, band, mode, comment, pota_reference, pota_park_name, pota_location, sota_summit_ref, raw_payload)
values
  -- Outside the window: today (after window_end) and eight days ago. Both are in WY so a leak shows up in potaByState too.
  ('pota', 'x1', 'x1', pg_temp.at_utc(7, 1),   'XX1OUT', null, 14062, '20m', 'cw', '', 'US-9999', 'Out Park', 'US-WY', null, '{}'),
  ('pota', 'x2', 'x2', pg_temp.at_utc(-1, 12), 'XX1OUT', null, 14062, '20m', 'cw', '', 'US-9999', 'Out Park', 'US-WY', null, '{}'),
  -- Day 1: KK4PWJ at a park spanning NC and VA. The newest row has no park name. Three spots, one
  -- activation; K1GMS spots twice and the third spot is a self-spot (not a chaser) even though the
  -- spotter carries a suffix the activator does not.
  ('pota', 'p1', 'p1', pg_temp.at_utc(1, 20), 'KK4PWJ', 'K1GMS',  14062, '20m', 'cw',  '', 'US-2763', 'Old Park Name', 'US-NC,US-VA', null, '{}'),
  ('pota', 'p2', 'p2', pg_temp.at_utc(1, 21), 'KK4PWJ', 'K1GMS',  14062, '20m', 'cw',  '', 'US-2763', 'New Park Name', 'US-NC,US-VA', null, '{}'),
  ('pota', 'p3', 'p3', pg_temp.at_utc(1, 22), 'KK4PWJ', 'KK4PWJ/P', 7185,  '40m', 'ssb', '', 'US-2763', null,            'US-NC,US-VA', null, '{}'),
  -- Days 2 and 3: N4DXX at the same park on two days (one reference, two activations); usb and lsb
  -- both land in SSB. One location has a space after the comma. K1GMS chases again, VE3ABC once.
  ('pota', 'p4', 'p4', pg_temp.at_utc(2, 20), 'N4DXX', 'K1GMS',  7185, '40m', 'usb', '', 'US-0817', 'Park B', 'US-NC, US-GA', null, '{}'),
  ('pota', 'p5', 'p5', pg_temp.at_utc(3, 10), 'N4DXX', 'VE3ABC', 7185, '40m', 'lsb', '', 'US-0817', 'Park B', 'US-NC',        null, '{}'),
  -- Day 3: a Canadian park with no band (ignored by potaByState and bands) and a 70cm FM spot (not one of the eleven bands). No spotter.
  ('pota', 'p6', 'p6', pg_temp.at_utc(3, 20), 'VE3ABC', null, 14074,  null,   'ft8', '', 'CA-1234', 'Canada Park', 'CA-ON', null, '{}'),
  ('pota', 'p7', 'p7', pg_temp.at_utc(3, 9),  'W1AW',   null, 446000, '70cm', 'fm',  '', 'US-0001', 'Park C',      'US-MA', null, '{}'),
  -- Day 4: W1AW on three references; one spot has no mode.
  ('pota', 'p8',  'p8',  pg_temp.at_utc(4, 20), 'W1AW', null, 14080, '20m', 'ft4', '', 'US-0002', 'Park D', 'US-MA', null, '{}'),
  ('pota', 'p9',  'p9',  pg_temp.at_utc(4, 11), 'W1AW', null, 14062, '20m', null,  '', 'US-0003', 'Park E', 'US-MA', null, '{}'),
  ('pota', 'p10', 'p10', pg_temp.at_utc(4, 20), 'W1AW', null, 14074, '20m', 'ft8', '', 'US-0003', 'Park E', 'US-MA', null, '{}'),
  -- Days 5 and 6: SOTA. W4C twice; SP four times in one hour, the busiest slot. SQ1GPR/P is spotted
  -- by SQ1GPR, by SQ1GPR/P exactly and by SQ1GPR/M: all self-spots, so W4ABC is the only SOTA chaser.
  ('sotawatch', 's1', 's1', pg_temp.at_utc(5, 12), 'W4/G4OBK', 'W4ABC',  7032,   '40m', 'cw',  '', null, null, null, 'W4C/CM-001', '{}'),
  ('sotawatch', 's2', 's2', pg_temp.at_utc(5, 13), 'W4/G4OBK', 'W4ABC',  7032,   '40m', 'cw',  '', null, null, null, 'W4C/CM-002', '{}'),
  ('sotawatch', 's3', 's3', pg_temp.at_utc(6, 14), 'SQ1GPR/P', 'SQ1GPR', 7097,   '40m', 'ssb', '', null, null, null, 'SP/SS-004',  '{}'),
  ('sotawatch', 's4', 's4', pg_temp.at_utc(6, 14), 'SQ1GPR/P', 'SQ1GPR/P', 145500, '2m',  'fm',  '', null, null, null, 'SP/SS-004',  '{}'),
  ('sotawatch', 's5', 's5', pg_temp.at_utc(6, 14), 'SQ1GPR/P', 'SQ1GPR/M', 7032,   '40m', 'cw',  '', null, null, null, 'SP/SS-004',  '{}'),
  ('sotawatch', 's6', 's6', pg_temp.at_utc(6, 14), 'SQ1GPR/P', 'SQ1GPR', 7032,   '40m', 'cw',  '', null, null, null, 'SP/SS-004',  '{}'),
  -- RBN: a skimmer report of a watched station, in the window. Not activity, so no total, chart or table counts it.
  ('rbn', 'r1', 'r1', pg_temp.at_utc(2, 20), 'RB1N', 'W3LPL', 14035, '20m', 'cw', '12 dB 22 WPM CQ', null, null, null, null, '{}'),
  -- DX Cluster: counted only in daily/hourly dx, never in totals or busiestSlot.
  ('dxcluster', 'dx1', 'dx1', pg_temp.at_utc(2, 20), 'DX1ABC', 'K1DX', 14025, '20m', 'cw', '', null, null, null, null, '{}'),
  ('dxcluster', 'dx2', 'dx2', pg_temp.at_utc(7, 1),  'DX1ABC', 'K1DX', 14025, '20m', 'cw', '', null, null, null, null, '{}');
-- RBN firehose (rbn_spots). Seven in-window spots from three skimmers of three stations; W3LPL hears
-- K1ABC twice on 20m at different frequencies, DK8NE hears it only as K1ABC/P. One spot has no band.
-- Today and eight days ago are out.
insert into rbn_spots (spot_time, received_at, spotter, callsign, frequency_khz, band, mode, mode_family, snr, speed, speed_unit, spot_type, line)
select t, t, sp, cs, f, b, 'cw', 'cw', 10, 25, 'WPM', 'CQ', 'line'
from (values
  (pg_temp.at_utc(2, 20),  'W3LPL', 'K1ABC', 14025.0, '20m'),
  (pg_temp.at_utc(2, 20),  'W3LPL', 'K1ABC', 14030.0, '20m'),
  (pg_temp.at_utc(2, 20),  'W3LPL', 'N4XX',  7025.0,  '40m'),
  (pg_temp.at_utc(2, 20),  'DK8NE', 'K1ABC/P', 14025.0, '20m'),
  (pg_temp.at_utc(3, 5),   'DK8NE', 'K1ABC/P', 999.0,   null),
  (pg_temp.at_utc(4, 3),   'W3LPL', 'N4XX',  1825.0,  '160m'),
  (pg_temp.at_utc(6, 23),  'VE7CC', 'JA1XX', 21025.0, '15m'),
  (pg_temp.at_utc(7, 1),   'VE7CC', 'XX1OUT', 14025.0, '20m'),
  (pg_temp.at_utc(-1, 12), 'VE7CC', 'XX1OUT', 14025.0, '20m')
) as v(t, sp, cs, f, b);
-- A rollup left from a day before the window; the refresh deletes it.
insert into rbn_daily_stations (day, callsign, spots) values ((pg_temp.at_utc(-2, 0) at time zone 'utc')::date, 'OLD1', 1);
-- APRS-IS, through ingest so aprs_packet_hours counts them. Four in-window packets: K4ABC under two
-- SSIDs on day 2 at 20 UTC, and N0XYZ and MYANET (no igate) on day 6 at 23 UTC. Today and eight days
-- ago are out.
select ingest_aprs_packets(jsonb_build_array(
  pg_temp.aprs(pg_temp.at_utc(2, 20), 'K4ABC-9', 'position', 'W1ABC-10'),
  pg_temp.aprs(pg_temp.at_utc(2, 20) + interval '1 minute', 'K4ABC-7', 'position', 'W1ABC-10'),
  pg_temp.aprs(pg_temp.at_utc(6, 23), 'N0XYZ', 'message', 'W2DEF'),
  pg_temp.aprs(pg_temp.at_utc(6, 23) + interval '1 minute', 'MYANET', 'status', null),
  pg_temp.aprs(pg_temp.at_utc(7, 1), 'XX1OUT', 'position', 'W1ABC-10'),
  pg_temp.aprs(pg_temp.at_utc(-1, 12), 'XX1OUT', 'position', 'W1ABC-10')));
-- An APRS rollup left from a day before the window; the refresh deletes it.
insert into aprs_daily_stations (day, base) values ((pg_temp.at_utc(-2, 0) at time zone 'utc')::date, 'OLD1');

-- Ingest stores mode_family from _shared/modes.ts; these rows bypass ingest, so set it the way modes.ts would.
update raw_spots set mode_family = case
  when mode = 'cw'                          then 'cw'
  when mode in ('ssb', 'usb', 'lsb', 'fm')  then 'phone'
  when mode in ('ft8', 'ft4')               then 'digital'
end;

-- Countries. With no cty.dat loaded the country rollup changes nothing and marks nothing, so the
-- day is retried once import-cty has run.
select is(rollup_country_day((pg_temp.at_utc(1, 0) at time zone 'utc')::date), false, 'rollup_country_day refuses to run without cty.dat');
select is((select count(*) from country_rollup_days), 0::bigint, 'a refused country day is not marked');
-- The entities the in-window calls come from; DX1ABC is the Philippines' DX prefix.
select load_cty('test',
  '[{"prefix":"K","name":"United States","continent":"NA","cq_zone":5,"itu_zone":8,"lat":37.6,"lon":-91.87},
    {"prefix":"VE","name":"Canada","continent":"NA","cq_zone":5,"itu_zone":9,"lat":44.35,"lon":-78.75},
    {"prefix":"SP","name":"Poland","continent":"EU","cq_zone":15,"itu_zone":28,"lat":52.28,"lon":18.67},
    {"prefix":"JA","name":"Japan","continent":"AS","cq_zone":25,"itu_zone":45,"lat":36.4,"lon":138.38},
    {"prefix":"DU","name":"Philippines","continent":"OC","cq_zone":27,"itu_zone":50,"lat":13.0,"lon":122.0}]',
  '[{"pattern":"K","exact":false,"entity":"K","continent":"NA","cq_zone":5,"itu_zone":8},
    {"pattern":"W","exact":false,"entity":"K","continent":"NA","cq_zone":5,"itu_zone":8},
    {"pattern":"N","exact":false,"entity":"K","continent":"NA","cq_zone":5,"itu_zone":8},
    {"pattern":"VE","exact":false,"entity":"VE","continent":"NA","cq_zone":5,"itu_zone":9},
    {"pattern":"SP","exact":false,"entity":"SP","continent":"EU","cq_zone":15,"itu_zone":28},
    {"pattern":"SQ","exact":false,"entity":"SP","continent":"EU","cq_zone":15,"itu_zone":28},
    {"pattern":"JA","exact":false,"entity":"JA","continent":"AS","cq_zone":25,"itu_zone":45},
    {"pattern":"DX","exact":false,"entity":"DU","continent":"OC","cq_zone":27,"itu_zone":50}]');

-- Refresh and window.
select lives_ok('select pg_temp.refresh()', 'refresh runs');
select is((select count(*) from stats_snapshots), 1::bigint, 'refresh inserts exactly one row');
select is((select window_start from stats_snapshots), pg_temp.at_utc(0, 0), 'window_start is 00:00 UTC seven days ago');
select is((select window_end from stats_snapshots), pg_temp.at_utc(7, 0), 'window_end is 00:00 UTC today');

-- totals: 16 in-window POTA and SOTA rows; today, eight days ago and the RBN row are excluded.
select is((pg_temp.snap() #>> '{totals,spots}')::int, 16, 'totals.spots counts only in-window rows');
select is((select count(*) from raw_spots where source = 'rbn')::int, 1, 'setup: an in-window RBN row exists and is left out of every count');
select is((pg_temp.snap() #>> '{totals,potaSpots}')::int, 10, 'totals.potaSpots');
select is((pg_temp.snap() #>> '{totals,sotaSpots}')::int, 6, 'totals.sotaSpots');
select is((pg_temp.snap() #>> '{totals,activators}')::int, 6, 'totals.activators counts distinct callsigns as stored');
select is((pg_temp.snap() #>> '{totals,references}')::int, 9, 'totals.references is distinct POTA refs plus distinct SOTA refs');
-- activations: distinct (callsign, reference, UTC day). N4DXX at US-0817 on two days is two activations
-- for one reference; SQ1GPR/P's four spots in one hour are one.
select is((pg_temp.snap() #>> '{totals,activations}')::int, 10, 'totals.activations: 7 POTA + 3 SOTA, one more than references');
select is((pg_temp.snap() #>> '{totals,potaActivations}')::int, 7, 'totals.potaActivations');
select is((pg_temp.snap() #>> '{totals,sotaActivations}')::int, 3, 'totals.sotaActivations');
-- chasers: distinct spotters, excluding null and self-spots (spotter and activator share a base
-- callsign). K1GMS is counted once across three spots; KK4PWJ/P and every SQ1GPR form are self-spots.
select is((pg_temp.snap() #>> '{totals,chasers}')::int, 3, 'totals.chasers: K1GMS, VE3ABC, W4ABC');
select is((pg_temp.snap() #>> '{totals,potaChasers}')::int, 2, 'totals.potaChasers excludes a self-spot by a suffixed spotter');
select is((pg_temp.snap() #>> '{totals,sotaChasers}')::int, 1, 'totals.sotaChasers excludes plain, exact and re-suffixed self-spots');

-- base_callsign and is_self_spot, the one definition of a self-spot.
select is(base_callsign('G4OBK'), 'G4OBK', 'base_callsign: a plain call is its own base');
select is(base_callsign('W4/G4OBK'), 'G4OBK', 'base_callsign: prefix dropped');
select is(base_callsign('KK4PWJ/P'), 'KK4PWJ', 'base_callsign: suffix dropped');
select is(base_callsign('EA8/G4OBK/QRP'), 'G4OBK', 'base_callsign: prefix and suffix dropped');
select is(base_callsign('VP2V/W1AW'), 'W1AW', 'base_callsign: a tie goes to the later part');
select ok(is_self_spot('EA2/G4OBK', 'EA2/G4OBK'), 'is_self_spot: exact slashed call');
select ok(is_self_spot('W4/G4OBK', 'G4OBK/P'), 'is_self_spot: different prefix and suffix on each side');
select ok(not is_self_spot('W4/G4OBK', 'W4'), 'is_self_spot: sharing only a prefix is not a self-spot');
select ok(not is_self_spot('KK4PWJ', null), 'is_self_spot: a null spotter is not a self-spot');
select ok(not has_function_privilege('authenticated', 'public.is_self_spot(text, text)', 'execute'), 'clients cannot call is_self_spot');

-- peakHour sums over the week (hour 20: five spots on four days); busiestSlot is one bucket (day 6, hour 14: four spots).
select is((pg_temp.snap() ->> 'peakHour')::int, 20, 'peakHour is the hour with most spots across the whole window');
select is(pg_temp.snap() #>> '{busiestSlot,day}', pg_temp.day_str(6), 'busiestSlot.day');
select is((pg_temp.snap() #>> '{busiestSlot,hour}')::int, 14, 'busiestSlot.hour is the single busiest bucket, not the peak hour');

-- daily: seven entries, oldest first, zero-filled.
select is(jsonb_array_length(pg_temp.snap() -> 'daily'), 7, 'daily has exactly 7 entries');
select is(pg_temp.snap() -> 'daily' -> 0, jsonb_build_object('day', pg_temp.day_str(0), 'pota', 0, 'sota', 0, 'wwff', 0, 'rbn', 0, 'aprs', 0, 'dx', 0), 'daily starts at the oldest day and a day without spots is zero-filled');
select is(pg_temp.snap() -> 'daily' -> 1, jsonb_build_object('day', pg_temp.day_str(1), 'pota', 3, 'sota', 0, 'wwff', 0, 'rbn', 0, 'aprs', 0, 'dx', 0), 'daily POTA count for day 1');
select is(pg_temp.snap() -> 'daily' -> 6, jsonb_build_object('day', pg_temp.day_str(6), 'pota', 0, 'sota', 4, 'wwff', 0, 'rbn', 1, 'aprs', 2, 'dx', 0), 'daily ends yesterday with the SOTA, RBN and APRS counts');

-- potaByState: 51 keys; the NC/VA park counts once in each; CA-ON is ignored; "US-NC, US-GA" is trimmed.
select is((select count(*) from jsonb_object_keys(pg_temp.snap() -> 'potaByState')), 51::bigint, 'potaByState has 50 states plus DC');
select is((pg_temp.snap() #>> '{potaByState,NC}')::int, 5, 'NC: three from the NC/VA park plus two from US-NC');
select is((pg_temp.snap() #>> '{potaByState,VA}')::int, 3, 'VA: the NC/VA park counts once in VA as well');
select is((pg_temp.snap() #>> '{potaByState,MA}')::int, 4, 'MA');
select is((pg_temp.snap() #>> '{potaByState,GA}')::int, 1, 'a space after the comma in pota_location is trimmed, not dropped');
select is((pg_temp.snap() #>> '{potaByState,WY}')::int, 0, 'an untouched state is 0 (the out-of-window WY spots do not leak in)');
select is((select sum(value::int) from jsonb_each_text(pg_temp.snap() -> 'potaByState')), 13::bigint, 'non-US locations are ignored');

-- countries: where the station on the air is, by the call as spotted. W4/G4OBK operates from the
-- US, so its two SOTA spots count there, not in England. RBN counts every firehose spot (K1ABC/P
-- included) and none of raw_spots' watched copy; today and eight days ago are out. Ties go by code.
select is(pg_temp.snap() -> 'countries',
          '[{"code":"US","pota":9,"sota":2,"wwff":0,"dx":0,"rbn":6},{"code":"PL","pota":0,"sota":4,"wwff":0,"dx":0,"rbn":0},
            {"code":"CA","pota":1,"sota":0,"wwff":0,"dx":0,"rbn":0},{"code":"JP","pota":0,"sota":0,"wwff":0,"dx":0,"rbn":1},
            {"code":"PH","pota":0,"sota":0,"wwff":0,"dx":1,"rbn":0}]'::jsonb,
          'countries: per-source spots per ISO country, busiest first');
select is((select count(*) from country_rollup_days), 7::bigint, 'every window day is marked once cty.dat is loaded');
select is((select count(*) from cty_entity_countries where country = 'GB'), 4::bigint, 'England, Scotland, Wales and Northern Ireland are all GB');
select is((select country from cty_entity_countries where entity = 'KL'), 'US', 'Alaska is US');

select is(pg_temp.snap() -> 'wwffPrograms', '[]'::jsonb, 'wwffPrograms is empty without WWFF spots');
select is(pg_temp.snap() -> 'sotaAssociations', '[{"code":"SP","spots":4},{"code":"W4C","spots":2}]'::jsonb, 'W4C/CM-001 rolls up to association W4C');

-- bands: twelve fixed entries; 70cm and null are excluded here but counted in totals.
select is(jsonb_array_length(pg_temp.snap() -> 'bands'), 12, 'bands has 12 entries');
select is((select string_agg(e ->> 'band', ',' order by ord) from jsonb_array_elements(pg_temp.snap() -> 'bands') with ordinality as t(e, ord)),
          '160m,80m,60m,40m,30m,20m,17m,15m,12m,10m,6m,2m', 'bands are in the fixed order, starting at 160m');
select is(pg_temp.snap() -> 'bands' -> 3, '{"band":"40m","pota":3,"sota":5,"wwff":0}'::jsonb, '40m split by program');
select is(pg_temp.snap() -> 'bands' -> 5, '{"band":"20m","pota":5,"sota":0,"wwff":0}'::jsonb, '20m split by program');
select is((select sum((e ->> 'pota')::int + (e ->> 'sota')::int) from jsonb_array_elements(pg_temp.snap() -> 'bands') e), 14::bigint,
          'the 70cm spot and the null-band spot are excluded from bands (14 of 16 spots)');

-- modes: 6 cw, 4 ssb/usb/lsb, 3 ft8/ft4, 2 fm, 1 null of 16 -> 38+25+19+13+6 = 101, so CW gives one back.
select is(pg_temp.snap() -> 'modes',
          '[{"label":"CW","percent":37},{"label":"SSB","percent":25},{"label":"FT8/FT4","percent":19},{"label":"FM","percent":13},{"label":"Other","percent":6}]'::jsonb,
          'mode buckets, fixed label order, and the rounding remainder taken from the largest bucket');
select is((select sum((e ->> 'percent')::int) from jsonb_array_elements(pg_temp.snap() -> 'modes') e), 100::bigint, 'percents sum to exactly 100');

-- topActivators: references desc, then spots desc, then callsign.
select is(jsonb_array_length(pg_temp.snap() -> 'topActivators'), 6, 'one entry per activator when there are fewer than 8');
select is(pg_temp.snap() -> 'topActivators' -> 0, '{"callsign":"W1AW","base":"W1AW","references":3,"activations":3,"spots":4,"topBand":"20m"}'::jsonb,
          'most references first; topBand is the band with the most spots (20m x3 over 70cm x1)');
select is((pg_temp.snap() #>> '{topActivators,4,activations}')::int, 2, 'N4DXX has two activations at one reference');
select is(pg_temp.snap() #>> '{topActivators,2,callsign}', 'SQ1GPR/P', 'tie on references is broken by spots desc (4 spots ranks above 3)');
select is(pg_temp.snap() #>> '{topActivators,2,base}', 'SQ1GPR', 'an activator carries its base call, the profile the page links to');
select is(pg_temp.snap() #>> '{topActivators,3,callsign}', 'KK4PWJ', 'KK4PWJ follows with one reference and three spots');
select is(pg_temp.snap() #>> '{topActivators,3,topBand}', '20m', 'topBand picks 20m (2) over 40m (1) for KK4PWJ');
select is(pg_temp.snap() #> '{topActivators,5,topBand}', 'null'::jsonb, 'an activator with no band on any spot has a JSON null topBand');

-- topReferences: spots desc then reference asc, capped at 8.
select is(jsonb_array_length(pg_temp.snap() -> 'topReferences'), 8, 'topReferences is capped at 8');
select is(pg_temp.snap() -> 'topReferences' -> 0, '{"reference":"SP/SS-004","name":null,"program":"SOTA","activations":1,"spots":4}'::jsonb, 'SOTA reference has a null name');
select is(pg_temp.snap() -> 'topReferences' -> 1, '{"reference":"US-2763","name":"New Park Name","program":"POTA","activations":1,"spots":3}'::jsonb,
          'POTA name is the most recent non-null park name (the newer null row is skipped)');
select is(pg_temp.snap() #>> '{topReferences,2,reference}', 'US-0003', 'equal spot counts order by reference asc');
select is(pg_temp.snap() -> 'topReferences' -> 3, '{"reference":"US-0817","name":"Park B","program":"POTA","activations":2,"spots":2}'::jsonb,
          'a park activated on two days has two activations');
select is(pg_temp.snap() #>> '{topReferences,7,reference}', 'W4C/CM-001', 'the eighth slot goes to the alphabetically first of the one-spot references');

-- hourly: 168 hours, oldest first, zero-filled. POTA and SOTA come from raw_spots (the RBN row there is
-- not counted twice), RBN from rbn_spots through the rollup.
select is(jsonb_array_length(pg_temp.snap() -> 'hourly'), 168, 'hourly has exactly 168 entries');
select is(pg_temp.snap() -> 'hourly' -> 0,
          jsonb_build_object('hour', to_char(pg_temp.at_utc(0, 0) at time zone 'utc', 'YYYY-MM-DD"T"HH24":00:00Z"'), 'pota', 0, 'sota', 0, 'wwff', 0, 'rbn', 0, 'aprs', 0, 'dx', 0),
          'hourly starts at window_start and an empty hour is zero-filled');
select is(pg_temp.snap() -> 'hourly' -> 68,
          jsonb_build_object('hour', to_char(pg_temp.at_utc(2, 20) at time zone 'utc', 'YYYY-MM-DD"T"HH24":00:00Z"'), 'pota', 1, 'sota', 0, 'wwff', 0, 'rbn', 4, 'aprs', 2, 'dx', 1),
          'day 2 at 20 UTC: one POTA spot, four RBN spots and two APRS packets');
select is((pg_temp.snap() #>> '{hourly,167,rbn}')::int, 1, 'hourly ends at 23 UTC yesterday');
select is((select sum((e ->> 'pota')::int + (e ->> 'sota')::int) from jsonb_array_elements(pg_temp.snap() -> 'hourly') e), 16::bigint,
          'hourly POTA and SOTA add up to totals.spots');
select is((select sum((e ->> 'rbn')::int) from jsonb_array_elements(pg_temp.snap() -> 'hourly') e), 7::bigint,
          'hourly RBN adds up to rbn.spots');

-- rbn: totals, bands and most heard stations from the rollup.
select is((pg_temp.snap() #>> '{rbn,spots}')::int, 7, 'rbn.spots counts in-window rbn_spots rows only');
select is((pg_temp.snap() #>> '{rbn,skimmers}')::int, 3, 'rbn.skimmers: W3LPL, DK8NE, VE7CC');
select is((select string_agg(e ->> 'band', ',' order by ord) from jsonb_array_elements(pg_temp.snap() #> '{rbn,bands}') with ordinality as t(e, ord)),
          '160m,80m,60m,40m,30m,20m,17m,15m,12m,10m,6m,2m', 'rbn.bands share the fixed order of bands');
select is(pg_temp.snap() #> '{rbn,bands,0}', '{"band":"160m","spots":1}'::jsonb, 'rbn 160m count');
select is(pg_temp.snap() #> '{rbn,bands,5}', '{"band":"20m","spots":3}'::jsonb, 'rbn 20m count');
select is((select sum((e ->> 'spots')::int) from jsonb_array_elements(pg_temp.snap() #> '{rbn,bands}') e), 6::bigint,
          'the null-band spot is left out of rbn.bands');
-- K1ABC by base call: four spots by two skimmers over two days, two of them as K1ABC/P; N4XX: two
-- spots by one skimmer on two bands.
select is(pg_temp.snap() #> '{rbn,topStations}',
          '[{"callsign":"K1ABC","spots":4,"skimmers":2},{"callsign":"N4XX","spots":2,"skimmers":1},{"callsign":"JA1XX","spots":1,"skimmers":1}]'::jsonb,
          'rbn.topStations by base call and spots, with distinct skimmers of any form of the call over the week');
select is((select count(*) from rbn_daily_stations where callsign like 'K1ABC%'), 3::bigint,
          'the daily rollup keeps callsigns as spotted (K1ABC on one day, K1ABC/P on two)');

-- The rollup: every window day once, old rollups gone.
select is((select count(*) from rbn_rollup_days), 7::bigint, 'each window day is rolled up');
select is((select count(*) from rbn_hourly), 168::bigint, 'a rolled-up day has 24 hourly rows, zeros included');
select is((select count(*) from rbn_daily_stations where callsign = 'OLD1'), 0::bigint, 'rollups older than the window are deleted');

-- aprs: packets from aprs_packet_hours, the rest from the day rollups.
select is((pg_temp.snap() #>> '{daily,2,aprs}')::int, 2, 'daily APRS counts come from aprs_packet_hours');
select is((select sum((e ->> 'aprs')::int) from jsonb_array_elements(pg_temp.snap() -> 'hourly') e), 4::bigint,
          'hourly APRS adds up to aprs.packets');
-- dx: DX Cluster spots per day and hour, and nowhere else.
select is((pg_temp.snap() #>> '{daily,2,dx}')::int, 1, 'daily dx counts in-window DX Cluster spots');
select is((select sum((e ->> 'dx')::int) from jsonb_array_elements(pg_temp.snap() -> 'daily') e), 1::bigint,
          'daily dx leaves out DX Cluster spots outside the window');
select is((select sum((e ->> 'dx')::int) from jsonb_array_elements(pg_temp.snap() -> 'hourly') e), 1::bigint,
          'hourly dx adds up to the in-window DX Cluster spots');
select ok((select bool_and(e ? 'dx') from jsonb_array_elements(pg_temp.snap() -> 'hourly') e), 'every hourly entry has dx');
select is((pg_temp.snap() #>> '{aprs,packets}')::int, 4, 'aprs.packets counts in-window packets only');
select is((pg_temp.snap() #>> '{aprs,stations}')::int, 3, 'aprs.stations counts base calls: K4ABC-9 and K4ABC-7 are one');
select is((pg_temp.snap() #>> '{aprs,igates}')::int, 2, 'aprs.igates counts igates as sent, never a missing one');
select is(jsonb_array_length(pg_temp.snap() #> '{aprs,types}'), 14, 'aprs.types has every packet type');
select is(pg_temp.snap() #> '{aprs,types,0}', '{"type":"position","packets":2}'::jsonb, 'the busiest type comes first');
select is((select string_agg(e ->> 'type', ',' order by o) from jsonb_array_elements(pg_temp.snap() #> '{aprs,types}') with ordinality as t(e, o)),
          'position,message,status,capabilities,item,mic_e,nmea,object,other,query,telemetry,third_party,user_defined,weather',
          'types run busiest first, then by name, zero-filled');
select set_eq(
  $$select e ->> 'type' from jsonb_array_elements(pg_temp.snap() #> '{aprs,types}') e$$,
  $$select m[1] from pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') as m
    where c.conrelid = 'aprs_packets'::regclass and c.conname = 'aprs_packets_packet_type_check'$$,
  'aprs.types lists exactly the packet types aprs_packets allows');
select is((select count(*) from aprs_rollup_days), 7::bigint, 'each window day is rolled up for APRS');
select is((select count(*) from aprs_daily_stations where base = 'OLD1'), 0::bigint, 'APRS rollups older than the window are deleted');
select is((select count(*) from aprs_daily_stations where base = 'XX1OUT'), 0::bigint, 'packets outside the window are not rolled up');
-- WWFF, a peer of POTA and SOTA. Four spots on days 5 and 6: ON4ABC at two Belgian references (the
-- second ONFF-0123 spot is a self-spot and renames the reference), KK4PWJ, a POTA activator above, at a
-- US one. ON calls are not in the test cty.dat, so only KK4PWJ reaches countries. The section undoes
-- itself so the sections after it see the snapshot as before.
create temp table before_wwff as select max(id) as id from stats_snapshots;
insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, spotter, frequency_khz, band, mode, mode_family, comment, wwff_reference, wwff_reference_name, raw_payload)
values
  ('wwff', 'w1', 'w1', pg_temp.at_utc(5, 9),  'ON4ABC', 'K1GMS',    14244, '20m', 'ssb', 'phone', '', 'ONFF-0123', 'Old Name',   '{}'),
  ('wwff', 'w2', 'w2', pg_temp.at_utc(5, 10), 'ON4ABC', 'ON4ABC/P', 7144,  '40m', 'ssb', 'phone', '', 'ONFF-0123', 'New Name',   '{}'),
  ('wwff', 'w3', 'w3', pg_temp.at_utc(6, 9),  'KK4PWJ', 'W4ABC',    14062, '20m', 'cw',  'cw',    '', 'KFF-1234',  'Falls Lake', '{}'),
  ('wwff', 'w4', 'w4', pg_temp.at_utc(6, 10), 'ON4ABC', 'DL1XX',    14244, '20m', 'ssb', 'phone', '', 'ONFF-0456', null,         '{}');
select ok(rollup_country_day((pg_temp.at_utc(5, 0) at time zone 'utc')::date) and rollup_country_day((pg_temp.at_utc(6, 0) at time zone 'utc')::date),
          'the country rollup takes WWFF spots');
select lives_ok('select pg_temp.refresh()', 'refresh runs with WWFF spots');
select is((pg_temp.snap() #>> '{totals,spots}')::int, 20, 'totals.spots counts WWFF spots');
select is((pg_temp.snap() #>> '{totals,wwffSpots}')::int, 4, 'totals.wwffSpots');
select is((pg_temp.snap() #>> '{totals,activators}')::int, 7, 'totals.activators adds ON4ABC; KK4PWJ was counted already');
select is((pg_temp.snap() #>> '{totals,references}')::int, 12, 'totals.references adds the three WWFF references');
select is((pg_temp.snap() #>> '{totals,wwffActivations}')::int, 3, 'totals.wwffActivations: distinct (callsign, reference, UTC day)');
select is((pg_temp.snap() #>> '{totals,activations}')::int, 13, 'totals.activations: 7 POTA + 3 SOTA + 3 WWFF');
select is((pg_temp.snap() #>> '{totals,wwffChasers}')::int, 3, 'totals.wwffChasers: K1GMS, W4ABC, DL1XX; ON4ABC/P is a self-spot');
select is((pg_temp.snap() #>> '{totals,chasers}')::int, 4, 'totals.chasers adds DL1XX; K1GMS and W4ABC chase other programs too');
select is((pg_temp.snap() #>> '{daily,5,wwff}')::int, 2, 'daily wwff for day 5');
select is((pg_temp.snap() #>> '{daily,6,wwff}')::int, 2, 'daily wwff for day 6');
select is((select sum((e ->> 'wwff')::int) from jsonb_array_elements(pg_temp.snap() -> 'hourly') e), 4::bigint, 'hourly wwff adds up to totals.wwffSpots');
select is((pg_temp.snap() #>> '{hourly,129,wwff}')::int, 1, 'hourly wwff at day 5, 09 UTC');
select is(pg_temp.snap() -> 'bands' -> 5, '{"band":"20m","pota":5,"sota":0,"wwff":3}'::jsonb, '20m split by program, WWFF included');
select is(pg_temp.snap() -> 'bands' -> 3, '{"band":"40m","pota":3,"sota":5,"wwff":1}'::jsonb, '40m split by program, WWFF included');
select is(pg_temp.snap() -> 'wwffPrograms', '[{"code":"ONFF","spots":3},{"code":"KFF","spots":1}]'::jsonb, 'wwffPrograms by the prefix before the dash');
select is(pg_temp.snap() -> 'countries' -> 0, '{"code":"US","pota":9,"sota":2,"wwff":1,"dx":0,"rbn":6}'::jsonb, 'countries count WWFF spots');
select is(pg_temp.snap() -> 'topReferences' -> 2, '{"reference":"ONFF-0123","name":"New Name","program":"WWFF","activations":1,"spots":2}'::jsonb,
          'a WWFF reference ranks with the others and takes its most recent name');
select is(pg_temp.snap() -> 'topActivators' -> 1, '{"callsign":"KK4PWJ","base":"KK4PWJ","references":2,"activations":2,"spots":4,"topBand":"20m"}'::jsonb,
          'an activator''s WWFF reference counts with its POTA one');
select is(pg_temp.snap() -> 'topActivators' -> 2, '{"callsign":"ON4ABC","base":"ON4ABC","references":2,"activations":2,"spots":3,"topBand":"20m"}'::jsonb,
          'a WWFF-only activator is ranked like any other');
delete from raw_spots where source = 'wwff';
select ok(rollup_country_day((pg_temp.at_utc(5, 0) at time zone 'utc')::date) and rollup_country_day((pg_temp.at_utc(6, 0) at time zone 'utc')::date),
          'cleanup: country days rolled up again without the WWFF spots');
delete from stats_snapshots where id > (select id from before_wwff);

-- RLS: anyone reads every row (the Stats page is public); nobody writes or refreshes through the API.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is((select count(*) from stats_snapshots), 1::bigint, 'signed-in users can read snapshots');
select throws_ok($$ insert into stats_snapshots (window_start, window_end, payload) values (now(), now(), '{}') $$, '42501', null, 'clients cannot insert snapshots');
select throws_ok('delete from stats_snapshots', '42501', null, 'clients cannot delete snapshots');
select throws_ok('select refresh_stats_snapshot()', '42501', null, 'clients cannot run the refresh');
select throws_ok('select count(*) from rbn_hourly', '42501', null, 'clients cannot read the RBN rollup');
select throws_ok('select rollup_rbn_day(current_date)', '42501', null, 'clients cannot run the RBN rollup');
select throws_ok('select refresh_stats_snapshot_at(now())', '42501', null, 'clients cannot run the refresh at a pinned time');
select throws_ok('select rollup_rbn_hours(now(), now())', '42501', null, 'clients cannot run the RBN hour rollup');
select throws_ok('select count(*) from rbn_rollup_hours', '42501', null, 'clients cannot read the RBN hour markers');
select throws_ok('select count(*) from aprs_daily_stations', '42501', null, 'clients cannot read the APRS rollup');
select throws_ok('select rollup_aprs_day(current_date)', '42501', null, 'clients cannot run the APRS rollup');
reset role;

set local role anon;
select is((select count(*) from stats_snapshots), 1::bigint, 'anon can read snapshots');
select throws_ok($$ insert into stats_snapshots (window_start, window_end, payload) values (now(), now(), '{}') $$, '42501', null, 'anon cannot insert snapshots');
select throws_ok('select refresh_stats_snapshot()', '42501', null, 'anon cannot run the refresh');
select throws_ok('select count(*) from rbn_daily_skimmers', '42501', null, 'anon cannot read the RBN rollup');
select throws_ok('select count(*) from aprs_daily_types', '42501', null, 'anon cannot read the APRS rollup');
reset role;

-- Window boundaries: exactly window_end is out, exactly window_start is in.
insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, frequency_khz, raw_payload)
values ('pota', 'b1', 'b1', pg_temp.at_utc(7, 0), 'XX1OUT', 14062, '{}');
select lives_ok('select pg_temp.refresh()', 'refresh runs after adding a spot at window_end');
select is((pg_temp.snap() #>> '{totals,spots}')::int, 16, 'a spot at exactly 00:00 UTC today is excluded');
insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, frequency_khz, raw_payload)
values ('pota', 'b2', 'b2', pg_temp.at_utc(0, 0), 'XX1IN', 14062, '{}');
select lives_ok('select pg_temp.refresh()', 'refresh runs after adding a spot at window_start');
select is((pg_temp.snap() #>> '{totals,spots}')::int, 17, 'a spot at exactly window_start is included');

-- Pruning. now() is frozen inside this transaction, so the dummies get
-- explicit older generated_at values; the refreshed rows are then the newest.
insert into stats_snapshots (generated_at, window_start, window_end, payload)
select now() - make_interval(mins => i), pg_temp.at_utc(0, 0), pg_temp.at_utc(7, 0), jsonb_build_object('dummy', i)
from generate_series(1, 50) as i;
select is((select count(*) from stats_snapshots), 53::bigint, 'setup: 53 rows before the refresh');
create temp table before_refresh as select max(id) as id from stats_snapshots;

select lives_ok('select pg_temp.refresh()', 'refresh runs with rows to prune');
select is((select count(*) from stats_snapshots), 48::bigint, 'refresh prunes to the 48 most recent rows');
select ok((select id from stats_snapshots order by generated_at desc, id desc limit 1) > (select id from before_refresh),
          'the newest row is the one the refresh just inserted');
select is((select count(*) from stats_snapshots where payload ? 'dummy'), 44::bigint, 'the six oldest dummy rows were deleted');

-- Day 5 was rolled up long after it ended, so a row added now is not picked up. Day 6 looks rolled up
-- five minutes after it ended, inside the relay's buffer time, so it is rolled up again.
insert into rbn_spots (spot_time, received_at, spotter, callsign, frequency_khz, band, mode, mode_family, snr, speed, speed_unit, spot_type, line)
values (pg_temp.at_utc(5, 12), now(), 'VE7CC', 'LATE1', 14025.0, '20m', 'cw', 'cw', 10, 25, 'WPM', 'CQ', 'line'),
       (pg_temp.at_utc(6, 23), now(), 'VE7CC', 'LATE2', 14025.0, '20m', 'cw', 'cw', 10, 25, 'WPM', 'CQ', 'line');
update rbn_rollup_days set rolled_at = pg_temp.at_utc(6, 3) where day = (pg_temp.at_utc(5, 0) at time zone 'utc')::date;
update rbn_rollup_days set rolled_at = pg_temp.at_utc(7, 0) + interval '5 minutes' where day = (pg_temp.at_utc(6, 0) at time zone 'utc')::date;
select lives_ok('select pg_temp.refresh()', 'refresh runs after late RBN rows');
select is((pg_temp.snap() #>> '{rbn,spots}')::int, 8, 'a day rolled up within an hour of its end is rolled up again; a final day is not');
select is((pg_temp.snap() #>> '{hourly,167,rbn}')::int, 2, 'the re-rolled hour shows the late row');
select ok((select rolled_at from rbn_rollup_days where day = (pg_temp.at_utc(5, 0) at time zone 'utc')::date) = pg_temp.at_utc(6, 3),
          'the final day kept its rollup');
select is((select count(*) from rbn_hourly), 168::bigint, 're-rolling a day replaces its hourly rows');
select is(jsonb_array_length(pg_temp.snap() #> '{rbn,topStations}'), 4, 'a rollup recounts the most heard stations (LATE2 joins)');

-- Late APRS packets. Day 5 was rolled up long after it ended, day 6 five minutes after: only day 6 is
-- rolled up again. Packets count straight away either way, through aprs_packet_hours.
select ingest_aprs_packets(jsonb_build_array(
  pg_temp.aprs(pg_temp.at_utc(5, 12), 'LATE1', 'weather', 'W1ABC-10'),
  pg_temp.aprs(pg_temp.at_utc(6, 23), 'LATE2', 'weather', 'W3GHI')));
update aprs_rollup_days set rolled_at = pg_temp.at_utc(6, 3) where day = (pg_temp.at_utc(5, 0) at time zone 'utc')::date;
update aprs_rollup_days set rolled_at = pg_temp.at_utc(7, 0) + interval '5 minutes' where day = (pg_temp.at_utc(6, 0) at time zone 'utc')::date;
select lives_ok('select pg_temp.refresh()', 'refresh runs after late APRS packets');
select is((pg_temp.snap() #>> '{aprs,packets}')::int, 6, 'late packets count at once through aprs_packet_hours');
select is((pg_temp.snap() #>> '{aprs,stations}')::int, 4, 'a day rolled up within an hour of its end is rolled up again (LATE2); a final day is not (LATE1)');
select is((pg_temp.snap() #>> '{aprs,igates}')::int, 3, 'the re-rolled day adds its igate');
select is((select (e ->> 'packets')::int from jsonb_array_elements(pg_temp.snap() #> '{aprs,types}') e where e ->> 'type' = 'weather'), 1,
          'the re-rolled day updates its type counts');

-- The hourly series ends at the last complete hour. At 02:10 UTC today it runs from 02:00 seven days
-- ago through 01:00 today: b1 (00:00) and x1 and an RBN spot (01:00) are in it. Every other figure keeps
-- window_end.
select lives_ok($$select pg_temp.refresh(pg_temp.at_utc(7, 2) + interval '10 minutes')$$, 'refresh runs at 02:10 UTC');
select is(jsonb_array_length(pg_temp.snap() -> 'hourly'), 168, 'the moved hourly series still has 168 entries');
select is(pg_temp.snap() #>> '{hourly,0,hour}', to_char(pg_temp.at_utc(0, 2) at time zone 'utc', 'YYYY-MM-DD"T"HH24":00:00Z"'),
          'hourly starts 168 hours before the last complete hour');
select is(pg_temp.snap() -> 'hourly' -> 166,
          jsonb_build_object('hour', to_char(pg_temp.at_utc(7, 0) at time zone 'utc', 'YYYY-MM-DD"T"HH24":00:00Z"'), 'pota', 1, 'sota', 0, 'wwff', 0, 'rbn', 0, 'aprs', 0, 'dx', 0),
          'hourly includes 00:00 UTC today');
select is(pg_temp.snap() -> 'hourly' -> 167,
          jsonb_build_object('hour', to_char(pg_temp.at_utc(7, 1) at time zone 'utc', 'YYYY-MM-DD"T"HH24":00:00Z"'), 'pota', 1, 'sota', 0, 'wwff', 0, 'rbn', 1, 'aprs', 1, 'dx', 1),
          'hourly ends at 01:00 UTC today, with its RBN spot and APRS packet');
select is((pg_temp.snap() #>> '{totals,spots}')::int, 17, 'totals still end at window_end');
select is((select window_end from stats_snapshots order by generated_at desc, id desc limit 1), pg_temp.at_utc(7, 0),
          'window_end stays 00:00 UTC today');
select is((select count(*) from rbn_rollup_hours), 2::bigint, 'each complete hour of today is counted');
select is((select count(*) from rbn_hourly), 170::bigint, 'today''s hours join the rolled-up days in rbn_hourly');

-- Late rows. Hour 00 looks counted two hours after it ended, so it is final; hour 01 looks counted ten
-- minutes after it ended, inside the relay's buffer time, so it is counted again.
insert into rbn_spots (spot_time, received_at, spotter, callsign, frequency_khz, band, mode, mode_family, snr, speed, speed_unit, spot_type, line)
values (pg_temp.at_utc(7, 0) + interval '20 minutes', now(), 'VE7CC', 'LATE3', 14025.0, '20m', 'cw', 'cw', 10, 25, 'WPM', 'CQ', 'line'),
       (pg_temp.at_utc(7, 1) + interval '30 minutes', now(), 'VE7CC', 'LATE4', 14025.0, '20m', 'cw', 'cw', 10, 25, 'WPM', 'CQ', 'line');
update rbn_rollup_hours set rolled_at = pg_temp.at_utc(7, 2) where hour = pg_temp.at_utc(7, 0);
update rbn_rollup_hours set rolled_at = pg_temp.at_utc(7, 2) + interval '10 minutes' where hour = pg_temp.at_utc(7, 1);
select lives_ok($$select pg_temp.refresh(pg_temp.at_utc(7, 2) + interval '40 minutes')$$, 'refresh runs after late RBN rows in today''s hours');
select is((pg_temp.snap() #>> '{hourly,166,rbn}')::int, 0, 'a final hour is not counted again');
select is((pg_temp.snap() #>> '{hourly,167,rbn}')::int, 2, 'an hour counted within an hour of its end is counted again');

-- At 00:30 UTC tomorrow today is a complete day: its day rollup replaces the hour counts, late rows
-- included, and the hour markers go.
select lives_ok($$select pg_temp.refresh(pg_temp.at_utc(8, 0) + interval '30 minutes')$$, 'refresh runs after today ends');
select is((select count(*) from rbn_rollup_hours), 0::bigint, 'a rolled-up day keeps no hour markers');
select is((pg_temp.snap() #>> '{hourly,144,rbn}')::int, 1, 'the day rollup counts the late row in a final hour');
select is((pg_temp.snap() #>> '{hourly,145,rbn}')::int, 2, 'the day rollup keeps the recounted hour');
select is((select count(*) from rbn_hourly), 168::bigint, 'rbn_hourly holds the seven window days');

-- The cron entry point refreshes at now().
select lives_ok('select refresh_stats_snapshot()', 'refresh_stats_snapshot runs');
select is(pg_temp.snap() #>> '{hourly,167,hour}',
          to_char(date_trunc('hour', now() at time zone 'utc') - interval '1 hour', 'YYYY-MM-DD"T"HH24":00:00Z"'),
          'refresh_stats_snapshot ends the hourly series at the last complete hour before now()');

select * from finish();
rollback;

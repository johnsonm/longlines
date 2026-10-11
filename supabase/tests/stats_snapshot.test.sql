-- pgTAP: stats_snapshots table, refresh_stats_snapshot() payload shape and
-- numbers, window boundaries, pruning to 48 rows, RLS.
begin;
create extension if not exists pgtap with schema extensions;
\ir helpers/users.psql
select plan(77);

-- Start from empty tables so every count below is exact. Both are empty on a
-- fresh CI database; locally the cron jobs may have filled them. deliveries
-- references raw_spots without cascade, so it goes first.
delete from deliveries;
delete from raw_spots;
delete from stats_snapshots;

-- Day k of the window (0 = oldest, 6 = yesterday, 7 = today) at hour h UTC,
-- derived from the current UTC date so the test is stable at any time of day.
-- Arithmetic is on a plain timestamp, exactly as in refresh_stats_snapshot().
create or replace function pg_temp.at_utc(k int, h int) returns timestamptz language sql as $$
  select (date_trunc('day', now() at time zone 'utc') - interval '7 days' + make_interval(days => k, hours => h)) at time zone 'utc';
$$;
create or replace function pg_temp.day_str(k int) returns text language sql as $$
  select to_char(date_trunc('day', now() at time zone 'utc') - interval '7 days' + make_interval(days => k), 'YYYY-MM-DD');
$$;
-- Payload of the newest snapshot.
create or replace function pg_temp.snap() returns jsonb language sql as $$
  select payload from stats_snapshots order by generated_at desc, id desc limit 1;
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
  ('rbn', 'r1', 'r1', pg_temp.at_utc(2, 20), 'RB1N', 'W3LPL', 14035, '20m', 'cw', '12 dB 22 WPM CQ', null, null, null, null, '{}');
-- Ingest stores mode_family from _shared/modes.ts; these rows bypass ingest, so set it the way modes.ts would.
update raw_spots set mode_family = case
  when mode = 'cw'                          then 'cw'
  when mode in ('ssb', 'usb', 'lsb', 'fm')  then 'phone'
  when mode in ('ft8', 'ft4')               then 'digital'
end;

-- Refresh and window.
select lives_ok('select refresh_stats_snapshot()', 'refresh runs');
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
select is(pg_temp.snap() -> 'daily' -> 0, jsonb_build_object('day', pg_temp.day_str(0), 'pota', 0, 'sota', 0), 'daily starts at the oldest day and a day without spots is zero-filled');
select is(pg_temp.snap() -> 'daily' -> 1, jsonb_build_object('day', pg_temp.day_str(1), 'pota', 3, 'sota', 0), 'daily POTA count for day 1');
select is(pg_temp.snap() -> 'daily' -> 6, jsonb_build_object('day', pg_temp.day_str(6), 'pota', 0, 'sota', 4), 'daily ends yesterday with the SOTA count');

-- potaByState: 51 keys; the NC/VA park counts once in each; CA-ON is ignored; "US-NC, US-GA" is trimmed.
select is((select count(*) from jsonb_object_keys(pg_temp.snap() -> 'potaByState')), 51::bigint, 'potaByState has 50 states plus DC');
select is((pg_temp.snap() #>> '{potaByState,NC}')::int, 5, 'NC: three from the NC/VA park plus two from US-NC');
select is((pg_temp.snap() #>> '{potaByState,VA}')::int, 3, 'VA: the NC/VA park counts once in VA as well');
select is((pg_temp.snap() #>> '{potaByState,MA}')::int, 4, 'MA');
select is((pg_temp.snap() #>> '{potaByState,GA}')::int, 1, 'a space after the comma in pota_location is trimmed, not dropped');
select is((pg_temp.snap() #>> '{potaByState,WY}')::int, 0, 'an untouched state is 0 (the out-of-window WY spots do not leak in)');
select is((select sum(value::int) from jsonb_each_text(pg_temp.snap() -> 'potaByState')), 13::bigint, 'non-US locations are ignored');

-- sotaAssociations: prefix before '/', busiest first.
select is(pg_temp.snap() -> 'sotaAssociations', '[{"code":"SP","spots":4},{"code":"W4C","spots":2}]'::jsonb, 'W4C/CM-001 rolls up to association W4C');

-- bands: eleven fixed entries; 70cm and null are excluded here but counted in totals.
select is(jsonb_array_length(pg_temp.snap() -> 'bands'), 11, 'bands has 11 entries');
select is((select string_agg(e ->> 'band', ',' order by ord) from jsonb_array_elements(pg_temp.snap() -> 'bands') with ordinality as t(e, ord)),
          '80m,60m,40m,30m,20m,17m,15m,12m,10m,6m,2m', 'bands are in the fixed order');
select is(pg_temp.snap() -> 'bands' -> 2, '{"band":"40m","pota":3,"sota":5}'::jsonb, '40m split by program');
select is(pg_temp.snap() -> 'bands' -> 4, '{"band":"20m","pota":5,"sota":0}'::jsonb, '20m split by program');
select is((select sum((e ->> 'pota')::int + (e ->> 'sota')::int) from jsonb_array_elements(pg_temp.snap() -> 'bands') e), 14::bigint,
          'the 70cm spot and the null-band spot are excluded from bands (14 of 16 spots)');

-- modes: 6 cw, 4 ssb/usb/lsb, 3 ft8/ft4, 2 fm, 1 null of 16 -> 38+25+19+13+6 = 101, so CW gives one back.
select is(pg_temp.snap() -> 'modes',
          '[{"label":"CW","percent":37},{"label":"SSB","percent":25},{"label":"FT8/FT4","percent":19},{"label":"FM","percent":13},{"label":"Other","percent":6}]'::jsonb,
          'mode buckets, fixed label order, and the rounding remainder taken from the largest bucket');
select is((select sum((e ->> 'percent')::int) from jsonb_array_elements(pg_temp.snap() -> 'modes') e), 100::bigint, 'percents sum to exactly 100');

-- topActivators: references desc, then spots desc, then callsign.
select is(jsonb_array_length(pg_temp.snap() -> 'topActivators'), 6, 'one entry per activator when there are fewer than 8');
select is(pg_temp.snap() -> 'topActivators' -> 0, '{"callsign":"W1AW","references":3,"activations":3,"spots":4,"topBand":"20m"}'::jsonb,
          'most references first; topBand is the band with the most spots (20m x3 over 70cm x1)');
select is((pg_temp.snap() #>> '{topActivators,4,activations}')::int, 2, 'N4DXX has two activations at one reference');
select is(pg_temp.snap() #>> '{topActivators,2,callsign}', 'SQ1GPR/P', 'tie on references is broken by spots desc (4 spots ranks above 3)');
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

-- RLS: anyone reads every row (the Stats page is public); nobody writes or refreshes through the API.
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select is((select count(*) from stats_snapshots), 1::bigint, 'signed-in users can read snapshots');
select throws_ok($$ insert into stats_snapshots (window_start, window_end, payload) values (now(), now(), '{}') $$, '42501', null, 'clients cannot insert snapshots');
select throws_ok('delete from stats_snapshots', '42501', null, 'clients cannot delete snapshots');
select throws_ok('select refresh_stats_snapshot()', '42501', null, 'clients cannot run the refresh');
reset role;

set local role anon;
select is((select count(*) from stats_snapshots), 1::bigint, 'anon can read snapshots');
select throws_ok($$ insert into stats_snapshots (window_start, window_end, payload) values (now(), now(), '{}') $$, '42501', null, 'anon cannot insert snapshots');
select throws_ok('select refresh_stats_snapshot()', '42501', null, 'anon cannot run the refresh');
reset role;

-- Window boundaries: exactly window_end is out, exactly window_start is in.
insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, frequency_khz, raw_payload)
values ('pota', 'b1', 'b1', pg_temp.at_utc(7, 0), 'XX1OUT', 14062, '{}');
select lives_ok('select refresh_stats_snapshot()', 'refresh runs after adding a spot at window_end');
select is((pg_temp.snap() #>> '{totals,spots}')::int, 16, 'a spot at exactly 00:00 UTC today is excluded');
insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, frequency_khz, raw_payload)
values ('pota', 'b2', 'b2', pg_temp.at_utc(0, 0), 'XX1IN', 14062, '{}');
select lives_ok('select refresh_stats_snapshot()', 'refresh runs after adding a spot at window_start');
select is((pg_temp.snap() #>> '{totals,spots}')::int, 17, 'a spot at exactly window_start is included');

-- Pruning. now() is frozen inside this transaction, so the dummies get
-- explicit older generated_at values; the refreshed rows are then the newest.
insert into stats_snapshots (generated_at, window_start, window_end, payload)
select now() - make_interval(mins => i), pg_temp.at_utc(0, 0), pg_temp.at_utc(7, 0), jsonb_build_object('dummy', i)
from generate_series(1, 50) as i;
select is((select count(*) from stats_snapshots), 53::bigint, 'setup: 53 rows before the refresh');
create temp table before_refresh as select max(id) as id from stats_snapshots;

select lives_ok('select refresh_stats_snapshot()', 'refresh runs with rows to prune');
select is((select count(*) from stats_snapshots), 48::bigint, 'refresh prunes to the 48 most recent rows');
select ok((select id from stats_snapshots order by generated_at desc, id desc limit 1) > (select id from before_refresh),
          'the newest row is the one the refresh just inserted');
select is((select count(*) from stats_snapshots where payload ? 'dummy'), 44::bigint, 'the six oldest dummy rows were deleted');

select * from finish();
rollback;

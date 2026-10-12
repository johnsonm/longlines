-- pgTAP: spot_stream and the callsign rollups (20261012000040).
begin;
create extension if not exists pgtap with schema extensions;
select plan(46);

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
                                       p_mode text, p_family text, p_snr int) returns jsonb language sql as $$
  select jsonb_build_object(
    'spot_time', p_time, 'received_at', p_time, 'spotter', p_spotter, 'callsign', p_call,
    'frequency_khz', p_khz, 'band', p_band, 'mode', p_mode, 'mode_family', p_family, 'snr', p_snr,
    'speed', 22, 'speed_unit', 'WPM', 'spot_type', 'CQ', 'line', 'x');
$$;
create or replace function pg_temp.heard(p_base text, p_source text, p_band text, p_bucket text)
returns callsign_activity language sql as $$
  select * from callsign_activity
  where base = p_base and role = 'heard' and source = p_source and band = p_band and mode_bucket = p_bucket;
$$;

delete from raw_spots;
delete from rbn_spots;
delete from callsign_activity;
delete from callsign_reach;
delete from callsign_references;
delete from callsign_seen;
delete from callsign_variants;
delete from callsign_rollup_days;

select load_cty('test',
  '[{"prefix":"K","name":"United States","continent":"NA","cq_zone":5,"itu_zone":8,"lat":37.6,"lon":-91.87},
    {"prefix":"G","name":"England","continent":"EU","cq_zone":14,"itu_zone":27,"lat":52.77,"lon":-1.47},
    {"prefix":"SM","name":"Sweden","continent":"EU","cq_zone":14,"itu_zone":18,"lat":61.2,"lon":14.57},
    {"prefix":"DL","name":"Fed. Rep. of Germany","continent":"EU","cq_zone":14,"itu_zone":28,"lat":51.0,"lon":10.0}]',
  '[{"pattern":"K","exact":false,"entity":"K","continent":"NA","cq_zone":5,"itu_zone":8},
    {"pattern":"W","exact":false,"entity":"K","continent":"NA","cq_zone":5,"itu_zone":8},
    {"pattern":"G","exact":false,"entity":"G","continent":"EU","cq_zone":14,"itu_zone":27},
    {"pattern":"SM","exact":false,"entity":"SM","continent":"EU","cq_zone":14,"itu_zone":18},
    {"pattern":"DL","exact":false,"entity":"DL","continent":"EU","cq_zone":14,"itu_zone":28}]');

-- Day -4: KK4PWJ activates a park (a self-spot and a chaser), a summit as W4/KK4PWJ, is heard by two
-- skimmers, and spots W1AW on DX Cluster. raw_spots also holds an RBN copy, which the stream skips.
select pg_temp.raw('pota', 'r1', pg_temp.at(-4, '10:05:00'), 'KK4PWJ/P', 'KK4PWJ', 14062, '20m', 'cw', 'cw',
                   'K-0817', 'Old Name', 'US-NC');
select pg_temp.raw('pota', 'r2', pg_temp.at(-4, '10:20:00'), 'KK4PWJ/P', 'W1AW', 14062.5, '20m', 'cw', 'cw',
                   'K-0817', 'Old Name', 'US-NC');
select pg_temp.raw('sotawatch', 'r3', pg_temp.at(-4, '14:00:00'), 'W4/KK4PWJ', 'G4OBK', 7032, '40m', 'cw', 'cw',
                   p_sota => 'W4C/CM-001');
select pg_temp.raw('rbn', 'r4', pg_temp.at(-4, '11:00:00'), 'KK4PWJ', 'SM1HEV', 14035, '20m', 'cw', 'cw');
select pg_temp.raw('dxcluster', 'r5', pg_temp.at(-4, '12:00:00'), 'W1AW', 'KK4PWJ', 14250, '20m', 'ssb', 'phone');
select ingest_rbn_spots(jsonb_build_array(
  pg_temp.rbn(pg_temp.at(-4, '11:00:00'), 'KK4PWJ', 'SM1HEV', 14035, '20m', 'cw', 'cw', 12),
  pg_temp.rbn(pg_temp.at(-4, '11:30:00'), 'KK4PWJ', 'DL1ABC', 14035.5, '20m', 'cw', 'cw', 20),
  pg_temp.rbn(pg_temp.at(-4, '23:59:59'), 'KK4PWJ', 'SM1HEV', 7030, '40m', 'rtty', 'digital', 9),
  -- Day -2 and today.
  pg_temp.rbn(pg_temp.at(-2, '08:00:00'), 'KK4PWJ', 'SM1HEV', 14036, '20m', 'cw', 'cw', 15),
  pg_temp.rbn(pg_temp.at(0, '00:00:01'), 'KK4PWJ', 'SM1HEV', 14036, '20m', 'cw', 'cw', 15)));
-- Day -2: a POTA spot under the bare call; the park has a new name.
select pg_temp.raw('pota', 'r6', pg_temp.at(-2, '09:00:00'), 'KK4PWJ', 'W1AW', 14063, '20m', 'ssb', 'phone',
                   'K-0817', 'New Name', 'US-NC');

-- mode_bucket and int_array_add.
select is(array[mode_bucket('cw', 'cw'), mode_bucket('usb', 'phone'), mode_bucket('ft4', 'digital'),
                mode_bucket('fm', 'phone'), mode_bucket('am', 'phone'), mode_bucket('rtty', 'digital'),
                mode_bucket(null, null)],
  array['CW', 'SSB', 'FT8/FT4', 'FM', 'Other', 'Other', 'Other'], 'mode_bucket: the Stats page''s five buckets');
select is(int_array_add(array[1, 2, 3], array[10, 20, 30]), array[11, 22, 33], 'int_array_add adds elementwise');
select is(int_array_add(null, array[1, 2]), array[1, 2], 'int_array_add treats null as empty');

-- spot_stream.
select is((select count(*) from spot_stream where spot_time < pg_temp.at(-3, '00:00:00'))::int, 7,
  'spot_stream has every source''s rows for the day');
select is((select count(*) from spot_stream where source = 'rbn' and spot_time < pg_temp.at(-3, '00:00:00'))::int, 3,
  'RBN rows come from rbn_spots, not the raw_spots copies');
select is((select (program, reference, reference_name, reference_location, base_callsign, spotter_base)::text
           from spot_stream where source = 'pota' and spotter = 'W1AW' and callsign = 'KK4PWJ/P'),
  '(POTA,K-0817,"Old Name",US-NC,KK4PWJ,W1AW)', 'a POTA row carries its park as the reference');
select is((select (program, reference, reference_name)::text from spot_stream where source = 'sotawatch'),
  '(SOTA,W4C/CM-001,)', 'a SOTA row carries its summit');
select is((select (snr, base_callsign, mode_bucket)::text from spot_stream
           where source = 'rbn' and spotter = 'DL1ABC'), '(20,KK4PWJ,CW)', 'an RBN row carries its SNR');

-- The first backfill call rolls up the oldest day only.
select is((select array_agg((rollup_day, spots, error)::text) from backfill_callsign_rollups(1)),
  array[format('(%s,7,)', pg_temp.d(-4))], 'backfill_callsign_rollups(1) rolls up the oldest unrolled day');
select ok(exists (select 1 from callsign_rollup_days where day = pg_temp.d(-4)), 'the day gets its marker');

select is((select (spots, hours[11])::text from pg_temp.heard('KK4PWJ', 'pota', '20m', 'CW')), '(2,2)',
  'heard: POTA spots of every variant under the base call, by UTC hour (10:00 is hours[11])');
select is((select spots from pg_temp.heard('KK4PWJ', 'rbn', '20m', 'CW')), 2, 'heard: RBN spots');
select is((select (spots, hours[24])::text from pg_temp.heard('KK4PWJ', 'rbn', '40m', 'Other')), '(1,1)',
  'heard: RTTY is Other, 23:59 is the last hour');
select is((select spots from pg_temp.heard('KK4PWJ', 'sotawatch', '40m', 'CW')), 1, 'heard: SOTA spots');
select is((select sum(spots) from callsign_activity where base = 'KK4PWJ' and role = 'heard')::int, 6,
  'heard: the RBN copy in raw_spots is not counted twice');
select is((select array_agg((source, band, mode_bucket, spots)::text order by source)
           from callsign_activity where base = 'KK4PWJ' and role = 'spotter'),
  array['(dxcluster,20m,SSB,1)'], 'spotter: what the station posted for others, without its self-spot');
select is((select array_agg((base, source, spots)::text order by base, source, band)
           from callsign_activity where role = 'spotter' and base <> 'KK4PWJ'),
  array['(DL1ABC,rbn,1)', '(G4OBK,sotawatch,1)', '(SM1HEV,rbn,1)', '(SM1HEV,rbn,1)', '(W1AW,pota,1)'],
  'spotter: chasers and skimmers by base call');
select ok((select bool_and(cardinality(hours) = 24 and spots = (select sum(h) from unnest(hours) h))
           from callsign_activity), 'every hours array has 24 entries summing to its spots');

select is((select array_agg((source, country, continent, spots)::text order by source, country)
           from callsign_reach where base = 'KK4PWJ'),
  array['(pota,"United States",NA,1)', '(rbn,"Fed. Rep. of Germany",EU,1)', '(rbn,Sweden,EU,2)',
        '(sotawatch,England,EU,1)'],
  'reach: spotter countries, without the self-spot');

select is((select array_agg((program, reference, name, location, days, spots, first_day = last_day)::text
                            order by program)
           from callsign_references where base = 'KK4PWJ'),
  array['(POTA,K-0817,"Old Name",US-NC,1,2,t)', '(SOTA,W4C/CM-001,,,1,1,t)'], 'references: parks and summits');
select is((select (first_spot = pg_temp.at(-4, '10:05:00'), last_spot = pg_temp.at(-4, '23:59:59'),
                   last_frequency_khz, last_mode, days_on_air)::text
           from callsign_seen where base = 'KK4PWJ'), '(t,t,7030.000,rtty,1)',
  'seen: first and last spot, the last one''s frequency and mode');
select is((select array_agg((callsign, spots)::text order by callsign) from callsign_variants where base = 'KK4PWJ'),
  array['(KK4PWJ,3)', '(KK4PWJ/P,2)', '(W4/KK4PWJ,1)'], 'variants: each spelling under the base call');

-- Exactly once.
select ok(rollup_callsign_day(pg_temp.d(-4)) is null, 'a day already rolled up returns null');
select is((select sum(spots) from callsign_activity where base = 'KK4PWJ' and role = 'heard')::int, 6,
  'and counts nothing twice');
select throws_ok(format('select rollup_callsign_day(%L)', pg_temp.d(0)), 'P0001', null, 'today is not rolled up');

-- The hourly job: at most two days a run. Day -3 is made to fail (a clashing activity row): it
-- reports the error, stays unrolled and does not use up the run's limit, so day -2 still rolls up.
select ingest_rbn_spots(jsonb_build_array(
  pg_temp.rbn(pg_temp.at(-3, '12:00:00'), 'N0FAIL', 'SM1HEV', 14036, '20m', 'cw', 'cw', 15)));
insert into callsign_activity (period, grain, base, role, source, band, mode_bucket, spots, hours)
values (pg_temp.d(-3), 'day', 'N0FAIL', 'heard', 'rbn', '20m', 'CW', 1, array_fill(0, array[24]));
select ok(exists (select 1 from cron.job where jobname = 'rollup-callsign-days' and schedule = '25 * * * *'),
  'the rollups run hourly');
select is((select array_agg((rollup_day, spots, error is not null)::text order by rollup_day)
           from backfill_callsign_rollups(1)),
  array[format('(%s,,t)', pg_temp.d(-3)), format('(%s,2,f)', pg_temp.d(-2))],
  'a failing day is reported and does not use up the run''s limit');
select is(array(select day from callsign_rollup_days order by day), array[pg_temp.d(-4), pg_temp.d(-2)],
  'the failed day stays unrolled, today is never rolled up');
delete from callsign_activity where base = 'N0FAIL';
select is((select array_agg((rollup_day, spots)::text) from backfill_callsign_rollups(1)),
  array[format('(%s,1)', pg_temp.d(-3))], 'and rolls it up once the problem is gone');
-- Yesterday (no spots) becomes eligible two hours after midnight, so it may or may not be rolled here.
select is((select count(*) from backfill_callsign_rollups() where spots <> 0 or error is not null)::int, 0,
  'nothing with spots is left to roll up');

select is((select (name, days, spots, first_day = pg_temp.d(-4), last_day = pg_temp.d(-2))::text
           from callsign_references where base = 'KK4PWJ' and reference = 'K-0817'),
  '("New Name",2,3,t,t)', 'references: days and spots add up, the latest name wins');
select is((select (last_spot = pg_temp.at(-2, '09:00:00'), last_frequency_khz, last_mode, days_on_air)::text
           from callsign_seen where base = 'KK4PWJ'), '(t,14063.000,ssb,2)',
  'seen: a later day moves the last spot and adds a day on the air');
select is((select (spots, last_day = pg_temp.d(-2))::text from callsign_variants
           where base = 'KK4PWJ' and callsign = 'KK4PWJ'), '(5,t)', 'variants: spots add up');
select is((select sum(spots) from callsign_activity where base = 'KK4PWJ' and role = 'heard')::int, 8,
  'activity: today''s spot is not in the rollups');

-- Compaction: day rows older than 35 days fold into month rows, adding to one already there.
insert into callsign_activity (period, grain, base, role, source, band, mode_bucket, spots, hours)
select date_trunc('month', pg_temp.d(-70))::date + o, 'day', 'K1OLD', 'heard', 'pota', null, 'CW', 2,
       array_fill(0, array[o]) || 2 || array_fill(0, array[23 - o])
from generate_series(1, 2) as o
union all
select date_trunc('month', pg_temp.d(-70))::date, 'month', 'K1OLD', 'heard', 'pota', null, 'CW', 5,
       array_fill(1, array[5]) || array_fill(0, array[19]);
insert into callsign_reach (period, grain, base, source, country, continent, spots)
select date_trunc('month', pg_temp.d(-70))::date + o, 'day', 'K1OLD', 'pota', 'England', 'EU', 3
from generate_series(1, 2) as o;
select lives_ok('select compact_callsign_rollups()', 'compact_callsign_rollups runs');
select is((select array_agg((grain, spots, hours[1:4])::text) from callsign_activity where base = 'K1OLD'),
  array['(month,9,"{1,3,3,1}")'], 'activity: old day rows become one month row, hours added up');
select is((select array_agg((grain, spots)::text) from callsign_reach where base = 'K1OLD'),
  array['(month,6)'], 'reach: old day rows become one month row');
select is((select count(*) from callsign_activity where grain = 'day' and period = pg_temp.d(-4))::int,
  (select count(*) from callsign_activity where period = pg_temp.d(-4))::int, 'recent day rows are kept');

-- Refusals: a day whose RBN spots were retired, and any day without cty.dat.
select pg_temp.raw('pota', 'r7', pg_temp.at(-20, '10:00:00'), 'K1GONE', 'W1AW', 14062, '20m', 'cw', 'cw');
select log_archive('rbn', pg_temp.at(-20, '10:00:00'), pg_temp.at(-20, '10:10:00'), 5, 100, 'rbn/test');
select throws_like(format('select rollup_callsign_day(%L)', pg_temp.d(-20)), '%RBN spots%were retired%',
  'a day whose RBN spots were archived and retired is refused');
select is(rollup_callsign_day(pg_temp.d(-20), true), 1::bigint, 'unless the operator accepts the gap');
delete from cty_prefixes;
delete from cty_entities;
delete from cty_load;
select pg_temp.raw('pota', 'r8', pg_temp.at(-21, '10:00:00'), 'K1NOCTY', 'W1AW', 14062, '20m', 'cw', 'cw');
select throws_like(format('select rollup_callsign_day(%L)', pg_temp.d(-21)), '%no cty.dat%',
  'a day is refused while no cty.dat is loaded');
select ok(not exists (select 1 from callsign_rollup_days where day = pg_temp.d(-21)), 'and keeps no marker');

-- Access.
select ok(not has_table_privilege('authenticated', 'spot_stream', 'select')
          and not has_table_privilege('anon', 'spot_stream', 'select'), 'clients cannot read spot_stream');
select ok(not exists (
  select 1 from unnest(array['callsign_activity', 'callsign_reach', 'callsign_references', 'callsign_seen',
                             'callsign_variants']) as t
  where has_table_privilege('authenticated', t, 'select') or has_table_privilege('anon', t, 'select')),
  'clients cannot read the rollup tables');
select ok(not has_function_privilege('authenticated', 'public.rollup_callsign_day(date, boolean)', 'execute')
          and not has_function_privilege('authenticated', 'public.backfill_callsign_rollups(int)', 'execute')
          and not has_function_privilege('authenticated', 'public.compact_callsign_rollups()', 'execute')
          and not has_function_privilege('anon', 'public.mode_bucket(text, text)', 'execute'),
  'clients cannot run the rollup functions');
set local role service_role;
select is((select count(*) from spot_stream where source = 'rbn')::int, 6, 'the service role reads spot_stream');
reset role;

select * from finish();
rollback;

-- pgTAP: spot_stream and the callsign rollups (20261012000040), callsign_days and the roll-up
-- status (20261019000200).
begin;
create extension if not exists pgtap with schema extensions;
select plan(90);

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
-- A heard day row as the roll-up would have written it, for days made up by hand.
create or replace function pg_temp.activity(p_day date, p_base text, p_source text, p_band text, p_bucket text,
                                            p_spots int) returns void language sql as $$
  insert into callsign_activity (period, grain, base, role, source, band, mode_bucket, spots, hours)
  values (p_day, 'day', p_base, 'heard', p_source, p_band, p_bucket, p_spots,
          array_fill(0, array[12]) || p_spots || array_fill(0, array[11]));
$$;
-- A day relative to the first of day -70's month: old enough for compaction, before every other day
-- here. Negative offsets fall in the month before, which keeps their month rows apart from K1OLD's.
create or replace function pg_temp.old_day(p_offset int) returns date language sql as $$
  select date_trunc('month', pg_temp.d(-70))::date + p_offset;
$$;
create or replace function pg_temp.old_at(p_offset int, p_hms text) returns timestamptz language sql as $$
  select ((pg_temp.old_day(p_offset))::text || ' ' || p_hms || '+00')::timestamptz;
$$;

delete from raw_spots;
delete from rbn_spots;
delete from callsign_activity;
delete from callsign_reach;
delete from callsign_references;
delete from callsign_seen;
delete from callsign_variants;
delete from callsign_rollup_days;
delete from callsign_days;
delete from callsign_rollup_failures;
-- rollup_callsign_day and the status view read the archive's counts.
delete from archive_log;

-- first_rollup_day: null with no spots; with RBN rows alone (no marker, no raw_spots) it falls back to
-- a spot_stream scan; once there is a raw spot or a marker it takes the earlier of the two.
select is(first_rollup_day(), null::date, 'first_rollup_day: null while there are no spots');
select ingest_rbn_spots(jsonb_build_array(
  pg_temp.rbn(pg_temp.at(-6, '12:00:00'), 'K1ONLY', 'SM1HEV', 14035, '20m', 'cw', 'cw', 10)));
select is(first_rollup_day(), pg_temp.d(-6), 'first_rollup_day: with RBN rows alone, the first spot_stream row');
delete from rbn_spots;

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

-- The first backfill call rolls up the oldest day only, from the first raw spot (no marker yet).
select is(first_rollup_day(), pg_temp.d(-4), 'first_rollup_day: the first raw spot while no day is rolled up');
select is((select array_agg((rollup_day, spots, error)::text) from backfill_callsign_rollups(1)),
  array[format('(%s,7,)', pg_temp.d(-4))], 'backfill_callsign_rollups(1) rolls up the oldest unrolled day');
select ok(exists (select 1 from callsign_rollup_days where day = pg_temp.d(-4)), 'the day gets its marker');
-- callsign_days: the stations heard that day, one row per source. The spotters (SM1HEV, DL1ABC, G4OBK,
-- W1AW as a chaser) get none; W1AW's row is the DX Cluster spot of it.
select is((select array_agg((base, source, spots)::text order by base, source) from callsign_days where day = pg_temp.d(-4)),
  array['(KK4PWJ,pota,2)', '(KK4PWJ,rbn,3)', '(KK4PWJ,sotawatch,1)', '(W1AW,dxcluster,1)'],
  'callsign_days: one row per heard station and source, none for spotters');
select is((select array_agg((source, modes, bands)::text order by source) from callsign_days
           where base = 'KK4PWJ' and day = pg_temp.d(-4)),
  array['(pota,{cw},{20m})', '(rbn,"{cw,rtty}","{20m,40m}")', '(sotawatch,{cw},{40m})'],
  'callsign_days: the distinct canonical modes and bands, sorted');
select is((select (spots, without_rbn, days_filled_at is not null)::text from callsign_rollup_days where day = pg_temp.d(-4)),
  '(7,f,t)', 'the marker records the count, that RBN was present, and the callsign_days fill');
select is((select status from callsign_rollup_status where day = pg_temp.d(-4)), 'done', 'the status view says done');

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
select is((select (count(*), sum(spots))::text from callsign_days where day = pg_temp.d(-4)), '(4,7)',
  'callsign_days is unchanged too');
select throws_ok(format('select rollup_callsign_day(%L)', pg_temp.d(0)), 'P0001', null, 'today is not rolled up');

-- A POTA re-poll returns the same spot (same id, same hash): the unique key keeps the second copy
-- out, so day -2 counts it once (asserted once the day rolls up below).
insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, spotter, frequency_khz, band, mode,
                       mode_family, comment, pota_reference, pota_park_name, pota_location, raw_payload)
values ('pota', 'r6', 'r6', pg_temp.at(-2, '09:00:00'), 'KK4PWJ', 'W1AW', 14063, '20m', 'ssb', 'phone', '', 'K-0817',
        'New Name', 'US-NC', '{}')
on conflict (source, source_spot_id, content_hash) do nothing;
select is((select count(*) from raw_spots where source = 'pota' and source_spot_id = 'r6')::int, 1,
  'a re-polled spot is stored once');

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
select is((select (attempts, first_failed_at = last_failed_at, last_error like '%duplicate key%')::text
           from callsign_rollup_failures where day = pg_temp.d(-3)), '(1,t,t)',
  'the failed day is recorded in callsign_rollup_failures with its error');
-- The next run fails it again. Yesterday (no spots) may roll up here too.
select count(*) from backfill_callsign_rollups(1);
select is((select (status, attempts, last_error is not null)::text from callsign_rollup_status where day = pg_temp.d(-3)),
  '(failed,2,t)', 'the status view shows the failure and counts the attempts');
delete from callsign_activity where base = 'N0FAIL';
select is((select array_agg((rollup_day, spots)::text) from backfill_callsign_rollups(1)),
  array[format('(%s,1)', pg_temp.d(-3))], 'and rolls it up once the problem is gone');
select is((select (status, attempts)::text from callsign_rollup_status where day = pg_temp.d(-3)), '(done,)',
  'success removes the failures row; the status is done');
select is((select spots from callsign_days where base = 'KK4PWJ' and day = pg_temp.d(-2) and source = 'pota'), 1,
  'callsign_days: the re-polled POTA spot counts once');
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

-- callsign_days for days rolled up before it existed: a marker without days_filled_at and
-- callsign_activity rows, nothing in callsign_days. Every source but RBN is filled from spot_stream.
-- Day -8 still has its spots, so its RBN row (none) is exact too. Day -9's roll-up counted five RBN
-- spots that the archive logged and retention has since retired (rbn_day_retired), so its RBN row
-- comes from callsign_activity instead: spots and bands exact, modes only where the bucket is CW.
select pg_temp.raw('pota', 'f1', pg_temp.at(-8, '10:00:00'), 'K1FILL/P', 'W1AW', 14062, '20m', 'cw', 'cw',
                   'K-0001', 'Fill Park', 'US-ME');
select pg_temp.raw('pota', 'f2', pg_temp.at(-8, '11:00:00'), 'K1FILL', 'W1AW', 7185, '40m', 'ssb', 'phone',
                   'K-0001', 'Fill Park', 'US-ME');
select pg_temp.raw('dxcluster', 'f3', pg_temp.at(-8, '12:00:00'), 'K1FILL', 'G4OBK', 14074, '20m', 'ft8', 'digital');
select pg_temp.activity(pg_temp.d(-8), 'K1FILL', 'pota', '20m', 'CW', 1);
select pg_temp.activity(pg_temp.d(-8), 'K1FILL', 'pota', '40m', 'SSB', 1);
select pg_temp.activity(pg_temp.d(-8), 'K1FILL', 'dxcluster', '20m', 'FT8/FT4', 1);
select pg_temp.raw('pota', 'f4', pg_temp.at(-9, '10:00:00'), 'K1RET', 'W1AW', 14285, '20m', 'ssb', 'phone',
                   'K-0002', 'Gone Park', 'US-ME');
select pg_temp.activity(pg_temp.d(-9), 'K1RET', 'pota', '20m', 'SSB', 1);
select pg_temp.activity(pg_temp.d(-9), 'K1RET', 'rbn', '20m', 'CW', 3);
select pg_temp.activity(pg_temp.d(-9), 'K1RET', 'rbn', '20m', 'FT8/FT4', 1);
select pg_temp.activity(pg_temp.d(-9), 'K1RET', 'rbn', '40m', 'Other', 1);
select log_archive('rbn', pg_temp.at(-9, '10:00:00'), pg_temp.at(-9, '10:10:00'), 5, 100, 'rbn/test');
insert into callsign_rollup_days (day, rolled_at) values (pg_temp.d(-9), now()), (pg_temp.d(-8), now());
select is((select array_agg((fill_day, spots, exact, error)::text) from backfill_callsign_days(1)),
  array[format('(%s,6,f,)', pg_temp.d(-9))],
  'backfill_callsign_days(1) fills the oldest unfilled day; RBN retired, so 1 fresh + 5 from callsign_activity');
select is((select array_agg((fill_day, spots, exact, error)::text) from backfill_callsign_days()),
  array[format('(%s,3,t,)', pg_temp.d(-8))], 'the next run fills the rest, exactly while every row is there');
select is((select array_agg((source, spots, modes, bands)::text order by source) from callsign_days where base = 'K1FILL'),
  array['(dxcluster,1,{ft8},{20m})', '(pota,2,"{cw,ssb}","{20m,40m}")'], 'an exact fill is spot_stream''s rows');
select is((select array_agg((source, spots, modes, bands)::text order by source) from callsign_days where base = 'K1RET'),
  array['(pota,1,{ssb},{20m})', '(rbn,5,{cw},"{20m,40m}")'],
  'an approximate RBN row: spots and bands from callsign_activity, only the CW bucket names a mode');
select is((select array_agg((spots, days_filled_at is not null)::text order by day) from callsign_rollup_days
           where day in (pg_temp.d(-9), pg_temp.d(-8))), array['(6,t)', '(3,t)'],
  'the fill records what the roll-up counted and that the day is filled');
select is((select count(*) from backfill_callsign_days())::int, 0, 'a day already filled is skipped');
select is((select count(*) from fill_callsign_days(pg_temp.d(-7)))::int, 0, 'a day without a marker is not filled');

-- WWFF is the third program: a WWFF spot rolls up as a reference with its name and no location. Its
-- day (-10) precedes the first marker (-9), so first_rollup_day() is the first raw spot and the hourly
-- job still reaches it (scripts/smoke-test.sql relies on that). A callsign_days row already there (a
-- day rebuilt from the archive before it was marked) wins over the roll-up's.
insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, spotter, frequency_khz, band, mode,
                       mode_family, comment, wwff_reference, wwff_reference_name, raw_payload)
values ('wwff', 'w1', 'w1', pg_temp.at(-10, '10:00:00'), 'K1WWF/P', 'W1AW', 14244, '20m', 'ssb', 'phone', '',
        'KFF-1234', 'Falls Lake', '{}');
select is((select (program, reference, reference_name, reference_location)::text from spot_stream where source = 'wwff'),
  '(WWFF,KFF-1234,"Falls Lake",)', 'a WWFF row carries its reference and name');
select is(first_rollup_day(), pg_temp.d(-10), 'first_rollup_day: the first raw spot when it precedes the first marker');
insert into callsign_days (base, day, source, spots, modes, bands)
values ('K1WWF', pg_temp.d(-10), 'wwff', 99, '{am}', '{160m}');
select is((select array_agg((rollup_day, spots, error)::text) from backfill_callsign_rollups(1)),
  array[format('(%s,1,)', pg_temp.d(-10))], 'backfill_callsign_rollups rolls up a day before the first marker');
select is((select (c.spots, c.modes, c.bands, r.spots)::text from callsign_days c
           join callsign_rollup_days r on r.day = c.day where c.base = 'K1WWF' and c.source = 'wwff'),
  '(99,{am},{160m},1)', 'callsign_days: a row already there is kept; the marker still counts the pass');
select is((select array_agg((program, reference, name, location, days, spots)::text)
           from callsign_references where base = 'K1WWF'),
  array['(WWFF,KFF-1234,"Falls Lake",,1,1)'], 'references: a WWFF reference under its program');

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
-- K1WAIT's day is marked but not filled into callsign_days yet, so its day rows have to wait.
insert into callsign_activity (period, grain, base, role, source, band, mode_bucket, spots, hours)
values (pg_temp.old_day(3), 'day', 'K1WAIT', 'heard', 'rbn', '20m', 'CW', 4,
        array_fill(0, array[10]) || 4 || array_fill(0, array[13]));
insert into callsign_rollup_days (day, rolled_at) values (pg_temp.old_day(3), now());
create temp table days_before as select * from callsign_days;
select lives_ok('select compact_callsign_rollups()', 'compact_callsign_rollups runs');
select is((select array_agg((grain, spots, hours[1:4])::text) from callsign_activity where base = 'K1OLD'),
  array['(month,9,"{1,3,3,1}")'], 'activity: old day rows become one month row, hours added up');
select is((select array_agg((grain, spots)::text) from callsign_reach where base = 'K1OLD'),
  array['(month,6)'], 'reach: old day rows become one month row');
select is((select count(*) from callsign_activity where grain = 'day' and period = pg_temp.d(-4))::int,
  (select count(*) from callsign_activity where period = pg_temp.d(-4))::int, 'recent day rows are kept');
select is((select array_agg((grain, spots)::text) from callsign_activity where base = 'K1WAIT'), array['(day,4)'],
  'a day not yet filled into callsign_days keeps its day rows');
update callsign_rollup_days set days_filled_at = now() where day = pg_temp.old_day(3);
select compact_callsign_rollups();
select is((select array_agg((grain, spots)::text) from callsign_activity where base = 'K1WAIT'), array['(month,4)'],
  'and folds once it is filled');
select results_eq('select * from callsign_days order by base, day, source',
                  'select * from days_before order by base, day, source', 'compaction never touches callsign_days');

-- Retired days: rbn_day_retired is "a slice of the day is logged with more RBN rows than the database
-- holds". Day -20's archive has five rows and the database none; day -7 has no archive; day -4's
-- archive matches its three rows.
select pg_temp.raw('pota', 'r7', pg_temp.at(-20, '10:00:00'), 'K1GONE', 'W1AW', 14062, '20m', 'cw', 'cw');
select log_archive('rbn', pg_temp.at(-20, '10:00:00'), pg_temp.at(-20, '10:10:00'), 5, 100, 'rbn/test');
-- One slice per row, as the archive logs them: retired is decided per slice.
select log_archive('rbn', pg_temp.at(-4, '11:00:00'), pg_temp.at(-4, '11:10:00'), 1, 100, 'rbn/test');
select log_archive('rbn', pg_temp.at(-4, '11:30:00'), pg_temp.at(-4, '11:40:00'), 1, 100, 'rbn/test');
select log_archive('rbn', pg_temp.at(-4, '23:50:00'), pg_temp.at(-3, '00:00:00'), 1, 100, 'rbn/test');
select is((rbn_day_archived_rows(pg_temp.d(-20)), rbn_day_retired(pg_temp.d(-20)))::text, '(5,t)',
  'a day whose archive holds RBN rows the database lacks is retired');
select is((rbn_day_archived_rows(pg_temp.d(-7)), rbn_day_retired(pg_temp.d(-7)))::text, '(0,f)',
  'a day the archive has nothing for is not retired');
select is((rbn_day_archived_rows(pg_temp.d(-4)), rbn_day_retired(pg_temp.d(-4)))::text, '(3,f)',
  'a day whose archive matches the database is not retired');

-- Refusals: a day whose RBN spots were retired, and any day without cty.dat. The hourly job records
-- the refusal as a failure every run; the status view still says rbn_retired. (The view starts at
-- first_rollup_day(), K1WAIT's old day here, so day -20 is inside its range.)
select throws_like(format('select rollup_callsign_day(%L)', pg_temp.d(-20)), '%RBN spots%were retired%',
  'a day whose RBN spots were archived and retired is refused');
select record_callsign_rollup_failure(pg_temp.d(-20), 'rollup_callsign_day: the RBN spots were retired');
select is((select (status, attempts)::text from callsign_rollup_status where day = pg_temp.d(-20)), '(rbn_retired,1)',
  'a retired day is rbn_retired even with a failures row');
select is(rollup_callsign_day(pg_temp.d(-20), true), 1::bigint, 'unless the operator accepts the gap');
select ok(not exists (select 1 from callsign_rollup_failures where day = pg_temp.d(-20)),
  'rollup_callsign_day itself removes the failures row, by hand too');
-- without_rbn: the roll-up counted no RBN spots and the archive holds five.
select is((select (s.status, r.without_rbn, r.spots)::text from callsign_rollup_status s
           join callsign_rollup_days r on r.day = s.day where s.day = pg_temp.d(-20)), '(done_without_rbn,t,1)',
  'and the marker and the view say it was rolled up without RBN');
-- A late RBN line of the retired day lands in the default partition; the archive still has more.
select ingest_rbn_spots(jsonb_build_array(
  pg_temp.rbn(pg_temp.at(-20, '10:05:00'), 'K1GONE', 'SM1HEV', 14035, '20m', 'cw', 'cw', 10)));
select is(rbn_day_retired(pg_temp.d(-20)), true, 'a retired day with a late RBN line is still retired');
delete from rbn_spots where callsign = 'K1GONE';
select is(array(select status from callsign_rollup_status where day between pg_temp.d(-7) and pg_temp.d(-2) order by day),
  array['pending', 'pending', 'pending', 'done', 'done', 'done'],
  'a day with no marker, archive or failure is pending');

-- A day rolled up before the fill existed whose RBN rows were retired and whose day rows compaction
-- already folded into a month row: only the archive has it, so the fill refuses it, the hourly job
-- records that, and the view says fill_failed (the marker is there). Without the month row the fill
-- goes through with nothing to count and flags the day: no RBN counted, RBN archived, so without_rbn.
insert into callsign_rollup_days (day, rolled_at) values (pg_temp.old_day(-10), now());
select log_archive('rbn', pg_temp.old_at(-10, '10:00:00'), pg_temp.old_at(-10, '10:10:00'), 7, 100, 'rbn/test');
insert into callsign_activity (period, grain, base, role, source, band, mode_bucket, spots, hours)
values (date_trunc('month', pg_temp.old_day(-10))::date, 'month', 'K1PACKED', 'heard', 'rbn', '20m', 'CW', 7,
        array_fill(0, array[10]) || 7 || array_fill(0, array[13]));
select throws_like(format('select * from fill_callsign_days(%L)', pg_temp.old_day(-10)), '%compacted%',
  'a retired day whose day rows were compacted is refused');
select is((select array_agg((fill_day, spots, exact, error like '%compacted%')::text) from backfill_callsign_days()),
  array[format('(%s,,,t)', pg_temp.old_day(-10))], 'backfill_callsign_days reports the refusal as an error row');
select is((select (attempts, last_error like 'callsign_days fill:%')::text from callsign_rollup_failures
           where day = pg_temp.old_day(-10)), '(1,t)', 'and records it as a fill failure');
select is((select status from callsign_rollup_status where day = pg_temp.old_day(-10)), 'fill_failed',
  'the status view says fill_failed');
delete from callsign_activity where base = 'K1PACKED';
select is((select array_agg((fill_day, spots, exact, error)::text) from backfill_callsign_days()),
  array[format('(%s,0,f,)', pg_temp.old_day(-10))], 'without the month row the fill goes through, with nothing to count');
select is((select (status, spots, days_filled_at is not null, attempts)::text from callsign_rollup_status
           where day = pg_temp.old_day(-10)), '(done_without_rbn,0,t,)',
  'the fill flags a day rolled up without its archived RBN rows and removes the failures row');
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
select ok(not exists (
  select 1 from unnest(array['callsign_days', 'callsign_rollup_failures', 'callsign_rollup_status']) as t
  where has_table_privilege('authenticated', t, 'select') or has_table_privilege('anon', t, 'select')),
  'clients cannot read callsign_days, the failures or the status view');
select ok(not has_function_privilege('authenticated', 'public.rollup_callsign_day(date, boolean)', 'execute')
          and not has_function_privilege('authenticated', 'public.backfill_callsign_rollups(int)', 'execute')
          and not has_function_privilege('authenticated', 'public.compact_callsign_rollups()', 'execute')
          and not has_function_privilege('anon', 'public.mode_bucket(text, text)', 'execute'),
  'clients cannot run the rollup functions');
select ok(not has_function_privilege('authenticated', 'public.fill_callsign_days(date)', 'execute')
          and not has_function_privilege('authenticated', 'public.backfill_callsign_days(int)', 'execute')
          and not has_function_privilege('authenticated', 'public.record_callsign_rollup_failure(date, text)', 'execute')
          and not has_function_privilege('anon', 'public.backfill_callsign_days(int)', 'execute'),
  'clients cannot run the callsign_days fill or record a failure');
set local role service_role;
select is((select count(*) from spot_stream where source = 'rbn')::int, 6, 'the service role reads spot_stream');
reset role;

select * from finish();
rollback;

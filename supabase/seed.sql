-- Preview seed data: a synthetic week of POTA, SOTAwatch and RBN spots so the
-- Stats page (and the Sources and recent-spot views) have something to show on
-- a Supabase preview branch or a fresh local stack, where no ingest runs.
--
-- Loaded by `supabase db reset` and by Supabase branching ([db.seed] in
-- config.toml). Never applied to the hosted project: `supabase db push` does
-- not run seeds.
--
-- Everything is generated relative to now(): the seven complete UTC days the
-- Stats page covers, plus today up to now. Callsigns, references and park names
-- are made up (W-style calls with an S suffix, "Seed" park names) so nobody
-- mistakes them for real activity. setseed() makes every run the same.
--
-- Shapes, not real volumes: about 450 POTA and 70 SOTA activations a day with
-- weekend bumps and a daily cycle, and about 55,000 RBN spots a day (the real
-- feed is ~1.5M; this keeps a preview branch small). The pgTAP suites clear
-- the tables they count, so they pass with or without this data.

select setseed(0.4242);

-- Helpers (temporary; gone when the seed session ends) -----------------------

-- A made-up callsign for member i of a pool, stable across runs: the same i
-- always gets the same prefix, digit and suffix.
create function pg_temp.seed_call(i int, prefixes text[]) returns text language sql immutable as $$
  select prefixes[1 + i % array_length(prefixes, 1)] || ((i / 7) % 10)::text
         || chr(65 + (i / 676) % 26) || chr(65 + (i / 26) % 26) || chr(65 + i % 26) || 'S';
$$;

-- A standard normal sample (Box-Muller); the argument only defeats caching.
create function pg_temp.gauss(seed int) returns double precision language sql volatile as $$
  select sqrt(-2 * ln(greatest(random(), 1e-9))) * cos(2 * pi() * random()) + 0 * seed;
$$;

-- Index into a pool of n, skewed toward the front (a few very active members).
create function pg_temp.skewed(n int, power double precision, seed int) returns int language sql volatile as $$
  select least(n - 1, floor(n * power(random(), power))::int) + 0 * seed;
$$;

-- Mode family as _shared/modes.ts derives it.
create function pg_temp.family(mode text) returns text language sql immutable as $$
  select case when mode = 'cw' then 'cw'
              when mode in ('ssb', 'fm', 'am') then 'phone'
              when mode in ('ft8', 'ft4', 'rtty', 'psk31') then 'digital' end;
$$;

-- A frequency in kHz for a band and mode.
create function pg_temp.freq(band text, mode text, seed int) returns numeric language sql volatile as $$
  select round((case
    when mode in ('ft8', 'ft4') then f.ft8 + case when mode = 'ft4' then f.ft4_offset else 0 end
    when mode in ('ssb', 'am')  then f.ssb_lo + random() * 60
    when mode = 'fm'            then 146520
    else f.cw_lo + random() * 40
  end)::numeric, 1) + 0 * seed
  from (values
    ('160m', 1810, 1840, 1840, 4),  ('80m', 3510, 3800, 3573, 2),   ('60m', 5332, 5357, 5357, 0),
    ('40m', 7010, 7180, 7074, -27), ('30m', 10105, 10136, 10136, 4), ('20m', 14010, 14230, 14074, 6),
    ('17m', 18070, 18120, 18100, 4), ('15m', 21010, 21280, 21074, 66), ('12m', 24892, 24940, 24915, 4),
    ('10m', 28010, 28350, 28074, 106), ('6m', 50060, 50130, 50313, 5), ('2m', 144050, 144200, 144174, 0)
  ) as f(band, cw_lo, ssb_lo, ft8, ft4_offset)
  where f.band = $1;
$$;

-- Days: the seven complete UTC days the Stats page covers, then today.
create temp table seed_days as
select d, (date_trunc('day', now() at time zone 'utc') + make_interval(days => d)) at time zone 'utc' as day_start,
       extract(isodow from date_trunc('day', now() at time zone 'utc') + make_interval(days => d))::int as dow
from generate_series(-7, 0) as d;

-- POTA --------------------------------------------------------------------------

create temp table seed_states (code text, weight int);
insert into seed_states values
  ('US-CA', 12), ('US-TX', 9), ('US-NC', 8), ('US-VA', 7), ('US-PA', 7), ('US-NY', 6), ('US-FL', 6),
  ('US-OH', 6), ('US-GA', 5), ('US-TN', 5), ('US-MI', 5), ('US-CO', 5), ('US-WA', 5), ('US-OR', 4),
  ('US-MA', 4), ('US-AZ', 4), ('US-IL', 4), ('US-MN', 3), ('US-WI', 3), ('US-MO', 3), ('US-IN', 3),
  ('US-SC', 3), ('US-KY', 3), ('US-AL', 2), ('US-UT', 3), ('US-NM', 2), ('US-ME', 2), ('US-NH', 2),
  ('US-VT', 2), ('US-MD', 3), ('US-NJ', 3), ('US-CT', 2), ('US-WV', 2), ('US-AR', 2), ('US-OK', 2),
  ('US-KS', 1), ('US-NE', 1), ('US-IA', 2), ('US-ID', 2), ('US-MT', 2), ('US-WY', 1), ('US-NV', 2),
  ('US-SD', 1), ('US-ND', 1), ('US-LA', 2), ('US-MS', 1), ('US-DE', 1), ('US-RI', 1), ('US-HI', 1),
  ('US-AK', 1), ('US-DC', 1), ('CA-ON', 3), ('CA-QC', 1), ('CA-BC', 2);

-- 600 parks; about 4% straddle two states.
create temp table seed_parks as
with expanded as (
  select code, row_number() over (order by random()) as rn
  from seed_states, generate_series(1, weight)
),
n as (select count(*) as total from expanded)
select i,
       case when e.code like 'CA-%' then 'CA-' else 'US-' end || lpad((1000 + i * 13 % 9000)::text, 4, '0') as reference,
       (array['Cedar', 'Pine', 'Eagle', 'Bear', 'Fox', 'Laurel', 'Granite', 'Willow', 'Hawk', 'Maple', 'Otter', 'Falcon',
              'Heron', 'Aspen', 'Juniper', 'Bluff', 'Sandy', 'Misty', 'Crystal', 'Hidden'])[1 + i % 20] || ' '
         || (array['Ridge', 'Creek', 'Lake', 'Hollow', 'Point', 'River', 'Valley', 'Mountain', 'Springs', 'Run'])[1 + (i / 20) % 10] || ' '
         || (array['State Park', 'National Forest', 'Wildlife Management Area', 'State Forest', 'Recreation Area',
                   'National Wildlife Refuge', 'Seed Park'])[1 + (i / 7) % 7] as name,
       case when e.code like 'US-%' and i % 25 = 0
            then e.code || ',' || (select code from seed_states where code like 'US-%' and code <> e.code order by md5(code || i) limit 1)
            else e.code end as location
from generate_series(0, 599) as i
cross join n
join expanded e on e.rn = 1 + (i * 37) % n.total;

-- Activations: 330 activators (a few very busy), 450 a day on weekdays, more at weekends.
create temp table seed_pota_activations as
select row_number() over () as id, d.day_start, d.d,
       pg_temp.seed_call(pg_temp.skewed(330, 1.25, g), array['K', 'W', 'N', 'KD', 'KC', 'KE', 'WB', 'AB', 'VE']) as callsign,
       pg_temp.skewed(600, 1.4, g) as park,
       -- Start time: US daytime, centered near 17:00 UTC.
       ((17 + pg_temp.gauss(g) * 4)::numeric % 24 + 24) % 24 as start_hour,
       (array['cw', 'cw', 'cw', 'cw', 'ssb', 'ssb', 'ssb', 'ssb', 'ft8', 'ft8', 'ft4', 'fm', null])[1 + floor(random() * 13)::int] as mode,
       3 + floor(random() * 10)::int as spots
from seed_days d,
     lateral generate_series(1, (case when d.dow in (6, 7) then 620 else 450 end * (0.9 + random() * 0.2))::int) as g;

create temp table seed_pota_spots as
select a.id, a.callsign, a.mode, p.reference, p.name, p.location, s,
       a.day_start + make_interval(secs => (a.start_hour * 3600 + s * 420 + random() * 300)::int) as spot_time,
       case when a.mode = 'fm' then '2m'
            when a.start_hour between 12 and 23
              then (array['20m', '20m', '20m', '40m', '40m', '17m', '15m', '30m', '10m', '12m', '60m', '80m', '6m'])[1 + floor(random() * 13)::int]
            else (array['40m', '40m', '40m', '80m', '80m', '20m', '30m', '160m', '60m'])[1 + floor(random() * 9)::int]
       end as band,
       -- About a third of activations open with a self-spot; the rest are chasers.
       case when s = 1 and a.id % 3 = 0 then a.callsign
            else pg_temp.seed_call(pg_temp.skewed(1800, 1.4, s + a.id::int), array['K', 'W', 'N', 'KB', 'KJ', 'AC', 'VA'])
       end as spotter
from seed_pota_activations a
join seed_parks p on p.i = a.park,
     lateral generate_series(1, a.spots) as s;

insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, spotter, frequency_khz, band, mode, mode_family,
                       comment, pota_reference, pota_park_name, pota_location, raw_payload)
select 'pota', 'seed-pota-' || id || '-' || s, md5('seed-pota-' || id || '-' || s), spot_time, callsign, spotter,
       pg_temp.freq(band, mode, s), band, mode, pg_temp.family(mode),
       case when spotter = callsign then 'QRV' else '' end, reference, name, location, '{"seed": true}'
from seed_pota_spots
where spot_time < now();

-- SOTA ------------------------------------------------------------------------

create temp table seed_associations (code text, regions text[], weight int);
insert into seed_associations values
  ('W4C', '{CM,WM}', 6), ('W7A', '{MN,YV,CN}', 5), ('G', '{LD,SP,NP}', 6), ('DM', '{BW,BM,NS}', 6),
  ('HB', '{BE,GR,VS}', 4), ('W6', '{CT,NS,SN}', 4), ('VK2', '{HU,CT}', 3), ('OE', '{TI,ST}', 4),
  ('EA2', '{NV,BI}', 2), ('W0C', '{FR,SR}', 3), ('JA', '{NN,KN}', 2), ('SP', '{SS,BZ}', 2), ('W4G', '{NG}', 2);

-- 70 activations a day (more at weekends), Europe in the morning and the US in the afternoon.
create temp table seed_sota_activations as
select row_number() over () as id, d.day_start,
       case when g % 5 = 0 then 'W4/' else '' end || pg_temp.seed_call(pg_temp.skewed(140, 1.3, g), array['G', 'DL', 'K', 'W', 'OE', 'HB9'])
         || case when g % 3 = 0 then '/P' else '' end as callsign,
       a.code || '/' || a.regions[1 + floor(random() * array_length(a.regions, 1))::int] || '-' || lpad((1 + floor(random() * 120))::text, 3, '0') as summit,
       ((case when random() < 0.5 then 11 else 18 end + pg_temp.gauss(g) * 2.5)::numeric % 24 + 24) % 24 as start_hour,
       (array['cw', 'cw', 'cw', 'ssb', 'ssb', 'fm'])[1 + floor(random() * 6)::int] as mode,
       2 + floor(random() * 6)::int as spots
from seed_days d,
     lateral generate_series(1, case when d.dow in (6, 7) then 95 else 70 end) as g,
     lateral (select * from seed_associations, generate_series(1, weight) order by random() + 0 * g limit 1) as a;

insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, spotter, frequency_khz, band, mode, mode_family,
                       comment, sota_summit_ref, raw_payload)
select 'sotawatch', 'seed-sota-' || a.id || '-' || s, md5('seed-sota-' || a.id || '-' || s), t.spot_time, a.callsign,
       -- RBNHole reports with no skimmer named have a null spotter; the rest are chasers or self-spots.
       case when s = 1 then split_part(split_part(a.callsign, '/', case when a.callsign like 'W4/%' then 2 else 1 end), '/', 1)
            when s % 4 = 0 then null
            else pg_temp.seed_call(pg_temp.skewed(500, 1.5, s + a.id::int), array['G', 'M', 'DL', 'W', 'K', 'EA']) end,
       pg_temp.freq(b.band, a.mode, s), b.band, a.mode, pg_temp.family(a.mode), '', a.summit, '{"seed": true}'
from seed_sota_activations a,
     lateral generate_series(1, a.spots) as s,
     lateral (select a.day_start + make_interval(secs => (a.start_hour * 3600 + s * 360 + random() * 240)::int) as spot_time) as t,
     lateral (select case when a.mode = 'fm' then '2m'
                          else (array['40m', '40m', '20m', '20m', '30m', '17m', '60m', '2m'])[1 + floor(random() * 8 + 0 * s)::int] end as band) as b
where t.spot_time < now()
  and not (b.band = '2m' and a.mode <> 'fm' and a.mode <> 'cw');

-- RBN -------------------------------------------------------------------------

-- About 55,000 spots a day from 260 skimmers hearing 9,000 stations, busiest in
-- the European and US afternoons, with a contest-like bump on Saturday.
insert into rbn_spots (spot_time, received_at, spotter, callsign, frequency_khz, band, mode, mode_family,
                       snr, speed, speed_unit, spot_type, line)
select t.spot_time, t.spot_time + interval '4 seconds', x.spotter, x.callsign, x.freq, x.band, x.mode, pg_temp.family(x.mode),
       x.snr, x.speed, x.unit, x.spot_type,
       format('DX de %s-#: %s  %s  %s %s dB %s %s %s %sZ', x.spotter, x.freq, x.callsign, upper(x.mode), x.snr, x.speed, x.unit, x.spot_type,
              to_char(t.spot_time at time zone 'utc', 'HH24MI'))
from seed_days d,
     lateral generate_series(0, 23) as h,
     lateral generate_series(1, (3300 * (0.45 + 0.55 * exp(-power(h - 15, 2) / 40.0))
                                      * case when d.dow = 6 then 1.6 else 1 end * (0.9 + random() * 0.2))::int) as g,
     lateral (select d.day_start + make_interval(hours => h, secs => floor(random() * 3600)::int + 0 * g) as spot_time) as t,
     lateral (
       select s.spotter, s.callsign, s.band, s.mode, s.snr, s.spot_type, pg_temp.freq(s.band, 'cw', g) as freq,
              -- RTTY reports carry a baud rate, not a keying speed.
              case when s.mode = 'rtty' then 45 else s.wpm end::smallint as speed,
              case when s.mode = 'rtty' then 'BPS' else 'WPM' end as unit
       from (
         select pg_temp.seed_call(pg_temp.skewed(260, 1.3, g), array['DL', 'W', 'K', 'G', 'OH', 'JA', 'VE', 'EA']) as spotter,
                pg_temp.seed_call(pg_temp.skewed(9000, 1.8, g + h), array['K', 'W', 'DL', 'G', 'I', 'JA', 'UA', 'EA', 'F', 'OK']) as callsign,
                case when h between 7 and 20
                       then (array['20m', '20m', '20m', '40m', '40m', '15m', '17m', '30m', '10m', '12m', '80m'])[1 + floor(random() * 11)::int]
                     else (array['40m', '40m', '40m', '80m', '80m', '160m', '160m', '30m', '20m'])[1 + floor(random() * 9)::int] end as band,
                case when random() < 0.92 then 'cw' else 'rtty' end as mode,
                (3 + floor(random() * 30))::smallint as snr,
                18 + floor(random() * 14) as wpm,
                (array['CQ', 'CQ', 'CQ', 'CQ', 'CQ', 'CQ', 'CQ', 'CQ', 'DX', 'BEACON'])[1 + floor(random() * 10)::int] as spot_type
       ) as s
     ) as x
where t.spot_time < now()
on conflict do nothing;

-- The first snapshot, so the page has data before the hourly cron runs. The
-- migrations' own refresh already ran on empty tables and marked every window
-- day as rolled up, so the RBN rollups are cleared first.
delete from rbn_rollup_days;
select public.refresh_stats_snapshot();

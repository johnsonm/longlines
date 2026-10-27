-- Preview seed data: a synthetic week of POTA, SOTAwatch, WWFF, WWBOTA and RBN spots so the
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
-- Shapes, not real volumes: about 450 POTA, 70 SOTA and 80 WWFF activations a day with
-- weekend bumps and a daily cycle, and about 55,000 RBN spots a day (the real
-- feed is ~1.5M; this keeps a preview branch small). The pgTAP suites clear
-- the tables they count, so they pass with or without this data. The reference
-- lists (reference_catalog) hold the seeded parks, summits and WWFF references
-- as a weekly load would leave them, minus one in fifty, so a reference page
-- can show both a listed and an unlisted reference.
--
-- One DO block on purpose: Supabase branching sends the seed file as a single
-- prepared batch, so a temp table created by one statement does not exist yet
-- when the next is prepared. PL/pgSQL plans each statement when it runs.

do $seed$
begin

perform setseed(0.4242);

-- Helpers (temporary; dropped at the end) ------------------------------------

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

-- WWFF ------------------------------------------------------------------------

-- Two kinds, as on the real feed: one POTA activation in eight at a US park is a
-- WWFF activation too (its first three spots, a KFF reference named after the
-- park), and about 25 a day are European, in the morning UTC.
insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, spotter, frequency_khz, band, mode, mode_family,
                       comment, wwff_reference, wwff_reference_name, raw_payload)
select 'wwff', 'seed-wwff-k-' || p.id || '-' || p.s, md5('seed-wwff-k-' || p.id || '-' || p.s), p.spot_time + interval '20 seconds',
       p.callsign, p.spotter, pg_temp.freq(p.band, p.mode, p.s), p.band, p.mode, pg_temp.family(p.mode), '',
       'KFF-' || substr(p.reference, 4), p.name, '{"seed": true}'
from seed_pota_spots p
where p.id % 8 = 0 and p.reference like 'US-%' and p.s <= 3 and p.spot_time < now();

insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, spotter, frequency_khz, band, mode, mode_family,
                       comment, wwff_reference, wwff_reference_name, raw_payload)
select 'wwff', 'seed-wwff-eu-' || d.d || '-' || g || '-' || s, md5('seed-wwff-eu-' || d.d || '-' || g || '-' || s), t.spot_time,
       x.callsign,
       case when s = 1 then x.callsign
            else pg_temp.seed_call(pg_temp.skewed(400, 1.5, s + g), array['ON', 'DL', 'G', 'OK', 'SP', 'F', 'I']) end,
       pg_temp.freq(x.band, x.mode, s), x.band, x.mode, pg_temp.family(x.mode),
       case when s = 3 then 'Re-spotted via RBN' else '' end,
       x.program || '-' || lpad((1 + (g * 37 + (d.d + 7) * 11) % 400)::text, 4, '0'),
       (array['Seed Heath', 'Seed Dunes', 'Seed Marsh', 'Seed Forest', 'Seed Valley'])[1 + g % 5], '{"seed": true}'
from seed_days d,
     lateral generate_series(1, case when d.dow in (6, 7) then 35 else 25 end) as g,
     lateral (select (array['ON', 'DL', 'G', 'OK', 'SP', 'F', 'I'])[1 + g % 7] as pfx,
                     (array['ONFF', 'DLFF', 'GFF', 'OKFF', 'SPFF', 'FFF', 'IFF'])[1 + g % 7] as program) as pr,
     lateral (select pg_temp.seed_call(pg_temp.skewed(90, 1.3, g), array[pr.pfx]) || case when g % 2 = 0 then '/P' else '' end as callsign,
                     pr.program,
                     (array['cw', 'cw', 'ssb', 'ssb', 'ft8'])[1 + g % 5] as mode,
                     (array['40m', '40m', '20m', '20m', '30m', '17m'])[1 + (g + d.d + 7) % 6] as band) as x,
     lateral generate_series(1, 2 + g % 4) as s,
     lateral (select d.day_start + make_interval(secs => ((8 + g % 6) * 3600 + s * 400 + g * 7)::int) as spot_time) as t
where t.spot_time < now();

-- WWBOTA ----------------------------------------------------------------------

-- About six bunker activations a day, European, around midday UTC, two to four
-- spots each. One in three is an n-fer of three bunkers; the first bunker's
-- name goes with the spot, as on the real feed.
insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, spotter, frequency_khz, band, mode, mode_family,
                       comment, wwbota_references, wwbota_reference_name, raw_payload)
select 'wwbota', 'seed-wwbota-' || d.d || '-' || g || '-' || s, md5('seed-wwbota-' || d.d || '-' || g || '-' || s), t.spot_time,
       x.callsign,
       case when s = 1 then x.callsign
            else pg_temp.seed_call(pg_temp.skewed(200, 1.5, s + g), array['G', 'ON', 'HB9', 'EA', 'DL']) end,
       pg_temp.freq(x.band, x.mode, s), x.band, x.mode, pg_temp.family(x.mode),
       array_to_string(x.refs, ' '), x.refs,
       (array['Seed Pillbox', 'Seed ROC Post', 'Seed Blockhouse', 'Seed Bunker'])[1 + g % 4], '{"seed": true}'
from seed_days d,
     lateral generate_series(1, case when d.dow in (6, 7) then 9 else 6 end) as g,
     lateral (select (array['G', 'ON', 'HB9', 'EA'])[1 + g % 4] as pfx,
                     (array['B/G-', 'B/ON-', 'B/HB-', 'B/EA-'])[1 + g % 4] as scheme,
                     1 + (g * 53 + (d.d + 7) * 17) % 900 as first_ref) as pr,
     lateral (select pg_temp.seed_call(pg_temp.skewed(40, 1.3, g), array[pr.pfx]) || '/P' as callsign,
                     (select array_agg(pr.scheme || lpad((pr.first_ref + k)::text, 4, '0') order by k)
                      from generate_series(0, case when g % 3 = 0 then 2 else 0 end) as k) as refs,
                     (array['ssb', 'ssb', 'cw', 'ft8'])[1 + g % 4] as mode,
                     (array['40m', '40m', '20m', '80m'])[1 + (g + d.d + 7) % 4] as band) as x,
     lateral generate_series(1, 2 + g % 3) as s,
     lateral (select d.day_start + make_interval(secs => ((10 + g % 4) * 3600 + s * 500 + g * 11)::int) as spot_time) as t
where t.spot_time < now() - interval '5 minutes';

-- Reference lists ---------------------------------------------------------------

-- What apply_reference_loads would leave (a seed is far below the load floor, so it writes the
-- table directly): every seeded reference but one in fifty, one in twenty-five retired, with
-- made-up coordinates and the six-character locator the parser gives them.
create function pg_temp.seed_hash(t text, n int) returns int language sql immutable as $$
  select mod(hashtext(t)::bigint + 2147483648, n)::int;
$$;

create function pg_temp.seed_grid(lat numeric, lon numeric) returns text language sql immutable as $$
  select chr(65 + floor((lon + 180) / 20)::int) || chr(65 + floor((lat + 90) / 10)::int)
         || floor(mod(lon + 180, 20) / 2)::int || floor(mod(lat + 90, 10))::int
         || chr(97 + floor(mod(lon + 180, 2) * 12)::int) || chr(97 + floor(mod(lat + 90, 1) * 24)::int);
$$;

insert into reference_catalog (program, reference, name, active, location, latitude, longitude, grid)
select 'pota', p.reference, p.name, p.i % 25 <> 3, p.location, c.lat, c.lon, pg_temp.seed_grid(c.lat, c.lon)
from seed_parks p,
     lateral (select round(30 + pg_temp.seed_hash(p.reference, 1800) / 100.0, 4) as lat,
                     round(-122 + pg_temp.seed_hash(p.reference || 'lon', 4700) / 100.0, 4) as lon) as c
where p.i % 50 <> 7;

insert into reference_catalog (program, reference, name, active, region, latitude, longitude, grid, altitude_m, points,
                               valid_from, valid_to)
select 'sota', s.ref, 'Seed Peak ' || split_part(s.ref, '-', 2), s.h % 25 <> 3,
       split_part(s.ref, '/', 1) || ', ' || split_part(split_part(s.ref, '/', 2), '-', 1) || ' Seed Region',
       c.lat, c.lon, pg_temp.seed_grid(c.lat, c.lon), 300 + s.h % 3500, 1 + s.h % 10,
       date '2010-07-01', case when s.h % 25 = 3 then date '2019-12-31' end
from (select r.ref, pg_temp.seed_hash(r.ref, 1000000) as h
      from (select distinct sota_summit_ref as ref from raw_spots
            where source = 'sotawatch' and source_spot_id like 'seed-%') r) s,
     lateral (select round(-40 + pg_temp.seed_hash(s.ref, 9000) / 100.0, 4) as lat,
                     round(-120 + pg_temp.seed_hash(s.ref || 'lon', 27000) / 100.0, 4) as lon) as c
where s.h % 50 <> 7;

insert into reference_catalog (program, reference, name, active, region, country, latitude, longitude, grid,
                               valid_from, valid_to)
select 'wwff', w.ref, w.name, w.h % 25 <> 3, w.region,
       case split_part(w.ref, '-', 1) when 'KFF' then 'United States' when 'ONFF' then 'Belgium'
            when 'DLFF' then 'Germany' when 'GFF' then 'England' when 'OKFF' then 'Czech Republic'
            when 'SPFF' then 'Poland' when 'FFF' then 'France' when 'IFF' then 'Italy' end,
       c.lat, c.lon, pg_temp.seed_grid(c.lat, c.lon),
       date '2012-01-01', case when w.h % 25 = 3 then date '2021-06-30' end
from (select x.wwff_reference as ref, min(x.wwff_reference_name) as name,
             min(substr(p.location, 4, 2)) as region, pg_temp.seed_hash(x.wwff_reference, 1000000) as h
      from raw_spots x
      left join seed_parks p on p.reference like 'US-%' and x.wwff_reference = 'KFF-' || substr(p.reference, 4)
      where x.source = 'wwff' and x.source_spot_id like 'seed-%'
      group by x.wwff_reference) w,
     lateral (select case when w.ref like 'KFF-%' then round(30 + pg_temp.seed_hash(w.ref, 1800) / 100.0, 4)
                          else round(42 + pg_temp.seed_hash(w.ref, 1200) / 100.0, 4) end as lat,
                     case when w.ref like 'KFF-%' then round(-122 + pg_temp.seed_hash(w.ref || 'lon', 4700) / 100.0, 4)
                          else round(-5 + pg_temp.seed_hash(w.ref || 'lon', 3000) / 100.0, 4) end as lon) as c
where w.h % 50 <> 7;

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

-- Callsign rollups for the seeded days, as the hourly job would have made.
-- They refuse to run without cty.dat, so load the few countries the seeded
-- spotters come from (import-cty loads the real file; it never runs here).
perform public.load_cty('seed',
  '[{"prefix":"K","name":"United States","continent":"NA","cq_zone":5,"itu_zone":8,"lat":37.6,"lon":-91.87},
    {"prefix":"VE","name":"Canada","continent":"NA","cq_zone":5,"itu_zone":9,"lat":44.35,"lon":-78.75},
    {"prefix":"G","name":"England","continent":"EU","cq_zone":14,"itu_zone":27,"lat":52.77,"lon":-1.47},
    {"prefix":"DL","name":"Fed. Rep. of Germany","continent":"EU","cq_zone":14,"itu_zone":28,"lat":51.0,"lon":10.0},
    {"prefix":"EA","name":"Spain","continent":"EU","cq_zone":14,"itu_zone":37,"lat":40.37,"lon":-4.88},
    {"prefix":"OH","name":"Finland","continent":"EU","cq_zone":15,"itu_zone":18,"lat":63.78,"lon":27.08},
    {"prefix":"JA","name":"Japan","continent":"AS","cq_zone":25,"itu_zone":45,"lat":36.4,"lon":138.38}]',
  '[{"pattern":"K","exact":false,"entity":"K","continent":"NA","cq_zone":5,"itu_zone":8},
    {"pattern":"W","exact":false,"entity":"K","continent":"NA","cq_zone":5,"itu_zone":8},
    {"pattern":"N","exact":false,"entity":"K","continent":"NA","cq_zone":5,"itu_zone":8},
    {"pattern":"AC","exact":false,"entity":"K","continent":"NA","cq_zone":5,"itu_zone":8},
    {"pattern":"VE","exact":false,"entity":"VE","continent":"NA","cq_zone":5,"itu_zone":9},
    {"pattern":"VA","exact":false,"entity":"VE","continent":"NA","cq_zone":5,"itu_zone":9},
    {"pattern":"G","exact":false,"entity":"G","continent":"EU","cq_zone":14,"itu_zone":27},
    {"pattern":"M","exact":false,"entity":"G","continent":"EU","cq_zone":14,"itu_zone":27},
    {"pattern":"DL","exact":false,"entity":"DL","continent":"EU","cq_zone":14,"itu_zone":28},
    {"pattern":"EA","exact":false,"entity":"EA","continent":"EU","cq_zone":14,"itu_zone":37},
    {"pattern":"OH","exact":false,"entity":"OH","continent":"EU","cq_zone":15,"itu_zone":18},
    {"pattern":"JA","exact":false,"entity":"JA","continent":"AS","cq_zone":25,"itu_zone":45}]');
perform public.backfill_callsign_rollups();

-- The first snapshot, with the day rollups (refresh_stats_snapshot() alone makes none), so the
-- page has data before the hourly cron runs. The
-- migrations' own refresh already ran on empty tables and marked every window
-- day as rolled up, so the RBN and country rollups are cleared first. It runs
-- after load_cty so the world map has countries.
delete from rbn_rollup_days;
delete from country_rollup_days;
perform public.refresh_stats_snapshot_at(now());

-- The branch may reuse this connection, so leave nothing temporary behind.
drop table seed_days, seed_states, seed_parks, seed_pota_activations, seed_pota_spots,
           seed_associations, seed_sota_activations;
drop function pg_temp.seed_call(int, text[]), pg_temp.gauss(int), pg_temp.skewed(int, double precision, int),
              pg_temp.family(text), pg_temp.freq(text, text, int), pg_temp.seed_hash(text, int),
              pg_temp.seed_grid(numeric, numeric);

end
$seed$;

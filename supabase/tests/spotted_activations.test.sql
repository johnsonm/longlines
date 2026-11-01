-- pgTAP: spotted activations (20261101000100). Detection by assemble_spotted_activations(p_now)
-- (runs and gaps, two-fers, rovers, the POTA midnight split, the watermark, the lag and the cap,
-- RBN and DX Cluster at close, places), the read RPCs spotted_activation(id) and
-- callsign_spotted_activations(call, now) with their shapes, hidden calls, grants and the cron job.
--
-- Every scenario starts from pg_temp.reset() (no activations, no spots, the watermark at the
-- start), so the suite passes on a seeded database too. Times are relative to T, midnight UTC
-- three days ago; each spot is ingested five seconds after its spot time unless a case says
-- otherwise, and a pass runs at a chosen p_now, as the minute job would.
begin;
create extension if not exists pgtap with schema extensions;
select plan(99);

create function pg_temp.keys(p jsonb) returns text[] language sql as $$
  select array_agg(k order by k) from jsonb_object_keys(p) as k;
$$;

-- T + p_day days at p_time (UTC), and that UTC day.
create function pg_temp.t(p_day int, p_time text) returns timestamptz language sql stable as $$
  select (((now() at time zone 'utc')::date - 3 + p_day)::timestamp + p_time::time) at time zone 'utc';
$$;
create function pg_temp.d(p_day int) returns date language sql stable as $$
  select (now() at time zone 'utc')::date - 3 + p_day;
$$;

create function pg_temp.freq(p_band text) returns numeric language sql immutable as $$
  select case p_band when '40m' then 7200 when '80m' then 3800 when '30m' then 10120 when '17m' then 18100
                     when '15m' then 21300 else 14250 end;
$$;

-- One raw_spots row. p_ref is the source's reference (the POTA park, the SOTA summit, the WWFF
-- reference, the IOTA group on a DX Cluster spot); p_refs is a WWBOTA spot's bunkers.
create function pg_temp.spot(p_source text, p_call text, p_spotter text, p_at timestamptz, p_ref text,
                             p_band text default '20m', p_mode text default 'ssb',
                             p_ingested timestamptz default null, p_spot_id text default null,
                             p_hash text default null, p_refs text[] default null)
returns bigint language sql as $$
  insert into raw_spots (source, source_spot_id, content_hash, ingested_at, spot_time, callsign, spotter,
                         frequency_khz, band, mode, pota_reference, pota_park_name, sota_summit_ref,
                         wwff_reference, wwff_reference_name, wwbota_references, wwbota_reference_name,
                         iota_reference, iota_reference_name, raw_payload)
  values (p_source, coalesce(p_spot_id, gen_random_uuid()::text), coalesce(p_hash, gen_random_uuid()::text),
          coalesce(p_ingested, p_at + interval '5 seconds'), p_at, p_call, p_spotter, pg_temp.freq(p_band), p_band,
          p_mode,
          case when p_source = 'pota' then p_ref end, case when p_source = 'pota' then 'Park ' || p_ref end,
          case when p_source = 'sotawatch' then p_ref end,
          case when p_source = 'wwff' then p_ref end, case when p_source = 'wwff' then 'Flora ' || p_ref end,
          p_refs, case when p_refs is not null then 'Bunker ' || p_refs[1] end,
          case when p_source = 'dxcluster' then p_ref end,
          case when p_source = 'dxcluster' and p_ref is not null then 'Island ' || p_ref end,
          '{}')
  returning id;
$$;

create function pg_temp.rbn(p_call text, p_spotter text, p_at timestamptz, p_band text, p_type text default 'CQ')
returns void language sql as $$
  insert into rbn_spots (spot_time, received_at, spotter, callsign, frequency_khz, band, mode, mode_family,
                         snr, speed, speed_unit, spot_type, line)
  values (p_at, p_at, p_spotter, p_call, pg_temp.freq(p_band) + 25, p_band, 'cw', 'cw', 12, 22, 'WPM', p_type, 'test');
$$;

create function pg_temp.reset() returns void language sql as $$
  delete from spotted_activation_redirects;
  delete from spotted_activations;
  delete from raw_spots;
  delete from rbn_spots;
  update spotted_activation_state set watermark_at = '-infinity', watermark_id = 0;
$$;

create function pg_temp.run(p_day int, p_time text) returns int language sql as $$
  select public.assemble_spotted_activations(pg_temp.t(p_day, p_time));
$$;

-- The activation of p_base that started at p_at.
create function pg_temp.act(p_base text, p_at timestamptz) returns text language sql stable as $$
  select a.id from spotted_activations a where a.base_callsign = p_base and a.started_at = p_at;
$$;

delete from hidden_callsigns;
delete from callsign_licenses;
delete from reference_catalog;

select public.load_cty('test',
  '[{"prefix":"K","name":"United States","continent":"NA","cq_zone":5,"itu_zone":8,"lat":37.6,"lon":-91.87},
    {"prefix":"KL","name":"Alaska","continent":"NA","cq_zone":1,"itu_zone":1,"lat":61.4,"lon":-148.87},
    {"prefix":"VE","name":"Canada","continent":"NA","cq_zone":5,"itu_zone":9,"lat":44.35,"lon":-78.75},
    {"prefix":"DL","name":"Fed. Rep. of Germany","continent":"EU","cq_zone":14,"itu_zone":28,"lat":51.0,"lon":10.0}]',
  '[{"pattern":"K","exact":false,"entity":"K","continent":"NA","cq_zone":5,"itu_zone":8},
    {"pattern":"W","exact":false,"entity":"K","continent":"NA","cq_zone":5,"itu_zone":8},
    {"pattern":"N","exact":false,"entity":"K","continent":"NA","cq_zone":5,"itu_zone":8},
    {"pattern":"KL","exact":false,"entity":"KL","continent":"NA","cq_zone":1,"itu_zone":1},
    {"pattern":"VE","exact":false,"entity":"VE","continent":"NA","cq_zone":5,"itu_zone":9},
    {"pattern":"DL","exact":false,"entity":"DL","continent":"EU","cq_zone":14,"itu_zone":28}]');

insert into callsign_licenses (callsign, authority, status, country, state, loaded_at) values
  ('N4AAA', 'FCC', 'Active', 'US', 'NC', now()),
  ('KL7BBB', 'FCC', 'Active', 'US', 'AK', now());

insert into reference_catalog (program, reference, name, active, location, latitude, longitude) values
  ('pota', 'US-0100', 'Geo Park', true, 'US-NC', 35.5, -79.0),
  ('pota', 'US-0050', 'Summary Park', true, 'US-NC,US-VA', 36.5, -80.0),
  ('sota', 'W4C/CM-001', 'Mount Test', true, null, 35.76, -82.26);

select pg_temp.reset();

-- ---------------------------------------------------------------------------
-- A run, the gap, /P, the watermark and a late spot
-- ---------------------------------------------------------------------------

select pg_temp.spot('pota', 'K1RUN/P', 'N4AAA', pg_temp.t(0, '10:00'), 'US-0001');
select pg_temp.spot('pota', 'K1RUN', 'N4AAA', pg_temp.t(0, '10:30'), 'US-0001');
select pg_temp.spot('pota', 'K1RUN', 'N4AAA', pg_temp.t(0, '11:10'), 'US-0001');
select pg_temp.spot('pota', 'K1RUN', 'N4AAA', pg_temp.t(0, '11:56'), 'US-0001');
select pg_temp.spot('pota', 'K1RUN', 'N4AAA', pg_temp.t(0, '12:10'), 'US-0001');

select is(pg_temp.run(0, '11:20'), 3, 'a pass reads the reference spots ingested before its cutoff');
select is((select count(*)::int from spotted_activations where base_callsign = 'K1RUN'), 1,
  'spots with gaps under 45 minutes are one activation');
select ok((select closed_at is null from spotted_activations where base_callsign = 'K1RUN'),
  'it stays open until 45 minutes have passed');
select is(pg_temp.run(0, '12:30'), 2, 'the next pass reads the rest');
select results_eq(
  $$select started_at, last_spot_at, closed_at, spot_count from spotted_activations
    where base_callsign = 'K1RUN' order by started_at$$,
  $$values (pg_temp.t(0, '10:00'), pg_temp.t(0, '11:10'), pg_temp.t(0, '12:30'), 3),
           (pg_temp.t(0, '11:56'), pg_temp.t(0, '12:10'), null::timestamptz, null::int)$$,
  'a 46-minute gap makes two, and the first closes once the gap has passed');
select is((select array_agg(distinct s.callsign order by s.callsign) from spotted_activation_spots s
           where s.activation_id = pg_temp.act('K1RUN', pg_temp.t(0, '10:00'))),
  array['K1RUN', 'K1RUN/P'], '/P and the plain call land in one activation');
select ok((select (watermark_at, watermark_id) = (r.ingested_at, r.id)
           from spotted_activation_state, raw_spots r where r.spot_time = pg_temp.t(0, '12:10')),
  'the watermark is the last row read');
select is(pg_temp.run(0, '12:31'), 0, 'the watermark never reprocesses a row');
select is((select count(*)::int from spotted_activation_spots), 5, 'and no spot is attached twice');

select pg_temp.spot('pota', 'K1RUN', 'N4AAA', pg_temp.t(0, '10:20'), 'US-0001', p_ingested => pg_temp.t(0, '12:40'));
select is(pg_temp.run(0, '12:45'), 1, 'a spot ingested after its activation closed is read');
select is((select spot_count from spotted_activations where id = pg_temp.act('K1RUN', pg_temp.t(0, '10:00'))), 3,
  'it is not attached to the closed activation');
select is((select count(*)::int from spotted_activations where base_callsign = 'K1RUN'), 2,
  'and it opens no new activation');

-- ---------------------------------------------------------------------------
-- The lag, the cutoff and the cap
-- ---------------------------------------------------------------------------

select pg_temp.reset();
select pg_temp.spot('pota', 'K2LAG', 'N4AAA', pg_temp.t(0, '09:00'), 'US-0002', p_ingested => pg_temp.t(0, '09:00:20'));
select is(pg_temp.run(0, '09:00:40'), 0, 'the lag holds back a row ingested within 30 seconds');
select is(pg_temp.run(0, '09:00:51'), 1, 'a pass 30 seconds later reads it');

select pg_temp.spot('pota', 'K2NOW', 'N4AAA', now() + interval '1 hour', 'US-0002',
                    p_ingested => now() + interval '1 hour');
select is(public.assemble_spotted_activations(now() + interval '2 hours'), 0,
  'the cutoff never passes the transaction''s now()');
select ok((select watermark_at < now() from spotted_activation_state), 'and neither does the watermark');

select pg_temp.reset();
select pg_temp.spot('pota', 'K3OLD', 'N4AAA', pg_temp.t(0, '08:00'), 'US-0003');
insert into raw_spots (source, source_spot_id, content_hash, ingested_at, spot_time, callsign, spotter, frequency_khz,
                       band, mode, pota_reference, raw_payload)
select 'pota', 'cap-' || g, 'cap-' || g, pg_temp.t(1, '08:00') + make_interval(secs => g + 5),
       pg_temp.t(1, '08:00') + make_interval(secs => g), 'K3CAP', 'N4AAA', 14250, '20m', 'ssb', 'US-0004', '{}'
from generate_series(1, 5001) as g;
select is(pg_temp.run(2, '00:00'), public.activation_batch_limit(), 'a pass reads at most activation_batch_limit() spots');
select ok((select closed_at is null from spotted_activations where base_callsign = 'K3OLD'),
  'a capped pass closes nothing');
select is((select watermark_id from spotted_activation_state),
          (select r.id from raw_spots r order by r.ingested_at, r.id offset public.activation_batch_limit() - 1 limit 1),
  'and moves the watermark only to the last row read');
select is(pg_temp.run(2, '00:01'), 2, 'the next pass reads the rest');
select is((select array_agg(closed_at order by base_callsign) from spotted_activations
           where base_callsign in ('K3CAP', 'K3OLD')),
  array[pg_temp.t(2, '00:01'), pg_temp.t(2, '00:01')], 'and closes');
select is((select spot_count from spotted_activations where base_callsign = 'K3CAP'), 5001,
  'every spot of the long run is one activation');

-- ---------------------------------------------------------------------------
-- Two-fers
-- ---------------------------------------------------------------------------

select pg_temp.reset();
-- K4TWO: a run at US-0011 on day 0 runs past midnight into a two-fer with US-0010 on day 1.
select pg_temp.spot('pota', 'K4TWO', 'N4AAA', pg_temp.t(0, '23:50'), 'US-0011');
select pg_temp.spot('pota', 'K4TWO', 'N4AAA', pg_temp.t(1, '00:05'), 'US-0010');
select pg_temp.spot('pota', 'K4TWO', 'N4AAA', pg_temp.t(1, '00:10'), 'US-0011');
select pg_temp.spot('pota', 'K4TWO', 'N4AAA', pg_temp.t(1, '00:20'), 'US-0010');
-- K5TWO: a two-fer on day 1 whose younger row a day-2 row continues.
select pg_temp.spot('pota', 'K5TWO', 'N4AAA', pg_temp.t(1, '23:30'), 'US-0012');
select pg_temp.spot('pota', 'K5TWO', 'N4AAA', pg_temp.t(1, '23:35'), 'US-0013');
select pg_temp.spot('pota', 'K5TWO', 'N4AAA', pg_temp.t(1, '23:50'), 'US-0012');
select pg_temp.spot('pota', 'K5TWO', 'N4AAA', pg_temp.t(2, '00:05'), 'US-0013');
-- K6TRI: a three-fer whose rows all meet once the first grows.
select pg_temp.spot('pota', 'K6TRI', 'N4AAA', pg_temp.t(1, '10:00'), 'US-0014');
select pg_temp.spot('pota', 'K6TRI', 'N4AAA', pg_temp.t(1, '10:01'), 'US-0015');
select pg_temp.spot('pota', 'K6TRI', 'N4AAA', pg_temp.t(1, '10:20'), 'US-0016');
select pg_temp.spot('pota', 'K6TRI', 'N4AAA', pg_temp.t(1, '10:30'), 'US-0014');
select is(pg_temp.run(2, '00:30'), 12, 'the two-fer spots are read in one pass');

select results_eq(
  $$select "references", reference_names, started_at, last_spot_at from spotted_activations
    where base_callsign = 'K4TWO' and day = pg_temp.d(1)$$,
  $$values (array['US-0010', 'US-0011'], array['Park US-0010', 'Park US-0011'], pg_temp.t(1, '00:05'),
            pg_temp.t(1, '00:20'))$$,
  'interleaved spots at two parks merge into one activation with both references, names aligned');
select is((select count(*)::int from spotted_activations where base_callsign = 'K4TWO'), 2,
  'the younger row is gone');
select is((select count(*)::int from spotted_activation_spots
           where activation_id = pg_temp.act('K4TWO', pg_temp.t(1, '00:05'))), 3,
  'its spots belong to the survivor');
select is((select count(*)::int from spotted_activation_spots s
           join spotted_activations a on a.id = s.activation_id where a.base_callsign = 'K4TWO'), 4,
  'and no spot is lost or left behind');
select is((select continued_from from spotted_activations where id = pg_temp.act('K4TWO', pg_temp.t(1, '00:05'))),
  pg_temp.act('K4TWO', pg_temp.t(0, '23:50')), 'the younger row''s continued_from moves to the survivor');
select is((select continued_from from spotted_activations where id = pg_temp.act('K5TWO', pg_temp.t(2, '00:05'))),
  pg_temp.act('K5TWO', pg_temp.t(1, '23:30')), 'a row that continued the younger row now continues the survivor');
select is((select "references" from spotted_activations where id = pg_temp.act('K5TWO', pg_temp.t(1, '23:30'))),
  array['US-0012', 'US-0013'], 'that two-fer has both references');
select results_eq(
  $$select "references", spot_count from spotted_activations where base_callsign = 'K6TRI'$$,
  $$values (array['US-0014', 'US-0015', 'US-0016'], 4)$$,
  'a row that grows into several others merges with all of them');

-- ---------------------------------------------------------------------------
-- A rover day and a single spot
-- ---------------------------------------------------------------------------

select pg_temp.reset();
select pg_temp.spot('pota', 'K6ROV', 'N4AAA', pg_temp.t(1, x.at), x.ref)
from (values ('14:00', 'US-0020'), ('14:12', 'US-0020'), ('14:31', 'US-0020'), ('14:40', 'US-0020'),
             ('15:30', 'US-0021'), ('15:45', 'US-0021'), ('16:10', 'US-0021'), ('17:20', 'US-0022')) as x(at, ref);
select pg_temp.run(1, '18:30');
select results_eq(
  $$select "references", spot_count, day from spotted_activations where base_callsign = 'K6ROV' order by started_at$$,
  $$values (array['US-0020'], 4, pg_temp.d(1)), (array['US-0021'], 3, pg_temp.d(1)), (array['US-0022'], 1, pg_temp.d(1))$$,
  'a rover''s three parks in a day stay three, and a single spot closes as a one-spot activation');

-- A spot read out of order can bridge two runs of one park: in time order they would have been one.
select pg_temp.reset();
select pg_temp.spot('pota', 'K6BRG', 'N4AAA', pg_temp.t(1, x.at), 'US-0023') from (values ('18:00'), ('18:10'), ('19:30')) as x(at);
select pg_temp.spot('pota', 'K6BRG', 'N4AAA', pg_temp.t(1, '18:50'), 'US-0023', p_ingested => pg_temp.t(1, '19:31'));
select pg_temp.spot('pota', 'K6HOP', 'N4AAA', pg_temp.t(1, x.at), x.ref)
from (values ('14:00', 'US-0024'), ('14:30', 'US-0024'), ('14:40', 'US-0025')) as x(at, ref);
select pg_temp.run(1, '21:00');
select results_eq(
  $$select started_at, last_spot_at, spot_count from spotted_activations where base_callsign = 'K6BRG'$$,
  $$values (pg_temp.t(1, '18:00'), pg_temp.t(1, '19:30'), 4)$$,
  'a spot read out of order that bridges two runs at one park makes them one activation');
select results_eq(
  $$select "references" from spotted_activations where base_callsign = 'K6HOP' order by started_at$$,
  $$values (array['US-0024']), (array['US-0025'])$$,
  'a rover''s parks within the gap of each other still stay apart');

-- ---------------------------------------------------------------------------
-- 00:00 UTC
-- ---------------------------------------------------------------------------

select pg_temp.reset();
select pg_temp.spot('pota', 'K7MID', 'N4AAA', pg_temp.t(0, x.at), 'US-0030')
from (values ('23:40'), ('23:58')) as x(at);
select pg_temp.spot('pota', 'K7MID', 'N4AAA', pg_temp.t(1, x.at), 'US-0030')
from (values ('00:02'), ('00:20')) as x(at);
-- The 00:02 spot is read before the 23:58 one.
select pg_temp.spot('pota', 'K7OOO', 'N4AAA', pg_temp.t(1, '00:02'), 'US-0031', p_ingested => pg_temp.t(1, '00:02:05'));
select pg_temp.spot('pota', 'K7OOO', 'N4AAA', pg_temp.t(0, '23:58'), 'US-0031', p_ingested => pg_temp.t(1, '00:03'));
select pg_temp.spot('sotawatch', 'K7SOT', 'N4AAA', pg_temp.t(0, '23:50'), 'W4C/CM-001');
select pg_temp.spot('sotawatch', 'K7SOT', 'N4AAA', pg_temp.t(1, '00:10'), 'W4C/CM-001');
select pg_temp.run(1, '01:30');

select results_eq(
  $$select day, started_at, last_spot_at from spotted_activations where base_callsign = 'K7MID' order by started_at$$,
  $$values (pg_temp.d(0), pg_temp.t(0, '23:40'), pg_temp.t(0, '23:58')),
           (pg_temp.d(1), pg_temp.t(1, '00:02'), pg_temp.t(1, '00:20'))$$,
  'a POTA run across 00:00 UTC splits into one activation per UTC day');
select is((select continued_from from spotted_activations where id = pg_temp.act('K7MID', pg_temp.t(1, '00:02'))),
  pg_temp.act('K7MID', pg_temp.t(0, '23:40')), 'the later half continues the earlier');
select is(public.spotted_activation(pg_temp.act('K7MID', pg_temp.t(0, '23:40'))) -> 'split',
  jsonb_build_object('continuedFrom', null, 'continuedBy', pg_temp.act('K7MID', pg_temp.t(1, '00:02'))),
  'the earlier half''s continuedBy is derived');
select is(public.spotted_activation(pg_temp.act('K7MID', pg_temp.t(1, '00:02'))) -> 'split',
  jsonb_build_object('continuedFrom', pg_temp.act('K7MID', pg_temp.t(0, '23:40')), 'continuedBy', null),
  'the later half''s continuedFrom');
select is((select continued_from from spotted_activations where id = pg_temp.act('K7OOO', pg_temp.t(1, '00:02'))),
  pg_temp.act('K7OOO', pg_temp.t(0, '23:58')), 'the split links when the 00:02 spot is read before the 23:58 one');
select results_eq(
  $$select day, "references", reference_names, spot_count from spotted_activations where base_callsign = 'K7SOT'$$,
  $$values (pg_temp.d(0), array['W4C/CM-001'], array['Mount Test'], 2)$$,
  'a SOTA run across midnight does not split, and the summit is named from the reference list');

select pg_temp.reset();
select set_config('timezone', 'America/New_York', true);
select pg_temp.spot('pota', 'K7TZ', 'N4AAA', pg_temp.t(0, '23:50'), 'US-0032');
select pg_temp.spot('pota', 'K7TZ', 'N4AAA', pg_temp.t(1, '00:10'), 'US-0032');
select pg_temp.run(1, '01:30');
select results_eq(
  $$select day, continued_from is not null from spotted_activations where base_callsign = 'K7TZ' order by started_at$$,
  $$values (pg_temp.d(0), false), (pg_temp.d(1), true)$$,
  'the split is at 00:00 UTC whatever the session time zone');
select set_config('timezone', 'UTC', true);

-- ---------------------------------------------------------------------------
-- SOTAwatch spotters, comment edits
-- ---------------------------------------------------------------------------

select pg_temp.reset();
select pg_temp.spot('sotawatch', 'K8SOT', null, pg_temp.t(0, '10:00'), 'W4C/CM-001');
select pg_temp.spot('sotawatch', 'K8SOT', 'N4AAA', pg_temp.t(0, '10:10'), 'W4C/CM-001');
select pg_temp.spot('sotawatch', 'K8SOT', 'N4AAA', pg_temp.t(0, '10:20'), null);
select is(pg_temp.run(0, '11:30'), 2, 'a SOTAwatch QRT without a summit is skipped');
select is((select spot_count from spotted_activations where base_callsign = 'K8SOT'), 2,
  'a SOTAwatch spot with no spotter attaches');
select ok(exists (select 1 from spotted_activation_spots where spotter is null and source = 'sotawatch'),
  'and keeps its null spotter');

select pg_temp.reset();
select pg_temp.spot('pota', 'K9EDT', 'N4AAA', pg_temp.t(0, '10:00'), 'US-0040', p_spot_id => 'edit-1', p_hash => 'h1');
select pg_temp.spot('pota', 'K9EDT', 'N4AAA', pg_temp.t(0, '10:00'), 'US-0040', p_spot_id => 'edit-1', p_hash => 'h2');
select pg_temp.spot('pota', 'K9EDT', 'N4AAA', pg_temp.t(0, '10:10'), 'US-0040');
select pg_temp.run(0, '11:30');
select is((select spot_count from spotted_activations where base_callsign = 'K9EDT'), 2,
  'a POTA comment edit (same source_spot_id, new hash) does not raise the spot count');

-- ---------------------------------------------------------------------------
-- RBN and DX Cluster at close
-- ---------------------------------------------------------------------------

select pg_temp.reset();
select pg_temp.spot('pota', 'K0RBN', 'N4AAA', pg_temp.t(0, '10:00:40'), 'US-0045');
select pg_temp.spot('pota', 'K0RBN', 'N4AAA', pg_temp.t(0, '10:30'), 'US-0045');
select pg_temp.rbn('K0RBN', 'DL1EEE-#', pg_temp.t(0, '10:00'), '20m');
select pg_temp.rbn('K0RBN', 'VE3DDD-#', pg_temp.t(0, '10:15'), '20m', 'DX');
select pg_temp.rbn('K0RBN/P', 'N4AAA-#', pg_temp.t(0, '10:16'), '20m');
select pg_temp.rbn('K0RBN', 'DL1EEE-#', pg_temp.t(0, '10:15'), '40m');
select pg_temp.rbn('K0RBN', 'DL1EEE-#', pg_temp.t(0, '10:20'), '20m', 'BEACON');
select pg_temp.rbn('K0RBN', 'DL1EEE-#', pg_temp.t(0, '10:31'), '20m');
select pg_temp.rbn('K0RBN', 'DL1EEE-#', pg_temp.t(0, '09:59'), '20m');
select pg_temp.spot('dxcluster', 'K0RBN', 'W9FFF', pg_temp.t(0, '10:10'), null);
select pg_temp.spot('dxcluster', 'K0RBN', 'W9FFF', pg_temp.t(0, '10:12'), null, p_band => '40m');
select pg_temp.spot('dxcluster', 'K0RBN', 'W9FFF', pg_temp.t(0, '10:33'), null);
select is(pg_temp.run(0, '11:30'), 2, 'DX Cluster spots without an IOTA reference are not reference spots');
select is((select source_counts from spotted_activations where base_callsign = 'K0RBN'),
  '{"pota": 2, "rbn": 3, "dxcluster": 1}'::jsonb, 'RBN and DX Cluster spots join at close');
select results_eq(
  $$select s.source, s.spot_time, s.spotter from spotted_activation_spots s
    where s.source in ('rbn', 'dxcluster') order by s.spot_time, s.spotter$$,
  $$values ('rbn', pg_temp.t(0, '10:00'), 'DL1EEE-#'), ('dxcluster', pg_temp.t(0, '10:10'), 'W9FFF'),
           ('rbn', pg_temp.t(0, '10:15'), 'VE3DDD-#'), ('rbn', pg_temp.t(0, '10:16'), 'N4AAA-#')$$,
  'RBN in the first minute and inside the window, on the reference spots'' band, CQ or DX only; DX Cluster likewise');

-- ---------------------------------------------------------------------------
-- Places, hidden calls and the payload shapes
-- ---------------------------------------------------------------------------

select pg_temp.reset();
select pg_temp.spot('pota', 'K4GEO', x.spotter, pg_temp.t(0, '10:00') + x.n * interval '5 minutes', 'US-0100')
from (values (0, 'K4GEO'), (1, 'N4AAA'), (2, 'KL7BBB'), (3, 'KL7CCC'), (4, 'VE3DDD'), (5, 'DL1EEE'), (6, 'W9FFF'))
       as x(n, spotter);
select pg_temp.run(0, '11:30');

select results_eq(
  $$select states, countries, spot_count, location_states, latitude, longitude
    from spotted_activations where base_callsign = 'K4GEO'$$,
  $$values (array['AK', 'NC'], array['Alaska', 'Canada', 'Fed. Rep. of Germany'], 7, array['NC'], 35.5, -79.0)$$,
  'states from license states (a KL7 with an AK license is Alaska, the state), countries from cty.dat for the rest');
select is((select farthest from spotted_activations where base_callsign = 'K4GEO'),
  jsonb_build_object('kind', 'country', 'code', 'DL', 'name', 'Fed. Rep. of Germany',
                     'km', round(public.great_circle_km(35.5, -79.0, 51.0, 10.0))::int),
  'farthest is the greatest great-circle distance from the reference');

create temp table geo as
select public.spotted_activation(id) as p, id from spotted_activations where base_callsign = 'K4GEO';

select is((select (p ->> 'spotCount')::int from geo), 7, 'self-spots count in spotCount');
select is((select sum((h ->> 'spots')::int)::int from geo, jsonb_array_elements(p -> 'heard') h), 5,
  'but not in heard, and neither does a US spotter with no license state');
select is((select array_agg(h ->> 'kind' || ':' || (h ->> 'code') order by h ->> 'kind', h ->> 'code')
           from geo, jsonb_array_elements(p -> 'heard') h),
  array['country:DL', 'country:KL', 'country:VE', 'state:AK', 'state:NC'], 'heard has every place once');
select is((select p -> 'heard' -> 0 from geo),
  '{"kind": "state", "code": "AK", "name": "Alaska", "latitude": 63.9244, "longitude": -152.3794, "spots": 1}'::jsonb,
  'a state is drawn at its centroid');
select is((select p -> 'location' from geo), '{"latitude": 35.5, "longitude": -79.0, "states": ["NC"]}'::jsonb,
  'location comes from the reference list');
select is((select p -> 'sources' from geo), '{"pota": 7}'::jsonb, 'sources counts each source');
select is((select p -> 'spots' -> 0 from geo),
  jsonb_build_object('time', public.spotted_activation_time(pg_temp.t(0, '10:00')), 'source', 'pota',
                     'spotter', 'K4GEO', 'spotterBase', 'K4GEO', 'selfSpot', true, 'place', 'United States',
                     'frequencyKhz', 14250.000, 'mode', 'ssb', 'references', jsonb_build_array('US-0100')),
  'a spot row');
select is((select p -> 'spots' -> 1 ->> 'place' from geo), 'North Carolina', 'a licensed spotter''s place is its state');

select is(pg_temp.keys((select p from geo)),
  array['bands', 'callsign', 'day', 'durationSeconds', 'farthest', 'heard', 'id', 'lastSpotAt', 'location', 'modes',
        'program', 'referenceNames', 'references', 'sources', 'split', 'spotCount', 'spots', 'startedAt'],
  'SpottedActivation''s keys');
select is(pg_temp.keys((select p -> 'split' from geo)), array['continuedBy', 'continuedFrom'], 'split''s keys');
select is(pg_temp.keys((select p -> 'location' from geo)), array['latitude', 'longitude', 'states'], 'location''s keys');
select is(pg_temp.keys((select p -> 'heard' -> 0 from geo)),
  array['code', 'kind', 'latitude', 'longitude', 'name', 'spots'], 'a heard place''s keys');
select is(pg_temp.keys((select p -> 'farthest' from geo)), array['code', 'kind', 'km', 'name'], 'farthest''s keys');
select is(pg_temp.keys((select p -> 'spots' -> 0 from geo)),
  array['frequencyKhz', 'mode', 'place', 'references', 'selfSpot', 'source', 'spotter', 'spotterBase', 'time'],
  'a spot''s keys');
select results_eq(
  $$select p ->> 'callsign', p ->> 'program', p -> 'references', p -> 'referenceNames', p ->> 'day',
           p ->> 'startedAt', p ->> 'lastSpotAt', (p ->> 'durationSeconds')::int from geo$$,
  $$values ('K4GEO', 'pota', '["US-0100"]'::jsonb, '["Park US-0100"]'::jsonb, pg_temp.d(0)::text,
            public.spotted_activation_time(pg_temp.t(0, '10:00')), public.spotted_activation_time(pg_temp.t(0, '10:30')),
            1800)$$,
  'the header values');

create temp table geo_list as select public.callsign_spotted_activations('k4geo/p', now()) as p;
select is(pg_temp.keys((select p from geo_list)), array['callsign', 'more', 'recent', 'summary'],
  'CallsignActivations'' keys');
select is(pg_temp.keys((select p -> 'summary' from geo_list)),
  array['activations', 'mostActivated', 'onAirSeconds', 'references'], 'summary''s keys');
select is(pg_temp.keys((select p -> 'summary' -> 'references' from geo_list)),
  array['iota', 'pota', 'sota', 'total', 'wwbota', 'wwff'], 'summary.references'' keys');
select is(pg_temp.keys((select p -> 'summary' -> 'mostActivated' from geo_list)),
  array['name', 'program', 'reference', 'times'], 'mostActivated''s keys');
select is(pg_temp.keys((select p -> 'recent' -> 0 from geo_list)),
  array['bands', 'continuedBy', 'continuedFrom', 'countries', 'day', 'durationSeconds', 'id', 'lastSpotAt', 'modes',
        'program', 'referenceNames', 'references', 'spotCount', 'startedAt', 'states'],
  'ActivationCard''s keys');
select is((select p ->> 'callsign' from geo_list), 'K4GEO', 'the list names the base call');
select is((select p -> 'recent' -> 0 -> 'spotCount' || jsonb_build_array(p -> 'recent' -> 0 -> 'states',
                                                                         p -> 'recent' -> 0 -> 'countries')
           from geo_list), '[7, 2, 3]'::jsonb, 'a card counts spots, states and countries');

-- A hidden spotter is left out and the places are recomputed; a hidden activator has no pages.
insert into hidden_callsigns (callsign) values ('DL1EEE');
select is((select (public.spotted_activation(id) ->> 'spotCount')::int from geo), 6, 'a hidden spotter''s spot is left out');
select ok((select not (public.spotted_activation(id) -> 'heard' @> '[{"code": "DL"}]') from geo),
  'and its country with it');
select is((select public.spotted_activation(id) -> 'farthest' ->> 'code' from geo),
  (select case when public.great_circle_km(35.5, -79.0, 63.9244, -152.3794)
                    > public.great_circle_km(35.5, -79.0, 61.4, -148.87) then 'AK' else 'KL' end),
  'farthest is recomputed without it');
select is((select public.callsign_spotted_activations('K4GEO', now()) -> 'recent' -> 0 -> 'countries'), '2'::jsonb,
  'the card''s count is recomputed too');

insert into hidden_callsigns (callsign) values ('K4GEO');
select is((select public.spotted_activation(id) from geo), null, 'a hidden activator''s activation is null');
select is(public.callsign_spotted_activations('K4GEO', now()), null, 'and so is its list');
delete from hidden_callsigns;

-- ---------------------------------------------------------------------------
-- WWBOTA, IOTA, redirects and what is not shown
-- ---------------------------------------------------------------------------

select pg_temp.reset();
select pg_temp.spot('wwbota', 'G0BUN', 'N4AAA', pg_temp.t(0, '10:00'), null, p_refs => array['B/G-0001', 'B/G-0002']);
select pg_temp.spot('wwbota', 'G0BUN', 'N4AAA', pg_temp.t(0, '10:10'), null, p_refs => array['b/g-0002', 'B/G-0003']);
select pg_temp.spot('dxcluster', 'EA8ISL', 'N4AAA', pg_temp.t(0, '10:00'), 'AF-004');
select pg_temp.spot('pota', 'K2OPN', 'N4AAA', pg_temp.t(0, '11:20'), 'US-0060');
select pg_temp.run(0, '11:30');

select results_eq(
  $$select program, "references", reference_names from spotted_activations
    where base_callsign in ('G0BUN', 'EA8ISL') order by program$$,
  $$values ('iota', array['AF-004'], array['Island AF-004']),
           ('wwbota', array['B/G-0001', 'B/G-0002', 'B/G-0003'], array['Bunker B/G-0001', 'Bunker b/g-0002', null])$$,
  'WWBOTA bunkers expand to references with aligned names; IOTA comes through DX Cluster');
select is((select array_agg(public.spotted_activation(id) -> 'location' order by program) from spotted_activations
           where base_callsign in ('G0BUN', 'EA8ISL')),
  array['null'::jsonb, 'null'::jsonb], 'WWBOTA and IOTA activations have no location');
select is((select farthest from spotted_activations where base_callsign = 'G0BUN'), null,
  'and no farthest place');

insert into spotted_activation_redirects (old_id, new_id)
select 'zzzzzzzzzzzz', id from spotted_activations where base_callsign = 'EA8ISL';
select is(public.spotted_activation('zzzzzzzzzzzz'),
  (select public.spotted_activation(id) from spotted_activations where base_callsign = 'EA8ISL'),
  'a redirected id resolves to the canonical payload');
select is(public.spotted_activation('zzzzzzzzzzzz') ->> 'id',
  (select id from spotted_activations where base_callsign = 'EA8ISL'), 'whose id is the canonical one');
select is(public.spotted_activation('aaaaaaaaaaaa'), null, 'an unknown id is null');
select is((select public.spotted_activation(id) from spotted_activations where base_callsign = 'K2OPN'), null,
  'an open activation is null');
select ok((select bool_and(id ~ '^[a-z2-7]{12}$') from spotted_activations), 'ids are 12 characters of [a-z2-7]');

-- ---------------------------------------------------------------------------
-- The twelve-month summary and the list's cap
-- ---------------------------------------------------------------------------

select pg_temp.reset();
insert into spotted_activations (id, base_callsign, program, "references", reference_names, day, started_at,
                                 last_spot_at, closed_at)
select public.new_activation_id(), 'K5SUM', x.program, x.refs, x.names,
       ((now() - x.ago) at time zone 'utc')::date, now() - x.ago, now() - x.ago + x.dur, now()
from (values ('pota', array['US-0050'], array['Summary Park'], interval '10 days', interval '1 hour'),
             ('pota', array['US-0050', 'US-0051'], array[null, 'Other Park'], interval '20 days', interval '30 minutes'),
             ('pota', array['US-0050'], array['Summary Park'], interval '30 days', interval '10 minutes'),
             ('sota', array['W4C/CM-001'], array['Mount Test'], interval '40 days', interval '20 minutes'),
             ('pota', array['US-0099'], array['Old Park'], interval '13 months', interval '1 hour'))
       as x(program, refs, names, ago, dur);
create temp table sum_list as select public.callsign_spotted_activations('K5SUM', now()) as p;
select is((select p -> 'summary' from sum_list),
  '{"activations": 4, "references": {"total": 3, "pota": 2, "sota": 1, "wwff": 0, "wwbota": 0, "iota": 0},
    "onAirSeconds": 7200,
    "mostActivated": {"program": "pota", "reference": "US-0050", "name": "Summary Park", "times": 3}}'::jsonb,
  'the summary covers the past 12 months');
select is((select jsonb_array_length(p -> 'recent') from sum_list), 5, 'recent is not limited to 12 months');
select is((select p -> 'more' from sum_list), 'false'::jsonb, 'more is false under the cap');

insert into spotted_activations (id, base_callsign, program, "references", reference_names, day, started_at,
                                 last_spot_at, closed_at)
select public.new_activation_id(), 'K5MOR', 'pota', array['US-0070'], array[null::text],
       ((now() - g * interval '1 day') at time zone 'utc')::date, now() - g * interval '1 day',
       now() - g * interval '1 day', now()
from generate_series(1, 201) as g;
select is((select jsonb_array_length(public.callsign_spotted_activations('K5MOR', now()) -> 'recent')), 200,
  'recent holds at most 200');
select is(public.callsign_spotted_activations('K5MOR', now()) -> 'more', 'true'::jsonb, 'with more when there were more');
select is(public.callsign_spotted_activations('K5MOR', now()) -> 'recent' -> 0 ->> 'startedAt',
  public.spotted_activation_time(now() - interval '1 day'), 'newest first');
select is(public.callsign_spotted_activations('P/1', now()), null, 'a malformed call is null');
select is(public.callsign_spotted_activations('W0NONE', now()),
  '{"callsign": "W0NONE", "more": false, "recent": [],
    "summary": {"activations": 0, "references": {"total": 0, "pota": 0, "sota": 0, "wwff": 0, "wwbota": 0, "iota": 0},
                "onAirSeconds": 0, "mostActivated": null}}'::jsonb,
  'a call with no activations gets an empty list');

-- ---------------------------------------------------------------------------
-- Grants and the job
-- ---------------------------------------------------------------------------

select ok(not has_function_privilege('anon', 'public.assemble_spotted_activations(timestamptz)', 'execute')
          and not has_function_privilege('authenticated', 'public.assemble_spotted_activations(timestamptz)', 'execute')
          and not has_function_privilege('anon', 'public.spotted_activation(text)', 'execute')
          and not has_function_privilege('authenticated', 'public.spotted_activation(text)', 'execute')
          and not has_function_privilege('anon', 'public.callsign_spotted_activations(text, timestamptz)', 'execute')
          and not has_function_privilege('authenticated', 'public.callsign_spotted_activations(text, timestamptz)', 'execute'),
  'clients cannot run the job or the read RPCs');
select ok(has_function_privilege('service_role', 'public.assemble_spotted_activations(timestamptz)', 'execute')
          and has_function_privilege('service_role', 'public.spotted_activation(text)', 'execute')
          and has_function_privilege('service_role', 'public.callsign_spotted_activations(text, timestamptz)', 'execute'),
  'the service role can');
select is_empty(
  $$select c.relname::text from pg_class c
    where c.oid in ('public.spotted_activations'::regclass, 'public.spotted_activation_redirects'::regclass,
                    'public.spotted_activation_spots'::regclass, 'public.spotted_activation_state'::regclass,
                    'public.us_state_centroids'::regclass)
      and (not c.relrowsecurity
           or has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select')
           or exists (select 1 from pg_policy p where p.polrelid = c.oid))$$,
  'every new table has RLS on, no policies and no client grants');
select is_empty(
  $$select p.proname::text from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('activation_gap', 'activation_ingest_lag', 'activation_batch_limit', 'activation_close_limit',
                        'great_circle_km', 'activation_merge_references', 'new_activation_id',
                        'spotted_activation_heard', 'spotted_activation_farthest', 'assemble_spotted_activations',
                        'spotted_activation_time', 'spotted_activation_continued_by',
                        'spotted_activation_continued_from', 'spotted_activation', 'callsign_spotted_activations')
      and (not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
           or has_function_privilege('anon', p.oid, 'execute')
           or has_function_privilege('authenticated', p.oid, 'execute'))$$,
  'every new function pins search_path and is closed to clients');
select results_eq(
  $$select schedule::text, command::text from cron.job where jobname = 'assemble-spotted-activations'$$,
  $$values ('* * * * *', ' select public.assemble_spotted_activations(now()); ')$$,
  'assemble-spotted-activations runs every minute');

select * from finish();
rollback;

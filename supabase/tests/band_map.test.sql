-- pgTAP: band_map_snapshot(), band_map_cache and cached_band_map()
-- (20261014000600). Pins the payload shape (BandMapPayload in
-- web/src/bandmap/types.ts), the sources, the 5-minute window, one row per
-- base call per band, the 30-second cache and access.
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

-- The window is relative to now(), so seeded or freshly ingested spots may sit
-- in it too. Every check below looks only at this suite's XX calls.
create function pg_temp.spots() returns setof jsonb
language sql as $$
  select s
  from jsonb_array_elements(public.band_map_snapshot() -> 'bands') b,
       jsonb_array_elements(b -> 'spots') s
  where s ->> 'base_callsign' like 'XX%'
$$;
create function pg_temp.rows() returns text[]
language sql as $$
  select coalesce(array_agg(s ->> 'source' || ':' || (s ->> 'callsign') || '@' || trim_scale((s ->> 'frequency_khz')::numeric)
                            order by (s ->> 'frequency_khz')::numeric, s ->> 'callsign'), '{}')
  from pg_temp.spots() s
$$;
create function pg_temp.ago(p_seconds int) returns timestamptz
language sql as $$ select now() - make_interval(secs => p_seconds) $$;

insert into hidden_callsigns (callsign, note) values ('XX9HID', 'test') on conflict do nothing;

insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, spotter, frequency_khz, band, mode,
                       pota_reference, pota_park_name, sota_summit_ref, raw_payload)
values
  -- XX1A on 20m twice, POTA then DX Cluster: the later one wins.
  ('pota',      'a1', 'a1', pg_temp.ago(200), 'XX1A',   'XX1SP', 14062,   '20m', 'cw',  'US-0817', 'Pisgah', null, '{"secret": 1}'),
  ('dxcluster', 'a2', 'a2', pg_temp.ago(60),  'XX1A',   'XX2SP', 14064.5, '20m', 'cw',  null, null, null, '{"secret": 1}'),
  -- And once on 40m: another band, another row.
  ('pota',      'a3', 'a3', pg_temp.ago(120), 'XX1A',   'XX1SP', 7032,    '40m', 'cw',  'US-0817', 'Pisgah', null, '{"secret": 1}'),
  -- XX1B/P and XX1B are one station: the later spot, as typed, is its row.
  ('sotawatch', 'b1', 'b1', pg_temp.ago(30),  'XX1B/P', 'XX3SP', 14285,   '20m', 'ssb', null, null, 'W4C/CM-001', '{"secret": 1}'),
  ('dxcluster', 'b2', 'b2', pg_temp.ago(90),  'XX1B',   'XX3SP', 14280,   '20m', 'ssb', null, null, null, '{"secret": 1}'),
  -- Left out: RBN, older than 5 minutes, a hidden call, outside every band.
  ('rbn',       'x1', 'x1', pg_temp.ago(10),  'XX1RBN', 'XX4SP', 14025,   '20m', 'cw',  null, null, null, '{}'),
  ('pota',      'x2', 'x2', pg_temp.ago(301), 'XX1OLD', 'XX1SP', 14062,   '20m', 'cw',  'US-0001', 'Old', null, '{}'),
  ('pota',      'x3', 'x3', pg_temp.ago(10),  'XX9HID/P', 'XX1SP', 14062, '20m', 'cw',  'US-0002', 'Hid', null, '{}'),
  ('dxcluster', 'x4', 'x4', pg_temp.ago(10),  'XX1OOB', 'XX4SP', 12345,   null,  null,  null, null, null, '{}');

select is(pg_temp.rows(),
  array['pota:XX1A@7032', 'dxcluster:XX1A@14064.5', 'sotawatch:XX1B/P@14285'],
  'one row per base call per band, the latest spot winning');
select ok(not exists (select 1 from pg_temp.spots() s where s ->> 'source' not in ('pota', 'sotawatch', 'dxcluster')),
  'only POTA, SOTAwatch and DX Cluster spots appear');
select ok(not exists (select 1 from pg_temp.spots() s where s ->> 'callsign' = 'XX1RBN'), 'RBN spots are left out');
select ok(not exists (select 1 from pg_temp.spots() s where s ->> 'callsign' = 'XX1OLD'), 'spots older than 5 minutes are left out');
select ok(not exists (select 1 from pg_temp.spots() s where s ->> 'base_callsign' = 'XX9HID'), 'hidden calls are left out');
select is((select count(*)::int from pg_temp.spots() s where s ->> 'base_callsign' = 'XX1B'), 1,
  'XX1B/P and XX1B collapse to one row');

select is((select s from pg_temp.spots() s where s ->> 'callsign' = 'XX1B/P') - 'id',
  jsonb_build_object('callsign', 'XX1B/P', 'base_callsign', 'XX1B', 'frequency_khz', 14285, 'mode', 'ssb',
                     'source', 'sotawatch', 'spot_time', pg_temp.ago(30), 'spotter', 'XX3SP',
                     'reference', 'W4C/CM-001', 'reference_name', null),
  'a spot''s shape, with a summit reference');
select is((select s ->> 'reference_name' from pg_temp.spots() s where s ->> 'callsign' = 'XX1A' and (s ->> 'frequency_khz')::numeric = 7032), 'Pisgah', 'a park reference carries its name');
select ok(position('raw_payload' in public.band_map_snapshot()::text) = 0
          and position('secret' in public.band_map_snapshot()::text) = 0,
  'raw_payload is not in the output');
select ok((select bool_and(b ?& array['band', 'spots'] and (select count(*) from jsonb_object_keys(b)) = 2)
           from jsonb_array_elements(public.band_map_snapshot() -> 'bands') b),
  'each band is {band, spots}');

-- The cache: a fresh row is served as is, a stale one is rebuilt.
delete from band_map_cache;
insert into band_map_cache (payload, generated_at) values ('{"bands": "cached"}', clock_timestamp());
select is(public.cached_band_map() -> 'bands', '"cached"'::jsonb, 'a cache under 30 seconds old is served without a rebuild');
update band_map_cache set generated_at = clock_timestamp() - interval '31 seconds';
select is(jsonb_typeof(public.cached_band_map() -> 'bands'), 'array', 'an older one is rebuilt');
select is((select count(*)::int from band_map_cache), 1, 'the cache keeps one row');
select is(public.cached_band_map() ->> 'generated_at', (select to_jsonb(generated_at) #>> '{}' from band_map_cache),
  'the payload carries the cache''s generated_at');

-- Access: only the Edge Function's service role reads the cache or runs the functions.
select ok(not has_table_privilege('anon', 'band_map_cache', 'select')
          and not has_table_privilege('authenticated', 'band_map_cache', 'select'), 'clients cannot read the cache');
select ok(not exists (
  select 1 from unnest(array['public.band_map_snapshot()', 'public.cached_band_map()']) as f
  where has_function_privilege('authenticated', f, 'execute') or has_function_privilege('anon', f, 'execute')),
  'clients cannot run the band map functions');
select ok(has_function_privilege('service_role', 'public.cached_band_map()', 'execute'), 'the service role can');

select * from finish();
rollback;

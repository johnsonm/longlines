-- Smoke test for the applied schema. Run by CI against a fresh local Postgres
-- after the migrations; safe to run locally too (it rolls itself back).
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f scripts/smoke-test.sql

begin;

do $$
declare
  n int;
  first_pass int;
  second_pass int;
  spots_before int := (select count(*) from raw_spots);
  queue_before int := (select count(*) from pgmq.q_spot_events);
begin
  -- Cron jobs are scheduled.
  select count(*) into n from cron.job where jobname in ('ingest-pota', 'ingest-sotawatch');
  assert n = 2, format('expected 2 cron jobs, found %s', n);
  assert exists (select 1 from cron.job where jobname = 'ingest-sotawatch' and schedule = '30 seconds'),
    'ingest-sotawatch should run every 30 seconds';

  -- ingest_state is seeded.
  select count(*) into n from ingest_state;
  assert n = 4, format('expected 4 ingest_state rows, found %s', n);

  -- ingest_spots inserts, dedups and enqueues.
  select count(*) into first_pass from public.ingest_spots('[
    {"source":"pota","source_spot_id":"smoke-1","content_hash":"a","spot_time":"2026-10-05T13:37:03Z","callsign":"W1AW","spotter":null,"frequency_khz":14074,"band":"20m","mode":"ft8","mode_family":"digital","comment":"","raw_payload":{}},
    {"source":"sotawatch","source_spot_id":"smoke-2","content_hash":"b","spot_time":"2026-10-05T13:37:03Z","callsign":"SQ1GPR/P","spotter":"SQ1GPR","frequency_khz":7097,"band":"40m","mode":"ssb","comment":"","sota_summit_ref":"SP/SS-004","raw_payload":{}},
    {"source":"rbn","source_spot_id":"2026-10-11T14:54:00.000Z|SM1HEV|CT1JGA/P|14038.30","content_hash":"c","spot_time":"2026-10-11T14:54:00Z","callsign":"CT1JGA/P","spotter":"SM1HEV","frequency_khz":14038.3,"band":"20m","mode":"cw","mode_family":"cw","comment":"8 dB 24 WPM CQ","raw_payload":{}},
    {"source":"dxcluster","source_spot_id":"2026-10-12T13:18:00.000Z|EA1FIC|SV8/DJ0MY|14305.0","content_hash":"d","spot_time":"2026-10-12T13:18:00Z","callsign":"SV8/DJ0MY","spotter":"EA1FIC","frequency_khz":14305,"band":"20m","mode":"ssb","mode_family":"phone","comment":"SSB [POTA] GR-0131 cq cq","raw_payload":{}}
  ]'::jsonb);
  assert first_pass = 4, format('expected 4 inserted rows, got %s', first_pass);
  assert (select mode_family from raw_spots where source = 'pota' and source_spot_id = 'smoke-1') = 'digital',
    'expected smoke-1 to store mode_family digital';

  select count(*) into second_pass from public.ingest_spots('[
    {"source":"pota","source_spot_id":"smoke-1","content_hash":"a","spot_time":"2026-10-05T13:37:03Z","callsign":"W1AW","frequency_khz":14074,"comment":"","raw_payload":{}},
    {"source":"pota","source_spot_id":"smoke-1","content_hash":"a2","spot_time":"2026-10-05T13:37:03Z","callsign":"W1AW","frequency_khz":14074,"comment":"edited","raw_payload":{}}
  ]'::jsonb);
  assert second_pass = 1, format('expected 1 inserted row on re-run with one edit, got %s', second_pass);

  select count(*) - spots_before into n from raw_spots;
  assert n = 5, format('expected 5 new raw_spots rows, found %s', n);

  select count(*) - queue_before into n from pgmq.q_spot_events;
  assert n = 5, format('expected 5 new queued messages, found %s', n);

  -- State RPCs.
  perform public.record_ingest_success('sotawatch', 1, 'epoch-1');
  perform public.record_ingest_failure('pota', 'boom');
  perform public.record_ingest_success('rbn', 0, null);
  assert (select last_success_at from ingest_state where source = 'rbn') is not null,
    'record_ingest_success should update the rbn row';
  perform public.record_ingest_success('dxcluster', 1, null);
  assert (select last_success_at from ingest_state where source = 'dxcluster') is not null,
    'record_ingest_success should update the dxcluster row';
  assert (select last_epoch from ingest_state where source = 'sotawatch') = 'epoch-1';
  assert (select consecutive_failures from ingest_state where source = 'pota') = 1;

  -- Health view reads.
  select count(*) into n from ingest_health;
  assert n = 4, 'ingest_health should have one row per source';

  -- rbn_spots: the bulk RPC inserts (dedup is covered in rbn_spots.test.sql).
  assert public.ingest_rbn_spots(jsonb_build_array(jsonb_build_object(
    'spot_time', now(), 'received_at', now(), 'spotter', 'W3LPL', 'callsign', 'SM0KE',
    'frequency_khz', 14035.1, 'band', '20m', 'mode', 'cw', 'mode_family', 'cw', 'snr', 12,
    'speed', 22, 'speed_unit', 'WPM', 'spot_type', 'CQ', 'line', 'smoke'))) = 1,
    'ingest_rbn_spots should insert one row';
  assert exists (select 1 from cron.job where jobname = 'maintain-rbn-spots'),
    'maintain-rbn-spots should be scheduled';

  -- Archive: the slice RPCs answer, the job is scheduled, the bucket is private.
  assert (select row_count from public.archive_ndjson('rbn', now() - interval '1 day', now() + interval '1 minute')) >= 1,
    'archive_ndjson should see the smoke rbn row';
  perform * from public.archive_pending_slices('pota', now(), 10);
  assert exists (select 1 from cron.job where jobname = 'archive-spots' and schedule = '*/10 * * * *'),
    'archive-spots should run every 10 minutes';
  assert to_regclass('storage.buckets') is null
      or exists (select 1 from storage.buckets where id = 'archive' and not public),
    'the archive bucket should exist and be private';

  -- Stats snapshot: cron job exists and the refresh inserts one row.
  assert exists (select 1 from cron.job where jobname = 'refresh-stats-snapshot' and schedule = '5 * * * *'),
    'refresh-stats-snapshot should run at five past every hour';
  select count(*) into n from stats_snapshots;
  perform public.refresh_stats_snapshot();
  assert (select count(*) from stats_snapshots) = least(n + 1, 48),
    format('refresh_stats_snapshot should insert one row (had %s)', n);

  -- Countries: the weekly import is scheduled and a load resolves a spotter.
  assert exists (select 1 from cron.job where jobname = 'import-cty' and schedule = '20 4 * * 1'),
    'import-cty should run weekly';
  perform public.load_cty('smoke',
    '[{"prefix":"SM","name":"Sweden","continent":"EU","cq_zone":14,"itu_zone":18,"lat":61.2,"lon":14.57}]',
    '[{"pattern":"SM","exact":false,"entity":"SM","continent":"EU","cq_zone":14,"itu_zone":18}]');
  assert (select continent from public.cty_lookup('SM1HEV-#')) = 'EU',
    'cty_lookup should place SM1HEV in Europe';
end $$;

-- anon must not be able to read the tables.
do $$
begin
  set local role anon;
  begin
    perform count(*) from raw_spots;
    raise exception 'anon could read raw_spots';
  exception when insufficient_privilege then
    null;
  end;
  reset role;
end $$;

rollback;
\echo smoke test passed

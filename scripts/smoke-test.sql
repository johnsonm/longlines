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
  select count(*) into n from cron.job where jobname in ('ingest-pota', 'ingest-sotawatch', 'ingest-wwff', 'ingest-wwbota');
  assert n = 4, format('expected 4 cron jobs, found %s', n);
  assert exists (select 1 from cron.job where jobname = 'ingest-sotawatch' and schedule = '30 seconds'),
    'ingest-sotawatch should run every 30 seconds';
  assert exists (select 1 from cron.job where jobname = 'import-iota' and schedule = '25 4 1 * *'),
    'import-iota should run monthly';

  -- ingest_state is seeded.
  select count(*) into n from ingest_state;
  assert n = 8, format('expected 8 ingest_state rows, found %s', n);

  -- ingest_spots inserts, dedups and enqueues.
  select count(*) into first_pass from public.ingest_spots('[
    {"source":"pota","source_spot_id":"smoke-1","content_hash":"a","spot_time":"2026-10-05T13:37:03Z","callsign":"W1AW","spotter":null,"frequency_khz":14074,"band":"20m","mode":"ft8","mode_family":"digital","comment":"","raw_payload":{}},
    {"source":"sotawatch","source_spot_id":"smoke-2","content_hash":"b","spot_time":"2026-10-05T13:37:03Z","callsign":"SQ1GPR/P","spotter":"SQ1GPR","frequency_khz":7097,"band":"40m","mode":"ssb","comment":"","sota_summit_ref":"SP/SS-004","raw_payload":{}},
    {"source":"rbn","source_spot_id":"2026-10-11T14:54:00.000Z|SM1HEV|CT1JGA/P|14038.30","content_hash":"c","spot_time":"2026-10-11T14:54:00Z","callsign":"CT1JGA/P","spotter":"SM1HEV","frequency_khz":14038.3,"band":"20m","mode":"cw","mode_family":"cw","comment":"8 dB 24 WPM CQ","raw_payload":{}},
    {"source":"dxcluster","source_spot_id":"2026-10-12T13:18:00.000Z|EA1FIC|SV8/DJ0MY|14305.0","content_hash":"d","spot_time":"2026-10-12T13:18:00Z","callsign":"SV8/DJ0MY","spotter":"EA1FIC","frequency_khz":14305,"band":"20m","mode":"ssb","mode_family":"phone","comment":"SSB [POTA] GR-0131 cq cq","iota_reference":"EU-005","raw_payload":{}},
    {"source":"wwff","source_spot_id":"157368","content_hash":"e","spot_time":"2026-10-15T18:25:38Z","callsign":"W3O","spotter":"WA7LNW","frequency_khz":14045.4,"band":"20m","mode":"cw","mode_family":"cw","comment":"Re-spotted via RBN","wwff_reference":"KFF-6101","wwff_reference_name":"State Game Land PA 013","raw_payload":{}},
    {"source":"wwbota","source_spot_id":"2026-10-26T17:23:08.479344Z","content_hash":"f","spot_time":"2026-10-26T17:23:08.479Z","callsign":"EA4IYL","spotter":"EA4IYL","frequency_khz":7138,"band":"40m","mode":"ssb","mode_family":"phone","comment":"B/EA-0105,0104,0103","wwbota_references":["B/EA-0103","B/EA-0104","B/EA-0105"],"wwbota_reference_name":"Búnker 1 del Cerro de los Ángeles","raw_payload":{}}
  ]'::jsonb);
  assert first_pass = 6, format('expected 6 inserted rows, got %s', first_pass);
  assert (select wwff_reference from raw_spots where source = 'wwff' and source_spot_id = '157368') = 'KFF-6101',
    'expected the wwff row to store its reference';
  assert (select wwbota_references from raw_spots where source = 'wwbota' and source_spot_id = '2026-10-26T17:23:08.479344Z')
    = array['B/EA-0103', 'B/EA-0104', 'B/EA-0105'],
    'expected the wwbota row to store every bunker';
  assert (select iota_reference from raw_spots where source = 'dxcluster' and content_hash = 'd') = 'EU-005',
    'expected the dxcluster row to store its IOTA reference';
  assert (select mode_family from raw_spots where source = 'pota' and source_spot_id = 'smoke-1') = 'digital',
    'expected smoke-1 to store mode_family digital';

  select count(*) into second_pass from public.ingest_spots('[
    {"source":"pota","source_spot_id":"smoke-1","content_hash":"a","spot_time":"2026-10-05T13:37:03Z","callsign":"W1AW","frequency_khz":14074,"comment":"","raw_payload":{}},
    {"source":"pota","source_spot_id":"smoke-1","content_hash":"a2","spot_time":"2026-10-05T13:37:03Z","callsign":"W1AW","frequency_khz":14074,"comment":"edited","raw_payload":{}}
  ]'::jsonb);
  assert second_pass = 1, format('expected 1 inserted row on re-run with one edit, got %s', second_pass);

  select count(*) - spots_before into n from raw_spots;
  assert n = 7, format('expected 7 new raw_spots rows, found %s', n);

  select count(*) - queue_before into n from pgmq.q_spot_events;
  assert n = 7, format('expected 7 new queued messages, found %s', n);

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
  assert n = 8, 'ingest_health should have one row per source';

  -- Logged contacts: apply_logged_contacts answers per item. An account without a profile can
  -- post nothing, and a delete of a contact never sent is unknown (and both change nothing).
  assert public.apply_logged_contacts('00000000-0000-0000-0000-00000000005e', jsonb_build_array(
           jsonb_build_object('op', 'upsert', 'external_id', 'smoke', 'logger_app', null, 'relay_version', '0.1.0',
             'spot', jsonb_build_object('source', 'logged',
               'source_spot_id', '00000000-0000-0000-0000-00000000005e|smoke', 'content_hash', 'g',
               'spot_time', now(), 'callsign', 'W1AW', 'spotter', 'SM0KE', 'frequency_khz', 14025, 'band', '20m',
               'mode', 'cw', 'mode_family', 'cw', 'comment', '', 'raw_payload', '{}'::jsonb)),
           jsonb_build_object('op', 'delete', 'external_id', 'smoke', 'logger_app', null, 'relay_version', '0.1.0',
             'spot', null)))
         = '[{"external_id": "smoke", "status": "rejected", "reason": "mycall_mismatch"},
             {"external_id": "smoke", "status": "unknown"}]'::jsonb,
    'apply_logged_contacts should reject a contact from an account without a callsign';
  assert not exists (select 1 from raw_spots where source = 'logged' and content_hash = 'g'),
    'a rejected contact should store no spot';

  -- rbn_spots: the bulk RPC inserts (dedup is covered in rbn_spots.test.sql).
  assert public.ingest_rbn_spots(jsonb_build_array(jsonb_build_object(
    'spot_time', now(), 'received_at', now(), 'spotter', 'W3LPL', 'callsign', 'SM0KE',
    'frequency_khz', 14035.1, 'band', '20m', 'mode', 'cw', 'mode_family', 'cw', 'snr', 12,
    'speed', 22, 'speed_unit', 'WPM', 'spot_type', 'CQ', 'line', 'smoke'))) = 1,
    'ingest_rbn_spots should insert one row';
  assert exists (select 1 from cron.job where jobname = 'maintain-rbn-spots'),
    'maintain-rbn-spots should be scheduled';

  -- aprs_packets: the bulk RPC inserts and counts the hour (dedup is covered in aprs.test.sql).
  assert public.ingest_aprs_packets(jsonb_build_array(jsonb_build_object(
    'received_at', now(), 'source_call', 'N0SMK', 'destination', 'APRS', 'path', '',
    'q_construct', 'qAC', 'igate', 'T2TEST', 'packet_type', 'status',
    'line', 'N0SMK>APRS,qAC,T2TEST:>smoke'))) = 1,
    'ingest_aprs_packets should insert one row';
  assert (select spots_last_hour from ingest_health where source = 'aprs') >= 1,
    'ingest_health should count the smoke aprs packet';
  assert exists (select 1 from cron.job where jobname = 'maintain-aprs-packets'),
    'maintain-aprs-packets should be scheduled';

  -- Archive: the slice RPCs answer, the job is scheduled, the local stand-in bucket is
  -- private (hosted, the archive is in Backblaze B2).
  assert (select row_count from public.archive_columns('rbn', now() - interval '1 day', now() + interval '1 minute')) >= 1,
    'archive_columns should see the smoke rbn row';
  assert (select row_count from public.archive_columns('aprs', now() - interval '1 day', now() + interval '1 minute')) >= 1,
    'archive_columns should see the smoke aprs packet';
  perform * from public.archive_pending_slices('pota', now(), 10);
  assert exists (select 1 from cron.job where jobname = 'archive-aprs' and schedule = '2-59/5 * * * *'),
    'archive-aprs should run every 5 minutes';
  assert exists (select 1 from cron.job where jobname = 'archive-spots' and schedule = '*/10 * * * *'),
    'archive-spots should run every 10 minutes';
  assert to_regclass('storage.buckets') is null
      or exists (select 1 from storage.buckets where id = 'archive' and not public),
    'the archive bucket should exist and be private';

  -- Stats snapshot: cron job exists and the refresh inserts one row.
  assert exists (select 1 from cron.job where jobname = 'refresh-stats-snapshot' and schedule = '5 * * * *'),
    'refresh-stats-snapshot should run at five past every hour';
  assert exists (select 1 from cron.job where jobname = 'rollup-stats-days' and schedule = '1 * * * *'),
    'rollup-stats-days should run at one past every hour';
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

  -- Reference lists: the hourly swap is scheduled, and the inbound worker's status names every program.
  assert exists (select 1 from cron.job where jobname = 'apply-reference-loads' and schedule = '55 * * * *'),
    'apply-reference-loads should run hourly at :55';
  assert (select array_agg(k order by k) from jsonb_object_keys(public.reference_load_status()) as k)
         = array['pota', 'sota', 'wwff'],
    'reference_load_status should name pota, sota and wwff';

  -- Discord destinations: a trigger gives each its settings, and SQL renders the message.
  assert exists (select 1 from pg_trigger where tgname = 'destinations_discord_settings'),
    'destinations_discord_settings should be installed';
  assert (public.discord_spot_fields(
            jsonb_populate_record(null::discord_destination_settings, public.discord_default_settings()),
            public.push_sample_spot()) ->> 'discord_title') = 'N0CALL · 14.062 MHz · CW',
    'discord_spot_fields should render the default card title';

  -- Webhook destinations: a trigger gives each its settings, and SQL renders the spot as ordered pairs.
  assert exists (select 1 from pg_trigger where tgname = 'destinations_webhook_settings'),
    'destinations_webhook_settings should be installed';
  assert (select array_agg(t.p ->> 'key' order by t.ord)
          from jsonb_array_elements(public.webhook_spot_fields(
                 jsonb_populate_record(null::webhook_destination_settings, public.webhook_default_settings()),
                 public.push_sample_spot())) with ordinality as t(p, ord))
         = array['id', 'time', 'callsign', 'frequency_khz', 'mode', 'band', 'source', 'reference', 'place_name',
                 'state', 'spotter'],
    'webhook_spot_fields should render the eleven default keys in order';
  assert (select array_agg(t.k order by t.ord)
          from json_object_keys(public.webhook_request_body(
                 jsonb_populate_record(null::webhook_destination_settings, public.webhook_default_settings()),
                 0, 'Smoke', public.push_sample_spot())) with ordinality as t(k, ord))
         = array['delivery_id', 'connection', 'spot'],
    'webhook_request_body should be {delivery_id, connection, spot}';

  -- Callsign rollups: the stream reads every source and a backfill marks the smoke spots' days
  -- (a seeded database may have rolled them up already).
  assert exists (select 1 from spot_stream where source = 'rbn' and callsign = 'SM0KE')
     and exists (select 1 from spot_stream where source = 'pota' and callsign = 'W1AW'),
    'spot_stream should see raw_spots and rbn_spots rows';
  assert exists (select 1 from cron.job where jobname = 'rollup-callsign-days' and schedule = '25 * * * *'),
    'rollup-callsign-days should run hourly';
  perform * from public.backfill_callsign_rollups();
  assert exists (select 1 from callsign_rollup_days where day = '2026-10-05'),
    'backfill_callsign_rollups should roll up the smoke spots'' first day';
  assert exists (select 1 from reference_days
                 where program = 'sota' and reference = 'SP/SS-004' and day = '2026-10-05'
                   and base = 'SQ1GPR' and source = 'sotawatch' and spots = 1),
    'the roll-up should write the smoke SOTA spot''s activation to reference_days';
  assert (select relrowsecurity from pg_class where oid = 'public.reference_days'::regclass),
    'reference_days should have row level security on';

  -- Group statistics: the sharing columns, the service-role-only cache, and a code nobody has.
  assert exists (select 1 from information_schema.columns
                 where table_name = 'callsign_groups' and column_name in ('public', 'show_callsigns', 'public_slug')
                 having count(*) = 3),
    'callsign_groups should have the sharing columns';
  assert (select relrowsecurity from pg_class where oid = 'public.group_stats_cache'::regclass),
    'group_stats_cache should have row level security on';
  assert public.public_group_statistics('zzzzzzzzzz', '30d') is null,
    'public_group_statistics should return null for an unknown code';

  -- Long Lines Relay pairing: a pairing starts pending, keeps only its device code's hash, and an
  -- unknown device code polls expired_token.
  declare
    v_start jsonb := public.start_relay_pairing('smoke', '0.0.0');
  begin
    assert v_start ->> 'verification_uri' = 'https://longlines.io/relay'
           and (v_start ->> 'expires_in')::int = 600,
      'start_relay_pairing should answer the contract''s verification URI and ten minutes';
    assert (select status from relay_pairings
            where device_code_hash = encode(extensions.digest(v_start ->> 'device_code', 'sha256'), 'hex'))
           = 'pending',
      'a started pairing should be stored pending by its device code''s hash';
  end;
  assert public.poll_relay_pairing(repeat('0', 64)) ->> 'status' = 'expired_token',
    'an unknown device code should poll expired_token';
  assert (select relrowsecurity from pg_class where oid = 'public.relay_tokens'::regclass)
         and (select relrowsecurity from pg_class where oid = 'public.relay_pairings'::regclass),
    'relay_tokens and relay_pairings should have row level security on';
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

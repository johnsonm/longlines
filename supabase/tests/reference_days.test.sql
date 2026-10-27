-- pgTAP: reference_days, the activations per reference and day (20261026001200): the roll-up
-- writes them, fill_reference_days writes the same rows from raw_spots, backfill_reference_days is
-- bounded and runs from the hourly job only when it rolled nothing up and filled no callsign_days.
begin;
create extension if not exists pgtap with schema extensions;
select plan(42);

create or replace function pg_temp.d(p_offset int) returns date language sql as $$
  select (now() at time zone 'utc')::date + p_offset;
$$;
create or replace function pg_temp.at(p_offset int, p_hms text) returns timestamptz language sql as $$
  select ((pg_temp.d(p_offset))::text || ' ' || p_hms || '+00')::timestamptz;
$$;
create or replace function pg_temp.raw(
  p_source text, p_id text, p_time timestamptz, p_call text, p_spotter text, p_khz numeric, p_band text,
  p_mode text, p_family text, p_pota text default null, p_sota text default null, p_wwff text default null,
  p_wwbota text[] default null) returns void language sql as $$
  insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, spotter, frequency_khz, band,
                         mode, mode_family, comment, pota_reference, sota_summit_ref, wwff_reference,
                         wwbota_references, raw_payload)
  values (p_source, p_id, p_id, p_time, p_call, p_spotter, p_khz, p_band, p_mode, p_family, '', p_pota, p_sota,
          p_wwff, p_wwbota, '{}');
$$;
create or replace function pg_temp.rows_of(p_day date) returns text[] language sql as $$
  select coalesce(array_agg((program, reference, base, source, spots, modes, bands)::text
                            order by program, reference, base, source), '{}')
  from reference_days where day = p_day;
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
delete from reference_days;
delete from archive_log;
delete from hidden_callsigns;

select load_cty('test',
  '[{"prefix":"K","name":"United States","continent":"NA","cq_zone":5,"itu_zone":8,"lat":37.6,"lon":-91.87},
    {"prefix":"G","name":"England","continent":"EU","cq_zone":14,"itu_zone":27,"lat":52.77,"lon":-1.47}]',
  '[{"pattern":"K","exact":false,"entity":"K","continent":"NA","cq_zone":5,"itu_zone":8},
    {"pattern":"W","exact":false,"entity":"K","continent":"NA","cq_zone":5,"itu_zone":8},
    {"pattern":"N","exact":false,"entity":"K","continent":"NA","cq_zone":5,"itu_zone":8},
    {"pattern":"G","exact":false,"entity":"G","continent":"EU","cq_zone":14,"itu_zone":27}]');

-- Day -4. KK4PWJ activates a park under two spellings (one spot without a mode, one outside the band
-- list), a summit, and a WWFF reference spelled in lower case. N0HIDE is hidden and activates the
-- park too. W1AW is spotted on DX Cluster (once with a park, which DX Cluster never sends), K1BOTA on
-- WWBOTA, and KK4PWJ by RBN (from rbn_spots, plus a raw_spots copy with a park).
select pg_temp.raw('pota', 'p1', pg_temp.at(-4, '10:05:00'), 'KK4PWJ/P', 'KK4PWJ', 14062, '20m', 'cw', 'cw',
                   p_pota => 'US-0817');
select pg_temp.raw('pota', 'p2', pg_temp.at(-4, '10:20:00'), 'KK4PWJ', 'W1AW', 7185, '40m', 'ssb', 'phone',
                   p_pota => 'US-0817');
select pg_temp.raw('pota', 'p3', pg_temp.at(-4, '10:40:00'), 'KK4PWJ', 'W1AW', 7185, '40m', null, null,
                   p_pota => 'US-0817');
select pg_temp.raw('pota', 'p4', pg_temp.at(-4, '11:00:00'), 'KK4PWJ', 'W1AW', 5000, null, 'cw', 'cw',
                   p_pota => 'US-0817');
select pg_temp.raw('pota', 'p5', pg_temp.at(-4, '12:00:00'), 'N0HIDE', 'W1AW', 14062, '20m', 'cw', 'cw',
                   p_pota => 'US-0817');
select pg_temp.raw('sotawatch', 's1', pg_temp.at(-4, '14:00:00'), 'W4/KK4PWJ', 'G4OBK', 7032, '40m', 'cw', 'cw',
                   p_sota => 'W4C/CM-001');
select pg_temp.raw('wwff', 'w1', pg_temp.at(-4, '15:00:00'), 'KK4PWJ', 'W1AW', 14244, '20m', 'ssb', 'phone',
                   p_wwff => 'kff-1234');
select pg_temp.raw('dxcluster', 'x1', pg_temp.at(-4, '12:00:00'), 'W1AW', 'G4OBK', 14250, '20m', 'ssb', 'phone');
select pg_temp.raw('dxcluster', 'x2', pg_temp.at(-4, '12:10:00'), 'W1AW', 'G4OBK', 14250, '20m', 'ssb', 'phone',
                   p_pota => 'US-0001');
select pg_temp.raw('wwbota', 'b1', pg_temp.at(-4, '13:00:00'), 'K1BOTA', 'W1AW', 14280, '20m', 'ssb', 'phone',
                   p_wwbota => array['B/G-2114', 'B/G-2115']);
select pg_temp.raw('rbn', 'r1', pg_temp.at(-4, '11:00:00'), 'KK4PWJ', 'G4OBK', 14035, '20m', 'cw', 'cw',
                   p_pota => 'US-0002');
select ingest_rbn_spots(jsonb_build_array(jsonb_build_object(
  'spot_time', pg_temp.at(-4, '11:00:00'), 'received_at', pg_temp.at(-4, '11:00:00'), 'spotter', 'G4OBK',
  'callsign', 'KK4PWJ', 'frequency_khz', 14035, 'band', '20m', 'mode', 'cw', 'mode_family', 'cw', 'snr', 12,
  'speed', 22, 'speed_unit', 'WPM', 'spot_type', 'CQ', 'line', 'x')));
insert into hidden_callsigns (callsign) values ('N0HIDE');

-- The roll-up.
select is((select array_agg((rollup_day, error)::text) from backfill_callsign_rollups(1)),
  array[format('(%s,)', pg_temp.d(-4))], 'backfill_callsign_rollups(1) rolls up the day');
select is(pg_temp.rows_of(pg_temp.d(-4)),
  array['(pota,US-0817,KK4PWJ,pota,4,"{cw,ssb}","{20m,40m}")', '(pota,US-0817,N0HIDE,pota,1,{cw},{20m})',
        '(sota,W4C/CM-001,KK4PWJ,sotawatch,1,{cw},{40m})', '(wwff,KFF-1234,KK4PWJ,wwff,1,{ssb},{20m})'],
  'the roll-up writes one row per program, reference, activator and source, modes and bands as callsign_days');
select ok(not exists (select 1 from reference_days where program <> lower(program) or reference <> upper(reference)),
  'program is lower case and reference upper case');
select ok(not exists (select 1 from reference_days where base in ('W1AW', 'K1BOTA', 'G4OBK')),
  'DX Cluster, WWBOTA and RBN spots write none, nor do spotters');
select ok(not exists (select 1 from reference_days where reference in ('US-0001', 'US-0002') or reference like 'B/%'),
  'not even a DX Cluster or RBN row that carries a park, or a WWBOTA bunker');
select ok(exists (select 1 from reference_days where base = 'N0HIDE'),
  'a hidden call is stored; hiding it is the reader''s job');
select is((select array_agg((base, source, spots, modes, bands)::text order by source) from callsign_days
           where base = 'KK4PWJ' and day = pg_temp.d(-4) and source <> 'rbn'),
  array['(KK4PWJ,pota,4,"{cw,ssb}","{20m,40m}")', '(KK4PWJ,sotawatch,1,{cw},{40m})', '(KK4PWJ,wwff,1,{ssb},{20m})'],
  'the same normalisation as the day''s callsign_days rows');
select ok((select references_filled_at is not null and days_filled_at is not null from callsign_rollup_days
           where day = pg_temp.d(-4)), 'the marker records the reference_days fill');
select ok(rollup_callsign_day(pg_temp.d(-4)) is null and cardinality(pg_temp.rows_of(pg_temp.d(-4))) = 4,
  'a day rolled up again writes nothing more');

-- The fill writes the same rows for the same day.
create temp table rolled as select * from reference_days;
delete from reference_days;
update callsign_rollup_days set references_filled_at = null where day = pg_temp.d(-4);
select is(fill_reference_days(pg_temp.d(-4)), 7::bigint, 'fill_reference_days counts the day''s reference spots');
select results_eq('select * from reference_days order by program, reference, day, base, source',
                  'select * from rolled order by program, reference, day, base, source',
                  'the fill writes exactly the roll-up''s rows');
select ok((select references_filled_at is not null from callsign_rollup_days where day = pg_temp.d(-4)),
  'the fill sets references_filled_at');
select is(fill_reference_days(pg_temp.d(-4)), null::bigint, 'a day already filled is skipped');
select is(fill_reference_days(pg_temp.d(-5)), null::bigint, 'a day without a marker is not filled');
-- A row already there wins.
update callsign_rollup_days set references_filled_at = null where day = pg_temp.d(-4);
update reference_days set spots = 99 where base = 'N0HIDE';
select fill_reference_days(pg_temp.d(-4));
select is((select spots from reference_days where base = 'N0HIDE'), 99, 'a row already there is kept');
update reference_days set spots = 1 where base = 'N0HIDE';

-- Days rolled up before reference_days existed. Days -9 to -6 have spots and markers without
-- references_filled_at; day -6 also waits for its callsign_days fill. Every other day up to the
-- last one a roll-up may take is marked and filled, so the job has nothing else to do.
select pg_temp.raw('pota', 'h9', pg_temp.at(-9, '10:00:00'), 'K1NINE', 'W1AW', 14062, '20m', 'cw', 'cw',
                   p_pota => 'US-0009');
select pg_temp.raw('sotawatch', 'h8', pg_temp.at(-8, '10:00:00'), 'K1EIGHT', 'W1AW', 7032, '40m', 'cw', 'cw',
                   p_sota => 'W4C/CM-008');
select pg_temp.raw('wwff', 'h7', pg_temp.at(-7, '10:00:00'), 'K1SEVEN', 'W1AW', 14244, '20m', 'ssb', 'phone',
                   p_wwff => 'KFF-0007');
select pg_temp.raw('pota', 'h6', pg_temp.at(-6, '10:00:00'), 'K1SIX', 'W1AW', 14062, '20m', 'cw', 'cw',
                   p_pota => 'US-0006');
insert into callsign_rollup_days (day, rolled_at, spots, days_filled_at, references_filled_at)
select g.d::date, now(), 0, now(), now()
from generate_series(first_rollup_day(), last_rollup_day(), interval '1 day') as g(d)
on conflict (day) do nothing;
update callsign_rollup_days set references_filled_at = null where day between pg_temp.d(-9) and pg_temp.d(-6);
update callsign_rollup_days set days_filled_at = null where day = pg_temp.d(-6);

-- A run that rolls a day up fills nothing: day -10 precedes every marker.
select pg_temp.raw('pota', 'h10', pg_temp.at(-10, '10:00:00'), 'K1TEN', 'W1AW', 14062, '20m', 'cw', 'cw',
                   p_pota => 'US-0010');
select is((select array_agg((rollup_day, spots, error)::text) from backfill_callsign_rollups(1)),
  array[format('(%s,1,)', pg_temp.d(-10))], 'the job rolls up day -10');
select is(pg_temp.rows_of(pg_temp.d(-10)), array['(pota,US-0010,K1TEN,pota,1,{cw},{20m})'],
  'which writes its reference_days rows');
select is((select count(*) from callsign_rollup_days where references_filled_at is null)::int, 4,
  'and fills no older day in the run that rolled one up');
-- A run that fills callsign_days fills no reference_days.
select is((select count(*) from backfill_callsign_rollups(1))::int, 0, 'the next run rolls nothing up');
select ok((select days_filled_at is not null from callsign_rollup_days where day = pg_temp.d(-6)),
  'it fills day -6''s callsign_days');
select is((select count(*) from callsign_rollup_days where references_filled_at is null)::int, 4,
  'and so no reference_days');
-- A run that does neither fills the oldest day, p_max_days of them.
select is((select count(*) from backfill_callsign_rollups(1))::int, 0, 'the third run rolls nothing up either');
select is(array(select day from callsign_rollup_days where references_filled_at is null order by day),
  array[pg_temp.d(-8), pg_temp.d(-7), pg_temp.d(-6)], 'and fills the oldest unfilled day, one as asked');
select is(pg_temp.rows_of(pg_temp.d(-9)), array['(pota,US-0009,K1NINE,pota,1,{cw},{20m})'],
  'from raw_spots');
select is((select array_agg((fill_day, spots, error)::text) from backfill_reference_days(2)),
  array[format('(%s,1,)', pg_temp.d(-8)), format('(%s,1,)', pg_temp.d(-7))],
  'backfill_reference_days(2) fills two days, oldest first');
select is((select array_agg((fill_day, spots, error)::text) from backfill_reference_days(null)),
  array[format('(%s,1,)', pg_temp.d(-6))], 'without a bound it fills the rest');
select is((select count(*) from backfill_reference_days(null))::int, 0, 'and then finds nothing to fill');

-- A failed fill is recorded with its prefix, the status view says fill_failed, and success clears
-- only this fill's failures row. Day -6 gets a park the constraint below refuses.
alter table reference_days add constraint reference_days_test_refuse check (reference <> 'US-FAIL');
update callsign_rollup_days set references_filled_at = null where day = pg_temp.d(-6);
select pg_temp.raw('pota', 'f6', pg_temp.at(-6, '11:00:00'), 'K1FAIL', 'W1AW', 14062, '20m', 'cw', 'cw',
                   p_pota => 'US-FAIL');
select is((select count(*) from backfill_callsign_rollups(1))::int, 0, 'the job''s rows are only roll-ups');
select is((select (attempts, last_error like 'reference_days fill: %reference_days_test_refuse%')::text
           from callsign_rollup_failures where day = pg_temp.d(-6)), '(1,t)',
  'the failed fill is recorded with the reference_days fill prefix');
select is((select (status, references_filled_at is null)::text from callsign_rollup_status where day = pg_temp.d(-6)),
  '(fill_failed,t)', 'the status view says fill_failed and shows references_filled_at');
alter table reference_days drop constraint reference_days_test_refuse;
select is((select array_agg((fill_day, spots, error)::text) from backfill_reference_days(1)),
  array[format('(%s,2,)', pg_temp.d(-6))], 'once the problem is gone the day fills');
select is((select status from callsign_rollup_status where day = pg_temp.d(-6)), 'done',
  'and its failures row is gone');
-- Another fill's failure stays.
update callsign_rollup_days set references_filled_at = null, days_filled_at = null where day = pg_temp.d(-7);
select record_callsign_rollup_failure(pg_temp.d(-7), 'callsign_days fill: refused');
select fill_reference_days(pg_temp.d(-7));
select is((select status from callsign_rollup_status where day = pg_temp.d(-7)), 'fill_failed',
  'a reference fill keeps a callsign_days fill''s failure');
-- And the other way round: a callsign_days fill keeps a reference_days fill's failure.
update callsign_rollup_days set references_filled_at = null, days_filled_at = null where day = pg_temp.d(-8);
select record_callsign_rollup_failure(pg_temp.d(-8), 'reference_days fill: refused');
select * from fill_callsign_days(pg_temp.d(-8));
select is((select (status, days_filled_at is not null, last_error)::text from callsign_rollup_status
           where day = pg_temp.d(-8)), '(fill_failed,t,"reference_days fill: refused")',
  'a callsign_days fill keeps a reference_days fill''s failure');
select fill_reference_days(pg_temp.d(-8));
select is((select (status, attempts)::text from callsign_rollup_status where day = pg_temp.d(-8)), '(done,)',
  'which goes once the reference fill succeeds');

-- The live read of PR 4 goes through spot_stream, by reference and time, and uses the index (the
-- index is on the view's reference expression, so the predicate reaches the raw_spots arm).
create or replace function pg_temp.plan(p_query text) returns text language plpgsql as $$
declare
  v_line text;
  v_plan text := '';
begin
  for v_line in execute 'explain ' || p_query loop
    v_plan := v_plan || v_line || E'\n';
  end loop;
  return v_plan;
end;
$$;
set local enable_seqscan = off;
select ok(pg_temp.plan($q$select callsign, spot_time from spot_stream
                           where reference = 'US-0817' and spot_time >= now() - interval '14 days'$q$)
          like '%raw_spots_reference_time_idx%',
  'a read of spot_stream by reference and time uses raw_spots_reference_time_idx');
select ok(pg_temp.plan($q$select callsign, spot_time from spot_stream
                           where program = 'WWBOTA' and reference = 'B/G-2114'$q$)
          like '%raw_spots_reference_time_idx%',
  'so does one by reference alone');
reset enable_seqscan;

-- The job's shape and schedule.
select is(pg_get_function_result('public.backfill_callsign_rollups(int)'::regprocedure),
  'TABLE(rollup_day date, spots bigint, error text)', 'backfill_callsign_rollups keeps its return shape');
select ok(exists (select 1 from cron.job where jobname = 'rollup-callsign-days'
                  and command like '%select count(*) from public.backfill_callsign_rollups(2)%'),
  'the cron body is unchanged');

-- Access.
select ok((select relrowsecurity from pg_class where oid = 'public.reference_days'::regclass)
          and not exists (select 1 from pg_policy where polrelid = 'public.reference_days'::regclass),
  'reference_days has RLS on and no policies');
select ok(not has_table_privilege('authenticated', 'reference_days', 'select')
          and not has_table_privilege('anon', 'reference_days', 'select')
          and not has_table_privilege('authenticated', 'reference_days', 'insert'),
  'clients cannot read or write reference_days');
select ok(not has_function_privilege('authenticated', 'public.fill_reference_days(date)', 'execute')
          and not has_function_privilege('anon', 'public.fill_reference_days(date)', 'execute')
          and not has_function_privilege('authenticated', 'public.backfill_reference_days(int)', 'execute')
          and not has_function_privilege('anon', 'public.backfill_reference_days(int)', 'execute')
          and has_function_privilege('service_role', 'public.backfill_reference_days(int)', 'execute'),
  'the fill functions are service-role only');

select * from finish();
rollback;

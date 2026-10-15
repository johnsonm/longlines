# Spot Archive and RBN Retention (PR 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Archive every spot of every source to Supabase Storage as gzipped NDJSON, and drop `rbn_spots` days older than seven only once Storage holds them with matching counts.

**Architecture:** Postgres builds each slice's NDJSON (`archive_ndjson`) and decides which slices are due (`archive_pending_slices`, slice length from `archive_slice_minutes`). A new Edge Function `archive`, called by pg_cron every 10 minutes with the service-role key, gzips each due slice, uploads it to a private `archive` bucket and records it in `archive_log`. The daily `maintain_rbn_spots()` gains the retention step: per day older than seven, every 10-minute slice must be logged with the database's row count before the partition (and any default-partition rows) is dropped; mismatched slices lose their log row so the next run re-archives them.

**Tech Stack:** Postgres 17 on Supabase (pg_cron, pg_net, Vault, Storage), Deno 2 Edge Functions in strict TypeScript, `CompressionStream`, pgTAP, `deno test`.

**Spec:** `docs/superpowers/specs/2026-10-11-rbn-firehose-archive-design.md`, including its "Amendment after measurement" (10-minute RBN slices, hourly POTA/SOTAwatch, a run every 10 minutes, a 60,000-row budget per run). PR 1 (`rbn_spots`, full ingest) is merged as #32.

## Global Constraints

- Strict TypeScript, no JavaScript files, no `any` without a justifying comment, no new runtime dependencies.
- New migrations only: `20261011000004_spot_archive.sql` and `20261011000005_rbn_retention.sql`. Never edit an applied migration (`20261011000003` is applied on the hosted project).
- Every new table, view and function has `anon`/`authenticated` revoked; functions are executable by `service_role` only; `archive_log` has RLS on with no policies; the bucket is private.
- Slice lengths: RBN 10 minutes, POTA and SOTAwatch 60 minutes, defined only in `archive_slice_minutes(source)`. Slices are aligned with `date_bin(step, t, '2000-01-01 00:00+00')`.
- Object path: `<source>/YYYY/MM/DD/HHMM.ndjson.gz` from the slice start in UTC, content type `application/gzip`, uploaded with `upsert: true`.
- Archive line fields — RBN: `spot_time, received_at, spotter, callsign, frequency_khz, band, mode, mode_family, snr, speed, speed_unit, spot_type, line`. POTA/SOTAwatch: every `raw_spots` column except `id`. Watched RBN rows in `raw_spots` are never archived from there.
- The `archive` function: cron `*/10 * * * *`; lag 2 hours; sources in order `pota`, `sotawatch`, `rbn`; at most 24 pending slices fetched per source; stops starting new slices once 60,000 rows have been archived in the run. A slice is logged only after its upload succeeds; an empty slice is logged with `row_count = 0` and no object.
- Retention: a day is eligible when `day < today_utc - 7`. It is dropped only when all 144 of its 10-minute slices have an `archive_log` row whose `row_count` equals the database count.
- Auth for `archive`: `verify_jwt` stays on and the handler requires `Authorization: Bearer <service-role key>` (403 otherwise), like `deliver`.
- Run `supabase db reset` before `supabase test db`. Never run `supabase db push`, `supabase functions deploy`, `fly deploy`, or `fly secrets set`.

## Review Focus

1. A slice whose upload fails must not be logged, and the next run must retry it, while other sources still progress in the same run (Task 2 "an upload failure leaves the slice unlogged").
2. A contest-rate backlog must not blow the CPU budget: the run stops starting slices at 60,000 rows (Task 2 "stops starting new slices at the row budget").
3. Rows arriving for a slice after it was archived (relay flushing after an outage, or a late default-partition move) must be re-archived before their day is dropped (Task 5 "a mismatched slice keeps the partition and loses its log row").
4. A day whose rows sit in `rbn_spots_default` (no partition) is retired by deleting those rows, not by dropping a partition (Task 5 "default-partition rows of an archived day are deleted").
5. Slice boundaries are half-open `[start, end)`: a spot at exactly 10:10:00 belongs to the 10:10 slice, never to both (Task 1 "a spot on the boundary is in exactly one slice").

---

## File Structure

| File | Responsibility |
| --- | --- |
| `supabase/migrations/20261011000004_spot_archive.sql` (create) | Bucket, `archive_log`, `archive_slice_minutes`, `archive_pending_slices`, `archive_ndjson`, `log_archive`, `archive_status`, cron `archive-spots`. |
| `supabase/migrations/20261011000005_rbn_retention.sql` (create) | `rbn_day_slices`, `retire_rbn_day`, `maintain_rbn_spots` with the retention step. |
| `supabase/tests/archive.test.sql`, `supabase/tests/rbn_retention.test.sql` (create) | pgTAP for the two migrations. |
| `scripts/smoke-test.sql` (modify) | `archive_ndjson` and `archive_pending_slices` calls; the cron job. |
| `supabase/functions/_shared/types.ts` (modify) | `ArchiveSlice`, `ArchiveLogEntry`, `ArchiveDb`, `ArchiveStore`. |
| `supabase/functions/_shared/archive.ts` (create) | `objectPath`, `gzip`, `runArchive` (pure over the two interfaces). |
| `supabase/functions/_shared/db.ts` (modify) | `createArchiveDb`, `createArchiveStore`. |
| `supabase/functions/_shared/__tests__/fake_supabase.ts` (modify) | `storage.from(bucket).upload` in the fake. |
| `supabase/functions/_shared/handlers/archive.ts` (create) | `handleArchive`: service-role check, run, JSON summary. |
| `supabase/functions/archive/index.ts`, `deno.json` (create) | Thin entrypoint. |
| `supabase/functions/_shared/serve.ts` (modify) | Remove the `ingest-rbn` GET (watchlist) branch. |
| `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, `README.md`, `CLAUDE.md` (modify), `web/src/lib/database.types.ts` (regenerate) | Describe the archive and retention. |

---

### Task 1: Archive schema, slice RPCs and the cron job

**Files:**
- Create: `supabase/migrations/20261011000004_spot_archive.sql`
- Create: `supabase/tests/archive.test.sql`
- Modify: `scripts/smoke-test.sql`

**Interfaces:**
- Produces: table `archive_log(source, slice_start, slice_end, row_count, bytes, object_path, archived_at)`, PK `(source, slice_start)`; `archive_slice_minutes(p_source text) returns int`; `archive_pending_slices(p_source text, p_before timestamptz, p_limit int) returns table (slice_start timestamptz, slice_end timestamptz)`; `archive_ndjson(p_source text, p_from timestamptz, p_to timestamptz) returns table (row_count int, ndjson text)`; `log_archive(p_source text, p_slice_start timestamptz, p_slice_end timestamptz, p_row_count int, p_bytes int, p_object_path text) returns void`; view `archive_status(source, archived_through, pending_slices)`; bucket `archive`; cron job `archive-spots`.

- [ ] **Step 1: Write the failing pgTAP suite**

Create `supabase/tests/archive.test.sql`:

```sql
-- pgTAP: the spot archive (20261011000004): slice lengths, pending slices,
-- NDJSON shape and boundaries, the log, the status view, grants, cron, bucket.
begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

-- Yesterday at hh:mm UTC.
create or replace function pg_temp.y(p_hm text) returns timestamptz language sql as $$
  select (((now() at time zone 'utc')::date - 1)::text || ' ' || p_hm || '+00')::timestamptz;
$$;
create or replace function pg_temp.rbn(p_time timestamptz, p_call text) returns jsonb language sql as $$
  select jsonb_build_object(
    'spot_time', p_time, 'received_at', p_time, 'spotter', 'W3LPL', 'callsign', p_call,
    'frequency_khz', 14035.1, 'band', '20m', 'mode', 'cw', 'mode_family', 'cw', 'snr', 12,
    'speed', 22, 'speed_unit', 'WPM', 'spot_type', 'CQ', 'line', 'DX de W3LPL-#: ' || p_call);
$$;

delete from rbn_spots;
delete from archive_log;

-- Slice lengths.
select is(archive_slice_minutes('rbn'), 10, 'RBN slices are 10 minutes');
select is(archive_slice_minutes('pota'), 60, 'POTA slices are an hour');
select is(archive_slice_minutes('sotawatch'), 60, 'SOTAwatch slices are an hour');

-- Pending slices: none without data.
select is((select count(*) from archive_pending_slices('rbn', now(), 100))::int, 0, 'no RBN data, no pending slices');

select ingest_rbn_spots(jsonb_build_array(
  pg_temp.rbn(pg_temp.y('10:03'), 'K1AAA'),
  pg_temp.rbn(pg_temp.y('10:09:59'), 'K1BBB'),
  pg_temp.rbn(pg_temp.y('10:10:00'), 'K1CCC'),
  pg_temp.rbn(pg_temp.y('10:27'), 'K1DDD')));

select is((select count(*) from archive_pending_slices('rbn', pg_temp.y('11:00'), 100))::int, 6,
  'every 10-minute slice from the first spot up to the cutoff is pending, empty ones included');
select is((select slice_start from archive_pending_slices('rbn', pg_temp.y('11:00'), 100) limit 1), pg_temp.y('10:00'),
  'slices are aligned to the clock, oldest first');
select is((select slice_end from archive_pending_slices('rbn', pg_temp.y('11:00'), 100) limit 1), pg_temp.y('10:10'),
  'a slice ends 10 minutes after it starts');
select is((select count(*) from archive_pending_slices('rbn', pg_temp.y('11:00'), 2))::int, 2, 'the limit caps the slices returned');
select is((select count(*) from archive_pending_slices('rbn', pg_temp.y('10:15'), 100))::int, 1,
  'a slice is pending only once it has ended before the cutoff');

-- NDJSON: half-open boundaries, shape, order.
select is((select row_count from archive_ndjson('rbn', pg_temp.y('10:00'), pg_temp.y('10:10'))), 2,
  'a spot on the boundary is in exactly one slice (10:09:59 in, 10:10:00 out)');
select is((select row_count from archive_ndjson('rbn', pg_temp.y('10:10'), pg_temp.y('10:20'))), 1,
  'the 10:10:00 spot is in the next slice');
select is((select split_part(ndjson, E'\n', 1)::jsonb ->> 'callsign' from archive_ndjson('rbn', pg_temp.y('10:00'), pg_temp.y('10:10'))),
  'K1AAA', 'lines are ordered by spot_time');
select is((select array(select k from jsonb_object_keys(split_part(ndjson, E'\n', 1)::jsonb) as k order by k collate "C")
           from archive_ndjson('rbn', pg_temp.y('10:00'), pg_temp.y('10:10'))),
  array['band','callsign','frequency_khz','line','mode','mode_family','received_at','snr','speed','speed_unit','spot_time','spot_type','spotter'],
  'an RBN line carries exactly the specified fields');
select is((select ndjson from archive_ndjson('rbn', pg_temp.y('10:40'), pg_temp.y('10:50'))), '',
  'an empty slice has an empty body');

insert into raw_spots (source, source_spot_id, content_hash, spot_time, callsign, frequency_khz, comment, pota_reference, raw_payload)
values ('pota', 'arch-1', 'h', pg_temp.y('09:30'), 'W1AW', 14062, '', 'US-0001', '{"upstream":true}');
select ok(exists (select 1 from archive_pending_slices('pota', pg_temp.y('11:00'), 1000) where slice_start = pg_temp.y('09:00')
                  and slice_end = pg_temp.y('10:00')), 'POTA slices are hourly');
select ok((select (split_part(ndjson, E'\n', 1)::jsonb ? 'raw_payload') and not (split_part(ndjson, E'\n', 1)::jsonb ? 'id')
           from archive_ndjson('pota', pg_temp.y('09:00'), pg_temp.y('10:00'))),
  'a POTA line carries raw_payload and not the internal id');
select throws_ok($$ select * from archive_ndjson('dxcluster', now(), now()) $$, 'P0001', 'unknown archive source: dxcluster',
  'an unknown source is rejected');

-- The log.
select lives_ok(format('select log_archive(%L, %L, %L, 2, 120, %L)', 'rbn', pg_temp.y('10:00'), pg_temp.y('10:10'), 'rbn/x/1000.ndjson.gz'),
  'log_archive records a slice');
select is((select slice_start from archive_pending_slices('rbn', pg_temp.y('11:00'), 100) limit 1), pg_temp.y('10:10'),
  'a logged slice is no longer pending');
select lives_ok(format('select log_archive(%L, %L, %L, 3, 150, %L)', 'rbn', pg_temp.y('10:00'), pg_temp.y('10:10'), 'rbn/x/1000.ndjson.gz'),
  'log_archive overwrites on re-archive');
select is((select row_count from archive_log where source = 'rbn' and slice_start = pg_temp.y('10:00')), 3, 'the newer count wins');
select throws_ok(format('select log_archive(%L, %L, %L, 5, 10, null)', 'rbn', pg_temp.y('10:20'), pg_temp.y('10:30')),
  '23514', null, 'a slice with rows must name its object');

-- Status, grants, cron.
select is((select count(*) from archive_status)::int, 3, 'archive_status has one row per source');
select ok(not has_function_privilege('authenticated', 'public.archive_ndjson(text, timestamptz, timestamptz)', 'execute')
          and not has_function_privilege('authenticated', 'public.log_archive(text, timestamptz, timestamptz, int, int, text)', 'execute')
          and not has_function_privilege('authenticated', 'public.archive_pending_slices(text, timestamptz, int)', 'execute')
          and not has_table_privilege('authenticated', 'public.archive_log', 'select')
          and not has_table_privilege('anon', 'public.archive_status', 'select')
          and has_function_privilege('service_role', 'public.archive_ndjson(text, timestamptz, timestamptz)', 'execute'),
  'the archive objects are service-role only');

select * from finish();
rollback;
```

Note: the plan count is 24 and the file has 24 assertions; the cron and bucket checks are in the smoke test (Step 5) because the bucket exists only where Storage runs.

- [ ] **Step 2: Run it to verify it fails**

Run: `supabase db reset && supabase test db 2>&1 | grep -A3 archive.test`
Expected: FAIL (`function archive_slice_minutes(unknown) does not exist`).

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261011000004_spot_archive.sql`:

```sql
-- Archive of every spot to Supabase Storage as gzipped NDJSON (spec
-- docs/superpowers/specs/2026-10-11-rbn-firehose-archive-design.md and its
-- "Amendment after measurement").
--
-- Postgres decides which slices are due and builds each slice's NDJSON, so the
-- archive Edge Function only gzips and uploads (it has 2 s of CPU per call).
-- A slice is logged in archive_log only after its upload succeeds; retention
-- (20261011000005) drops nothing that is not logged with a matching count.

-- Private bucket. Guarded because a database started without Storage (CI runs
-- `supabase db start`) has no storage schema; hosted projects always do.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('archive', 'archive', false)
    on conflict (id) do nothing;
  end if;
end $$;

create table archive_log (
  source       text        not null check (source in ('pota', 'sotawatch', 'rbn')),
  slice_start  timestamptz not null,
  slice_end    timestamptz not null check (slice_end > slice_start),
  row_count    int         not null check (row_count >= 0),
  bytes        int,
  object_path  text,
  archived_at  timestamptz not null default now(),
  primary key (source, slice_start),
  -- An empty slice is logged without an object; a slice with rows always has one.
  check ((row_count = 0) = (object_path is null))
);

alter table archive_log enable row level security;
revoke all on archive_log from anon, authenticated;

-- The one place slice length is defined: RBN is busy enough to need 10-minute
-- slices to stay inside the function's CPU budget; the other sources are tiny.
create function public.archive_slice_minutes(p_source text)
returns int
language sql
immutable
as $$
  select case p_source when 'rbn' then 10 when 'pota' then 60 when 'sotawatch' then 60 end;
$$;

-- Slices of one source that have ended before p_before and are not logged yet,
-- oldest first, from the slice holding the source's earliest spot. Empty slices
-- are included so that a gap in archive_log always means "not archived".
create function public.archive_pending_slices(p_source text, p_before timestamptz, p_limit int)
returns table (slice_start timestamptz, slice_end timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  with cfg as (
    select make_interval(mins => public.archive_slice_minutes(p_source)) as step
  ),
  first_spot as (
    select case
             when p_source = 'rbn' then (select min(r.spot_time) from rbn_spots r)
             else (select min(s.spot_time) from raw_spots s where s.source = p_source)
           end as t
  )
  select g.s, g.s + cfg.step
  from cfg, first_spot,
       generate_series(date_bin(cfg.step, first_spot.t, timestamptz '2000-01-01 00:00+00'),
                       p_before - cfg.step, cfg.step) as g(s)
  where first_spot.t is not null
    and not exists (select 1 from archive_log l where l.source = p_source and l.slice_start = g.s)
  order by g.s
  limit p_limit;
$$;

-- One slice as NDJSON, [p_from, p_to) by spot_time, one JSON object per line,
-- built here so the Edge Function never parses rows.
create function public.archive_ndjson(p_source text, p_from timestamptz, p_to timestamptz)
returns table (row_count int, ndjson text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_source = 'rbn' then
    return query
      select count(*)::int,
             coalesce(string_agg(to_json(r)::text, E'\n'
                                 order by r.spot_time, r.spotter, r.callsign, r.frequency_khz), '')
      from (
        select x.spot_time, x.received_at, x.spotter, x.callsign, x.frequency_khz, x.band, x.mode,
               x.mode_family, x.snr, x.speed, x.speed_unit, x.spot_type, x.line
        from rbn_spots x
        where x.spot_time >= p_from and x.spot_time < p_to
      ) r;
  elsif p_source in ('pota', 'sotawatch') then
    return query
      select count(*)::int,
             coalesce(string_agg(to_json(r)::text, E'\n'
                                 order by r.spot_time, r.source_spot_id, r.content_hash), '')
      from (
        select x.source, x.source_spot_id, x.content_hash, x.spot_time, x.ingested_at, x.callsign,
               x.spotter, x.frequency_khz, x.band, x.mode, x.mode_family, x.comment,
               x.pota_reference, x.pota_park_name, x.pota_location, x.sota_summit_ref, x.raw_payload
        from raw_spots x
        where x.source = p_source and x.spot_time >= p_from and x.spot_time < p_to
      ) r;
  else
    raise exception 'unknown archive source: %', p_source;
  end if;
end;
$$;

-- Records an archived slice; a re-archive overwrites the row.
create function public.log_archive(
  p_source text, p_slice_start timestamptz, p_slice_end timestamptz,
  p_row_count int, p_bytes int, p_object_path text
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into archive_log (source, slice_start, slice_end, row_count, bytes, object_path)
  values (p_source, p_slice_start, p_slice_end, p_row_count, p_bytes, p_object_path)
  on conflict (source, slice_start) do update
    set slice_end   = excluded.slice_end,
        row_count   = excluded.row_count,
        bytes       = excluded.bytes,
        object_path = excluded.object_path,
        archived_at = now();
$$;

-- At a glance: how far each source is archived and how many finished slices wait.
create view archive_status with (security_invoker = true) as
select s.source,
       (select max(l.slice_end) from archive_log l where l.source = s.source) as archived_through,
       (select count(*) from public.archive_pending_slices(s.source, now() - interval '2 hours', 100000))
         as pending_slices
from (values ('pota'), ('sotawatch'), ('rbn')) as s(source);

revoke all on archive_status from anon, authenticated;
revoke all on function public.archive_slice_minutes(text) from public, anon, authenticated;
revoke all on function public.archive_pending_slices(text, timestamptz, int) from public, anon, authenticated;
revoke all on function public.archive_ndjson(text, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.log_archive(text, timestamptz, timestamptz, int, int, text) from public, anon, authenticated;
grant execute on function public.archive_slice_minutes(text) to service_role;
grant execute on function public.archive_pending_slices(text, timestamptz, int) to service_role;
grant execute on function public.archive_ndjson(text, timestamptz, timestamptz) to service_role;
grant execute on function public.log_archive(text, timestamptz, timestamptz, int, int, text) to service_role;

-- Every 10 minutes, like the ingest jobs: Vault holds the URL and key.
select cron.schedule(
  'archive-spots',
  '*/10 * * * *',
  $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'longlines_supabase_url')
             || '/functions/v1/archive',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'longlines_service_role_key')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
  $$
);
```

- [ ] **Step 4: Run the suite to verify it passes**

Run: `supabase db reset && supabase test db 2>&1 | tail -4`
Expected: `Result: PASS`, `archive.test.sql .. ok`.

- [ ] **Step 5: Smoke test, lint, commit**

In `scripts/smoke-test.sql`, after the `maintain-rbn-spots` assertion, add:

```sql
  -- Archive: the slice RPCs answer, the job is scheduled, the bucket is private.
  assert (select row_count from public.archive_ndjson('rbn', now() - interval '1 day', now() + interval '1 minute')) >= 1,
    'archive_ndjson should see the smoke rbn row';
  perform * from public.archive_pending_slices('pota', now(), 10);
  assert exists (select 1 from cron.job where jobname = 'archive-spots' and schedule = '*/10 * * * *'),
    'archive-spots should run every 10 minutes';
  assert to_regclass('storage.buckets') is null
      or exists (select 1 from storage.buckets where id = 'archive' and not public),
    'the archive bucket should exist and be private';
```

Run: `docker exec -i supabase_db_longlines psql -U postgres -v ON_ERROR_STOP=1 -X < scripts/smoke-test.sql | tail -1` → `smoke test passed`; `supabase db lint --fail-on error` → no results.

```bash
git add supabase/migrations/20261011000004_spot_archive.sql supabase/tests/archive.test.sql scripts/smoke-test.sql
git commit -m "Add the spot archive schema: slices, NDJSON, log, status, cron"
```

---

### Task 2: `runArchive`, gzip and object paths

**Files:**
- Modify: `supabase/functions/_shared/types.ts`
- Create: `supabase/functions/_shared/archive.ts`
- Test: `supabase/functions/_shared/__tests__/archive.test.ts`

**Interfaces:**
- Produces (types.ts): `interface ArchiveSlice { slice_start: string; slice_end: string }`; `interface ArchiveLogEntry extends ArchiveSlice { source: Source; row_count: number; bytes: number | null; object_path: string | null }`; `interface ArchiveDb { pendingSlices(source: Source, before: Date, limit: number): Promise<ArchiveSlice[]>; sliceNdjson(source: Source, slice: ArchiveSlice): Promise<{ row_count: number; ndjson: string }>; logArchive(entry: ArchiveLogEntry): Promise<void> }`; `interface ArchiveStore { upload(path: string, bytes: Uint8Array): Promise<void> }`.
- Produces (archive.ts): `ARCHIVE_ORDER`, `LAG_MS`, `MAX_ROWS_PER_RUN`, `MAX_SLICES_PER_SOURCE`; `objectPath(source: Source, sliceStart: string): string`; `gzip(text: string): Promise<Uint8Array>`; `interface ArchiveSummary { slices: number; rows: number; bytes: number; empty: number; errors: string[]; duration_ms: number }`; `runArchive(db: ArchiveDb, store: ArchiveStore, now?: Date): Promise<ArchiveSummary>`.

- [ ] **Step 1: Write the failing tests**

Create `supabase/functions/_shared/__tests__/archive.test.ts`:

```ts
import { assertEquals } from "@std/assert";
import { gzip, LAG_MS, MAX_ROWS_PER_RUN, objectPath, runArchive } from "../archive.ts";
import type { ArchiveDb, ArchiveLogEntry, ArchiveSlice, ArchiveStore, Source } from "../types.ts";

const NOW = new Date("2026-10-11T20:05:00Z");

async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

function slice(start: string, minutes: number): ArchiveSlice {
  const end = new Date(new Date(start).getTime() + minutes * 60_000).toISOString();
  return { slice_start: new Date(start).toISOString(), slice_end: end };
}

function fakes(
  options: {
    pending?: Partial<Record<Source, ArchiveSlice[]>>;
    rows?: (source: Source, s: ArchiveSlice) => number;
    failUpload?: (path: string) => boolean;
  } = {},
) {
  const calls = {
    pending: [] as Array<[Source, string, number]>,
    uploads: [] as Array<{ path: string; bytes: Uint8Array }>,
    logs: [] as ArchiveLogEntry[],
    events: [] as string[],
  };
  const db: ArchiveDb = {
    pendingSlices(source, before, limit) {
      calls.pending.push([source, before.toISOString(), limit]);
      return Promise.resolve(options.pending?.[source] ?? []);
    },
    sliceNdjson(source, s) {
      const n = options.rows?.(source, s) ?? 2;
      const lines = Array.from({ length: n }, (_, i) => JSON.stringify({ source, i, at: s.slice_start }));
      return Promise.resolve({ row_count: n, ndjson: lines.join("\n") });
    },
    logArchive(entry) {
      calls.events.push(`log ${entry.source} ${entry.slice_start}`);
      calls.logs.push(entry);
      return Promise.resolve();
    },
  };
  const store: ArchiveStore = {
    upload(path, bytes) {
      calls.events.push(`upload ${path}`);
      if (options.failUpload?.(path)) return Promise.reject(new Error("storage 503"));
      calls.uploads.push({ path, bytes });
      return Promise.resolve();
    },
  };
  return { db, store, calls };
}

Deno.test("objectPath names the object by source and UTC slice start", () => {
  assertEquals(objectPath("rbn", "2026-10-11T14:10:00+00:00"), "rbn/2026/10/11/1410.ndjson.gz");
  assertEquals(objectPath("pota", "2026-01-02T03:00:00.000Z"), "pota/2026/01/02/0300.ndjson.gz");
});

Deno.test("gzip round-trips text", async () => {
  assertEquals(await gunzip(await gzip("a\nb\n")), "a\nb\n");
});

Deno.test("runArchive asks every source for slices that ended two hours ago, POTA first", async () => {
  const { db, store, calls } = fakes();
  await runArchive(db, store, NOW);
  const cutoff = new Date(NOW.getTime() - LAG_MS).toISOString();
  assertEquals(calls.pending.map(([s, b]) => [s, b]), [["pota", cutoff], ["sotawatch", cutoff], ["rbn", cutoff]]);
});

Deno.test("runArchive uploads a gzipped slice, then logs it with its count and size", async () => {
  const s = slice("2026-10-11T14:10:00Z", 10);
  const { db, store, calls } = fakes({ pending: { rbn: [s] }, rows: () => 3 });
  const summary = await runArchive(db, store, NOW);
  assertEquals(calls.events, ["upload rbn/2026/10/11/1410.ndjson.gz", `log rbn ${s.slice_start}`]);
  const text = await gunzip(calls.uploads[0]!.bytes);
  assertEquals(text.split("\n").filter((l) => l !== "").length, 3);
  assertEquals(text.endsWith("\n"), true);
  assertEquals(calls.logs[0], {
    source: "rbn",
    ...s,
    row_count: 3,
    bytes: calls.uploads[0]!.bytes.length,
    object_path: "rbn/2026/10/11/1410.ndjson.gz",
  });
  assertEquals([summary.slices, summary.rows, summary.empty, summary.errors], [1, 3, 0, []]);
});

Deno.test("runArchive logs an empty slice without uploading anything", async () => {
  const s = slice("2026-10-11T03:00:00Z", 60);
  const { db, store, calls } = fakes({ pending: { sotawatch: [s] }, rows: () => 0 });
  const summary = await runArchive(db, store, NOW);
  assertEquals(calls.uploads, []);
  assertEquals(calls.logs, [{ source: "sotawatch", ...s, row_count: 0, bytes: null, object_path: null }]);
  assertEquals([summary.slices, summary.empty], [1, 1]);
});

Deno.test("runArchive stops starting new slices at the row budget", async () => {
  const slices = [0, 10, 20].map((m) => slice(`2026-10-11T14:${String(m).padStart(2, "0")}:00Z`, 10));
  const { db, store, calls } = fakes({ pending: { rbn: slices }, rows: () => MAX_ROWS_PER_RUN - 1 });
  const summary = await runArchive(db, store, NOW);
  // The first slice stays under the budget, the second crosses it, the third is left for the next run.
  assertEquals(calls.uploads.length, 2);
  assertEquals(summary.rows, 2 * (MAX_ROWS_PER_RUN - 1));
});

Deno.test("runArchive: an upload failure leaves the slice unlogged and the other sources continue", async () => {
  const bad = slice("2026-10-11T12:00:00Z", 60);
  const next = slice("2026-10-11T13:00:00Z", 60);
  const good = slice("2026-10-11T14:00:00Z", 10);
  const { db, store, calls } = fakes({
    pending: { pota: [bad, next], rbn: [good] },
    failUpload: (path) => path.startsWith("pota/"),
  });
  const summary = await runArchive(db, store, NOW);
  assertEquals(calls.logs.map((l) => `${l.source} ${l.slice_start}`), [`rbn ${good.slice_start}`]);
  assertEquals(calls.events.filter((e) => e.startsWith("upload pota")).length, 1); // stopped POTA after the failure
  assertEquals(summary.errors.length, 1);
  assertEquals(summary.errors[0]!.includes("storage 503"), true);
});

Deno.test("runArchive records a pending-slices error and moves on", async () => {
  const { db, store } = fakes({ pending: { rbn: [slice("2026-10-11T14:00:00Z", 10)] } });
  const failing: ArchiveDb = {
    ...db,
    pendingSlices: (source, before, limit) =>
      source === "pota" ? Promise.reject(new Error("db down")) : db.pendingSlices(source, before, limit),
  };
  const summary = await runArchive(failing, store, NOW);
  assertEquals(summary.errors, ["pota: db down"]);
  assertEquals(summary.slices, 1);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `deno test -P supabase/functions/_shared/__tests__/archive.test.ts`
Expected: FAIL (`archive.ts` missing).

- [ ] **Step 3: Add the types**

Append to `supabase/functions/_shared/types.ts`:

```ts
/** One archive slice, [slice_start, slice_end), as ISO 8601 strings from Postgres. */
export interface ArchiveSlice {
  slice_start: string;
  slice_end: string;
}

/** An archived slice for archive_log. bytes and object_path are null for an empty slice. */
export interface ArchiveLogEntry extends ArchiveSlice {
  source: Source;
  row_count: number;
  bytes: number | null;
  object_path: string | null;
}

/** Database operations the archive job needs. Implemented by db.ts over the archive RPCs. */
export interface ArchiveDb {
  /** Slices of a source that ended before `before` and are not logged, oldest first. */
  pendingSlices(source: Source, before: Date, limit: number): Promise<ArchiveSlice[]>;
  /** One slice as NDJSON (no trailing newline) and its row count. */
  sliceNdjson(source: Source, slice: ArchiveSlice): Promise<{ row_count: number; ndjson: string }>;
  logArchive(entry: ArchiveLogEntry): Promise<void>;
}

/** Where archive objects go. Implemented by db.ts over the private `archive` bucket. */
export interface ArchiveStore {
  /** Writes the object, replacing one already at that path. */
  upload(path: string, bytes: Uint8Array): Promise<void>;
}
```

- [ ] **Step 4: Implement `archive.ts`**

Create `supabase/functions/_shared/archive.ts`:

```ts
// The archive job: every 10 minutes, write each finished slice of each source
// to Storage as gzipped NDJSON and record it in archive_log. Postgres decides
// which slices are due and builds their NDJSON (archive_pending_slices,
// archive_ndjson); this module only gzips, uploads and logs, so a run stays
// inside the Edge Function's 2 s CPU budget (measured: ~0.3 s for a full RBN
// hour). A slice is logged only after its upload succeeds, so a failure leaves
// it pending for the next run. Spec: docs/superpowers/specs/2026-10-11-rbn-firehose-archive-design.md.

import type { ArchiveDb, ArchiveSlice, ArchiveStore, Source } from "./types.ts";

/** POTA and SOTAwatch first: they are tiny, so an RBN backlog never starves them. */
export const ARCHIVE_ORDER: readonly Source[] = ["pota", "sotawatch", "rbn"];
/** Only slices that ended this long ago are archived, so late relay batches land first. */
export const LAG_MS = 2 * 60 * 60 * 1000;
/** A run starts no new slice once it has archived this many rows. */
export const MAX_ROWS_PER_RUN = 60_000;
export const MAX_SLICES_PER_SOURCE = 24;

export interface ArchiveSummary {
  slices: number;
  rows: number;
  bytes: number;
  empty: number;
  errors: string[];
  duration_ms: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `<source>/YYYY/MM/DD/HHMM.ndjson.gz` from the slice start in UTC. */
export function objectPath(source: Source, sliceStart: string): string {
  const d = new Date(sliceStart);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${source}/${d.getUTCFullYear()}/${two(d.getUTCMonth() + 1)}/${two(d.getUTCDate())}/` +
    `${two(d.getUTCHours())}${two(d.getUTCMinutes())}.ndjson.gz`;
}

export async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function runArchive(
  db: ArchiveDb,
  store: ArchiveStore,
  now: Date = new Date(),
): Promise<ArchiveSummary> {
  const started = performance.now();
  const summary: ArchiveSummary = { slices: 0, rows: 0, bytes: 0, empty: 0, errors: [], duration_ms: 0 };
  const before = new Date(now.getTime() - LAG_MS);

  sources: for (const source of ARCHIVE_ORDER) {
    let slices: ArchiveSlice[];
    try {
      slices = await db.pendingSlices(source, before, MAX_SLICES_PER_SOURCE);
    } catch (error) {
      summary.errors.push(`${source}: ${errorMessage(error)}`);
      continue;
    }
    for (const slice of slices) {
      if (summary.rows >= MAX_ROWS_PER_RUN) break sources;
      try {
        const { row_count, ndjson } = await db.sliceNdjson(source, slice);
        if (row_count === 0) {
          await db.logArchive({ source, ...slice, row_count: 0, bytes: null, object_path: null });
          summary.empty += 1;
        } else {
          const bytes = await gzip(`${ndjson}\n`);
          const path = objectPath(source, slice.slice_start);
          await store.upload(path, bytes);
          await db.logArchive({ source, ...slice, row_count, bytes: bytes.length, object_path: path });
          summary.rows += row_count;
          summary.bytes += bytes.length;
        }
        summary.slices += 1;
      } catch (error) {
        // Later slices of this source wait for the next run, which retries this one first.
        summary.errors.push(`${source} ${slice.slice_start}: ${errorMessage(error)}`);
        continue sources;
      }
    }
  }

  summary.duration_ms = Math.round(performance.now() - started);
  return summary;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `deno test -P supabase/functions/_shared/__tests__/archive.test.ts && deno task check`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/types.ts supabase/functions/_shared/archive.ts supabase/functions/_shared/__tests__/archive.test.ts
git commit -m "Add runArchive: gzip each due slice, upload, then log it"
```

---

### Task 3: Archive database and Storage adapters

**Files:**
- Modify: `supabase/functions/_shared/db.ts`
- Modify: `supabase/functions/_shared/__tests__/fake_supabase.ts`
- Test: `supabase/functions/_shared/__tests__/db.test.ts`

**Interfaces:**
- Consumes: `ArchiveDb`, `ArchiveStore`, `ArchiveSlice`, `ArchiveLogEntry` (Task 2).
- Produces: `createArchiveDb(client: SupabaseClient): ArchiveDb`; `createArchiveStore(client: SupabaseClient): ArchiveStore` (bucket `archive`); the fake gains `options.storageUpload?: FakeResult` and `calls.storage: Array<{ bucket: string; path: string; body: unknown; options: unknown }>`.

- [ ] **Step 1: Extend the fake client**

In `fake_supabase.ts`: add `storageUpload?: FakeResult;` to `FakeSupabaseOptions`; add `storage: Array<{ bucket: string; path: string; body: unknown; options: unknown }>;` to `FakeCalls` and `storage: [],` to the `calls` initializer; and add to the `fake` object, after `auth`:

```ts
    storage: {
      from(bucket: string) {
        return {
          upload(path: string, body: unknown, uploadOptions?: unknown) {
            calls.storage.push({ bucket, path, body, options: uploadOptions });
            return settle(options.storageUpload);
          },
        };
      },
    },
```

Update the header comment's list to "rpc, from(...).select/eq/single/maybeSingle/insert, storage.from(...).upload, and a few auth calls."

- [ ] **Step 2: Write the failing tests**

Append to `db.test.ts` (add `createArchiveDb, createArchiveStore` to the `../db.ts` import):

```ts
const SLICE = { slice_start: "2026-10-11T14:10:00+00:00", slice_end: "2026-10-11T14:20:00+00:00" };

Deno.test("pendingSlices calls archive_pending_slices with an ISO cutoff", async () => {
  const { client, calls } = fakeSupabase({ rpc: { archive_pending_slices: { data: [SLICE] } } });
  const before = new Date("2026-10-11T18:00:00Z");
  assertEquals(await createArchiveDb(client).pendingSlices("rbn", before, 24), [SLICE]);
  assertEquals(calls.rpc, [{
    fn: "archive_pending_slices",
    args: { p_source: "rbn", p_before: "2026-10-11T18:00:00.000Z", p_limit: 24 },
  }]);
});

Deno.test("sliceNdjson returns the RPC's single row, or an empty slice", async () => {
  const a = fakeSupabase({ rpc: { archive_ndjson: { data: [{ row_count: 2, ndjson: "{}\n{}" }] } } });
  assertEquals(await createArchiveDb(a.client).sliceNdjson("rbn", SLICE), { row_count: 2, ndjson: "{}\n{}" });
  assertEquals(a.calls.rpc[0]!.args, { p_source: "rbn", p_from: SLICE.slice_start, p_to: SLICE.slice_end });
  const b = fakeSupabase({ rpc: { archive_ndjson: { data: [] } } });
  assertEquals(await createArchiveDb(b.client).sliceNdjson("pota", SLICE), { row_count: 0, ndjson: "" });
});

Deno.test("logArchive passes every field to log_archive", async () => {
  const { client, calls } = fakeSupabase();
  await createArchiveDb(client).logArchive({
    source: "rbn", ...SLICE, row_count: 3, bytes: 120, object_path: "rbn/2026/10/11/1410.ndjson.gz",
  });
  assertEquals(calls.rpc, [{
    fn: "log_archive",
    args: {
      p_source: "rbn", p_slice_start: SLICE.slice_start, p_slice_end: SLICE.slice_end,
      p_row_count: 3, p_bytes: 120, p_object_path: "rbn/2026/10/11/1410.ndjson.gz",
    },
  }]);
});

Deno.test("archive RPC errors are thrown with the function name", async () => {
  const { client } = fakeSupabase({
    rpc: { archive_pending_slices: boom, archive_ndjson: boom, log_archive: boom },
  });
  const db = createArchiveDb(client);
  await assertRejects(() => db.pendingSlices("rbn", new Date(), 1), Error, "archive_pending_slices failed: boom");
  await assertRejects(() => db.sliceNdjson("rbn", SLICE), Error, "archive_ndjson failed: boom");
  await assertRejects(
    () => db.logArchive({ source: "rbn", ...SLICE, row_count: 0, bytes: null, object_path: null }),
    Error,
    "log_archive failed: boom",
  );
});

Deno.test("createArchiveStore uploads gzip to the private archive bucket, replacing any object", async () => {
  const { client, calls } = fakeSupabase();
  const bytes = new Uint8Array([1, 2, 3]);
  await createArchiveStore(client).upload("rbn/2026/10/11/1410.ndjson.gz", bytes);
  assertEquals(calls.storage, [{
    bucket: "archive",
    path: "rbn/2026/10/11/1410.ndjson.gz",
    body: bytes,
    options: { contentType: "application/gzip", upsert: true },
  }]);
  const failing = fakeSupabase({ storageUpload: boom });
  await assertRejects(
    () => createArchiveStore(failing.client).upload("p", bytes),
    Error,
    "archive upload failed for p: boom",
  );
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `deno test -P supabase/functions/_shared/__tests__/db.test.ts`
Expected: FAIL (`createArchiveDb` not exported).

- [ ] **Step 4: Implement the adapters**

In `db.ts`, add `ArchiveDb, ArchiveLogEntry, ArchiveSlice, ArchiveStore` to the type import and append:

```ts
export function createArchiveDb(client: SupabaseClient): ArchiveDb {
  return {
    async pendingSlices(source: Source, before: Date, limit: number): Promise<ArchiveSlice[]> {
      const { data, error } = await client.rpc("archive_pending_slices", {
        p_source: source,
        p_before: before.toISOString(),
        p_limit: limit,
      });
      if (error) throw new Error(`archive_pending_slices failed: ${error.message}`);
      return (data ?? []) as ArchiveSlice[];
    },

    async sliceNdjson(source: Source, slice: ArchiveSlice) {
      const { data, error } = await client.rpc("archive_ndjson", {
        p_source: source,
        p_from: slice.slice_start,
        p_to: slice.slice_end,
      });
      if (error) throw new Error(`archive_ndjson failed: ${error.message}`);
      const row = (data as Array<{ row_count: number; ndjson: string | null }> | null)?.[0];
      return { row_count: Number(row?.row_count ?? 0), ndjson: row?.ndjson ?? "" };
    },

    async logArchive(entry: ArchiveLogEntry): Promise<void> {
      const { error } = await client.rpc("log_archive", {
        p_source: entry.source,
        p_slice_start: entry.slice_start,
        p_slice_end: entry.slice_end,
        p_row_count: entry.row_count,
        p_bytes: entry.bytes,
        p_object_path: entry.object_path,
      });
      if (error) throw new Error(`log_archive failed: ${error.message}`);
    },
  };
}

export function createArchiveStore(client: SupabaseClient): ArchiveStore {
  return {
    async upload(path: string, bytes: Uint8Array): Promise<void> {
      const { error } = await client.storage.from("archive").upload(path, bytes, {
        contentType: "application/gzip",
        upsert: true,
      });
      if (error) throw new Error(`archive upload failed for ${path}: ${error.message}`);
    },
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass, then commit**

Run: `deno test -P supabase/functions/_shared/__tests__/db.test.ts && deno task check` → all pass.

```bash
git add supabase/functions/_shared/db.ts supabase/functions/_shared/__tests__/fake_supabase.ts supabase/functions/_shared/__tests__/db.test.ts
git commit -m "Add archive adapters over the slice RPCs and the archive bucket"
```

---

### Task 4: The `archive` Edge Function

**Files:**
- Create: `supabase/functions/_shared/handlers/archive.ts`
- Create: `supabase/functions/archive/index.ts`, `supabase/functions/archive/deno.json`
- Test: `supabase/functions/_shared/__tests__/handlers_archive.test.ts`

**Interfaces:**
- Consumes: `runArchive`, `ArchiveSummary` (Task 2); `createArchiveDb`, `createArchiveStore` (Task 3); `bearerToken` (`auth.ts`).
- Produces: `interface ArchiveDeps { serviceRoleKey: string | undefined; db: () => SupabaseClient }`; `handleArchive(req: Request, deps: ArchiveDeps, now?: Date): Promise<Response>` — 403 without the service-role bearer, otherwise the summary JSON with status 500 when `errors` is non-empty and 200 otherwise.

- [ ] **Step 1: Write the failing tests**

Create `supabase/functions/_shared/__tests__/handlers_archive.test.ts`:

```ts
import { assertEquals } from "@std/assert";
import { handleArchive } from "../handlers/archive.ts";
import { fakeSupabase } from "./fake_supabase.ts";

const KEY = "service-key";
const NOW = new Date("2026-10-11T20:05:00Z");
const req = (token?: string) =>
  new Request("http://x/archive", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

Deno.test("handleArchive refuses callers without the service-role key", async () => {
  const { client, calls } = fakeSupabase();
  for (const token of [undefined, "anon-key"]) {
    const res = await handleArchive(req(token), { serviceRoleKey: KEY, db: () => client }, NOW);
    assertEquals(res.status, 403);
  }
  const unset = await handleArchive(req(KEY), { serviceRoleKey: undefined, db: () => client }, NOW);
  assertEquals(unset.status, 403);
  assertEquals(calls.rpc, []);
});

Deno.test("handleArchive runs the archive and returns its summary", async () => {
  const slice = { slice_start: "2026-10-11T14:10:00+00:00", slice_end: "2026-10-11T14:20:00+00:00" };
  const { client, calls } = fakeSupabase({
    rpc: {
      archive_pending_slices: (args) => ({ data: args?.["p_source"] === "rbn" ? [slice] : [] }),
      archive_ndjson: { data: [{ row_count: 1, ndjson: '{"callsign":"K1ABC"}' }] },
    },
  });
  const res = await handleArchive(req(KEY), { serviceRoleKey: KEY, db: () => client }, NOW);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals([body.slices, body.rows, body.errors], [1, 1, []]);
  assertEquals(calls.storage.map((s) => s.path), ["rbn/2026/10/11/1410.ndjson.gz"]);
});

Deno.test("handleArchive answers 500 when any slice failed", async () => {
  const slice = { slice_start: "2026-10-11T14:00:00+00:00", slice_end: "2026-10-11T15:00:00+00:00" };
  const { client } = fakeSupabase({
    rpc: {
      archive_pending_slices: (args) => ({ data: args?.["p_source"] === "pota" ? [slice] : [] }),
      archive_ndjson: { data: [{ row_count: 1, ndjson: "{}" }] },
    },
    storageUpload: { error: { message: "storage 503" } },
  });
  const res = await handleArchive(req(KEY), { serviceRoleKey: KEY, db: () => client }, NOW);
  assertEquals(res.status, 500);
  assertEquals((await res.json()).errors.length, 1);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `deno test -P supabase/functions/_shared/__tests__/handlers_archive.test.ts`
Expected: FAIL (`handlers/archive.ts` missing).

- [ ] **Step 3: Implement the handler and entrypoint**

Create `supabase/functions/_shared/handlers/archive.ts`:

```ts
// The archive worker, called by pg_cron every 10 minutes with the service-role
// key (Vault). Runs runArchive over the slice RPCs and the archive bucket and
// returns its summary; 500 when any slice failed, so the failure shows up in
// net._http_response.

import type { SupabaseClient } from "@supabase/supabase-js";
import { runArchive } from "../archive.ts";
import { bearerToken } from "../auth.ts";
import { createArchiveDb, createArchiveStore } from "../db.ts";

export interface ArchiveDeps {
  serviceRoleKey: string | undefined;
  db: () => SupabaseClient;
}

export async function handleArchive(
  req: Request,
  deps: ArchiveDeps,
  now: Date = new Date(),
): Promise<Response> {
  // Only the service role (cron) may run the archive.
  if (!deps.serviceRoleKey || bearerToken(req) !== deps.serviceRoleKey) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  const client = deps.db();
  const summary = await runArchive(createArchiveDb(client), createArchiveStore(client), now);
  console.log(JSON.stringify(summary));
  return Response.json(summary, { status: summary.errors.length > 0 ? 500 : 200 });
}
```

Create `supabase/functions/archive/index.ts`:

```ts
import { createServiceClient } from "../_shared/db.ts";
import { handleArchive } from "../_shared/handlers/archive.ts";

Deno.serve((req) =>
  handleArchive(req, {
    serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    db: createServiceClient,
  })
);
```

Create `supabase/functions/archive/deno.json` with the same content as `supabase/functions/ingest-pota/deno.json`.

- [ ] **Step 4: Run all Deno checks, then commit**

Run: `deno task fmt && deno task lint && deno task check && deno task test` → all pass.

```bash
git add supabase/functions/_shared/handlers/archive.ts supabase/functions/_shared/__tests__/handlers_archive.test.ts supabase/functions/archive/
git commit -m "Add the archive Edge Function"
```

---

### Task 5: Retention in `maintain_rbn_spots`

**Files:**
- Create: `supabase/migrations/20261011000005_rbn_retention.sql`
- Create: `supabase/tests/rbn_retention.test.sql`

**Interfaces:**
- Consumes: `archive_log`, `log_archive` (Task 1); `create_rbn_spots_partition`, `maintain_rbn_spots` (PR 1).
- Produces: `rbn_day_slices(p_day date) returns table (slice_start timestamptz, db_rows int, archived_rows int)`; `retire_rbn_day(p_day date) returns boolean` (true when the day was dropped); `maintain_rbn_spots()` now also retires days with `day < today_utc - 7`.

- [ ] **Step 1: Write the failing pgTAP suite**

Create `supabase/tests/rbn_retention.test.sql`:

```sql
-- pgTAP: rbn_spots retention (20261011000005). A day older than seven is
-- dropped only when every 10-minute slice is archived with the database's count.
begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

create or replace function pg_temp.d(p_offset int) returns date language sql as $$
  select (now() at time zone 'utc')::date + p_offset;
$$;
create or replace function pg_temp.at(p_offset int, p_hm text) returns timestamptz language sql as $$
  select ((pg_temp.d(p_offset))::text || ' ' || p_hm || '+00')::timestamptz;
$$;
create or replace function pg_temp.spot(p_time timestamptz, p_call text) returns jsonb language sql as $$
  select jsonb_build_object(
    'spot_time', p_time, 'received_at', p_time, 'spotter', 'W3LPL', 'callsign', p_call,
    'frequency_khz', 14035.1, 'band', '20m', 'mode', 'cw', 'mode_family', 'cw', 'snr', 12,
    'speed', 22, 'speed_unit', 'WPM', 'spot_type', 'CQ', 'line', 'x');
$$;
-- Logs every 10-minute slice of a day with the database's current count.
create or replace function pg_temp.archive_day(p_offset int) returns void language sql as $$
  select log_archive('rbn', s.slice_start, s.slice_start + interval '10 minutes', s.db_rows,
                     case when s.db_rows > 0 then 100 end,
                     case when s.db_rows > 0 then 'rbn/test' end)
  from rbn_day_slices(pg_temp.d(p_offset)) s;
$$;
create or replace function pg_temp.partition(p_offset int) returns regclass language sql as $$
  select to_regclass('partitions.rbn_spots_' || to_char(pg_temp.d(p_offset), 'YYYYMMDD'));
$$;

delete from rbn_spots;
delete from archive_log;

-- Day -9: archived with matching counts.          -> dropped
-- Day -10: one slice logged with the wrong count.  -> kept, that log row deleted
-- Day -11: never archived.                         -> kept
-- Day -12: rows only in the default partition, archived -> rows deleted
-- Day -3: archived but recent.                     -> kept
select create_rbn_spots_partition(pg_temp.d(-9));
select create_rbn_spots_partition(pg_temp.d(-10));
select create_rbn_spots_partition(pg_temp.d(-11));
select create_rbn_spots_partition(pg_temp.d(-3));
select ingest_rbn_spots(jsonb_build_array(
  pg_temp.spot(pg_temp.at(-9, '10:01'), 'A1'), pg_temp.spot(pg_temp.at(-9, '10:02'), 'A2'),
  pg_temp.spot(pg_temp.at(-10, '11:05'), 'B1'), pg_temp.spot(pg_temp.at(-10, '11:06'), 'B2'),
  pg_temp.spot(pg_temp.at(-11, '12:00'), 'C1'),
  pg_temp.spot(pg_temp.at(-12, '13:00'), 'D1'),
  pg_temp.spot(pg_temp.at(-3, '14:00'), 'E1')));
select pg_temp.archive_day(-9);
select pg_temp.archive_day(-10);
select log_archive('rbn', pg_temp.at(-10, '11:00'), pg_temp.at(-10, '11:10'), 1, 100, 'rbn/test');
select pg_temp.archive_day(-12);
select pg_temp.archive_day(-3);

select is((select count(*) from rbn_day_slices(pg_temp.d(-9)))::int, 144, 'a day has 144 ten-minute slices');
select is((select db_rows from rbn_day_slices(pg_temp.d(-10)) where slice_start = pg_temp.at(-10, '11:00')), 2,
  'rbn_day_slices counts the database rows per slice');

select lives_ok('select maintain_rbn_spots()', 'maintain_rbn_spots runs the retention step');

select ok(pg_temp.partition(-9) is null, 'an archived day older than seven is dropped');
select is((select count(*) from rbn_spots where callsign like 'A%')::int, 0, 'its rows are gone');
select ok(pg_temp.partition(-10) is not null, 'a mismatched slice keeps the partition');
select ok(not exists (select 1 from archive_log where source = 'rbn' and slice_start = pg_temp.at(-10, '11:00')),
  'a mismatched slice keeps the partition and loses its log row, so it is re-archived');
select is((select count(*) from archive_log where source = 'rbn' and slice_start >= pg_temp.at(-10, '00:00')
           and slice_start < pg_temp.at(-9, '00:00'))::int, 143, 'the day''s matching slices keep their log rows');
select ok(pg_temp.partition(-11) is not null, 'a day never archived is kept');
select is((select count(*) from rbn_spots where callsign = 'D1')::int, 0, 'default-partition rows of an archived day are deleted');
select ok(pg_temp.partition(-3) is not null, 'a recent day is kept even when archived');
select ok(not has_function_privilege('authenticated', 'public.retire_rbn_day(date)', 'execute')
          and not has_function_privilege('authenticated', 'public.rbn_day_slices(date)', 'execute'),
  'retention functions are not callable by clients');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it to verify it fails**

Run: `supabase db reset && supabase test db 2>&1 | grep -A3 rbn_retention`
Expected: FAIL (`function rbn_day_slices(date) does not exist`).

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261011000005_rbn_retention.sql`:

```sql
-- rbn_spots retention (spec "Retention", steps 2 and 3, with 10-minute slices
-- from the "Amendment after measurement"). maintain_rbn_spots() now also
-- retires days that ended more than seven days ago: a day is dropped only when
-- every one of its 144 slices is in archive_log with the database's row count.
-- A slice whose count differs loses its log row, so the next archive run writes
-- it again; the day is checked again the next night.

-- The day's 10-minute slices with the database count and the archived count
-- (null when the slice is not logged).
create function public.rbn_day_slices(p_day date)
returns table (slice_start timestamptz, db_rows int, archived_rows int)
language sql
stable
security definer
set search_path = public
as $$
  with bounds as (
    select p_day::timestamp at time zone 'utc' as day_from,
           (p_day + 1)::timestamp at time zone 'utc' as day_to
  ),
  counts as (
    select date_bin(interval '10 minutes', r.spot_time, timestamptz '2000-01-01 00:00+00') as s,
           count(*)::int as n
    from rbn_spots r, bounds b
    where r.spot_time >= b.day_from and r.spot_time < b.day_to
    group by 1
  )
  select g.s, coalesce(c.n, 0), l.row_count
  from bounds b,
       generate_series(b.day_from, b.day_to - interval '10 minutes', interval '10 minutes') as g(s)
  left join counts c on c.s = g.s
  left join archive_log l on l.source = 'rbn' and l.slice_start = g.s
  order by g.s;
$$;

-- Drops one day if it is fully archived; otherwise clears the log rows of its
-- mismatched slices. Returns true when the day was dropped.
create function public.retire_rbn_day(p_day date)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from timestamptz := p_day::timestamp at time zone 'utc';
  v_to   timestamptz := (p_day + 1)::timestamp at time zone 'utc';
  v_bad  int;
begin
  delete from archive_log l
  using public.rbn_day_slices(p_day) s
  where l.source = 'rbn' and l.slice_start = s.slice_start and l.row_count <> s.db_rows;

  select count(*) into v_bad
  from public.rbn_day_slices(p_day) s
  where s.archived_rows is distinct from s.db_rows;
  if v_bad > 0 then
    return false;
  end if;

  execute format('drop table if exists partitions.%I', 'rbn_spots_' || to_char(p_day, 'YYYYMMDD'));
  delete from partitions.rbn_spots_default where spot_time >= v_from and spot_time < v_to;
  return true;
end;
$$;

-- Daily at 03:30 UTC (cron from 20261011000003): partitions ahead, then retention.
create or replace function public.maintain_rbn_spots()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'utc')::date;
  v_day   date;
begin
  for v_day in select (v_today + i) from generate_series(0, 3) as i loop
    perform public.create_rbn_spots_partition(v_day);
  end loop;

  for v_day in
    select to_date(substr(c.relname, 11), 'YYYYMMDD')
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'public.rbn_spots'::regclass and c.relname ~ '^rbn_spots_[0-9]{8}$'
    union
    select distinct (d.spot_time at time zone 'utc')::date from partitions.rbn_spots_default d
    order by 1
  loop
    continue when v_day >= v_today - 7;
    perform public.retire_rbn_day(v_day);
  end loop;
end;
$$;

revoke all on function public.rbn_day_slices(date) from public, anon, authenticated;
revoke all on function public.retire_rbn_day(date) from public, anon, authenticated;
revoke all on function public.maintain_rbn_spots() from public, anon, authenticated;
grant execute on function public.maintain_rbn_spots() to service_role;
```

- [ ] **Step 4: Run the suites to verify they pass, then commit**

Run: `supabase db reset && supabase test db 2>&1 | tail -4` → `Result: PASS`; `supabase db lint --fail-on error` → no results; smoke test → `smoke test passed`.

```bash
git add supabase/migrations/20261011000005_rbn_retention.sql supabase/tests/rbn_retention.test.sql
git commit -m "Retire rbn_spots days only once every slice is archived with matching counts"
```

---

### Task 6: Remove the `ingest-rbn` watchlist GET

**Files:**
- Modify: `supabase/functions/_shared/serve.ts`
- Test: `supabase/functions/_shared/__tests__/serve.test.ts`

**Interfaces:**
- Produces: `pushIngestHandler<D>(source, run, deps)` without the `WatchlistDb` bound; GET answers 405 like any other non-POST method.

- [ ] **Step 1: Change the tests**

In `serve.test.ts`: delete the tests "pushIngestHandler GET returns the watchlist for its source" and "pushIngestHandler GET reports a watchlist failure as a 500"; in `pushHandler` drop the `watchlist` override and the `watched` array (return `{ handler, bodies }`; `pushDb` becomes `db`); in "fails closed when the secret is not configured" change the request method to `"POST"` with body `"{}"`; and add:

```ts
Deno.test("pushIngestHandler refuses GET now that the relay no longer reads a watchlist", async () => {
  const { handler } = pushHandler();
  assertEquals((await handler(relayRequest("GET", SECRET))).status, 405);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `deno test -P supabase/functions/_shared/__tests__/serve.test.ts`
Expected: FAIL (GET still answers 200).

- [ ] **Step 3: Remove the GET branch**

In `serve.ts`: delete the `if (req.method === "GET") { ... }` block; change `PushDeps<D extends WatchlistDb>` and `pushIngestHandler<D extends WatchlistDb>` to `PushDeps<D>` and `pushIngestHandler<D>`; drop `WatchlistDb` from the type import; change the header's last sentence to "Pushed sources (RBN) are invoked by the relay, which holds only the relay secret, with POST batches of lines."

- [ ] **Step 4: Run all Deno checks, then commit**

Run: `deno task fmt && deno task lint && deno task check && deno task test` → all pass.

```bash
git add supabase/functions/_shared/serve.ts supabase/functions/_shared/__tests__/serve.test.ts
git commit -m "ingest-rbn: drop the watchlist GET the relay no longer calls"
```

---

### Task 7: Docs, types and end-to-end verification

**Files:**
- Regenerate: `web/src/lib/database.types.ts`
- Modify: `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, `README.md`, `CLAUDE.md`

- [ ] **Step 1: Regenerate types and run the web checks**

Run: `supabase db reset && supabase gen types typescript --local > web/src/lib/database.types.ts && cd web && npm run lint && npm test && SUPABASE_URL=https://example.supabase.co SUPABASE_ANON_KEY=placeholder npm run build`
Expected: clean; `git diff --stat web/src/lib/database.types.ts` shows `archive_log`, `archive_status` and the new functions, and no `partitions` tables.

- [ ] **Step 2: Update the docs**

- `docs/ARCHITECTURE.md`, section "Streaming sources: the relay": replace "until that archive and retention work lands, nothing is dropped." with "`maintain_rbn_spots()` drops a day once every 10-minute slice is archived with a matching count (see "The spot archive")." Add a new top-level section after it:

  "# The spot archive" with: every spot of every source is written to the private `archive` bucket as gzipped NDJSON by the `archive` Edge Function, which pg_cron calls every 10 minutes with the service-role key; slice length comes from `archive_slice_minutes` (RBN 10 minutes, POTA and SOTAwatch an hour) and objects are `<source>/YYYY/MM/DD/HHMM.ndjson.gz`; Postgres decides which slices are due (`archive_pending_slices`, two hours after they end) and builds their NDJSON (`archive_ndjson`), so the function only gzips and uploads (measured at ~0.3 s CPU for a full RBN hour against the 2 s limit); a run stops starting slices at 60,000 rows; a slice is logged in `archive_log` only after its upload succeeds and empty slices are logged with `row_count = 0`; retention (`retire_rbn_day`) drops an RBN day older than seven only when all 144 slices are logged with the database's count and clears the log rows of mismatched slices so they are re-archived; POTA and SOTAwatch are never deleted from `raw_spots`. The NDJSON fields per source as in the spec.

- `docs/OPERATIONS.md`: replace the "rbn_spots size" subsection's "Until archiving and retention land (PR 2) nothing is dropped." with "About seven days (2.5-3 GB) stay in the database." Add a section "# Spot archive" with:
  - "Is it keeping up?" → `select * from archive_status;` (`pending_slices` should be 0-2 per source; growth means runs are failing) and `select status_code, content::text from net._http_response order by created desc limit 5;` for the function's last responses.
  - "Re-archive a slice" → `delete from archive_log where source = 'rbn' and slice_start = '<ts>';` (the next run rewrites the object).
  - "Retention" → runs in `maintain_rbn_spots()` at 03:30 UTC; `select * from rbn_day_slices('<date>') where archived_rows is distinct from db_rows;` shows why a day is still kept.
  - "Reading the archive" → DuckDB over Storage's S3 endpoint:
    ```sql
    install httpfs; load httpfs;
    create secret (type s3, key_id '<S3 access key>', secret '<S3 secret>',
                   endpoint '<project-ref>.supabase.co/storage/v1/s3', region '<region>', url_style 'path');
    select spot_type, count(*) from read_json_auto('s3://archive/rbn/2026/10/11/*.ndjson.gz') group by 1;
    ```
    with a note that S3 keys are created under Storage settings and grant access to every bucket, so they belong on an operator's machine, never in the app or the relay.
- `README.md`: in the "Streaming sources" paragraph replace "(partitioned by day; a rolling seven days with older days archived to Storage once the archive work lands, nothing is dropped until then)" with "(partitioned by day; seven days stay in the database)", and after the "Deliver." paragraph add a paragraph: "**Archive.** Every spot from every source is also written to a private Storage bucket as gzipped NDJSON, ten-minute files for RBN and hourly for POTA and SOTAwatch, by the `archive` function every 10 minutes. Files are readable directly by DuckDB, pandas or Spark. RBN days are dropped from the database only after their archive matches." Add `archive` to the function deploy loop in "Deploying to a hosted project".
- `CLAUDE.md`: add an "## Archive rules" section: slice length lives only in `archive_slice_minutes`; NDJSON is built in SQL (`archive_ndjson`), never in TypeScript; a slice is logged only after its upload succeeds; nothing is deleted from `rbn_spots` unless `retire_rbn_day` finds every slice logged with a matching count; `raw_spots` is never pruned by the archive; S3 keys never go in the app or relay. In "Relay rules", remove "`GET` still returns the watchlist" wording if present, and in the ARCHITECTURE push bullet remove the sentence about `GET` returning the watchlist.

- [ ] **Step 3: End-to-end against the local stack**

With `supabase start` and `supabase functions serve` (no extra env needed for `archive`), seed one synthetic RBN hour three hours ago (the 62,000-row `generate_series` insert from the spec's amendment measurement) and two POTA rows, then:

```bash
KEY=$(supabase status -o env | grep '^SERVICE_ROLE_KEY' | cut -d'"' -f2)
for i in 1 2; do curl -s -X POST http://127.0.0.1:54321/functions/v1/archive -H "Authorization: Bearer $KEY"; echo; done
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:54321/functions/v1/archive   # expected 403
```

Expected: the first run archives the POTA slice(s) and all six RBN slices of ~10,333 rows (the 60,000-row budget is checked before starting each slice, so the sixth still starts at ~51,700), `errors: []`; the second run archives nothing new except slices that have since become due. Then check:

```sql
select source, count(*), sum(row_count) from archive_log group by 1;   -- rbn 62000 rows over its slices
select name from storage.objects where bucket_id = 'archive' order by 1 limit 3;  -- rbn/YYYY/MM/DD/HHMM.ndjson.gz
select * from archive_status;                                            -- pending 0 for the seeded sources
```

Download one RBN object (`curl -H "Authorization: Bearer $KEY" http://127.0.0.1:54321/storage/v1/object/archive/<path> | gunzip | wc -l`) and confirm its line count equals that slice's `row_count`. Record the function's `duration_ms` for a full-hour run.

- [ ] **Step 4: Full CI, commit, PR**

Run: `supabase db reset && cd web && npm run test:all` → all groups pass.

```bash
git add web/src/lib/database.types.ts docs/ARCHITECTURE.md docs/OPERATIONS.md README.md CLAUDE.md
git commit -m "Describe the spot archive and RBN retention; regenerate database types"
git push -u origin rbn-archive
gh pr create --title "Archive every spot to Storage and retire old RBN days (firehose, PR 2 of 2)" --body "<summary, verification, deploy order: db push + functions deploy archive and ingest-rbn before merge>"
```

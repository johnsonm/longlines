# RBN Firehose Ingest (PR 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store every RBN spot the inbound worker receives in a day-partitioned `rbn_spots` table, while only watched callsigns continue into `raw_spots` and alerting.

**Architecture:** The inbound worker stops filtering and forwards every spot line in batches of up to 1,000. `ingest-rbn` turns each line into an `rbn_spots` row and bulk-inserts the batch through one RPC, then runs the existing `runIngest` over only the watched lines so matching and delivery are unchanged. A daily pg_cron job keeps partitions created four days ahead and moves any rows that fell into the default partition.

**Tech Stack:** Postgres 17 (Supabase, pg_cron, declarative partitioning), Deno 2 Edge Functions in strict TypeScript, the Deno inbound in `inbound/`, pgTAP, `deno test`.

**Spec:** `docs/superpowers/specs/2026-10-11-rbn-firehose-archive-design.md` (this plan covers the spec's "Rollout" PR 1: data model for `rbn_spots`, ingest path, partition creation. Archive, `archive_log`, retention drops and `archive_status` are PR 2 and a separate plan.)

## Global Constraints

- Strict TypeScript, no JavaScript files, no `any` without a justifying comment, no new runtime dependencies.
- Applied migrations are never edited. This plan adds `supabase/migrations/20261011000003_rbn_spots.sql` (`20261011000002` is taken by the open stats-fix branch).
- Every new table, partition and function has `anon` and `authenticated` revoked; functions are executable by `service_role` only. Every partition has RLS enabled with no policies.
- `rbn_spots` unique key is exactly `(spot_time, spotter, callsign, frequency_khz)`; partitions are named `rbn_spots_YYYYMMDD` by UTC day plus `rbn_spots_default`.
- Inbound batches: `maxBatch` 1,000, `flushMs` 10 s, `heartbeatMs` 60 s, `maxBuffer` 50,000. `ingest-rbn` rejects bodies over 1,000 lines (existing `MAX_LINES`).
- Lines are stored in `rbn_spots` regardless of age. Only the alert path (`runIngest`) applies the five-minute `too_old` cutoff.
- Parsing lives in `supabase/functions/_shared/rbn.ts`; the inbound worker never parses beyond calling `parseRbnLine`.
- The inbound worker holds only `LONGLINES_INBOUND_SECRET`, never a Supabase key. No test connects to RBN.
- `deno fmt` line width is 100. Run `supabase db reset` before `supabase test db`; another session may share the local stack.
- Never run `supabase db push`, `supabase functions deploy`, `fly deploy` or `fly secrets set`.

## Review Focus

1. The daily job missed a few days, so a day's rows sit in `rbn_spots_default` when that day's partition is created: creation must move them, not fail (Task 1, test "rows waiting in the default partition move into the new partition").
2. The inbound worker retries a batch whose first attempt was stored but timed out: no duplicate rows, and a batch with the same spot twice stores it once (Task 1 dedup tests; Task 3 "a retried batch").
3. One batch mixes banners, bad `received_at`, watched and unwatched spots: every parseable line reaches `rbn_spots`, only watched ones reach `raw_spots`, each bad line becomes exactly one `ingest_failures` row (Task 3 "stores every line and alerts only watched callsigns").
4. A 2359Z spot received just after midnight UTC belongs to the previous day and its partition (Task 2 "midnight").
5. Supabase is down for half an hour: the inbound worker buffers up to 50,000 lines, drops only the oldest beyond that and reports `dropped`; when lines finally arrive they are stored but not alerted (Task 5 "defaults"; Task 3 "late lines").

---

## File Structure

| File | Responsibility |
| --- | --- |
| `supabase/migrations/20261011000003_rbn_spots.sql` (create) | `rbn_spots` table, default partition, `create_rbn_spots_partition`, `maintain_rbn_spots`, `ingest_rbn_spots`, cron job, grants. |
| `supabase/tests/rbn_spots.test.sql` (create) | pgTAP for the migration. |
| `scripts/smoke-test.sql` (modify) | One `ingest_rbn_spots` round trip. |
| `supabase/functions/_shared/types.ts` (modify) | `RbnSpotRow`, `RbnDb`, `IngestSummary.stored`. |
| `supabase/functions/_shared/rbn.ts` (modify) | `parseInboundBody`, `rbnComment`, `rbnSpotRow` (pure). |
| `supabase/functions/_shared/db.ts` (modify) | `createRbnDb` over the `ingest_rbn_spots` RPC. |
| `supabase/functions/_shared/rbn_push.ts` (create) | `runRbnPush`: store all lines, alert watched ones. |
| `supabase/functions/_shared/serve.ts` (modify) | `pushIngestHandler` / `servePush` take a run function instead of an adapter factory. |
| `supabase/functions/ingest-rbn/index.ts` (modify) | `servePush("rbn", runRbnPush)`. |
| `inbound/feeds.ts`, `inbound/main.ts`, `inbound/forwarder.ts`, `inbound/functions.ts`, `inbound/health.ts` (modify) | Forward every spot line; new defaults; `dropped` in health. |
| `inbound/watchlist.ts` (delete) | No longer used. |
| `web/src/lib/database.types.ts` (regenerate) | Generated types. |
| `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, `README.md`, `CLAUDE.md` (modify) | Describe full ingest. |

---

### Task 1: `rbn_spots` schema, partitions and bulk-insert RPC

**Files:**
- Create: `supabase/migrations/20261011000003_rbn_spots.sql`
- Create: `supabase/tests/rbn_spots.test.sql`
- Modify: `scripts/smoke-test.sql`

**Interfaces:**
- Produces: table `public.rbn_spots`; `public.create_rbn_spots_partition(p_day date) returns void`; `public.maintain_rbn_spots() returns void`; `public.ingest_rbn_spots(p_rows jsonb) returns int` (rows inserted). RPC row keys: `spot_time, received_at, spotter, callsign, frequency_khz, band, mode, mode_family, snr, speed, speed_unit, spot_type, line`.

Requires the local stack: `supabase start` (Docker running).

- [ ] **Step 1: Write the failing pgTAP suite**

Create `supabase/tests/rbn_spots.test.sql`:

```sql
-- pgTAP: rbn_spots (20261011000003): partitions by UTC day, the default
-- partition hand-off, dedup, the bulk-insert RPC, grants and the cron job.
begin;
create extension if not exists pgtap with schema extensions;
select plan(22);

create or replace function pg_temp.day_name(p_offset int) returns text language sql as $$
  select 'rbn_spots_' || to_char((now() at time zone 'utc')::date + p_offset, 'YYYYMMDD');
$$;
create or replace function pg_temp.day_start(p_offset int) returns timestamptz language sql as $$
  select ((now() at time zone 'utc')::date + p_offset)::timestamp at time zone 'utc';
$$;
create or replace function pg_temp.spot(p_time timestamptz, p_call text) returns jsonb language sql as $$
  select jsonb_build_object(
    'spot_time', p_time, 'received_at', p_time, 'spotter', 'W3LPL', 'callsign', p_call,
    'frequency_khz', 14035.1, 'band', '20m', 'mode', 'cw', 'mode_family', 'cw', 'snr', 12,
    'speed', 22, 'speed_unit', 'WPM', 'spot_type', 'CQ',
    'line', 'DX de W3LPL-#:  14035.1  ' || p_call || '  CW  12 dB  22 WPM  CQ  1200Z');
$$;

-- Partitions: the job is idempotent and keeps today through three days ahead.
select lives_ok('select maintain_rbn_spots()', 'maintain_rbn_spots runs');
select lives_ok('select maintain_rbn_spots()', 'maintain_rbn_spots is idempotent');
select ok(to_regclass('public.' || pg_temp.day_name(0)) is not null, 'today has a partition');
select ok(to_regclass('public.' || pg_temp.day_name(3)) is not null, 'three days ahead has a partition');
select ok(to_regclass('public.' || pg_temp.day_name(4)) is null, 'four days ahead is not created yet');
select ok(to_regclass('public.rbn_spots_default') is not null, 'the default partition exists');

-- Bulk insert and dedup.
select is(ingest_rbn_spots(jsonb_build_array(
  pg_temp.spot(pg_temp.day_start(0) + interval '1 hour', 'K1TODAY'),
  pg_temp.spot(pg_temp.day_start(0) + interval '2 hours', 'K2TODAY'))), 2, 'ingest_rbn_spots returns rows inserted');
select is(ingest_rbn_spots(jsonb_build_array(
  pg_temp.spot(pg_temp.day_start(0) + interval '1 hour', 'K1TODAY'),
  pg_temp.spot(pg_temp.day_start(0) + interval '2 hours', 'K2TODAY'))), 0, 'a retried batch inserts nothing');
select is(ingest_rbn_spots(jsonb_build_array(
  pg_temp.spot(pg_temp.day_start(0) + interval '3 hours', 'K3TWICE'),
  pg_temp.spot(pg_temp.day_start(0) + interval '3 hours', 'K3TWICE'))), 1, 'the same spot twice in one batch is stored once');
select is((select tableoid::regclass::text from rbn_spots where callsign = 'K1TODAY'), pg_temp.day_name(0),
  'a row is routed to its UTC day''s partition');

-- A day with no partition lands in the default partition, and creating that
-- day's partition later moves the rows instead of failing.
select is(ingest_rbn_spots(jsonb_build_array(pg_temp.spot(pg_temp.day_start(-10) + interval '23 hours 59 minutes', 'K4LATE'))), 1,
  'a row for a day without a partition is accepted');
select is((select tableoid::regclass::text from rbn_spots where callsign = 'K4LATE'), 'rbn_spots_default',
  'it is held in the default partition');
select lives_ok(format('select create_rbn_spots_partition(%L::date)', (now() at time zone 'utc')::date - 10),
  'creating that day''s partition succeeds with rows waiting in the default partition');
select is((select tableoid::regclass::text from rbn_spots where callsign = 'K4LATE'), pg_temp.day_name(-10),
  'rows waiting in the default partition move into the new partition');
select is((select count(*) from rbn_spots_default)::int, 0, 'the default partition is empty afterwards');

-- Access: service role only, including partitions created later.
select ok((select relrowsecurity from pg_class where relname = pg_temp.day_name(-10)), 'a created partition has RLS on');
select ok(not has_table_privilege('anon', 'public.' || pg_temp.day_name(-10), 'select'), 'anon cannot read a created partition');
select ok(not has_table_privilege('authenticated', 'public.rbn_spots', 'select'), 'authenticated cannot read rbn_spots');
select ok(not has_function_privilege('authenticated', 'public.ingest_rbn_spots(jsonb)', 'execute'), 'clients cannot call ingest_rbn_spots');
select ok(has_function_privilege('service_role', 'public.ingest_rbn_spots(jsonb)', 'execute'), 'service_role can call ingest_rbn_spots');

select throws_ok(
  format('select ingest_rbn_spots(%L::jsonb)', jsonb_build_array(pg_temp.spot(now(), 'K5BAD') || '{"speed_unit":"FPS"}')),
  '23514', null, 'speed_unit must be WPM or BPS');
select ok(exists (select 1 from cron.job where jobname = 'maintain-rbn-spots' and schedule = '30 3 * * *'),
  'maintain-rbn-spots runs daily at 03:30 UTC');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it to verify it fails**

Run: `supabase db reset && supabase test db 2>&1 | grep -A3 rbn_spots.test`
Expected: FAIL (`function maintain_rbn_spots() does not exist`).

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20261011000003_rbn_spots.sql`:

```sql
-- Every RBN spot, kept for seven days in the database and archived to Storage
-- (spec: docs/superpowers/specs/2026-10-11-rbn-firehose-archive-design.md).
--
-- raw_spots keeps only RBN spots of watched callsigns, so matching and delivery
-- never see the firehose. This table holds all of them, partitioned by UTC day
-- so old days can be dropped whole once archived (PR 2).
--
-- The unique key includes spot_time because Postgres requires the partition key
-- in every unique constraint; it is also what identifies an RBN spot, so a batch
-- the inbound worker retries inserts nothing new.

create table rbn_spots (
  spot_time      timestamptz   not null,
  received_at    timestamptz   not null,
  ingested_at    timestamptz   not null default now(),
  spotter        text          not null,
  callsign       text          not null,
  frequency_khz  numeric(12,3) not null,
  band           text,
  mode           text,
  mode_family    text,
  snr            smallint      not null,
  speed          smallint      not null,
  speed_unit     text          not null check (speed_unit in ('WPM', 'BPS')),
  spot_type      text          not null,
  line           text          not null,
  unique (spot_time, spotter, callsign, frequency_khz)
) partition by range (spot_time);

create index rbn_spots_callsign_time_idx on rbn_spots (callsign, spot_time);

-- Catches rows for a day without a partition (the daily job did not run), so an
-- insert never fails for lack of one. create_rbn_spots_partition moves them out.
create table rbn_spots_default partition of rbn_spots default;

alter table rbn_spots enable row level security;
alter table rbn_spots_default enable row level security;
revoke all on rbn_spots from anon, authenticated;
revoke all on rbn_spots_default from anon, authenticated;

-- Creates the partition for one UTC day. A plain CREATE ... PARTITION OF fails
-- when the default partition already holds rows for that day, so the table is
-- built standalone, those rows are moved into it, and it is attached. New
-- tables pick up Supabase's default grants, so access is revoked here too.
create function public.create_rbn_spots_partition(p_day date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text        := 'rbn_spots_' || to_char(p_day, 'YYYYMMDD');
  v_from timestamptz := p_day::timestamp at time zone 'utc';
  v_to   timestamptz := (p_day + 1)::timestamp at time zone 'utc';
begin
  if to_regclass('public.' || v_name) is not null then
    return;
  end if;
  execute format('create table %I (like rbn_spots including defaults including constraints)', v_name);
  execute format(
    'with moved as (delete from rbn_spots_default where spot_time >= %L and spot_time < %L returning *)
     insert into %I select * from moved',
    v_from, v_to, v_name);
  execute format('alter table rbn_spots attach partition %I for values from (%L) to (%L)', v_name, v_from, v_to);
  execute format('alter table %I enable row level security', v_name);
  execute format('revoke all on %I from anon, authenticated', v_name);
end;
$$;

-- Daily: partitions for today and the next three UTC days. PR 2 adds the
-- archived-only drop of days older than seven.
create function public.maintain_rbn_spots()
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
end;
$$;

-- One batch from ingest-rbn. Keys match the columns (RbnSpotRow in
-- _shared/types.ts). Returns the number of rows inserted.
create function public.ingest_rbn_spots(p_rows jsonb)
returns int
language sql
security definer
set search_path = public
as $$
  with ins as (
    insert into rbn_spots (
      spot_time, received_at, spotter, callsign, frequency_khz, band, mode, mode_family,
      snr, speed, speed_unit, spot_type, line
    )
    select x.spot_time, x.received_at, x.spotter, x.callsign, x.frequency_khz, x.band, x.mode,
           x.mode_family, x.snr, x.speed, x.speed_unit, x.spot_type, x.line
    from jsonb_to_recordset(p_rows) as x(
      spot_time timestamptz, received_at timestamptz, spotter text, callsign text,
      frequency_khz numeric, band text, mode text, mode_family text, snr smallint,
      speed smallint, speed_unit text, spot_type text, line text
    )
    on conflict do nothing
    returning 1
  )
  select count(*)::int from ins;
$$;

revoke all on function public.create_rbn_spots_partition(date) from public, anon, authenticated;
revoke all on function public.maintain_rbn_spots() from public, anon, authenticated;
revoke all on function public.ingest_rbn_spots(jsonb) from public, anon, authenticated;
grant execute on function public.ingest_rbn_spots(jsonb) to service_role;
grant execute on function public.maintain_rbn_spots() to service_role;

select public.maintain_rbn_spots();
select cron.schedule('maintain-rbn-spots', '30 3 * * *', $$ select public.maintain_rbn_spots(); $$);
```

- [ ] **Step 4: Run the suite to verify it passes**

Run: `supabase db reset && supabase test db 2>&1 | tail -4`
Expected: `Result: PASS` with `rbn_spots.test.sql .. ok`.

- [ ] **Step 5: Add the smoke-test round trip**

In `scripts/smoke-test.sql`, after the block that asserts `ingest_health` has one row per source, add:

```sql
  -- rbn_spots: the bulk RPC inserts and dedups.
  assert public.ingest_rbn_spots(jsonb_build_array(jsonb_build_object(
    'spot_time', now(), 'received_at', now(), 'spotter', 'W3LPL', 'callsign', 'SM0KE',
    'frequency_khz', 14035.1, 'band', '20m', 'mode', 'cw', 'mode_family', 'cw', 'snr', 12,
    'speed', 22, 'speed_unit', 'WPM', 'spot_type', 'CQ', 'line', 'smoke'))) = 1,
    'ingest_rbn_spots should insert one row';
  assert exists (select 1 from cron.job where jobname = 'maintain-rbn-spots'),
    'maintain-rbn-spots should be scheduled';
```

Run: `docker exec -i supabase_db_longlines psql -U postgres -v ON_ERROR_STOP=1 -X < scripts/smoke-test.sql | tail -1`
Expected: `smoke test passed`.

- [ ] **Step 6: Lint the schema and commit**

Run: `supabase db lint --fail-on error`
Expected: `{"results":[],...}`.

```bash
git add supabase/migrations/20261011000003_rbn_spots.sql supabase/tests/rbn_spots.test.sql scripts/smoke-test.sql
git commit -m "Add rbn_spots, partitioned by UTC day, with a bulk-insert RPC"
```

---

### Task 2: `rbnSpotRow` and the shared RBN row type

**Files:**
- Modify: `supabase/functions/_shared/types.ts`
- Modify: `supabase/functions/_shared/rbn.ts`
- Test: `supabase/functions/_shared/__tests__/rbn.test.ts`

**Interfaces:**
- Consumes: `parseRbnLine`, `spotTimeFromHhmm` (existing in `rbn.ts`).
- Produces (in `types.ts`): `interface RbnSpotRow { spot_time: string; received_at: string; spotter: string; callsign: string; frequency_khz: number; band: string | null; mode: string | null; mode_family: ModeFamily | null; snr: number; speed: number; speed_unit: "WPM" | "BPS"; spot_type: string; line: string }`; `interface RbnDb { ingestRbnSpots(rows: RbnSpotRow[]): Promise<number> }`; `IngestSummary.stored?: number`.
- Produces (in `rbn.ts`): `parseInboundBody(body: unknown): JsonObject[]` (throws on bad shape, >1,000 lines); `rbnSpotRow(raw: JsonObject): RbnSpotRow` (throws when unusable; no age check).

- [ ] **Step 1: Write the failing tests**

Append to `supabase/functions/_shared/__tests__/rbn.test.ts` (it already defines `line()`, `item()`, `RECEIVED`) and add `parseInboundBody, rbnSpotRow` to its import from `../rbn.ts`:

```ts
Deno.test("rbnSpotRow maps a fixture line to an rbn_spots row", () => {
  const raw = item(line("DX de SM1HEV-#"));
  assertEquals(rbnSpotRow(raw), {
    spot_time: "2026-10-11T14:54:00.000Z",
    received_at: "2026-10-11T14:55:30.000Z",
    spotter: "SM1HEV",
    callsign: "CT1JGA/P",
    frequency_khz: 14038.3,
    band: "20m",
    mode: "cw",
    mode_family: "cw",
    snr: 8,
    speed: 24,
    speed_unit: "WPM",
    spot_type: "CQ",
    line: line("DX de SM1HEV-#"),
  });
});

Deno.test("rbnSpotRow keeps BPS and marks RTTY digital", () => {
  const row = rbnSpotRow(item(line("DX de LZ7AA-#:   7043.73")));
  assertEquals([row.mode, row.mode_family, row.speed, row.speed_unit], ["rtty", "digital", 45, "BPS"]);
});

Deno.test("rbnSpotRow dates a 2359Z spot received after midnight on the previous day", () => {
  const text = "DX de W3LPL-#:  14035.10  K1ABC          CW    12 dB  22 WPM  CQ      2359Z";
  assertEquals(rbnSpotRow(item(text, "2026-10-12T00:00:10Z")).spot_time, "2026-10-11T23:59:00.000Z");
});

Deno.test("rbnSpotRow throws on a banner, a missing received_at or a bad one", () => {
  assertThrows(() => rbnSpotRow(item("Local users: 586")), Error, "not an RBN spot line");
  assertThrows(() => rbnSpotRow({ line: line("DX de SM1HEV-#") }), Error, "received_at");
  assertThrows(() => rbnSpotRow(item(line("DX de SM1HEV-#"), "yesterday")));
});

Deno.test("parseInboundBody returns the items and rejects bad shapes and oversize batches", () => {
  const items = [item(line("DX de SM1HEV-#"))];
  assertEquals(parseInboundBody({ lines: items }), items);
  assertThrows(() => parseInboundBody([]));
  assertThrows(() => parseInboundBody({ lines: [null] }));
  assertThrows(() => parseInboundBody({ lines: Array(1001).fill(items[0]) }), Error, "limit is 1000");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `deno test -P supabase/functions/_shared/__tests__/rbn.test.ts`
Expected: FAIL (`rbnSpotRow` / `parseInboundBody` not exported).

- [ ] **Step 3: Add the types**

In `supabase/functions/_shared/types.ts`, add after `NormalizedSpot`:

```ts
/**
 * One row for rbn_spots, every RBN spot the inbound worker forwards. Keys match the
 * columns so the batch can be passed straight to the ingest_rbn_spots RPC.
 */
export interface RbnSpotRow {
  spot_time: string; // ISO 8601 UTC
  received_at: string; // ISO 8601 UTC
  spotter: string;
  callsign: string;
  frequency_khz: number;
  band: string | null;
  mode: string | null;
  mode_family: ModeFamily | null;
  snr: number;
  speed: number;
  speed_unit: "WPM" | "BPS";
  spot_type: string;
  line: string;
}
```

In `IngestSummary`, after `failed: number;` add:

```ts
  /** Rows written to rbn_spots by a push (RBN only). */
  stored?: number;
```

At the end of the file add:

```ts
/** Bulk storage of every RBN spot. Implemented by db.ts over ingest_rbn_spots. */
export interface RbnDb {
  /** Inserts the batch, skipping spots already stored; returns rows inserted. */
  ingestRbnSpots(rows: RbnSpotRow[]): Promise<number>;
}
```

- [ ] **Step 4: Implement in `rbn.ts`**

Change the type import to `import type { JsonObject, NormalizeResult, RbnSpotRow, SourceAdapter } from "./types.ts";`.

Add after `spotTimeFromHhmm`:

```ts
/** Validates an inbound request body and returns its items in order. Throws on a bad shape. */
export function parseInboundBody(body: unknown): JsonObject[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("expected a JSON object from the inbound worker");
  }
  const lines = (body as JsonObject)["lines"];
  if (!Array.isArray(lines)) throw new Error('expected a "lines" array from the inbound worker');
  if (lines.length > MAX_LINES) {
    throw new Error(`inbound batch has ${lines.length} lines; the limit is ${MAX_LINES}`);
  }
  return lines.map((item: unknown, i) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`inbound line ${i} is not an object`);
    }
    return item as JsonObject;
  });
}

/** The comment stored in raw_spots: "<snr> dB <speed> <unit> <type>". */
function rbnComment(parsed: RbnLine): string {
  return `${parsed.snr} dB ${parsed.speed} ${parsed.speedUnit} ${parsed.type}`;
}

/**
 * The rbn_spots row for one inbound item. No age cutoff: storage keeps late lines.
 * Throws when the line is not a spot or received_at is unusable.
 */
export function rbnSpotRow(raw: JsonObject): RbnSpotRow {
  const line = requireString(raw, "line");
  const receivedAt = parseUtc(requireString(raw, "received_at"));
  const parsed = parseRbnLine(line);
  if (!parsed) throw new Error("not an RBN spot line");
  const frequencyKhz = parseKhz(parsed.frequency, "khz");
  const mode = resolveMode(parsed.mode, rbnComment(parsed));
  return {
    spot_time: spotTimeFromHhmm(parsed.hhmm, receivedAt).toISOString(),
    received_at: receivedAt.toISOString(),
    spotter: parsed.spotter,
    callsign: parsed.callsign,
    frequency_khz: frequencyKhz,
    band: bandForFrequency(frequencyKhz),
    mode,
    mode_family: modeFamily(mode),
    snr: Number(parsed.snr),
    speed: Number(parsed.speed),
    speed_unit: parsed.speedUnit,
    spot_type: parsed.type,
    line,
  };
}
```

In `rbnAdapter`, replace the whole `parseFeed` body with `return parseInboundBody(feed);`, and in `normalize` replace the `comment` line with `const comment = rbnComment(parsed);`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `deno test -P supabase/functions/_shared/__tests__/rbn.test.ts && deno task check`
Expected: all pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/types.ts supabase/functions/_shared/rbn.ts supabase/functions/_shared/__tests__/rbn.test.ts
git commit -m "Add rbnSpotRow: every inbound line as an rbn_spots row"
```

---

### Task 3: `runRbnPush`: store every line, alert watched ones

**Files:**
- Modify: `supabase/functions/_shared/db.ts`
- Create: `supabase/functions/_shared/rbn_push.ts`
- Test: `supabase/functions/_shared/__tests__/db.test.ts`, `supabase/functions/_shared/__tests__/rbn_push.test.ts`

**Interfaces:**
- Consumes: `parseInboundBody`, `rbnSpotRow`, `rbnAdapter` (`rbn.ts`); `runIngest` (`ingest.ts`); `IngestDb`, `WatchlistDb`, `RbnDb`, `RbnSpotRow`, `IngestSummary`, `SpotFailure` (`types.ts`).
- Produces: `createRbnDb(client: SupabaseClient): RbnDb` (`db.ts`); `type RbnPushDb = IngestDb & WatchlistDb & RbnDb` and `runRbnPush(body: unknown, db: RbnPushDb, now?: Date): Promise<IngestSummary>` (`rbn_push.ts`).

- [ ] **Step 1: Write the failing db test**

Append to `supabase/functions/_shared/__tests__/db.test.ts` and add `createRbnDb` to its import from `../db.ts`, `RbnSpotRow` to its type import:

```ts
Deno.test("ingestRbnSpots sends the batch to the RPC and returns the inserted count", async () => {
  const { client, calls } = fakeSupabase({ rpc: { ingest_rbn_spots: { data: 2 } } });
  const rows = [{ callsign: "K1ABC" }] as unknown as RbnSpotRow[];
  assertEquals(await createRbnDb(client).ingestRbnSpots(rows), 2);
  assertEquals(calls.rpc, [{ fn: "ingest_rbn_spots", args: { p_rows: rows } }]);
});

Deno.test("ingestRbnSpots treats a non-number as 0 and throws on error", async () => {
  const a = fakeSupabase({ rpc: { ingest_rbn_spots: { data: null } } });
  assertEquals(await createRbnDb(a.client).ingestRbnSpots([]), 0);
  const b = fakeSupabase({ rpc: { ingest_rbn_spots: boom } });
  await assertRejects(() => createRbnDb(b.client).ingestRbnSpots([]), Error, "ingest_rbn_spots failed: boom");
});
```

- [ ] **Step 2: Write the failing `runRbnPush` tests**

Create `supabase/functions/_shared/__tests__/rbn_push.test.ts`:

```ts
import { assertEquals, assertRejects } from "@std/assert";
import { runRbnPush } from "../rbn_push.ts";
import type { InsertedSpot, NormalizedSpot, RbnSpotRow, Source, SpotFailure } from "../types.ts";
import type { RbnPushDb } from "../rbn_push.ts";

const NOW = new Date("2026-10-11T14:57:00Z");
const RECEIVED = "2026-10-11T14:55:30Z";
const watchedLine = "DX de SM1HEV-#: 14038.30  CT1JGA/P       CW     8 dB  24 WPM  CQ      1454Z";
const otherLine = "DX de DM5GG-#:  18089.00  N2GM           CW    10 dB  25 WPM  CQ      1454Z";
const item = (line: string, received_at = RECEIVED) => ({ line, received_at });

function fakeDb(options: { watched?: string[]; stored?: number; storeFails?: boolean } = {}) {
  const calls = {
    stored: [] as RbnSpotRow[][],
    ingested: [] as NormalizedSpot[][],
    failures: [] as SpotFailure[][],
    success: [] as Array<[Source, number]>,
    failure: [] as Array<[Source, string]>,
  };
  const db: RbnPushDb = {
    ingestRbnSpots(rows) {
      calls.stored.push(rows);
      if (options.storeFails) return Promise.reject(new Error("disk full"));
      return Promise.resolve(options.stored ?? rows.length);
    },
    watchedCallsigns: () => Promise.resolve(options.watched ?? ["CT1JGA/P"]),
    ingestSpots(spots) {
      calls.ingested.push(spots);
      return Promise.resolve(
        spots.map((s, i): InsertedSpot => ({ id: i + 1, source: s.source, source_spot_id: s.source_spot_id })),
      );
    },
    recordSpotFailures(failures) {
      calls.failures.push(failures);
      return Promise.resolve();
    },
    recordSuccess(source, inserted) {
      calls.success.push([source, inserted]);
      return Promise.resolve();
    },
    recordFailure(source, error) {
      calls.failure.push([source, error]);
      return Promise.resolve();
    },
    getLastEpoch: () => Promise.resolve(null),
    matchPendingSpots: () => Promise.resolve(0),
  };
  return { db, calls };
}

Deno.test("runRbnPush stores every line and alerts only watched callsigns", async () => {
  const { db, calls } = fakeDb();
  const body = {
    lines: [item(watchedLine), item(otherLine), item("Local users: 586"), item(otherLine, "not a time")],
  };
  const summary = await runRbnPush(body, db, NOW);
  assertEquals(calls.stored.length, 1);
  assertEquals(calls.stored[0]!.map((r) => r.callsign), ["CT1JGA/P", "N2GM"]);
  assertEquals(calls.ingested.length, 1);
  assertEquals(calls.ingested[0]!.map((s) => s.callsign), ["CT1JGA/P"]);
  assertEquals(calls.failures.flat().map((f) => f.error), ["not an RBN spot line", 'invalid timestamp: "not a time"']);
  assertEquals([summary.fetched, summary.stored, summary.inserted, summary.failed], [4, 2, 1, 2]);
  assertEquals(calls.success, [["rbn", 1]]);
});

Deno.test("runRbnPush records a heartbeat when nothing is watched or the batch is empty", async () => {
  const { db, calls } = fakeDb({ watched: [] });
  const summary = await runRbnPush({ lines: [] }, db, NOW);
  assertEquals(calls.stored, []);
  assertEquals(calls.ingested, []);
  assertEquals(calls.success, [["rbn", 0]]);
  assertEquals(summary.stored, 0);
});

Deno.test("runRbnPush reports a retried batch as stored 0 without failing", async () => {
  const { db, calls } = fakeDb({ stored: 0 });
  const summary = await runRbnPush({ lines: [item(otherLine)] }, db, NOW);
  assertEquals(summary.stored, 0);
  assertEquals(calls.failure, []);
});

Deno.test("runRbnPush stores late lines but does not alert them", async () => {
  const { db, calls } = fakeDb();
  const late = new Date("2026-10-11T15:40:00Z"); // 46 minutes after the spot
  const summary = await runRbnPush({ lines: [item(watchedLine)] }, db, late);
  assertEquals(calls.stored[0]!.length, 1);
  assertEquals(calls.ingested, []);
  assertEquals([summary.stored, summary.inserted, summary.skipped.too_old], [1, 0, 1]);
});

Deno.test("runRbnPush records the failure and rethrows when storage fails", async () => {
  const { db, calls } = fakeDb({ storeFails: true });
  await assertRejects(() => runRbnPush({ lines: [item(otherLine)] }, db, NOW), Error, "disk full");
  assertEquals(calls.failure, [["rbn", "disk full"]]);
  assertEquals(calls.ingested, []);
});

Deno.test("runRbnPush records the failure and rethrows on a malformed body", async () => {
  const { db, calls } = fakeDb();
  await assertRejects(() => runRbnPush({ nope: true }, db, NOW), Error, '"lines" array');
  assertEquals(calls.failure.length, 1);
  assertEquals(calls.stored, []);
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `deno test -P supabase/functions/_shared/__tests__/rbn_push.test.ts supabase/functions/_shared/__tests__/db.test.ts`
Expected: FAIL (`rbn_push.ts` missing, `createRbnDb` not exported).

- [ ] **Step 4: Implement `createRbnDb`**

In `supabase/functions/_shared/db.ts`, add `RbnDb` and `RbnSpotRow` to the type import and append:

```ts
export function createRbnDb(client: SupabaseClient): RbnDb {
  return {
    async ingestRbnSpots(rows: RbnSpotRow[]): Promise<number> {
      const { data, error } = await client.rpc("ingest_rbn_spots", { p_rows: rows });
      if (error) throw new Error(`ingest_rbn_spots failed: ${error.message}`);
      return typeof data === "number" ? data : 0;
    },
  };
}
```

- [ ] **Step 5: Implement `runRbnPush`**

Create `supabase/functions/_shared/rbn_push.ts`:

```ts
// One inbound batch for ingest-rbn. Every line goes to rbn_spots (the full
// record, kept for seven days and archived); only lines whose station is on the
// watchlist continue through runIngest into raw_spots, the spot_events queue and
// the matcher, exactly as before the firehose.

import { runIngest } from "./ingest.ts";
import { parseInboundBody, rbnAdapter, rbnSpotRow } from "./rbn.ts";
import type {
  IngestDb,
  IngestSummary,
  JsonObject,
  RbnDb,
  RbnSpotRow,
  SpotFailure,
  WatchlistDb,
} from "./types.ts";

export type RbnPushDb = IngestDb & WatchlistDb & RbnDb;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runRbnPush(
  body: unknown,
  db: RbnPushDb,
  now: Date = new Date(),
): Promise<IngestSummary> {
  const rows: RbnSpotRow[] = [];
  const kept: JsonObject[] = [];
  const failures: SpotFailure[] = [];
  let items: JsonObject[];
  let watchedItems: JsonObject[];
  let stored = 0;

  try {
    items = parseInboundBody(body);
    for (const raw of items) {
      try {
        rows.push(rbnSpotRow(raw));
        kept.push(raw);
      } catch (error) {
        failures.push({ source: "rbn", error: errorMessage(error), raw_payload: raw });
      }
    }
    if (rows.length > 0) stored = await db.ingestRbnSpots(rows);
    if (failures.length > 0) await db.recordSpotFailures(failures);
    const watched = new Set(await db.watchedCallsigns("rbn"));
    watchedItems = kept.filter((_raw, i) => watched.has(rows[i]!.callsign));
  } catch (error) {
    await db.recordFailure("rbn", errorMessage(error));
    throw error;
  }

  // Runs even with no watched lines so ingest_state records the heartbeat.
  const summary = await runIngest(rbnAdapter({ lines: watchedItems }), db, now);
  return { ...summary, fetched: items.length, failed: summary.failed + failures.length, stored };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `deno test -P supabase/functions/_shared/__tests__/rbn_push.test.ts supabase/functions/_shared/__tests__/db.test.ts && deno task check`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/_shared/db.ts supabase/functions/_shared/rbn_push.ts supabase/functions/_shared/__tests__/db.test.ts supabase/functions/_shared/__tests__/rbn_push.test.ts
git commit -m "Store every RBN line in rbn_spots and alert only watched ones"
```

---

### Task 4: Wire `ingest-rbn` to `runRbnPush`

**Files:**
- Modify: `supabase/functions/_shared/serve.ts`
- Modify: `supabase/functions/ingest-rbn/index.ts`
- Test: `supabase/functions/_shared/__tests__/serve.test.ts`

**Interfaces:**
- Consumes: `runRbnPush`, `RbnPushDb` (Task 3); `createRbnDb` (Task 3).
- Produces: `pushIngestHandler<D extends WatchlistDb>(source: Source, run: (body: unknown, db: D) => Promise<IngestSummary>, deps: { db: () => D; secret: () => string | undefined }): (req: Request) => Promise<Response>`; `servePush(source: Source, run: (body: unknown, db: RbnPushDb) => Promise<IngestSummary>): void`.

- [ ] **Step 1: Update the push-handler tests**

In `supabase/functions/_shared/__tests__/serve.test.ts`, replace the `pushHandler` helper with a run-function version and update the POST test. Replace from `function pushHandler(` through the end of that helper with:

```ts
function pushHandler(
  overrides: { secret?: string; watchlist?: () => Promise<string[]> } = {},
): { handler: (req: Request) => Promise<Response>; bodies: unknown[]; watched: Source[] } {
  const bodies: unknown[] = [];
  const watched: Source[] = [];
  const pushDb: IngestDb & WatchlistDb = {
    ...db,
    watchedCallsigns: (source) => {
      watched.push(source);
      return overrides.watchlist?.() ?? Promise.resolve(["K1ABC", "W1AW"]);
    },
  };
  const handler = pushIngestHandler("rbn", (body, d) => {
    bodies.push(body);
    return runIngest({ ...adapter([]), source: "rbn" }, d);
  }, {
    db: () => pushDb,
    secret: () => "secret" in overrides ? overrides.secret : SECRET,
  });
  return { handler, bodies, watched };
}
```

Add `import { runIngest } from "../ingest.ts";` to the imports. Add this test:

```ts
Deno.test("pushIngestHandler POST turns a run error into a 500 naming the source", async () => {
  const handler = pushIngestHandler("rbn", () => Promise.reject(new Error("disk full")), {
    db: () => ({ ...db, watchedCallsigns: () => Promise.resolve([]) }),
    secret: () => SECRET,
  });
  const res = await handler(inboundRequest("POST", SECRET, JSON.stringify({ lines: [] })));
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { source: "rbn", error: "disk full" });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `deno test -P supabase/functions/_shared/__tests__/serve.test.ts`
Expected: FAIL (type error: `pushIngestHandler` still expects an adapter factory).

- [ ] **Step 3: Change `serve.ts`**

Replace `runAndRespond` and `ingestHandler` with:

```ts
async function respond(source: Source, run: () => Promise<IngestSummary>): Promise<Response> {
  try {
    const summary = await run();
    console.log(JSON.stringify(summary));
    return Response.json(summary);
  } catch (error) {
    const message = errorMessage(error);
    console.error(`ingest-${source} failed: ${message}`);
    return Response.json({ source, error: message }, { status: 500 });
  }
}

export function ingestHandler(
  adapter: SourceAdapter,
  makeDb: () => IngestDb,
): (req: Request) => Promise<Response> {
  return (_req: Request) => respond(adapter.source, () => runIngest(adapter, makeDb()));
}
```

Change `PushDeps` and `pushIngestHandler` to:

```ts
export interface PushDeps<D extends WatchlistDb> {
  db: () => D;
  /** The shared secret the inbound worker sends in x-inbound-secret; undefined when unset. */
  secret: () => string | undefined;
}

export function pushIngestHandler<D extends WatchlistDb>(
  source: Source,
  run: (body: unknown, db: D) => Promise<IngestSummary>,
  deps: PushDeps<D>,
): (req: Request) => Promise<Response> {
```

Inside it, the POST branch's last line becomes `return respond(source, () => run(body, deps.db()));`. Leave the secret check and GET branch as they are (GET stays for relays not yet redeployed).

Replace `servePush` with:

```ts
export function servePush(
  source: Source,
  run: (body: unknown, db: RbnPushDb) => Promise<IngestSummary>,
): void {
  Deno.serve(pushIngestHandler(source, run, {
    db: () => {
      const client = createServiceClient();
      return { ...createIngestDb(client), ...createWatchlistDb(client), ...createRbnDb(client) };
    },
    secret: () => Deno.env.get(INBOUND_SECRET_ENV),
  }));
}
```

Update imports: `createRbnDb` from `./db.ts`; `type RbnPushDb` from `./rbn_push.ts`; `IngestSummary` added to the `./types.ts` type import.

- [ ] **Step 4: Point the entrypoint at `runRbnPush`**

Replace `supabase/functions/ingest-rbn/index.ts` with:

```ts
import { runRbnPush } from "../_shared/rbn_push.ts";
import { servePush } from "../_shared/serve.ts";

servePush("rbn", runRbnPush);
```

- [ ] **Step 5: Run all Deno checks**

Run: `deno task fmt && deno task lint && deno task check && deno task test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/serve.ts supabase/functions/_shared/__tests__/serve.test.ts supabase/functions/ingest-rbn/index.ts
git commit -m "ingest-rbn: run runRbnPush for every inbound worker batch"
```

---

### Task 5: Inbound forwards every spot line

**Files:**
- Modify: `inbound/feeds.ts`, `inbound/forwarder.ts`, `inbound/functions.ts`, `inbound/health.ts`, `inbound/main.ts`
- Delete: `inbound/watchlist.ts`
- Test: `inbound/__tests__/modules.test.ts`, `inbound/__tests__/forwarder.test.ts`

**Interfaces:**
- Consumes: `parseRbnLine` (`_shared/rbn.ts`).
- Produces: `Feed.isSpot(line: string): boolean` (replaces `callsignOf`); `FunctionClient` with only `push(lines: InboundLine[]): Promise<unknown>`; `FeedHealth.dropped: () => number` (replaces `watching`); `Forwarder` defaults `maxBatch` 1,000 and `maxBuffer` 50,000.

- [ ] **Step 1: Update the inbound worker tests**

In `inbound/__tests__/modules.test.ts`:
- Delete the import of `Watchlist` and both `Watchlist` tests.
- Delete the test "functionClient GETs the watchlist with the secret and a User-Agent", and in "functionClient throws on non-2xx and on a malformed watchlist" replace the body with:

```ts
  await assertRejects(
    () => functionClient("https://x", "ingest-rbn", "s", fakeFetch(401, "{}").fn).push([]),
    Error,
    "HTTP 401",
  );
```

  and rename it to "functionClient throws on non-2xx".
- Add a User-Agent and secret assertion to "functionClient POSTs a batch as JSON" after the content-type check:

```ts
  assertEquals(req.headers.get("x-inbound-secret"), "s");
  assertEquals(req.headers.get("user-agent")?.startsWith("LongLines/"), true);
```

- Replace the `RBN_FEED.callsignOf` test with:

```ts
Deno.test("RBN_FEED.isSpot accepts every fixture spot line and nothing else", () => {
  const fixture = Deno.readTextFileSync(
    new URL("../../supabase/functions/_shared/__tests__/fixtures/rbn-telnet.txt", import.meta.url),
  ).split("\n");
  for (const l of fixture) assertEquals(RBN_FEED.isSpot(l), l.startsWith("DX de"), l);
});
```

- In the `healthHandler` test, replace `watching: () => 2` with `dropped: () => 3` and the assertion `body.feeds[0].watching, 2` with `body.feeds[0].dropped, 3`.

Append to `inbound/__tests__/forwarder.test.ts`:

```ts
Deno.test("Forwarder defaults: batches of 1,000 and a 50,000-line buffer", async () => {
  const pushes: InboundLine[][] = [];
  const f = new Forwarder({
    now: () => 0,
    log: () => {},
    push: (lines) => {
      pushes.push(lines);
      return Promise.resolve();
    },
  });
  for (let i = 0; i < 50_001; i++) f.add(line(i));
  assertEquals([f.buffered, f.dropped], [50_000, 1]);
  await f.tick();
  assertEquals(pushes[0]!.length, 1_000);
  assertEquals(pushes[0]![0], line(1)); // line 0 was the one dropped
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `deno test -P inbound/__tests__/`
Expected: FAIL (`isSpot` missing, `dropped` not in `FeedHealth`, defaults are 200/5,000).

- [ ] **Step 3: Implement the inbound worker changes**

`inbound/feeds.ts`: replace the `callsignOf` member of `Feed` with

```ts
  /** True for a spot line; banners, prompts and blank lines are not forwarded. */
  isSpot(line: string): boolean;
```

and in `RBN_FEED` replace `callsignOf: ...` with `isSpot: (line) => parseRbnLine(line) !== null,`. Update the file header comment's second sentence to: "Each feed is one telnet connection whose spot lines are all pushed to one Edge Function."

`inbound/forwarder.ts`: in the constructor defaults set `maxBatch: 1_000` and `maxBuffer: 50_000`, and change the header comment's last sentence to: "the buffer is bounded (50,000 lines, about 50 minutes of RBN) so a long Supabase outage cannot exhaust memory."

`inbound/functions.ts`: delete `watchlist()` from `FunctionClient` and from the returned object, and change the header comment to `// The inbound worker's call to its Edge Function: push a batch of lines.`

`inbound/health.ts`: in `FeedHealth` replace `watching: () => number;` with `dropped: () => number;`, and in the report replace `watching: f.watching(),` with `dropped: f.dropped(),`.

`inbound/main.ts`: remove the `Watchlist` import, `WATCHLIST_REFRESH_MS`, the `watchlist`, `matched`, `refreshWatchlist` and `firstLoad` declarations and the refresh loop. The `done` promise becomes:

```ts
  const done = Promise.all([
    every(1_000, () => forwarder.tick()),
    every(STATS_LOG_MS, () => {
      if (lines > 0) {
        log(
          `${lines} lines, ${spots} spots, ${forwarder.pushed} pushed, ` +
            `${forwarder.buffered} buffered, ${forwarder.dropped} dropped`,
        );
      }
    }),
    runTelnet({
      host: feed.host,
      port: feed.port,
      loginCall: config.loginCall,
      loginPrompt: feed.loginPrompt,
      status,
      signal,
      log,
      onLine: (line, receivedAt) => {
        lines += 1;
        if (!feed.isSpot(line)) return;
        spots += 1;
        forwarder.add({ line, received_at: receivedAt.toISOString() });
      },
    }),
  ]).then(() => {});
```

and the health entry uses `dropped: () => forwarder.dropped,` instead of `watching`. Change the file header to: "Long Lines inbound worker. Holds one telnet connection per feed and pushes every spot line to the feed's Edge Function, which stores all of them and alerts on watched callsigns."

Delete `inbound/watchlist.ts`.

- [ ] **Step 4: Run all Deno checks**

Run: `deno task fmt && deno task lint && deno task check && deno task test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -An inbound worker/
git commit -m "Inbound: forward every RBN spot line in batches of up to 1,000"
```

---

### Task 6: Types, docs and end-to-end verification

**Files:**
- Regenerate: `web/src/lib/database.types.ts`
- Modify: `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Regenerate database types and run the web checks**

Run:
```bash
supabase db reset
supabase gen types typescript --local > web/src/lib/database.types.ts
cd web && npm run lint && npm test && SUPABASE_URL=https://example.supabase.co SUPABASE_ANON_KEY=placeholder npm run build
```
Expected: lint clean, tests pass, `built in`.

- [ ] **Step 2: Update the docs**

`docs/ARCHITECTURE.md`, section "Streaming sources: the inbound worker":
- Replace the mermaid diagram's `R -- "GET every 5 min: watched callsigns" --> F` edge with nothing (delete the line), and change the POST edge label to `"POST every line, batches every 10 s, heartbeat every 60 s"`. Add `F -- "rpc ingest_rbn_spots" --> RS[(rbn_spots)]`.
- Replace the "Watched callsigns only." bullet with:
  "**Everything is stored; watched callsigns are alerted.** The inbound worker forwards every spot line. `ingest-rbn` writes each batch to `rbn_spots` (one RPC, `ingest_rbn_spots`), a table partitioned by UTC day that keeps seven days in the database and is archived to Storage (spec `docs/superpowers/specs/2026-10-11-rbn-firehose-archive-design.md`). Only lines whose station is in `watched_callsigns('rbn')` continue through `runIngest` into `raw_spots` and the matcher, so alerting sees a few hundred RBN rows a day."
- Replace the "One parser." bullet's text "The inbound worker filters with `parseRbnLine`" with "The inbound worker drops non-spot lines with `parseRbnLine`".
- Add a bullet: "**Partitions.** `maintain_rbn_spots()` runs daily at 03:30 UTC and keeps partitions for today and three days ahead. Rows for a day without a partition land in `rbn_spots_default`; `create_rbn_spots_partition` moves them in when it creates that day."

`docs/OPERATIONS.md`, section "Inbound (RBN)":
- In "Is it running?", add `select count(*) from rbn_spots where spot_time > now() - interval '1 hour';  -- tens of thousands when RBN is busy`.
- Replace "Why is a watched station not showing up?" step 1's last sentence "The inbound worker picks up changes within five minutes." with "Changes apply to the next batch." and add step 5: "Check `rbn_spots` for the call: if it is there but not in `raw_spots`, the subscription does not watch it; if it is not there, RBN did not hear it."
- Add a subsection "### rbn_spots size": "About 1.5 million rows and 350 MB a day. Until archiving and retention land (PR 2) nothing is dropped. `select pg_size_pretty(pg_total_relation_size('rbn_spots'));` shows the total; `select tableoid::regclass, count(*) from rbn_spots group by 1 order by 1;` shows rows per day."

`README.md`, "Streaming sources" paragraph: replace "Every five minutes it asks `ingest-rbn` for the callsigns named in enabled subscriptions; it forwards only those stations' spots, in batches every 10 seconds," with "It forwards every spot in batches every 10 seconds;" and after "`ingest-rbn` runs the same orchestrator as the pulled sources." add "It stores every spot in `rbn_spots` (seven days in the database, archived to Storage) and sends only spots of callsigns named in a subscription on to matching."

`CLAUDE.md`, "Inbound rules": replace the bullet starting "It forwards only callsigns from `watched_callsigns(source)`." with:
"- The inbound worker forwards every spot line. `ingest-rbn` stores all of them in `rbn_spots` (partitioned by UTC day; partitions come from `create_rbn_spots_partition`, never `create table ... partition of`) and runs `runIngest` only over watched callsigns. `spot_matches` lets an RBN spot match only subscriptions that name callsigns; keep that guard if the predicate changes."

- [ ] **Step 3: Full local CI**

Run: `supabase db reset && cd web && npm run test:all`
Expected: every group passes (deno, db, web).

- [ ] **Step 4: End-to-end against the local stack**

With `supabase start`, `supabase functions serve --env-file <file with LONGLINES_INBOUND_SECRET=local>`, a subscription for `CS3B` with sources `{rbn}`, and the fake RBN server from the PR #28 verification replaying `rbn-telnet.txt` with current `HHMM` (scratchpad script), run the inbound worker via `main([{ ...RBN_FEED, host: "127.0.0.1", port: 7300 }])`. Then:

```sql
select count(*) from rbn_spots;                               -- expected: 91 (every fixture spot line), less any
                                                              -- line the fixture repeats within one minute
select count(*) from raw_spots where source = 'rbn';          -- expected: 10 (CS3B only)
select count(*) from deliveries;                              -- expected: 10
select count(*) from ingest_failures where source = 'rbn';    -- expected: 0
```

Then replay the fixture 12 times without pause (~1,100 lines) and confirm the inbound worker sends a 1,000-line batch that is accepted (`ingest-rbn` log shows `"fetched":1000`, HTTP 200), and that `select spot_time, spotter, callsign, frequency_khz, count(*) from rbn_spots group by 1,2,3,4 having count(*) > 1;` returns no rows.

- [ ] **Step 5: Commit and open the PR**

```bash
git add web/src/lib/database.types.ts docs/ARCHITECTURE.md docs/OPERATIONS.md README.md CLAUDE.md
git commit -m "Describe full RBN ingest; regenerate database types"
git push -u origin rbn-firehose
gh pr create --title "Store every RBN spot in rbn_spots" --body "<summary, verification results, deploy order: db push + functions deploy, then the inbound worker merges/deploys>"
```

# Daily per-callsign activity and roll-up status: design

Date: 2026-10-19. Status: approved. Migration: `supabase/migrations/20261019000200_callsign_days.sql`.

## Purpose

For every callsign heard on each UTC day, from each source, keep its spot count and the modes and
bands it was heard on, forever. Idempotent, no double counting from the pollers, nothing done per
spot, cheap enough for the hosted database, and a roll-up that says when it has failed instead of
going quiet.

## What already exists

Most of this shipped with the callsign roll-ups (`20261012000040`, spec
`2026-10-12-callsign-lookup-design.md`, `docs/ARCHITECTURE.md` "Callsign rollups").
`rollup_callsign_day(day)`, run hourly by pg_cron through `backfill_callsign_rollups(2)`, reads one
completed UTC day from `spot_stream` (`raw_spots` without its RBN copies, plus `rbn_spots`) in one
pass and fills `callsign_activity` (base, role, source, band, mode bucket: spots and spots per
hour), `callsign_reach`, `callsign_references`, `callsign_seen` and `callsign_variants`. It is
exactly once through the `callsign_rollup_days` marker, assigns spots by their own UTC
`spot_time`, normalises callsigns with `base_callsign()` (the raw spelling kept in
`callsign_variants`), leaves APRS-IS out by construction and gates RBN retention on the marker.
The hosted project has run it since 2026-10-12.

This design does not build a second roll-up. It maps the request onto what exists, names the gaps
and closes them with the smallest change that touches neither ingestion, the inbound worker nor the sender.

### Requirement by requirement

| # | Requirement | Before this change | Gap |
|---|---|---|---|
| 1 | No load spikes; nothing per spot | One pass over the day's rows at 02:25 UTC (~13 s for a synthetic 1.5M-row RBN day locally, about a minute hosted). Nothing written per spot. | None |
| 2 | Right place per source | All four sources (and WWFF) are already rows in Postgres; the roll-up is SQL over stored rows. See "Where aggregation happens". | None |
| 3 | Idempotent | Marker row first, `on conflict do nothing`, whole day in one transaction; a second call returns null. pgTAP covers it. | None |
| 4 | No double counting from polls | `raw_spots` is unique on `(source, source_spot_id, content_hash)`; a re-poll inserts nothing. An upstream *edit* of a spot (new hash) is a new row, as on the Stats page. | None (documented limit) |
| 5 | UTC day by spot time | `spot_time` bounds; a day is rolled up two hours after it ends (`last_rollup_day()`), covering the inbound worker's ~50 min buffer. A spot arriving later than that is not counted. | None (documented limit) |
| 6 | Status tracking, no silent loss | Only "done" was recorded (`callsign_rollup_days`). A failure was a Postgres `raise warning`; `cron.job_run_details` showed success. RBN retention gave up waiting at 14 days and retired the day with only a warning. | **A**: closed by `callsign_rollup_failures` and `callsign_rollup_status` |
| 7 | Callsign normalisation | `base_callsign()` drops /P, /M, /MM, /AM, /QRP, /QRPP, /R, single digits and SSIDs; raw spelling kept in `callsign_variants`. | None |
| 8 | Mode and band normalisation | Modes are canonicalised at ingest in `_shared/modes.ts` (lowercase, hyphens and spaces stripped, comment hints, DX Cluster usb/lsb to ssb); bands from `_shared/bands.ts`. But the roll-up kept only `mode_bucket` (CW / SSB / FT8-FT4 / FM / Other), coarser than "which modes". | **B**: closed by `callsign_days.modes` |
| 9 | Multiple instances | The inbound worker never aggregates; the marker insert serialises concurrent roll-ups (the second caller blocks on the unique index, then sees the conflict and returns null). | None |
| 10 | Kept indefinitely | `compact_callsign_rollups()` folds `callsign_activity` and `callsign_reach` day rows into month rows after 35 days, so "every day X was active" was unanswerable past 35 days. Nothing compacted yet (first day 2026-10-11, first fold 2026-11-15). | **C**: closed by `callsign_days`, never compacted |
| Q | Backfill beyond retention | Every source is archived as Parquet to B2 (10-minute RBN slices, hourly for the rest) and logged in `archive_log`; `raw_spots` is never pruned. No in-database loader exists. | **D**: documented procedure, not code |

## Open questions, answered

- **Which sources are persisted?** All of them. POTA, SOTAwatch, WWFF and DX Cluster write
  `raw_spots` through `runIngest` / `ingest_spots` (`_shared/ingest.ts`, `_shared/dxcluster.ts`).
  RBN writes every line to `rbn_spots` (`_shared/rbn_push.ts`) and copies watched stations to
  `raw_spots`. APRS-IS writes only `aprs_packets`. Nothing is "matched and delivered only".
- **Daily volume.** Documented: RBN ~1.5M rows a day (~350 MB); APRS 4-13M packets a day (out of
  scope). Distinct callsigns per day are documented nowhere, and the seed is synthetic (9,000 RBN
  stations, 330 POTA activators). The hosted roll-up tables hold the exact numbers; this query
  (read-only, indexed, cheap) gives the rows per day the new table holds, per source:
  ```sql
  select period, source, count(distinct base) as bases, sum(spots) as spots
  from callsign_activity where grain = 'day' and role = 'heard'
  group by 1, 2 order by 1, 2;
  select pg_size_pretty(pg_total_relation_size('callsign_activity'));
  ```
  The sizing below assumes 10k-30k distinct (base, source) pairs a day; run the query after the
  push and compare with `pg_total_relation_size('callsign_days')`.
- **Indexes.** None new beyond the table's primary key. The day pass is partition-pruned on
  `rbn_spots` (a sequential scan of one day's partition is the cheapest plan) and uses
  `raw_spots_spot_time_idx` on `raw_spots`. One existing inefficiency is fixed in passing: see
  "First-day lookup".
- **Archive for later backfill.** Already done (`docs/ARCHITECTURE.md` "The spot archive"). Gap D
  is an offline procedure in `docs/OPERATIONS.md` ("Rebuilding a day from the archive"), not code.

## Where aggregation happens

In SQL, for every source; the inbound worker does not aggregate.

- The inbound worker's job is holding telnet sessions and forwarding lines; CLAUDE.md forbids parsing
  spots there, and every RBN and DX Cluster line is already a row in Postgres, so aggregating in
  the inbound worker would be a second, divergent copy of the same data.
- The forwarder retries failed batches (`inbound/forwarder.ts`); in-flight counters would need
  per-batch idempotency keys to avoid double counting, which the database's unique constraints
  already give rows.
- A roll-up computed from stored rows is "whole day or none" and can be checked against the
  archive's slice counts; streaming counters cannot be reconciled.
- The cost is already paid: one pass a day over ~1.5M rows at 02:25 UTC, about a minute hosted,
  in its own cron job so it never holds `maintain_rbn_spots` locks.

For POTA, SOTAwatch and WWFF the once-daily roll-up from `raw_spots` is exactly what runs today.

## Design

### `callsign_days`

One row per base callsign, UTC day and source, heard role only, never compacted.

| Column | Notes |
|---|---|
| `base` | `base_callsign()` of the call as spotted |
| `day` | UTC day of `spot_time` |
| `source` | `pota`, `sotawatch`, `dxcluster`, `wwff`, `rbn` |
| `spots` | rows of `spot_stream` that day |
| `modes` | `text[]`, distinct canonical modes as stored, sorted; a spot with a null mode counts in `spots` and adds nothing here |
| `bands` | `text[]`, distinct bands, sorted; likewise for a spot outside the band list |

Primary key `(base, day, source)`, no other index: the two target queries ("every day X was
active", "X per day this year by source") are prefix scans of it. RLS on, `anon` and
`authenticated` revoked, like the other roll-up tables.

Why a new slim table rather than stopping compaction: a `callsign_activity` row is about 270 B,
split by role, band and mode bucket with a 24-int hours array (50k+ rows a day for RBN alone,
5-7 GB a year), which is why compaction exists. A `callsign_days` row is about 150 B and there is
one per (base, source): at 10k-30k rows a day, 1.5-4.5 MB a day and 0.5-1.6 GB a year, no
partitioning. That fits the Pro plan disk the project already needs for `rbn_spots` (3 GB) and
`aprs_packets` (5 GB); it would not fit a free-tier database.

Why canonical `mode` rather than the bucket: the table is permanent, so it stores the most
specific normalised value and readers group. A mode added to `modes.ts` appears with no schema
change. `usb` and `lsb` stay as stored (subscriptions filter on them, and `mode_bucket` already
groups them for the Stats page and profiles); a reader that wants one SSB figure groups them in
its query. There is no `mode_group` SQL function: no SQL consumer exists yet, and it would copy
the sets `modes.ts` owns. It comes with the first consumer.

Spotters stay out: skimmers and chasers appear as the `spotter` role in `callsign_activity`, which
profiles keep for their Hunting card.

**Filled by `rollup_callsign_day`**, from its existing materialised CTE `b` (the day grouped by
call, source, band and mode, with base calls resolved per distinct call). Every `b` row feeds the
heard role, so summing `n` by base and source counts each spot once:

```sql
insert into callsign_days (base, day, source, spots, modes, bands)
select base, p_day, source, sum(n)::int,
       coalesce(array_agg(distinct mode order by mode) filter (where mode is not null), '{}'),
       coalesce(array_agg(distinct band order by band) filter (where band is not null), '{}')
from b group by base, source
on conflict (base, day, source) do nothing
```

It is one more data-modifying CTE of the same statement, in the same transaction as the marker,
so it inherits exactly once. A row already there wins (a day rebuilt from the archive before it
was marked; see `docs/OPERATIONS.md`). Added cost: one aggregate over tens of thousands of grouped
rows, under a second. `compact_callsign_rollups()` never touches `callsign_days`.

### Filling history

Days rolled up before the migration (2026-10-11 onward) need rows too. The marker gains
`callsign_rollup_days.days_filled_at timestamptz`: null means `callsign_days` is not filled for
that day. `rollup_callsign_day` sets it for every day it rolls up, so the fill only ever sees
pre-migration days.

`fill_callsign_days(p_day) returns (spots bigint, exact boolean)` fills one such day:

- It locks the marker row (`for update`), so two fills of one day cannot both insert, and
  returns no row when the day is not rolled up or already filled.
- One grouped pass over `spot_stream` for the day, by `(source, callsign, mode, band)`, with base
  calls resolved per distinct call afterwards. Every source but RBN is inserted from it as is:
  `raw_spots` is never pruned, so those rows are complete and exact whatever happened to RBN.
- Only the RBN row is decided. It too comes from the pass while the day is not retired
  (`rbn_day_retired`, below) and the pass holds at least the RBN spots the roll-up counted
  (`sum(spots)` of `callsign_activity`'s RBN heard day rows); a handful of late rows that arrived
  after the roll-up are included rather than losing the row to the approximate path, so a day's
  `callsign_days.spots` can exceed its marker's `spots`. `exact = true`.
- Otherwise (the day is retired, or the pass holds fewer RBN spots than the roll-up counted) the
  RBN row comes from `callsign_activity`'s RBN heard day rows: `spots` and `bands` exact, `modes`
  at most `cw`. Only the CW bucket maps back to a mode: RBN reports no FM, and the SSB, FT8/FT4
  and Other buckets hold several modes, so RTTY is missing. `exact = false`. Only the RBN row is
  affected; the day's POTA, SOTAwatch, DX Cluster and WWFF rows are exact. This touches 2026-10-11
  and every later day retention had already dropped (eight days old at 03:35 UTC) when the fill
  reached it; `backfill_callsign_days`' `exact` column shows which. Recorded in
  `docs/OPERATIONS.md`.
- A day that cannot be filled is refused with `only the archive has it` rather than filled short:
  retired, not marked `without_rbn`, no `callsign_activity` day rows left for the day, and RBN
  heard month rows for its month (compacted before the fill reached it). A day rolled up knowingly
  without RBN has no RBN rows to lose and is filled. The archive recipe applies to a refused day.
- It then sets `days_filled_at`, for a pre-migration marker whose `spots` is null sets `spots` to
  the fill's count (the pass's total, or its non-RBN total plus the roll-up's RBN count), sets
  `without_rbn` for a day rolled up with `(day, true)` before the column existed (no RBN heard day
  rows while the archive logged RBN rows), and deletes the day's failures row.

`backfill_callsign_days(p_max_days int default null) returns (fill_day, spots, exact, error)` runs
it for every marked day with `days_filled_at` null, oldest first, each in its own subtransaction,
until `p_max_days` are filled (all when null), attempting at most twice `p_max_days` days so
failures cannot turn a run into a pass over every unfilled day. A failed day is undone, returned
with its `error`, recorded in `callsign_rollup_failures` as `callsign_days fill: <error>` (status
`fill_failed`), and is tried again next time. A day another caller filled
meanwhile is skipped without a row.

`backfill_callsign_rollups` calls it with the same `p_max_days` only in a run whose day loop
rolled nothing up, **before** compaction, in its own exception block (a warning on failure, so it
can never undo the days just rolled up). One kind of work per run keeps a run to a few day passes
(at most `p_max_days` roll-ups, or at most twice `p_max_days` fill attempts): `when others` does not catch a statement-timeout cancel, which would undo
the whole run, rolled-up days included. Its rows stay out of `backfill_callsign_rollups`' return
table, whose shape `seed.sql`, `scripts/smoke-test.sql` and pgTAP depend on. History fills two days
a run in the 23 hourly runs of 24 that roll nothing up (the 02:25 run rolls up yesterday), so a
week finishes within a day of the push with no long statement inside `supabase db push`; the
operator can also call `backfill_callsign_days` by hand to see each day's `exact`.

`compact_callsign_rollups` skips `callsign_activity` and `callsign_reach` day rows whose marker
has `days_filled_at` null, so the approximate path's source cannot vanish before the fill runs
(the first fold would be 2026-11-15).

### Status and failures

`callsign_rollup_days` keeps meaning "done" (retention and `callsign_profile` depend on that; both
only test existence and `min(day)`, so new nullable columns are safe) and gains:

| Column | Notes |
|---|---|
| `spots bigint` | what the roll-up counted (the pass's total); null on a pre-migration marker until the fill sets it |
| `without_rbn boolean not null default false` | the roll-up counted fewer RBN spots than the archive logged for the day: the whole day after `(day, true)`, or a late line or two of a retired day. The migration sets it for days already rolled up with `(day, true)` whose day rows still exist (archive has RBN rows, `callsign_activity` has heard day rows but no RBN ones; a compacted day has no RBN day rows either way), and the fill sets it the same way |
| `days_filled_at timestamptz` | see "Filling history" |

```sql
create table callsign_rollup_failures (
  day             date primary key,
  attempts        int not null,
  first_failed_at timestamptz not null,
  last_failed_at  timestamptz not null,
  last_error      text not null
);
```

RLS on, clients revoked. `record_callsign_rollup_failure(day, error)` inserts the row or bumps
`attempts`, `last_failed_at` and `last_error`.

- `backfill_callsign_rollups`: the per-day `exception when others` handler runs after the block's
  subtransaction rolled back and in the function's transaction, so the failures row it writes
  stays when pg_cron commits. `rollup_callsign_day` itself deletes the day's row right after
  inserting the marker, in the same transaction, so a day that succeeds clears it whether the job
  or an operator (`rollup_callsign_day(day, true)` included) ran it, and a failure puts it back.
  Known limit: `when others` does not catch a statement-timeout cancel, which rolls back the whole
  run as before.
- The retired test is `rbn_day_retired(day)`: some RBN slice of the day is logged in
  `archive_log` with more rows than `rbn_spots` holds for it (the per-slice test
  `rbn_day_archived` uses, written out as one range probe of `rbn_spots`' unique index, which
  leads with `spot_time`, per logged slice, stopping at the first short one; a day with nothing
  archived costs one `archive_log` probe).
  `rollup_callsign_day` skips it for a day already marked. Only retention removes rows, so fewer
  than logged means retired, and late lines in the default partition cannot hide a retired day
  unless they refill every logged slice. A day the archive has nothing for is not retired, whether
  it had no RBN rows or is not archived yet. `rollup_callsign_day`, `fill_callsign_days`,
  `maintain_rbn_spots` and the status view all use it. The roll-up's `without_rbn` compares its
  own count with the day's total (`rbn_day_archived_rows`, the sum of `archive_log.row_count` over
  the day's RBN slices): RBN spots counted < RBN rows archived. It reads that total before its
  pass, so a slice the archive logs during the pass (which may hold a line that arrived after the
  pass's snapshot) cannot set `without_rbn`.
- `maintain_rbn_spots` (the body of `20261012000010` plus one step): when the 14-day give-up
  retires a day that has no marker, it records `RBN rows retired before the roll-up ran` and
  raises a warning, but only when the day did not already read as retired (`rbn_day_retired`)
  and the archive logged RBN rows for the day, both decided in the eligibility pass before any
  partition is dropped (a scan under a drop's lock would block ingest). The test is the day's state, not
  whether a partition existed: a day whose rows only ever lived in the default partition is
  recorded too, and deleting late rows of a day retired earlier records nothing. The give-up stays: an RBN day is ~350 MB and a stuck roll-up must not fill the disk; the archive
  still has the rows (Gap D). The point is that the loss is visible within hours, not silent at
  day 14.
- `callsign_rollup_status` (`security_invoker = true`, clients revoked): one row per UTC day from
  `first_rollup_day()` (below) to `last_rollup_day()`, with `status` decided in this order:
  `fill_failed` (marker, `days_filled_at` null, a failures row: the fill keeps failing),
  `done_without_rbn`, `done`, `rbn_retired` (no marker and `rbn_day_retired`; a day with zero RBN
  rows or none archived yet is `pending`, not retired), `failed` (a failures row), `pending`. Plus
  `spots`, `rolled_at`, `days_filled_at`, `attempts`, `last_failed_at` and `last_error`.
  `rbn_retired` comes before `failed` because such a day also gains a failures row every hour from
  the refusal. The retired test runs only for days without a marker, which are few.
- The cron job body stays `select count(*) from public.backfill_callsign_rollups(2)`:
  `cron.job_run_details.return_message` only ever holds the command tag, and raising from the
  body to mark the run failed would roll back the successful days. The failures table is the
  signal.

No web surface: nothing is exposed to clients (CLAUDE.md: no UI without being asked). If a
dashboard row is wanted later, `list_ingest_health` is the place.

### First-day lookup

`backfill_callsign_rollups` found the first day with `min(spot_time)` over `spot_stream` every
hour, which has no leading `spot_time` index on `rbn_spots` and so scanned every partition
(~10M rows). `first_rollup_day()` now takes the earlier of `min(day)` of `callsign_rollup_days`
and the first `raw_spots` row with `source <> 'rbn'` (the raw spots `spot_stream` reads, not the
RBN copies; an index probe), so a spot day before the first marker is still
rolled up (`scripts/smoke-test.sql` relies on it), and scans `spot_stream` only while there is
neither (a database with RBN rows alone). `backfill_callsign_rollups` and the status view both
use it.

### Decision: arrays, not counts

The one choice that had to be settled before the migration shipped, because changing it later
means rebuilding history. The request says "no distributions, just the summary", so `modes` and
`bands` are `text[]`. The alternative, `jsonb` maps such as `{"cw": 120, "rtty": 3}` from the same
CTE at about 30-50 B more per row, would also answer "how many CW spots that day". Arrays, as
asked.

Every new function is `security definer` with `set search_path = public`, and `execute` is
revoked from `public`, `anon` and `authenticated` (`advisor.test.sql` gains no entry: none is
client-callable or unpinned).

## Assumptions

- WWFF is included: it is already in `spot_stream`, and CLAUDE.md treats it as a peer of POTA and
  SOTA. The request lists four sources, but excluding it would need a filter nothing else has.
- Spotters stay out of `callsign_days`; `callsign_activity` keeps its `spotter` role for profiles.
- "Unique spot" is a `raw_spots` row, as on the Stats page and in profiles; an upstream edit counts
  again. `count(distinct source_spot_id)` is possible but would make the roll-up disagree with
  every other count.
- The 14-day retention give-up stays; it becomes visible instead of silent.
- Hosted tier is Pro with Micro compute and a disk already beyond 8 GB.

## Documented limits

- A spot that arrives more than two hours after its UTC day ends is not counted, by the roll-up or
  by `callsign_days`. The inbound worker buffers about 50 minutes; the archive uses the same two-hour lag.
- An upstream edit of a spot (same `source_spot_id`, new `content_hash`) is a new `raw_spots` row
  and counts again, as it does everywhere else.
- A retired day's RBN row filled from `callsign_activity` has only `cw` among its modes (see
  "Filling history"); its other sources' rows are exact. Only the archive can make the RBN row
  exact.

## Scheduling and load

- The job is unchanged: `rollup-callsign-days` at :25 hourly, `backfill_callsign_rollups(2)`;
  yesterday at 02:25 UTC, ahead of RBN retention at 03:35 and off the archive's */10 grid and the
  stats refresh at :05.
- Added work per day: one aggregate over the already-grouped CTE (sub-second) and one marker
  update. History fill: at most two days a run, only in runs that rolled nothing up (23 of 24),
  each one pass over the day (about a minute hosted for an RBN day, seconds otherwise), finished
  within a day of the push. Removing the
  hourly `min(spot_time)` scan of `rbn_spots` saves more than the new work costs.
- Ingest, matching and delivery: no change. Nothing per spot.
- The migration alters `callsign_rollup_days`, on which the hourly job holds row locks while it
  runs, so it starts with `select set_config('lock_timeout', '10s', true)` and fails rather than
  queue with the whole transaction open. The setting is transaction-scoped: `supabase db push`
  applies a migration in one transaction; applied by hand with psql, the file needs wrapping in
  `begin`/`commit`. A timeout fails the push; run it again away from :25 (an RBN day takes about a
  minute).

## Testing

- `supabase/tests/callsign_rollups.test.sql` adds `callsign_days` and `callsign_rollup_failures`
  to its delete-first list and covers: `callsign_days` rows per source with sorted modes and
  bands; a second `rollup_callsign_day` changes nothing; a POTA re-poll (same `source_spot_id`,
  same hash) counts once; a failed day appears in `callsign_rollup_failures` and the status view
  and disappears on success; `backfill_callsign_days` fills a marked day exactly from
  `spot_stream` and approximately from `callsign_activity` (RBN retired); compaction leaves
  `callsign_days` alone and skips an unfilled day; the status order (`rbn_retired` over
  `failed`); clients cannot read the new table, the failures table or the view.
- `supabase/tests/rbn_retention.test.sql` deletes `callsign_rollup_failures` first; the 14-day
  give-up writes a failures row.
- `supabase/tests/advisor.test.sql` passes unchanged and confirms RLS on the new tables.
- `scripts/smoke-test.sql` is unchanged (it checks only the job name and the marker).
- Locally, after `supabase db reset` (the seed runs the backfill): `select * from
  callsign_rollup_status order by day;` shows `done` for the seeded days with `days_filled_at`
  set; `select * from callsign_days where base = '<seeded call>' order by day, source;` shows one
  row per source with sorted modes and bands; `select rollup_callsign_day('<rolled day>')` returns
  null and `callsign_days` is unchanged; `select first_rollup_day()` returns in milliseconds, and
  `explain analyze` of its select (run directly: EXPLAIN of `backfill_callsign_rollups` does not
  show nested plpgsql statements) never executes the `spot_stream` scan.
- Hosted, after `supabase db push`: run the volume query, then `select * from
  backfill_callsign_days(3)` a few times or wait for the hourly job; `callsign_rollup_status` has
  no `pending` day older than yesterday and every `done` day has `days_filled_at`;
  `pg_size_pretty(pg_total_relation_size('callsign_days'))` matches the estimate.

## Docs

- `docs/ARCHITECTURE.md` "Callsign rollups": `callsign_days`, the fill of history, the status view
  and failures table, and the documented limits.
- `docs/OPERATIONS.md` "Callsign rollups": the status query, `backfill_callsign_days`, the
  RBN-row modes note, a size check and "Rebuilding a day from the archive" (DuckDB over the day's
  Parquet slices, aggregated to the `callsign_days` shape, inserted with `on conflict do nothing`;
  a rebuilt row survives a later roll-up; `callsign_activity` and the running totals cannot be
  redone).
- `CLAUDE.md` "Callsign rollup rules": `callsign_days` is day grain forever and never compacted,
  stores canonical modes that readers group; failures go through `callsign_rollup_failures`;
  compaction waits for `days_filled_at`; `backfill_callsign_rollups`' return shape stays.
- `web/src/lib/database.types.ts` regenerated; nothing in `inbound/`, `sender/`,
  `supabase/functions/` or `web/src` otherwise.

# Health page: design

Date: 2026-10-21. Status: **in progress** (PR 1 schema, functions and worker heartbeats, PR 2 the
web page). Decisions 1 to 3 were made by Brad on 2026-10-21. If the design
changes during a PR, update this file in that PR.

Source: Brad's "Long Lines health page" canvas (artboard `Main.dc.html`, "Health"). Where the
canvas and this file disagree, this file wins; the differences are listed under Decisions and
marked in Copy. The canvas's figures are mock data.

## Purpose

There is no single place to see whether Long Lines is keeping up. Today an operator runs the
queries in `docs/OPERATIONS.md` one by one, opens `fly logs` for the sender and the relay, and reads
`cron.job_run_details` and `net._http_response` by hand.

`/health` is a public, read-only page that answers "is anything stuck or behind?" at a glance:

- eight checks, each Healthy, Delayed or Failing against a stated rule
- a banner when any check is not Healthy
- queue, throughput and capacity charts over the last hour, 24 hours or 7 days
- every scheduled job with its last result

It diagnoses nothing. When something is behind, the operator goes to Supabase or Fly.io.

## Decisions

1. **Both workers report in.** The sender calls a new heartbeat RPC every `SENDER_STATS_MS`
   (60 s). The relay posts to a new `relay-status` function every 60 s. Each heartbeat carries the
   process start time and its RSS; the sender adds its last progress time, the relay its feeds and
   reconnect count. Restarts are counted from distinct start times. *Decided by Brad 2026-10-21.*
2. **Disk is measured against a knob.** `health_disk_limit_bytes()` returns 8 GB (Supabase Pro's
   included disk). Postgres can't see the plan's limit. Change the knob in a migration when the disk
   grows. *Decided by Brad 2026-10-21.*
3. **Function-calling cron jobs go through one helper.** `cron_call_function(job, function, body,
   timeout)` reads Vault, calls `net.http_post` and logs the request id in `cron_http_requests`.
   The sampler copies each response's status before pg_net forgets it (a few hours). The six jobs
   (`ingest-pota`, `ingest-sotawatch`, `ingest-wwff`, `archive-spots`, `archive-aprs`,
   `import-cty`) are rescheduled by name with the same schedules, bodies and timeouts. *Decided by
   Brad 2026-10-21.*
4. **"Oldest ready delivery" is per destination.** Deliveries go out newest first under a
   per-minute budget, so a busy destination always has old rows waiting, and the age of the oldest
   message would read Delayed while everything works. The figure is the longest time any
   destination has had a ready delivery waiting: per destination, the age of its *newest* ready
   row, then the largest. "Ready" is the claim's `ready` predicate (visible, destination enabled,
   not paused or throttled, subscription enabled and linked, not past its age). A batch hold is at
   most 60 s, so it never crosses the 2-minute rule. *(Differs from the canvas, which describes the
   oldest deliverable message.)*
5. **Failed deliveries get a timestamp.** `mark_deliveries_failed` writes none, and a later success
   overwrites the row. A `before update` trigger on `deliveries` sets the new `last_failed_at` when
   `attempts` goes up with status `failed`, so the RPC is not redefined. A row that fails twice in
   one 30-minute bucket counts once.
6. **History is sampled once a minute.** Queue depths, ages, connections and size exist only in
   the moment, so the `health-sample` cron job writes one `health_samples` row a minute, with each
   source's `ingest_state.total_spots_ingested` (spots per bucket are the differences). Event
   figures (sent, failed, expired, latency) come straight from `deliveries` through partial
   indexes. Samples, heartbeats and request logs are kept 8 days; the sampler prunes them, so
   `run_housekeeping` is not redefined (#234 redefines it).
7. **Ranges are fixed buckets.** 1 hour is 60 one-minute buckets, 24 hours is 48 half-hour
   buckets, 7 days is 56 three-hour buckets. Gauges show each bucket's maximum, counts its sum.
   Latency percentiles are computed per bucket from the rows, never averaged.
8. **One public function, one cache.** `health` (GET `?range=1h|24h|7d`, `verify_jwt = false`)
   calls `cached_health(range)`, which serves `health_cache` while a range's row is under 30
   seconds old and rebuilds it under an advisory lock, like the band map. No rate limit: a request
   is one read of a three-row table. The page polls every 60 seconds while visible and on Refresh.
9. **Numbers only.** The payload carries statuses, counts, ages and sizes. Never error text,
   destination or user ids, URLs, or response bodies: the page is public.
10. **Rules are SQL's.** Every status is decided in `health_snapshot`; the web words it. The rule
    text on the page is copy and has to match the SQL; `health_snapshot.test.sql` pins each
    threshold.
11. **Relay feeds come from the relay.** The feeds checked are the latest relay heartbeat's (APRS-IS
    is off until `APRS_LOGIN_CALL` is set). With no heartbeat in 10 minutes, they are the relay
    sources with a success in the last 7 days.
12. **Before the workers report, their rows say "No data".** The sender row, restarts, reconnects
    and memory are `unknown`/null until the workers report in (they ship to Fly when PR 1 merges, the
    schema when it is pushed); the page shows "No data" meanwhile.

## Checks and rules

| Check | Figures | Rule |
| --- | --- | --- |
| `pulled` (POTA, SOTAwatch, WWFF) | seconds since each source's `last_success_at` | Delayed when any is over 180 s or never |
| `relay` (RBN, DX Cluster, APRS-IS) | seconds since each feed's `last_success_at` (the relay's 60 s heartbeat push), reconnects in 24 h | Delayed when any is over 180 s or never |
| `match_queue` | `spot_events` length and oldest age (`pgmq.metrics`) | Delayed when the oldest is over 120 s |
| `delivery_queue` | `deliveries_queue` length, oldest ready (decision 4), destinations throttled now | Delayed when oldest ready is over 120 s |
| `sender` | seconds since last progress, restarts in 24 h | Failing when over 120 s; unknown with no heartbeat |
| `database` | connections (`pg_stat_activity`) of `max_connections`, `pg_database_size` of `health_disk_limit_bytes()` | Delayed over 80% of either |
| `jobs` | cron jobs, failed runs in the last hour | Failing when any job's last 3 finished runs failed |
| `archive` | seconds since the newest `archive_log.archived_at` | Delayed over 2 hours |

A job run failed when cron says so, or, for a `cron_call_function` job, when its response is not
2xx or timed out. A request with no response yet is left out.

## Schema (migration `20261021000100_health.sql`)

- `health_samples` (`sampled_at` primary key, `match_waiting`, `match_oldest_seconds`,
  `delivery_waiting`, `delivery_oldest_ready_seconds`, `throttled_destinations`, `db_connections`,
  `db_bytes`, `spots_total jsonb`).
- `worker_heartbeats` (`id`, `worker` in `sender`/`relay`, `received_at`, `started_at`,
  `rss_bytes`, `last_progress_at` (sender), `reconnects` (relay), `feeds jsonb` (relay)), indexed
  `(worker, received_at desc)`.
- `cron_http_requests` (`request_id` primary key, `job`, `sent_at`, `status_code`, `timed_out`,
  `answered_at`), indexed `(job, sent_at desc)`.
- `health_cache` (`range` primary key, `payload`, `generated_at`).
- `deliveries.last_failed_at` with trigger `deliveries_last_failed_at`; partial indexes on
  `sent_at`, `dropped_at` and `last_failed_at`.

All four tables have RLS on, no policies and no client grants.

Functions, all `security definer` with pinned `search_path`, none granted to clients:

- `health_disk_limit_bytes()` (8 GB), `health_worker_memory_bytes()` (256 MB, both Fly machines).
- `cron_call_function(p_job, p_function, p_body, p_timeout_ms) returns bigint`, for pg_cron.
- `record_health_sample()`: one sample, the response copy, the 8-day prune. Cron `health-sample`,
  every minute.
- `record_sender_heartbeat(p_started_at, p_last_progress_at, p_rss_bytes)`: granted to
  `delivery_sender` (allowlist, `sender_role.test.sql`).
- `record_relay_heartbeat(p_started_at, p_rss_bytes, p_reconnects, p_feeds)`: service role, called
  by `relay-status`.
- `health_snapshot(p_range)` builds the payload; `cached_health(p_range)` serves it.

The payload is `HealthPayload` in `web/src/health/types.ts`, pinned by
`supabase/tests/health_snapshot.test.sql`; change the SQL, the type and the test together.

## Edge functions

- `health`: as `band-map`. GET only, `range` defaults to `24h`, any other value is a 400.
  `Cache-Control: public, max-age=15`.
- `relay-status`: POST with `x-relay-secret`, `verify_jwt = false`, never imports
  `isServiceRole`. Body `{started_at, rss_bytes, reconnects, feeds: [{id, connected}]}`, checked in
  TypeScript for shape, then `record_relay_heartbeat`.

## Workers

- Sender: `statsLoop` calls `record_sender_heartbeat` after `delivery_queue_stats`, with
  `Deno.memoryUsage().rss`. A failure is logged, never retried or counted as progress.
- Relay: a status loop posts to `relay-status` every 60 s, first at start. Reconnects are
  `sum(connects - 1)` over feeds that have connected. A failure is logged.

Both are best effort, so they can ship before or after the migration is hosted. The sender's RPC
is in the same PR as its grant and `sender_role.test.sql`, as the sender rules require.

## Web (PR 2)

- `/health` is a `PublicRoute`, in the nav after Stats as "Health" (`MonitorHeartIcon`), open
  signed out.
- `useHealth(range)` polls `loadHealth` every 60 s while visible (`useVisibleInterval`), at once on
  a range change and on Refresh, keeping the last payload on a failed refresh.
- Charts are stock MUI X `LineChart`/`BarChart` with `ChartsReferenceLine` for limits; no custom
  SVG. Times are the browser's local time.
- `web/src/health/model.ts` words checks, rules and job schedules; it never decides a status.

## PR order

1. Spec, migration, pgTAP, `health` and `relay-status`, the sender and relay heartbeats,
   `OPERATIONS.md`. The sender and relay ship to Fly on merge; hosted, `supabase db push` and deploy
   both functions.
2. The web page and generated types.

## Out of scope

Alerting or notifications, per-destination or per-user detail, Fly or Supabase API calls, error
text, any control beyond the range and Refresh.

## Copy

From the canvas, word for word except where marked.

- Title: "Health". Lede: "How Long Lines is running right now: queues, workers, database and
  scheduled jobs. Times are local."
- Range: "1 hour", "24 hours", "7 days". "Updated HH:MM:SS", "Refresh".
- Banner titles *(the canvas has one example)*: Pulled sources "Pulled sources are behind", Relay
  "A relay feed is behind", Match queue "Matching is behind", Delivery queue "Outbound is slower
  than usual", Sender "The sender has stopped", Database "The database is nearly full", Scheduled
  jobs "A scheduled job keeps failing", Archive "The archive is behind". Body: the check's Now text.
  More than one: the first in table order, and "N checks need attention." after the body.
- Current status: "Each rule is the point where a row turns Delayed or Failing." Columns Check,
  Status, Now, Rule. Chips "Healthy", "Delayed", "Failing", "No data" *(added)*.
- Rows (name, caption, rule):
  - "Pulled sources", "POTA, SOTAwatch, WWFF", "Delayed after 3 min without a success"
  - "Relay feeds", "RBN, DX Cluster, APRS-IS", "Delayed after 3 min without a push"
  - "Match queue", "spot_events", "Delayed when the oldest waits over 2 min"
  - "Delivery queue", "deliveries_queue", "Delayed when the oldest ready waits over 2 min"
  - "Sender", "Fly.io, longlines-sender", "Failing after 2 min without progress"
  - "Database", none, "Delayed over 80% of either"
  - "Scheduled jobs", none, "Failing when a job fails 3 runs in a row"
  - "Archive", none, "Delayed after 2 hours"
- Now texts: "Last success 22 s ago" (the oldest of the sources); "Last push 41 s ago · 0
  reconnects in 24 h"; "9 waiting · oldest 3 s"; "184 waiting · oldest ready 4 min · 3
  destinations throttled"; "Last progress 6 s ago · 0 restarts in 24 h"; "38 of 60 connections ·
  disk 61% full"; "10 jobs · 0 failed runs in the last hour"; "Last slice written 6 min ago".
- Sections "Queues", "Throughput and speed", "Capacity", "Scheduled jobs", with the canvas's chart
  titles, captions and legends, except:
  - Oldest ready delivery caption *(amended, decision 4)*: "How long a destination has had a
    deliverable message waiting. Over the dashed line, outbound is stuck or throttled."
  - Worker memory caption: "The two Fly.io machines have 256 MB each. A line that keeps climbing
    toward the dashed line means it's time for a bigger machine."
- Scheduled jobs: "Jobs that call a function show the HTTP status it returned, not just that the
  request was sent." Columns Job, Schedule, Last run, Last result, Failed in 24 h. Results "HTTP
  200", "Timed out" *(added)*, "Done in 0.2 s".

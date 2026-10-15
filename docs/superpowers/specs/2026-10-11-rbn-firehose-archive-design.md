# RBN firehose and the spot archive

Date: 2026-10-11

Follow-up to #13 and #28; recorded first as #29.

## Goal

Long Lines ingests everything it can get and keeps all of it for future analytics. The first step is
the Reverse Beacon Network: every spot RBN publishes on port 7000 (about 1.5 million a day, ~17/s on
average, bursting far higher in contests), not only the callsigns someone watches.

The database keeps a recent window that SQL can query. Every source is also written, hour by hour,
to Supabase Storage as gzipped NDJSON, and nothing leaves the database until Storage holds it.

Success means:

- Every RBN spot the relay receives is stored, apart from gaps while the relay reconnects.
- Every spot from every source reaches the archive, and the archive never misses rows the database
  had.
- `rbn_spots` stays near seven days (~2.5 GB) on the Pro plan's 8 GB disk.
- Alerting (matching, deliveries, quiet windows, previews) and the Stats page behave exactly as they
  do now.
- Running cost stays in single dollars a month on top of Pro.

## Decisions

| Question                   | Decision                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| Supabase plan              | Pro (8 GB database, 100 GB Storage included).                                                    |
| RBN window in the database | 7 days, matching the Stats page window.                                                          |
| Archive format             | Gzipped NDJSON, one file per source per hour. Parquet can be produced later from these files.    |
| Where RBN lives            | A new table `rbn_spots`, partitioned by day. `raw_spots` keeps only watched RBN spots, as today. |
| POTA and SOTAwatch         | Stay in `raw_spots` with no new deletion; archived hourly like RBN.                              |

## Non-goals

- Partitioning or pruning `raw_spots`.
- Parquet files, an analytics UI, or RBN on the Stats page.
- RBN port 7001 (FT8/FT4), DX Cluster or PSK Reporter. The relay's feed list makes these later
  additions.
- Reading archives from inside Postgres.

## Data model

### `rbn_spots`

Every RBN spot, `partition by range (spot_time)`, one partition per UTC day named
`rbn_spots_YYYYMMDD`, plus a default partition.

| Column          | Type                               | Notes                                                           |
| --------------- | ---------------------------------- | --------------------------------------------------------------- |
| `spot_time`     | timestamptz not null               | From the line's `HHMMZ` and `received_at` (`spotTimeFromHhmm`). |
| `received_at`   | timestamptz not null               | When the relay read the line.                                   |
| `ingested_at`   | timestamptz not null default now() |                                                                 |
| `spotter`       | text not null                      | Skimmer without `-#`.                                           |
| `callsign`      | text not null                      |                                                                 |
| `frequency_khz` | numeric(12,3) not null             |                                                                 |
| `band`          | text                               | `bandForFrequency`.                                             |
| `mode`          | text                               | `resolveMode`.                                                  |
| `mode_family`   | text                               | `modeFamily`.                                                   |
| `snr`           | smallint not null                  | dB.                                                             |
| `speed`         | smallint not null                  |                                                                 |
| `speed_unit`    | text not null                      | `WPM` or `BPS`.                                                 |
| `spot_type`     | text not null                      | CQ, BEACON, NCDXF B, DX.                                        |
| `line`          | text not null                      | The telnet line exactly as received.                            |

- Unique `(spot_time, spotter, callsign, frequency_khz)`. It includes the partition key, as Postgres
  requires, and it is what identifies an RBN spot, so a retried batch inserts nothing new.
- Index `(callsign, spot_time)`.
- RLS on, no policies; `anon` and `authenticated` revoked. Service role only.

### `archive_log`

| Column        | Type                                        |
| ------------- | ------------------------------------------- |
| `source`      | text, part of primary key                   |
| `hour_start`  | timestamptz, part of primary key (UTC hour) |
| `row_count`   | int not null                                |
| `bytes`       | int (null when `row_count = 0`)             |
| `object_path` | text (null when `row_count = 0`)            |
| `archived_at` | timestamptz not null default now()          |

RLS on, no policies, service role only. A row means "this hour is in Storage with this many rows".
`row_count = 0` means the hour had no spots; no file is written.

### Storage

A private bucket `archive`, created by the migration. Objects are
`<source>/YYYY/MM/DD/HH.ndjson.gz`, for example `rbn/2026/10/11/14.ndjson.gz`, uploaded with content
type `application/gzip`.

### Unchanged

`raw_spots`, `spot_matches`, `match_pending_spots`, deliveries, `refresh_stats_snapshot` and the web
app.

## Ingest path

### Relay

- Forwards every line `parseRbnLine` accepts; banners and prompts are still dropped. The relay no
  longer reads the watchlist: `watchlist.ts` and the GET call are removed, and `Feed.callsignOf`
  becomes `Feed.isSpot`.
- `Forwarder`: `maxBatch` 1,000 (the function's existing `MAX_LINES`), `flushMs` 10 s, `heartbeatMs`
  60 s, `maxBuffer` 50,000 lines.
- `/healthz` and the ten-minute stats log report `dropped` (lines discarded from a full buffer).

### `ingest-rbn` POST

1. Parse the body as today (`rbnAdapter(body).parseFeed`).
2. Turn every line into an `rbn_spots` row and insert the batch with one RPC,
   `ingest_rbn_spots(p_rows jsonb) returns int` (rows inserted), `on conflict do nothing`. No age
   cutoff: lines flushed after an outage are stored. Lines that do not parse go to `ingest_failures`
   as today and are not stored.
3. Read `watched_callsigns('rbn')` and run the existing `runIngest(rbnAdapter(watchedBody), db)`
   over only the watched lines. They reach `raw_spots`, the `spot_events` queue and the matcher
   exactly as now, including the five-minute `too_old` skip.
4. `IngestSummary` gains `stored` (rows inserted into `rbn_spots`); `ingest_state` is recorded as
   now.

`ingest-rbn` GET (the watchlist) stays for compatibility with a relay that has not been redeployed
yet, and is removed once the relay no longer calls it.

## Archive job

### Schedule

An Edge Function `archive`, `verify_jwt = true`, called by pg_cron at `10 * * * *` through
`net.http_post` with the Vault URL and service-role key, like the ingest jobs.

### Which hours

For each source in `rbn`, `pota`, `sotawatch`: hours whose end is at least two hours before now and
that have no `archive_log` row, oldest first, starting from the source's earliest stored
`spot_time`. At most 3 hours per source per run, so a backlog after downtime clears over several
runs. The two-hour lag covers batches the relay flushes after an outage of up to ~50 minutes.

### Building a file

- RPC `archive_ndjson(p_source text, p_from timestamptz, p_to timestamptz) returns text`: the rows
  of one source in `[p_from, p_to)` by `spot_time`, one JSON object per line, ordered by
  `spot_time`, built with `to_json` and `string_agg` in Postgres, so the function never parses rows.
- The function reads an hour as six 10-minute slices (~10,000 RBN rows each), writes them in order
  into a `CompressionStream("gzip")`, and uploads the result with `upsert: true`.
- RBN object fields: `spot_time`, `received_at`, `spotter`, `callsign`, `frequency_khz`, `band`,
  `mode`, `mode_family`, `snr`, `speed`, `speed_unit`, `spot_type`, `line`.
- POTA and SOTAwatch object fields: every `raw_spots` column except `id`, including `raw_payload`.
  Watched RBN rows in `raw_spots` are not archived from there; `rbn_spots` already holds them.
- After the upload succeeds, upsert the `archive_log` row with `row_count`, `bytes` and
  `object_path`. An hour with no rows gets `row_count = 0` and no object.

### CPU budget

Edge Functions get 2 s of CPU per request. Before relying on hourly files, measure one simulated
full RBN hour (~62,000 rows) through the function locally. If it does not fit comfortably, the
function writes 15-minute objects (`HH-MM.ndjson.gz`) with the same format and `archive_log` keyed
by slice start. Choosing between the two is the only open item, and the measurement settles it.

## Retention

`maintain_rbn_spots()`, security definer, run daily by pg_cron at `30 3 * * *`:

1. Create the partitions for today and the next three days if missing.
2. For each daily partition whose day ended more than 7 days ago, check its 24 hours:
   - Every hour has an `archive_log` row whose `row_count` equals the partition's count for that
     hour: drop the partition.
   - Otherwise: delete the `archive_log` rows of the hours that are missing or mismatched, so the
     next archive run redoes them, and keep the partition. It is checked again the next day.
3. Rows in the default partition older than 7 days are deleted by hour under the same rule.

Nothing is removed from the database unless Storage holds it with the same row count. If archiving
stops, data stays in the database and `archive_status` shows the backlog.

POTA and SOTAwatch rows are never deleted, so a row that arrives after its hour was archived stays
in `raw_spots`; deleting that hour's `archive_log` row re-archives it. At their volume and with the
two-hour lag this is not expected in practice, so no automatic recount is added.

## Monitoring

- View `archive_status` (service role only): per source, the last archived hour and the number of
  finished hours waiting.
- `docs/OPERATIONS.md`: checking the archive, re-archiving an hour (delete its `archive_log` row),
  reading archives with DuckDB over Storage's S3 endpoint, and the expected `rbn_spots` size.
- Relay logs and `/healthz`: `dropped`.

## Testing

- Deno, relay: forwards every spot line; no watchlist; batch, flush, heartbeat and buffer sizes;
  `dropped` reported.
- Deno, `ingest-rbn`: every parsed line goes to `ingest_rbn_spots`; only watched lines go through
  `runIngest`; unparseable lines go to `ingest_failures`; `stored` in the summary.
- Deno, `archive`: hour selection (lag, per-run cap, gaps, earliest hour), 10-minute slicing, gzip
  round trip of the uploaded bytes, empty hours, `upsert` on retry, `archive_log` written only after
  a successful upload. Fake database and Storage clients.
- pgTAP: `rbn_spots` partition routing and dedup; `ingest_rbn_spots` counts; `archive_ndjson` shape
  for each source and its slice boundaries; `maintain_rbn_spots` creates partitions ahead, drops
  only fully archived days with matching counts, resets mismatched hours; grants on every new
  object.
- Smoke test: an `rbn_spots` insert and an `archive_ndjson` call.
- Measurement: one simulated full RBN hour through the archive function (see CPU budget).

## Rollout

Two PRs:

1. **Full ingest.** `rbn_spots`, `ingest_rbn_spots`, partition creation (step 1 of
   `maintain_rbn_spots` only), `ingest-rbn` storing every line, and the relay forwarding every line.
   Nothing is dropped yet; the database grows ~350 MB a day until PR 2 lands.
2. **Archive and retention.** The bucket, `archive_log`, `archive_ndjson`, the `archive` function
   and its cron job, `archive_status`, and steps 2 and 3 of `maintain_rbn_spots`.

Deploy order for each: migrations and Edge Functions first, then the relay. The new `ingest-rbn`
accepts the current relay's watched-only batches, so the order is safe in between.

## Amendment after measurement (2026-10-11, before PR 2)

The CPU budget's open item was measured with a throwaway prototype: one synthetic full RBN hour
(62,000 rows) built as NDJSON in Postgres in six 10-minute slices, fetched with supabase-js and
gzipped with `CompressionStream`.

| Measure                               | Result                                     |
| ------------------------------------- | ------------------------------------------ |
| NDJSON for the hour                   | 22.1 MB                                    |
| Gzipped                               | 1.59 MB (14x)                              |
| Process CPU (user + sys, three runs)  | ~0.33 s, of which ~0.04 s is Deno start-up |
| Wall time                             | ~0.8 s                                     |
| One 10-minute slice built in Postgres | 72 ms (not function CPU)                   |

A normal hour fits the 2 s limit, but a contest hour (several times the average rate) would come
close on slower hosted hardware. So:

- **Slice length per source.** RBN is archived in 10-minute slices; POTA and SOTAwatch stay hourly.
  Objects are named by slice start: `<source>/YYYY/MM/DD/HHMM.ndjson.gz` (`HH00` for the hourly
  sources). `archive_log` is keyed by `(source, slice_start)` with `slice_end`; the slice length
  lives in one SQL function, `archive_slice_minutes(source)`.
- **Schedule.** The `archive` function runs every 10 minutes (`*/10 * * * *`), not hourly. Each run
  takes pending slices oldest first (POTA, SOTAwatch, then RBN) and stops starting new slices once
  it has archived 60,000 rows, so a normal run does one RBN slice and a backlog clears about six
  times faster than real time. The two-hour lag is unchanged.
- **Retention** compares counts per 10-minute RBN slice instead of per hour.
- **`ingest-rbn` GET** is removed in PR 2: the relay deployed with PR 1 no longer calls it.

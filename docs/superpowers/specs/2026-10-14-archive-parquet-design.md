# Archive as Parquet

Date: 2026-10-14

## Goal

Write the spot archive as Parquet instead of gzipped NDJSON. The source stays the top-level folder,
and the year, month and day folders under it become Hive-style, so DuckDB, Spark and Athena can
query the bucket as one partitioned dataset. Slicing, the two-hour lag, `archive_log` and retention
are unchanged (spec `2026-10-11-rbn-firehose-archive-design.md`).

## Decisions (Brad)

| Question                      | Decision                                                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File grain                    | One Parquet file per slice (APRS-IS 5 min, RBN 10, others 60). A file per day would mean a compaction worker outside the Edge Function's 2 s CPU budget. |
| Folder names                  | Hive: `<source>/year=YYYY/month=MM/day=DD/HHMM.parquet`. The source stays a plain folder, because each source has its own schema.                        |
| Existing `.ndjson.gz` objects | Out of scope. A separate one-off migration tool will rewrite them once Parquet is live.                                                                  |

## Design

- `archive_columns(source, from, to)` replaces `archive_ndjson`. It selects the same rows, columns
  and order, and returns them as one JSON object of column arrays (`row_count`, `columns`).
  Timestamps come back as epoch milliseconds and `raw_payload` as JSON text. An empty slice returns
  `columns = null`.
- The `archive` function parses that JSON once, encodes it with `hyparquet-writer` (pure JS, snappy,
  one dependency), uploads it as `application/vnd.apache.parquet` and logs it. Each file is one row
  group.
- `ARCHIVE_SCHEMAS` in `_shared/archive.ts` gives each column's Parquet type:
  - timestamps: `INT64` `TIMESTAMP(MILLIS, isAdjustedToUTC)`
  - `frequency_khz`: `DOUBLE`
  - `snr` and `speed`: `INT32`
  - `raw_payload`: `JSON`
  - everything else: `UTF8` strings

  Every column is optional. A test reads the migration and checks that its column lists match
  `ARCHIVE_SCHEMAS`.
- Month and day are zero-padded so folders sort as text. DuckDB still reads them as integers.

## Measurement

Synthetic batches went through `encodeParquet`, timing `JSON.parse` plus encoding (wall clock, three
runs each, local Deno):

| Batch                                                   | Time          | Parquet | JSON in |
| ------------------------------------------------------- | ------------- | ------- | ------- |
| RBN, 60,000 rows (one full run's row budget)            | 234 to 256 ms | 1.8 MB  | 9.9 MB  |
| APRS-IS, two 30,000-row slices (one `archive-aprs` run) | 198 to 211 ms | 2.0 MB  | 11.0 MB |

Both are well inside the 2 s CPU limit, so `MAX_ROWS_PER_RUN` stays at 60,000. A local run through
`supabase functions serve` archived 48 seeded slices (9,442 rows) in one call with no errors. The
files read back with the matching row counts.

## Deploy

1. `supabase db push`. Until step 2, the deployed function still calls `archive_ndjson`, so its runs
   fail and slices stay pending. Nothing is lost: retention waits for `archive_log`.
2. `supabase functions deploy archive`. The backlog clears over the next runs.

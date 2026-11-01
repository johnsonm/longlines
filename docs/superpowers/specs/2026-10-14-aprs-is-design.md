# APRS-IS full feed

Date: 2026-10-14

## Goal

Long Lines ingests every APRS-IS packet: the full feed on port 10152, not a filtered subset. This
continues the "ingest everything, keep everything" goal of the RBN firehose
(`2026-10-11-rbn-firehose-archive-design.md`).

The full feed runs at roughly 50-150 packets a second, or 4-13 million a day: three to nine times
RBN. That volume shapes everything below.

## Decisions (Brad)

| Question | Decision |
| --- | --- |
| Database window | About two days. Everything is kept in Storage as gzipped NDJSON. A day leaves the database only when every slice is archived with the database's count. |
| Parse depth | Header and packet type only: source, destination, digipeater path, q-construct, igate, and the data-type identifier. The TNC2 line is stored exactly as received, for later decoding. |
| Alerting | None. APRS-IS is stored and archived only: no `raw_spots`, matcher, subscription option, Stats or profiles. Any of these can be a follow-up. |

## Shape

The flow is inbound → `ingest-aprs` → `ingest_aprs_packets` → `aprs_packets`. That table is
partitioned by UTC day on `received_at`, then archived and retired, the same pattern as
`rbn_spots`. `docs/ARCHITECTURE.md` ("APRS-IS", "The spot archive") has the details, and
`docs/OPERATIONS.md` ("APRS-IS") the runbook.

- **Inbound.** The inbound worker needs a plain TCP line decoder (UTF-8, no telnet IAC). It also needs a login
  line sent after the server's `# ...` banner: `user CALL pass -1 vers LongLines 0.1`. The feed is
  off until `APRS_LOGIN_CALL` is set, which also gates the rollout below. The forwarder buffer is
  150,000 lines.
- **Dedup.** `unique (received_at, line_md5)`. The inbound worker resends the same line with the same
  `received_at` when a push fails.
- **Health.** `aprs_packet_hours` counts packets per hour. It is kept indefinitely, so the Sources
  page never counts a day of packets.
- **Archive.** Five-minute slices go out in their own cron job, `archive-aprs`, every five minutes
  with `{"sources": ["aprs"]}`. At 100 packets a second APRS alone would fill the 60,000-row budget
  that the other sources share every 10 minutes.

## Measurement

The archive cost was measured on a synthetic two-slice run: 60,000 packets of about 120 characters
each, in an isolated local database.

| Measure | Result |
| --- | --- |
| `archive_ndjson`, one 30,000-packet slice, in Postgres | ~110 ms |
| NDJSON per slice | 9.4 MB |
| Parse the RPC body and gzip both slices, process CPU (three runs) | 173-183 ms |
| Gzipped, both slices | 1.9 MB |

Two slices per run is well inside the 2 s Edge Function CPU limit, so five-minute slices stand.

The synthetic lines contain an md5 hex string, which compresses worse than real comments. Real
objects should come out smaller than ~1 MB per slice.

## Size and cost

These estimates assume 100 packets a second.

- **Database:** about 300 bytes a packet with its two indexes, so ~2.5 GB a day. The database keeps
  yesterday and today, about 5 GB at the peak just before the nightly retirement. Beyond the Pro
  plan's 8 GB, disk is $0.125/GB-month, so APRS-IS adds roughly $0.60-1 a month.
- **Storage:** ~0.3 GB a day, ~8.5 GB a month, kept indefinitely. Pro includes 100 GB.

The real rate is checked after the first day from the inbound worker's stats log and `aprs_packet_hours`.
If it is far from 100 a second, the slice length or the window changes.

## Rollout

1. Merge. The Supabase GitHub integration applies `20261014000010_aprs_source`, and Fly redeploys
   the inbound worker with the feed off.
2. `supabase functions deploy ingest-aprs`. The integration skips new functions.
3. `fly secrets set APRS_LOGIN_CALL=<CALL-SSID>`. Use a call-SSID no other client uses.
4. After a day, check the rate, `archive_status` and the `aprs_packets` size.

## Amendment, 2026-10-31: connections

The Alerting decision above ("None") is superseded: a connection can now list APRS-IS. The table
stays as the record of the first decision. Migration `20261031000100_aprs_connections`; the rules
are in CLAUDE.md ("Inbound worker rules", "Delivery rules") and `docs/ARCHITECTURE.md` ("APRS-IS").

| Question | Decision (Brad, 2026-10-31) |
| --- | --- |
| Which packets | Watched stations only, as RBN: `runAprsPush` stores every packet, then sends the packets whose source call `watched_among('aprs', ...)` returns through `runIngest` into `raw_spots`. Only `position`, `mic_e`, `object` and `item` packets become spots; everything else, and a source call that is not a plausible callsign, is a skip. |
| Cadence | One spot per station per 15 minutes (`APRS_SPOT_BUCKET_MS`). `source_spot_id` is `<callsign>\|<bucket>` and the hash `[callsign, bucket]`, the bucket being `received_at` floored to the window, so later packets in the window hit `ON CONFLICT DO NOTHING`. Fixed forever. |
| Spot fields | Callsign: `source_call`, upper-cased. Spotter: the igate for `qAR`, `qAr`, `qAO`, `qAo`, else null. Comment: the info field as received (position decoding is a possible follow-up). Time: `received_at`; older than five minutes is a skip. Frequency, band, mode, mode family and references: null, so `raw_spots.frequency_khz` is nullable. |
| Matching | Opt-in in `source_matches`: "any source" never includes it. Like RBN, a spot passes only an AND group that names stations, and a connection on RBN and/or APRS-IS alone must have one. |
| Where it shows | Connections, the connection preview and the home diagram. Not in `spot_stream` (profiles, rollups, group statistics), Stats (which keeps counting packets), the band map, recent spots or callsign groups' on-air. |
| Delivery | Labelled `APRS-IS` in push and the sender; Discord has its own colour; no source link. Never sent to a Local DX cluster (no frequency). |

What did not change: the source id stays `aprs`, and outside `raw_spots` (`ingest_state`,
`ingest_health`, the archive, `archive-aprs`, Stats) it still means packets.

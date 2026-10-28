# APRS-IS on the Stats page

Date: 2026-10-14

## Goal

The Stats page (`/stats`) shows what Long Lines took in over the last seven complete UTC days. APRS-IS
(`2026-10-14-aprs-is-design.md`) is now the busiest feed, and the page leaves it out. This change
counts APRS packets in the page's volume figures and adds a small APRS-IS section.

APRS stays out of everything else: no `raw_spots`, matching, `spot_stream`, subscription source
option, profiles or callsign rollups. Packets are not spots and never trigger alerts.

## Decisions (Brad)

| Question | Decision |
| --- | --- |
| Placement | APRS counts in the volume figures (Spots processed, average rate, the per-hour chart, a fourth per-day chart) and gets its own section. |
| Section figures | Packets, stations heard, igates, and packets by type. No top-stations table: the busiest senders include non-callsigns (`MYANET`, `WINLINK`), and profiles hold no APRS data. |
| Counting method | Daily rollup tables, built by the hourly stats refresh, as for RBN. Not at ingest, and not approximate counts. |

## Why rollups

`aprs_packets` keeps about two days; the Stats window is seven. Anything the page needs must be
saved before `maintain_aprs_packets` drops a day. A finished day holds roughly 2-8 million packets,
too many to read on every hourly refresh.

Packet volume already has a durable source: `ingest_aprs_packets` adds every inserted row to
`aprs_packet_hours`, which is never pruned. Daily and hourly packet counts come from there. Only
the distinct counts and the type breakdown need new tables.

## Data

One migration, `20261014000030_stats_aprs.sql`. Every new table is service-role only: RLS on, no
policies, `anon`/`authenticated` revoked.

| Table | Key | Holds |
| --- | --- | --- |
| `aprs_daily_stations` | `(day, base)` | Each base call that sent at least one packet that day. |
| `aprs_daily_igates` | `(day, igate)` | Each igate, as sent, that gated at least one packet that day. |
| `aprs_daily_types` | `(day, packet_type)` | Packets per type per day. |
| `aprs_rollup_days` | `day` | When the day was last rolled up (`rolled_at`). |

Stations are base calls: `base_callsign()` strips the SSID, so `K4ABC-9` and `K4ABC-7` are one
station, and leaves non-callsigns such as `MYANET` as they are. Following the rollup rule, a day is
grouped by `source_call` before `base_callsign()` is called. Igates are counted as sent: an igate is
one gateway, so `K4ABC-10` and `K4ABC` running two gateways are two.

Rollup rows older than the window are pruned on each refresh. `aprs_rollup_days` is not pruned (one
row a day), so the retention guard below never loses a marker.

### `rollup_aprs_day(p_day date) returns boolean`

Replaces the day's rows in the three daily tables and upserts its marker, in one transaction. It
reads the day once into a materialized CTE grouped by `(source_call, igate, packet_type)`, then
derives the three tables from that.

It refuses a day it cannot roll up whole. The day's row count in `aprs_packets` must equal the sum
of its `aprs_packet_hours`, read in the same statement. Ingest writes both in one statement, so they
differ only when packets have been dropped. On a mismatch it writes nothing, raises a warning and
returns false. This covers a day retired before this migration existed.

Security definer, `search_path = public`, execute revoked from `public`, `anon` and
`authenticated`.

### Retention guard

`maintain_aprs_packets()` gets one more condition: a day is dropped only if `aprs_rollup_days` holds
it with `rolled_at` at least an hour after the day ended. Otherwise it raises a warning and keeps
the day until the next night. A day older than the Stats window (before today minus seven) is
dropped without a marker: the refresh never rolls it up, so without this cap a failing refresh or a
refused day would keep gigabytes of packets forever (`maintain_rbn_spots` caps its callsign-rollup
guard the same way). It never runs the rollup itself; rollups stay out of the partition
maintenance job, as with the callsign rollups.

Timing on a normal day D: the refresh at D+1 00:05 rolls it, and the refresh at D+1 01:05 rolls it
again because the first roll came within an hour of its end. Retention first considers D at D+2 03:45,
about 26 hours later.

The re-roll rule (rolled within an hour of the day's end) and the guard (rolled at least an hour
after) are complements. A day retention could drop is never re-rolled, so a re-roll never finds an
empty partition.

## Snapshot

`refresh_stats_snapshot_at(p_now)` is replaced in the same migration, unchanged except:

- **Rollups.** After the RBN rollups, every window day without an `aprs_rollup_days` marker, or
  rolled within an hour of its end, is passed to `rollup_aprs_day`, oldest first. A refused day is
  retried on the next refresh. Days before APRS-IS started roll up as empty.
- **`daily[].aprs`, `hourly[].aprs`.** Summed from `aprs_packet_hours`, zero-filled. Today's hours
  are live there, so the hourly series needs no extra hourly rollup.
- **`aprs`.** A new top-level object:

```ts
aprs: {
  packets: number;  // sum of aprs_packet_hours over the seven window days
  stations: number; // distinct base calls over the week
  igates: number;   // distinct igates over the week, as sent
  types: { type: AprsPacketType; packets: number }[]; // all 14 types, packets desc then type asc
};
```

`AprsPacketType` is the 14 values of `aprs_packets.packet_type`'s check constraint. Every type is
always present, zero-filled.

`web/src/stats/types.ts` and `supabase/tests/stats_snapshot.test.sql` change with the SQL, per the
Phase 3 stats rule.

## Page

Colour follows the source everywhere: POTA primary, SOTA secondary, RBN warning, APRS `success`.

### Volume figures

- **Spots processed.** The value adds APRS packets. The detail becomes
  `{rbn} RBN, {aprs} APRS, {pota} POTA, {sota} SOTA`.
- **Average rate** and **Peak hour** include APRS through `processed` and the hourly totals.
- **Spots processed per hour.** The combined series adds `aprs`. Copy unchanged ("All sources
  combined").
- **Spots per day.** A fourth chart, `APRS`, subheader `{n} packets`. Four across from `md`, two
  across on `sm`, one on phones. The section text becomes: "One chart per source. RBN and APRS run
  100 times the volume of POTA or more, so they don't share a scale."

### APRS-IS section

At the bottom of the page, after "Most heard on RBN":

- Heading `APRS-IS` (`h6`, as "Spots per day" is), with the body text: "Every packet on the APRS-IS
  full feed. Packets aren't spots and never trigger alerts."
- Three KPIs, `xs: 12, sm: 4`:
  - **APRS packets**: `{packets}`, detail "Every packet on the full feed".
  - **Stations heard**: `{stations}`, detail "Unique callsigns that sent a packet, SSIDs combined".
  - **Igates**: `{igates}`, detail "Unique gateways that passed a packet to APRS-IS".
- **Packet types** chart card, subheader "What APRS stations sent". A horizontal bar chart in the
  payload's order, `success` colour. Labels come from a fixed map in `format.ts`: Position, Mic-E,
  Object, Item, Message, Status, Weather, Telemetry, NMEA, Third party, Capabilities, Query, User
  defined, Other.

There is no mockup for this copy; the strings above are the source.

### Older snapshots

A snapshot written before this migration has no `aprs` and no `aprs` in `daily`/`hourly`. The page
renders zeros, as it does for RBN (`NO_APRS`, `d.aprs ?? 0`), until the next hourly refresh.

## Tests

- **pgTAP `stats_snapshot.test.sql`:** the new keys and shapes; `daily`/`hourly` APRS counts from
  `aprs_packet_hours`; stations by base call (two SSIDs count once); igates as sent; all 14 types
  zero-filled and ordered; rollup rows outside the window are pruned.
- **pgTAP `aprs.test.sql`:** `rollup_aprs_day` refuses a day whose rows don't match its hours and
  writes no marker; `maintain_aprs_packets` keeps a two-day-old day without a marker, or with one
  set within an hour of the day's end, and drops it once properly rolled; a re-roll replaces a
  day's rows.
- **`advisor.test.sql`:** passes unchanged. `rollup_aprs_day` pins `search_path` and is not
  client-callable, so it joins neither list.
- **Vitest `StatsPage.test.tsx`:** the APRS section and its KPIs; the fourth per-day chart; APRS in
  the Spots processed detail; an older payload without `aprs` renders zeros.
- `web/src/lib/database.types.ts` gains the new tables (hand-spliced if the generator drifts, as
  for #156).

## Docs

- `CLAUDE.md`, Inbound rules: APRS packets still never reach `raw_spots`, matching or `spot_stream`,
  but the Stats refresh rolls them up (`aprs_daily_*`, from `aprs_packets` and
  `aprs_packet_hours`). Phase 3 stats rules: APRS figures come from those tables, never
  `aprs_packets` directly, and retention waits for the rollup.
- `docs/ARCHITECTURE.md`, "APRS-IS" and the Stats section: the rollups and the retention guard.
- The header of `20261014000010_aprs_source.sql` says nothing rolls APRS up; it is applied and stays
  as is, and the new migration's header supersedes it.

## Rollout

1. Merge. The Supabase integration applies `20261014000030_stats_aprs`; no function changes. Vercel
   deploys the web app.
2. The next refresh (:05) writes a snapshot with `aprs`. Window days before 2026-10-14 roll up empty;
   2026-10-14 rolls at 2026-10-15 00:05Z.
3. If this merges after 2026-10-16 03:45Z, retention will already have dropped 2026-10-14 without the
   guard. That day's rollup refuses, so the page shows its packet volume but not its stations, igates
   or types.
4. Check the first snapshot: `select payload->'aprs' from stats_snapshots order by generated_at desc
   limit 1`.

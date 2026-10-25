// One relay batch for ingest-rbn. Every line goes to rbn_spots (the full
// record, kept for seven days and archived); only lines whose station a
// subscription names (exactly or by base call, see watched_among) continue through runIngest into raw_spots, the spot_events queue and
// the matcher, exactly as before the firehose.

import { recordFailureAndThrow, runIngest } from "./ingest.ts";
import { rbnAdapter, rbnSpotRow } from "./rbn.ts";
import { parseRelayBody, withoutNul } from "./relay_lines.ts";
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
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export async function runRbnPush(
  body: unknown,
  db: RbnPushDb,
  now: Date,
): Promise<IngestSummary> {
  const rows: RbnSpotRow[] = [];
  const kept: JsonObject[] = [];
  const failures: SpotFailure[] = [];
  let items: JsonObject[];
  let watchedItems: JsonObject[];
  let stored = 0;

  try {
    items = parseRelayBody(body);
    for (const raw of items) {
      try {
        rows.push(rbnSpotRow(raw, now));
        kept.push(raw);
      } catch (error) {
        failures.push({ source: "rbn", error: errorMessage(error), raw_payload: withoutNul(raw) });
      }
    }
    if (rows.length > 0) {
      stored = await db.ingestRbnSpots(rows);
    }
    if (failures.length > 0) {
      await db.recordSpotFailures(failures);
    }
    const stations = Array.from(new Set(rows.map((row) => row.callsign)));
    const watched = new Set(await db.watchedAmong("rbn", stations));
    // kept[i] is the item rows[i] came from.
    watchedItems = [];
    for (const entry of kept.entries()) {
      const row = rows[entry[0]];
      if (row === undefined) {
        throw new Error(`rbn push: no row for kept line ${String(entry[0])}`);
      }
      if (watched.has(row.callsign)) {
        watchedItems.push(entry[1]);
      }
    }
  } catch (error) {
    return await recordFailureAndThrow(db, "rbn", error);
  }

  // Runs even with no watched lines so ingest_state records the heartbeat.
  const summary = await runIngest(rbnAdapter({ lines: watchedItems }), db, now);
  // Same keys in the same order as the summary, with fetched and failed
  // replaced in place and stored added last.
  return Object.assign({}, summary, {
    fetched: items.length,
    failed: summary.failed + failures.length,
    stored,
  });
}

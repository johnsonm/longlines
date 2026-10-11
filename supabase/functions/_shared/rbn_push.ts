// One relay batch for ingest-rbn. Every line goes to rbn_spots (the full
// record, kept for seven days and archived); only lines whose station is on the
// watchlist continue through runIngest into raw_spots, the spot_events queue and
// the matcher, exactly as before the firehose.

import { runIngest } from "./ingest.ts";
import { parseRelayBody, rbnAdapter, rbnSpotRow } from "./rbn.ts";
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

/** The item with every U+0000 removed: ingest_failures.raw_payload is jsonb, which rejects it. */
function withoutNul(raw: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(raw).replaceAll("\\u0000", "")) as JsonObject;
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
    items = parseRelayBody(body);
    for (const raw of items) {
      try {
        rows.push(rbnSpotRow(raw));
        kept.push(raw);
      } catch (error) {
        failures.push({ source: "rbn", error: errorMessage(error), raw_payload: withoutNul(raw) });
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

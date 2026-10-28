// One inbound batch for ingest-rbn. Every line goes to rbn_spots (the full
// record, kept for seven days and archived); only lines whose station a
// subscription names (exactly or by base call, see watched_among) continue through runIngest into raw_spots, the spot_events queue and
// the matcher, exactly as before the firehose.

import { ValidationError } from "./errors.ts";
import { recordFailureAndThrow, runIngest } from "./ingest.ts";
import { rbnAdapter, rbnSpotRow } from "./rbn.ts";
import { parseInboundBody, withoutNul } from "./inbound_lines.ts";
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

/** An inbound item that made an rbn_spots row, and that row. */
interface StoredLine {
  raw: JsonObject;
  row: RbnSpotRow;
}

export async function runRbnPush(
  body: unknown,
  db: RbnPushDb,
  now: Date,
): Promise<IngestSummary> {
  const lines: StoredLine[] = [];
  const failures: SpotFailure[] = [];
  const watchedItems: JsonObject[] = [];
  let items: JsonObject[];
  let stored = 0;

  try {
    items = parseInboundBody(body);
    for (const raw of items) {
      try {
        lines.push({ raw, row: rbnSpotRow(raw, now) });
      } catch (error) {
        // Per line: an unparseable line becomes one ingest_failures row, and anything
        // else fails the batch.
        if (!(error instanceof ValidationError)) {
          throw error;
        }
        failures.push({ source: "rbn", error: error.message, raw_payload: withoutNul(raw) });
      }
    }
    const rows = lines.map((line) => line.row);
    if (rows.length > 0) {
      stored = await db.ingestRbnSpots(rows);
    }
    if (failures.length > 0) {
      await db.recordSpotFailures(failures);
    }
    const stations = Array.from(new Set(rows.map((row) => row.callsign)));
    const watched = new Set(await db.watchedAmong("rbn", stations));
    for (const line of lines) {
      if (watched.has(line.row.callsign)) {
        watchedItems.push(line.raw);
      }
    }
  } catch (error) {
    // Records the run's failure in ingest_state, then rethrows it for the handler's 500.
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

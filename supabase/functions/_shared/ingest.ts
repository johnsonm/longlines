// Orchestrator shared by both ingest functions. Pure of HTTP framing; the
// Edge Function index.ts files turn the summary or error into a response.

import { withoutNul } from "./nul.ts";
import type {
  IngestDb,
  IngestSummary,
  NormalizedSpot,
  SkipReason,
  SourceAdapter,
  SpotFailure,
} from "./types.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One ingest run:
 *   1. (optional) compare the upstream epoch with the stored one; stop if unchanged
 *   2. fetch and parse the feed
 *   3. strip U+0000 from every item, then normalize it, collecting unprocessable
 *      ones instead of failing the run
 *   4. insert the batch and enqueue the newly inserted rows (ingest_spots RPC)
 *   5. write the dead letters and the run outcome to ingest_state
 *   6. run the matcher when anything was inserted
 *
 * Throws (after recording the failure) when the run as a whole cannot proceed.
 */
export async function runIngest(
  adapter: SourceAdapter,
  db: IngestDb,
  now: Date = new Date(),
): Promise<IngestSummary> {
  const started = performance.now();
  const summary: IngestSummary = {
    source: adapter.source,
    epoch_unchanged: false,
    fetched: 0,
    inserted: 0,
    skipped: { too_old: 0, test_comment: 0, not_normal: 0 },
    failed: 0,
    matched: null,
    duration_ms: 0,
  };

  try {
    let epoch: string | null = null;
    if (adapter.fetchEpoch) {
      epoch = await adapter.fetchEpoch();
      if (epoch === await db.getLastEpoch(adapter.source)) {
        summary.epoch_unchanged = true;
        await db.recordSuccess(adapter.source, 0, epoch);
        summary.duration_ms = Math.round(performance.now() - started);
        return summary;
      }
    }

    const feed = adapter.parseFeed(await adapter.fetchSpots());
    summary.fetched = feed.length;

    const spots: NormalizedSpot[] = [];
    const failures: SpotFailure[] = [];
    for (const item of feed) {
      const raw = withoutNul(item);
      try {
        const result = await adapter.normalize(raw, now);
        if (result.kind === "spot") {
          spots.push(result.spot);
        } else {
          summary.skipped[result.reason satisfies SkipReason] += 1;
        }
      } catch (error) {
        failures.push({ source: adapter.source, error: errorMessage(error), raw_payload: raw });
      }
    }

    if (spots.length > 0) {
      const inserted = await db.ingestSpots(spots);
      summary.inserted = inserted.length;
    }
    if (failures.length > 0) {
      await db.recordSpotFailures(failures);
      summary.failed = failures.length;
    }

    await db.recordSuccess(adapter.source, summary.inserted, epoch);

    // New spots are queued; run the matcher now rather than waiting for cron.
    // A matcher problem is reported but does not turn a good ingest into a failure.
    if (summary.inserted > 0) {
      try {
        summary.matched = await db.matchPendingSpots();
      } catch (error) {
        summary.match_error = errorMessage(error);
        console.error(`ingest-${adapter.source}: matcher failed: ${summary.match_error}`);
      }
    }

    summary.duration_ms = Math.round(performance.now() - started);
    return summary;
  } catch (error) {
    await db.recordFailure(adapter.source, errorMessage(error));
    throw error;
  }
}

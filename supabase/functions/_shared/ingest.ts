// Orchestrator shared by both ingest functions. Pure of HTTP framing; the
// Edge Function index.ts files turn the summary or error into a response.

import { z } from "zod";
import { type ErrorContext, FunctionCallError, ValidationError } from "./errors.ts";
import { assertStorableSpot } from "./normalize.ts";
import { withoutNul } from "./strip_nul.ts";
import { parseWith } from "./validate.ts";
import type {
  IngestDb,
  IngestSummary,
  NormalizedSpot,
  SkipReason,
  Source,
  SourceAdapter,
  SpotFailure,
} from "./types.ts";
import { logError } from "./sentry.ts";

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * The upstream feed could not be read: its fetch failed, timed out, or answered a non-2xx or a
 * body that is not JSON. The run still fails and is recorded in ingest_state, where /health
 * shows it, but the handler does not report it to Sentry (upstream feed trouble is not ours).
 */
export class UpstreamError extends Error {
  constructor(message: string, context: ErrorContext) {
    super(message, { cause: context.cause });
    this.name = "UpstreamError";
  }
}

/**
 * The error from an upstream fetch when it is the upstream's trouble, else null (a bug):
 * FunctionCallError (a non-2xx), TypeError (fetch's network error), DOMException (its timeout)
 * or SyntaxError (a body that is not JSON).
 */
function fetchFailure(error: unknown): Error | null {
  if (
    error instanceof FunctionCallError || error instanceof TypeError ||
    error instanceof DOMException || error instanceof SyntaxError
  ) {
    return error;
  }
  return null;
}

/** The adapter's feed body; a fetch failure becomes an UpstreamError with the same message. */
async function fetchFeed(adapter: SourceAdapter): Promise<unknown> {
  try {
    return await adapter.fetchSpots();
  } catch (error) {
    const failure = fetchFailure(error);
    if (failure === null) {
      throw error;
    }
    throw new UpstreamError(failure.message, { cause: error });
  }
}

/**
 * An upstream epoch worth comparing and storing. SOTAwatch's (the only source with one) is a
 * UUID; an empty body or a maintenance page answered with 200 must not become `last_epoch`,
 * or every later run would compare equal and skip the spots while reporting success.
 */
export const epochSchema: z.ZodType<string> = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  "not a UUID",
);

/**
 * The adapter's epoch, or null when it has none, its fetch fails or the value is malformed.
 * The epoch only saves a spots fetch, so a failure is logged and the run fetches the spots
 * anyway; recordSuccess with null keeps the stored epoch (`coalesce` in record_ingest_success).
 */
async function upstreamEpoch(adapter: SourceAdapter): Promise<string | null> {
  if (adapter.fetchEpoch === undefined) {
    return null;
  }
  try {
    return parseWith(epochSchema, await adapter.fetchEpoch(), `ingest-${adapter.source}: epoch`);
  } catch (error) {
    // A fetch failure, or ValidationError: a malformed value. Anything else is a bug and fails
    // the run.
    let unusable = fetchFailure(error);
    if (error instanceof ValidationError) {
      unusable = error;
    }
    if (unusable === null) {
      throw error;
    }
    console.error(
      `ingest-${adapter.source}: epoch unusable, fetching spots anyway: ${unusable.message}`,
    );
    return null;
  }
}

/**
 * Records a failed run and rethrows its error. When the recording RPC fails too
 * (the database is usually why both failed), that is only logged: the run's own
 * error is the one the caller and the 500 body should see.
 */
export async function recordFailureAndThrow(
  db: Pick<IngestDb, "recordFailure">,
  source: Source,
  error: unknown,
): Promise<never> {
  try {
    await db.recordFailure(source, errorMessage(error));
  } catch (recordError) {
    if (!(recordError instanceof FunctionCallError)) {
      throw recordError;
    }
    logError(`ingest-${source}: recording the failure failed: ${recordError.message}`, recordError);
  }
  throw error;
}

/**
 * One ingest run:
 *   1. (optional) compare the upstream epoch with the stored one; stop if unchanged.
 *      A failed or malformed epoch is logged and the run goes on without one.
 *   2. fetch and parse the feed
 *   3. strip U+0000 and lone surrogates from every item, then normalize and
 *      bound-check it (assertStorableSpot), collecting unprocessable ones
 *      (ValidationError) instead of failing the run
 *   4. insert the batch and enqueue the newly inserted rows (ingest_spots RPC)
 *   5. write the dead letters and the run outcome to ingest_state
 *   6. run the matcher when anything was inserted
 *
 * Throws (after recording the failure) when the run as a whole cannot proceed.
 */
export async function runIngest(
  adapter: SourceAdapter,
  db: IngestDb,
  now: Date,
): Promise<IngestSummary> {
  const started = performance.now();
  const summary: IngestSummary = {
    source: adapter.source,
    epoch_unchanged: false,
    fetched: 0,
    inserted: 0,
    skipped: { too_old: 0, test_comment: 0, not_normal: 0, not_callsign: 0 },
    failed: 0,
    matched: null,
    duration_ms: 0,
  };

  try {
    const epoch = await upstreamEpoch(adapter);
    if (epoch !== null) {
      if (epoch === await db.getLastEpoch(adapter.source)) {
        summary.epoch_unchanged = true;
        await db.recordSuccess(adapter.source, 0, epoch);
        summary.duration_ms = Math.round(performance.now() - started);
        return summary;
      }
    }

    const feed = adapter.parseFeed(await fetchFeed(adapter));
    summary.fetched = feed.length;

    const spots: NormalizedSpot[] = [];
    const failures: SpotFailure[] = [];
    for (const item of feed) {
      const raw = withoutNul(item);
      try {
        const result = await adapter.normalize(raw, now);
        if (result.kind === "spot") {
          assertStorableSpot(result.spot, now);
          spots.push(result.spot);
        } else {
          summary.skipped[result.reason satisfies SkipReason] += 1;
        }
      } catch (error) {
        // Per spot: an unprocessable spot becomes one ingest_failures row without
        // aborting the run; anything else fails the run.
        if (!(error instanceof ValidationError)) {
          throw error;
        }
        failures.push({ source: adapter.source, error: error.message, raw_payload: raw });
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
    // A matcher problem (the RPC failing or answering a bad result) is reported but
    // does not turn a good ingest into a failure.
    if (summary.inserted > 0) {
      try {
        summary.matched = await db.matchPendingSpots();
      } catch (error) {
        if (!(error instanceof FunctionCallError) && !(error instanceof ValidationError)) {
          throw error;
        }
        summary.match_error = error.message;
        logError(`ingest-${adapter.source}: matcher failed: ${summary.match_error}`, error);
      }
    }

    summary.duration_ms = Math.round(performance.now() - started);
    return summary;
  } catch (error) {
    // Records the run's failure in ingest_state, then rethrows it for the handler's 500.
    return await recordFailureAndThrow(db, adapter.source, error);
  }
}

// One delivery cycle: claim queued deliveries, send them grouped by
// destination, record the outcomes. Run only by the sender process (the
// deliver Edge Function is gone since 20261015001400), whose image loads it with
// sender/deno.json as the import map, so it talks to the database only through
// `DeliveryRpc` and imports no package that map lacks (zod is the only one).
//
// Policy lives in SQL. The claim is rate-aware and newest first, expiry sets
// `dropped_at` before anything is claimed, and a throttle is a column on the
// destination; this loop only sends what it was handed and reports back.

import { z } from "zod";
import { type ErrorContext, ValidationError } from "../errors.ts";
import { type JsonObject, jsonObjectSchema } from "../types.ts";
import { parseWith } from "../validate.ts";
import { backoffSeconds } from "./format.ts";
import { pushBookkeeping, type SendResult } from "./send.ts";
import { type DeliveryDestination, type PendingDelivery, pendingDeliverySchema } from "./types.ts";

export const CLAIM_LIMIT = 200;
export const VISIBILITY_SECONDS = 60;
/** Destinations sent at once. 1 sends them one after another, as the Edge worker always did. */
export const DEFAULT_CONCURRENCY = 4;
/**
 * Waits before the second and third attempt of a bookkeeping RPC that is safe
 * to repeat; well inside VISIBILITY_SECONDS, so the rows are still hidden.
 */
export const BOOKKEEPING_RETRY_MS: readonly number[] = [500, 1_000];
/**
 * The bookkeeping RPCs a retry cannot double: each sets state rather than
 * adding to it (a repeated ack only steps throttle_level down once more, to no
 * lower than 0). mark_deliveries_failed and throttle_destination increment
 * attempts, consecutive_failures and throttle_level, so one whose commit
 * landed but whose answer was lost would count twice; they get one attempt,
 * and their rows reappear after the visibility timeout anyway.
 */
const REPEATABLE_RPCS: ReadonlySet<string> = new Set([
  "mark_deliveries_sent",
  "prune_push_devices",
  "record_push_results",
]);

/**
 * The database as the loop sees it: the sender's RPC allowlist, nothing else.
 * supabase-js and postgres.js each get a ten-line adapter. `error` is the
 * message or null.
 */
export interface DeliveryRpc {
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: string | null }>;
}

export type DeliverySender = (
  destination: DeliveryDestination,
  deliveries: readonly PendingDelivery[],
  now: Date,
) => Promise<SendResult>;

export interface RunDeliveryOptions {
  /** Rows per `claim_deliveries` call. */
  claimLimit?: number;
  /** Seconds a claimed message stays invisible to the next claim. */
  visibilitySeconds?: number;
  /** Destinations in flight at once; sends within a destination stay in order. */
  concurrency?: number;
  /**
   * Called on each step forward: the claim answered, a destination's send
   * finished (sent or not), a bookkeeping RPC succeeded. The sender's watchdog
   * measures liveness from it, so a long but healthy cycle is not taken for a
   * wedged one.
   */
  onProgress?: (step: ProgressStep) => void;
  /** The wait between bookkeeping attempts; tests pass one that returns at once. */
  sleep?: (ms: number) => Promise<void>;
}

/** What moved a cycle forward; see RunDeliveryOptions.onProgress. */
export type ProgressStep = "claim" | "send" | "bookkeeping";

/** What happened to one destination's claimed rows this cycle. Never the destination's secrets. */
export interface DestinationResult {
  id: string;
  type: DeliveryDestination["type"];
  name: string;
  claimed: number;
  sent: number;
  failed: number;
  /** Rows handed back to SQL with `throttle_destination` (a 429 or the Discord cap). */
  throttled: number;
  skipped_paused: number;
  /**
   * Rows after a webhook's failed request, never sent and not counted as an
   * attempt: left alone, they reappear when the claim's visibility timeout
   * lapses (SendResult.attempted).
   */
  unattempted: number;
  error?: string;
}

export interface DeliveryBatchResult {
  claimed: number;
  sent: number;
  failed: number;
  throttled: number;
  skipped_paused: number;
  /** Every destination's unattempted rows, plus claimed rows that did not parse (claimedRows). */
  unattempted: number;
  /** Bookkeeping RPCs that failed and claimed rows that did not parse; the cycle still completes. */
  errors: string[];
  destinations: DestinationResult[];
}

/** `claim_deliveries` itself failed, or answered with something other than rows, so nothing was sent. */
export class ClaimError extends Error {
  override readonly name = "ClaimError";

  constructor(message: string, context: ErrorContext) {
    super(message, { cause: context.cause });
  }
}

/** claim_deliveries' result: rows (each checked by claimedRows), or null when it claimed none. */
const claimResultSchema: z.ZodType<JsonObject[] | null> = z.array(jsonObjectSchema).nullable();

/**
 * Claims up to `claimLimit` deliveries and sends them, one batch per
 * destination, up to `concurrency` destinations at a time. Successful ids are
 * acked with one `mark_deliveries_sent` per cycle; a rate limit throttles the
 * destination in SQL without touching its health; anything else is a failure
 * marked per destination with the usual backoff.
 */
export async function runDeliveryBatch(
  db: DeliveryRpc,
  send: DeliverySender,
  now: Date,
  options: RunDeliveryOptions,
): Promise<DeliveryBatchResult> {
  const result: DeliveryBatchResult = {
    claimed: 0,
    sent: 0,
    failed: 0,
    throttled: 0,
    skipped_paused: 0,
    unattempted: 0,
    errors: [],
    destinations: [],
  };

  let claimLimit = CLAIM_LIMIT;
  if (options.claimLimit !== undefined) {
    claimLimit = options.claimLimit;
  }
  let visibilitySeconds = VISIBILITY_SECONDS;
  if (options.visibilitySeconds !== undefined) {
    visibilitySeconds = options.visibilitySeconds;
  }
  const claimed = await db.rpc("claim_deliveries", {
    p_limit: claimLimit,
    p_vt: visibilitySeconds,
  });
  if (claimed.error !== null) {
    throw new ClaimError(claimed.error, { cause: undefined });
  }
  let progress: (step: ProgressStep) => void = noProgress;
  if (options.onProgress !== undefined) {
    progress = options.onProgress;
  }
  let sleep: (ms: number) => Promise<void> = defaultSleep;
  if (options.sleep !== undefined) {
    sleep = options.sleep;
  }
  function bookkeep(fn: string, args: Record<string, unknown>): Promise<void> {
    return rpcOrLog(db, result, fn, args, progress, sleep);
  }
  progress("claim");
  const rows = claimedRows(claimed.data, result);

  // Rows arrive in claim order (newest first per destination); keep that
  // order within each group so Discord messages and webhook requests go out
  // the way SQL ranked them.
  const groups = new Map<string, DestinationBatch>();
  for (const row of rows) {
    const group = groups.get(row.destination.id);
    if (group === undefined) {
      groups.set(row.destination.id, { destination: row.destination, batch: [row] });
    } else {
      group.batch.push(row);
    }
  }

  async function sendBatch(group: DestinationBatch): Promise<Outcome> {
    const destination = group.destination;
    const batch = group.batch;
    // The claim leaves paused destinations out; this is the belt to its braces.
    // Their messages reappear after the visibility timeout.
    if (destination.health === "paused") {
      return { destination, batch, sent: null };
    }
    let sent: SendResult;
    try {
      sent = await send(destination, batch, now);
    } catch (error) {
      // The per-destination boundary. A send function reports its own
      // failures; a throw is a bug in what runs around the request
      // (formatting, signing). It fails this destination's rows like any other
      // failure (no `attempted`, so the whole batch counts an attempt and a
      // webhook row's retries run out) instead of rejecting the cycle before
      // the ack and re-sending every other destination's delivered rows.
      if (!(error instanceof Error)) {
        throw error;
      }
      sent = { ok: false, sent: 0, error: `send threw: ${error.message}` };
    }
    progress("send");
    return { destination, batch, sent };
  }

  let concurrency = DEFAULT_CONCURRENCY;
  if (options.concurrency !== undefined) {
    concurrency = options.concurrency;
  }
  const outcomes = await mapBounded(
    Array.from(groups.values()),
    Math.max(1, Math.floor(concurrency)),
    sendBatch,
  );

  // Bookkeeping in claim order so a cycle's RPCs are the same whatever the
  // concurrency. The ack goes before any throttle: mark_deliveries_sent clears
  // throttled_until, so the other order would lose a 429 that followed a
  // partial success.
  const done: PendingDelivery[] = [];
  for (const outcome of outcomes) {
    const sent = outcome.sent;
    if (sent === null) {
      continue;
    }
    for (const call of pushBookkeeping(sent)) {
      await bookkeep(call[0], call[1]);
    }
    for (const row of outcome.batch.slice(0, sent.sent)) {
      done.push(row);
    }
  }
  if (done.length > 0) {
    await bookkeep("mark_deliveries_sent", {
      p_delivery_ids: done.map((r) => r.delivery_id),
      p_msg_ids: done.map((r) => r.msg_id),
    });
  }

  for (const outcome of outcomes) {
    const batch = outcome.batch;
    const sent = outcome.sent;
    const destination = outcome.destination;
    const per: DestinationResult = {
      id: destination.id,
      type: destination.type,
      name: destination.name,
      claimed: batch.length,
      sent: 0,
      failed: 0,
      throttled: 0,
      skipped_paused: 0,
      unattempted: 0,
    };
    result.destinations.push(per);
    if (sent === null) {
      per.skipped_paused = batch.length;
      result.skipped_paused += batch.length;
      continue;
    }
    per.sent = Math.min(sent.sent, batch.length);
    result.sent += per.sent;
    const rest = batch.slice(sent.sent);
    if (rest.length === 0) {
      continue;
    }

    if (sent.retryAfterSeconds !== undefined) {
      // Rate limited, not broken: SQL hides the destination and these
      // messages for Retry-After, or for its own backoff when there is none.
      await bookkeep("throttle_destination", {
        p_destination_id: destination.id,
        p_msg_ids: rest.map((r) => r.msg_id),
        p_seconds: sent.retryAfterSeconds,
      });
      per.throttled = rest.length;
      result.throttled += rest.length;
    } else {
      // Only the rows that were in a request count an attempt (a webhook's
      // `attempted`); the rest are left for the claim's visibility timeout.
      let reported = batch.length;
      if (sent.attempted !== undefined) {
        reported = sent.attempted;
      }
      const attempted = Math.min(Math.max(reported, sent.sent), batch.length);
      const failedRows = batch.slice(sent.sent, attempted);
      const skipped = batch.length - attempted;
      per.unattempted = skipped;
      result.unattempted += skipped;
      let error = "unknown error";
      if (sent.error !== undefined) {
        error = sent.error;
      }
      per.error = error;
      if (failedRows.length > 0) {
        // Math.max over every row's attempts, folded one row at a time.
        let maxAttempts = -Infinity;
        for (const row of failedRows) {
          maxAttempts = Math.max(maxAttempts, row.attempts);
        }
        const attempt = maxAttempts + 1;
        // Discord and push wait backoffSeconds; SQL's retry policy wins for a webhook.
        await bookkeep("mark_deliveries_failed", {
          p_delivery_ids: failedRows.map((r) => r.delivery_id),
          p_msg_ids: failedRows.map((r) => r.msg_id),
          p_error: error,
          p_delay_seconds: backoffSeconds(attempt),
        });
        per.failed = failedRows.length;
        result.failed += failedRows.length;
      }
      console.error(`deliver: ${destination.type} "${destination.name}" failed: ${error}`);
    }
  }

  return result;
}

/** One destination's claimed rows, in claim order. */
interface DestinationBatch {
  destination: DeliveryDestination;
  batch: PendingDelivery[];
}

interface Outcome {
  destination: DeliveryDestination;
  batch: PendingDelivery[];
  /** Null when the destination was paused and nothing was sent. */
  sent: SendResult | null;
}

/**
 * The claim's rows that parse, in claim order; sets `result.claimed` to every row claimed.
 * Throws ClaimError when the result is not rows at all. A row that does not parse is never
 * sent: it counts as unattempted, its issues go in `result.errors`, and its message reappears
 * after the visibility timeout until the claim's expiry sweep drops it, so one malformed row
 * cannot hold up every other destination's deliveries.
 */
function claimedRows(data: unknown, result: DeliveryBatchResult): PendingDelivery[] {
  let raw: JsonObject[] | null;
  try {
    raw = parseWith(claimResultSchema, data, "runDeliveryBatch: claim_deliveries result");
  } catch (error) {
    // Not rows: as good as a failed claim, so the sender backs off rather than exiting.
    if (error instanceof ValidationError) {
      throw new ClaimError(error.message, { cause: error });
    }
    throw error;
  }
  const rows: PendingDelivery[] = [];
  if (raw === null) {
    return rows;
  }
  result.claimed = raw.length;
  for (const entry of raw.entries()) {
    const where = `runDeliveryBatch: claim_deliveries row ${String(entry[0])}`;
    try {
      rows.push(parseWith(pendingDeliverySchema, entry[1], where));
    } catch (error) {
      // Per-row isolation inside the per-destination boundary: only a row of the wrong shape.
      if (!(error instanceof ValidationError)) {
        throw error;
      }
      result.unattempted++;
      result.errors.push(error.message);
      console.error(`deliver: ${error.message}; left for the visibility timeout`);
    }
  }
  return rows;
}

/** The default onProgress: nobody is watching. */
function noProgress(): void {
  // Nothing to report to.
}

/** The default wait between bookkeeping attempts. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** `Promise.all` with at most `limit` calls of `fn` in flight; results keep the input order. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  // One iterator shared by every worker: each takes the next item when it is free.
  const pending = items.entries();
  async function worker(): Promise<void> {
    for (const entry of pending) {
      results[entry[0]] = await fn(entry[1]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * One bookkeeping RPC, repeated after BOOKKEEPING_RETRY_MS when it fails and
 * is in REPEATABLE_RPCS: a lost mark_deliveries_sent would send the whole
 * batch again after the visibility timeout. The last error is recorded, never
 * thrown, so the cycle still completes.
 */
async function rpcOrLog(
  db: DeliveryRpc,
  result: DeliveryBatchResult,
  fn: string,
  args: Record<string, unknown>,
  progress: (step: ProgressStep) => void,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  let waits: readonly number[];
  if (REPEATABLE_RPCS.has(fn)) {
    waits = BOOKKEEPING_RETRY_MS;
  } else {
    waits = [];
  }
  for (let attempt = 0;; attempt++) {
    const answer = await db.rpc(fn, args);
    const error = answer.error;
    if (error === null) {
      progress("bookkeeping");
      return;
    }
    const wait = waits[attempt];
    if (wait === undefined) {
      result.errors.push(`${fn}: ${error}`);
      console.error(`deliver: ${fn} failed: ${error}`);
      return;
    }
    console.error(`deliver: ${fn} failed: ${error}; retrying in ${String(wait)} ms`);
    await sleep(wait);
  }
}

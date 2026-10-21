// One delivery cycle: claim queued deliveries, send them grouped by
// destination, record the outcomes. Run only by the sender process (the
// deliver Edge Function is gone since 20261015001400), which bundles it without
// an import map, so it talks to the database only through `DeliveryRpc` and
// imports nothing that needs one (it must load under `deno run --no-config`).
//
// Policy lives in SQL. The claim is rate-aware and newest first, expiry sets
// `dropped_at` before anything is claimed, and a throttle is a column on the
// destination; this loop only sends what it was handed and reports back.

import { backoffSeconds } from "./format.ts";
import { pushBookkeeping, type SendResult } from "./send.ts";
import type { DeliveryDestination, PendingDelivery } from "./types.ts";

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
  unattempted: number;
  /** Bookkeeping RPCs that failed; the cycle still completes. */
  errors: string[];
  destinations: DestinationResult[];
}

/** `claim_deliveries` itself failed, so nothing was sent. */
export class ClaimError extends Error {
  override readonly name = "ClaimError";
}

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
  options: RunDeliveryOptions = {},
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

  const claimed = await db.rpc("claim_deliveries", {
    p_limit: options.claimLimit ?? CLAIM_LIMIT,
    p_vt: options.visibilitySeconds ?? VISIBILITY_SECONDS,
  });
  if (claimed.error !== null) throw new ClaimError(claimed.error);
  const progress = options.onProgress ?? (() => {});
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const bookkeep = (fn: string, args: Record<string, unknown>) =>
    rpcOrLog(db, result, fn, args, progress, sleep);
  progress("claim");
  const rows = (claimed.data ?? []) as PendingDelivery[];
  result.claimed = rows.length;

  // Rows arrive in claim order (newest first per destination); keep that
  // order within each group so Discord messages and webhook requests go out
  // the way SQL ranked them.
  const groups = new Map<string, PendingDelivery[]>();
  for (const row of rows) {
    const list = groups.get(row.destination.id) ?? [];
    list.push(row);
    groups.set(row.destination.id, list);
  }

  const outcomes = await mapBounded(
    [...groups.values()],
    Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY)),
    async (batch): Promise<Outcome> => {
      const destination = batch[0]!.destination;
      // The claim leaves paused destinations out; this is the belt to its braces.
      // Their messages reappear after the visibility timeout.
      if (destination.health === "paused") return { batch, sent: null };
      let sent: SendResult;
      try {
        sent = await send(destination, batch, now);
      } catch (error) {
        // A send function reports its own failures; a throw is a bug in what
        // runs around the request (formatting, signing). It fails this
        // destination's rows like any other failure (no `attempted`, so the whole
        // batch counts an attempt and a webhook row's retries run out) instead of
        // rejecting the cycle before the ack and re-sending every other
        // destination's delivered rows.
        const message = error instanceof Error ? error.message : String(error);
        sent = { ok: false, sent: 0, error: `send threw: ${message}` };
      }
      progress("send");
      return { batch, sent };
    },
  );

  // Bookkeeping in claim order so a cycle's RPCs are the same whatever the
  // concurrency. The ack goes before any throttle: mark_deliveries_sent clears
  // throttled_until, so the other order would lose a 429 that followed a
  // partial success.
  const done: PendingDelivery[] = [];
  for (const { batch, sent } of outcomes) {
    if (sent === null) continue;
    for (const [fn, args] of pushBookkeeping(sent)) await bookkeep(fn, args);
    done.push(...batch.slice(0, sent.sent));
  }
  if (done.length > 0) {
    await bookkeep("mark_deliveries_sent", {
      p_delivery_ids: done.map((r) => r.delivery_id),
      p_msg_ids: done.map((r) => r.msg_id),
    });
  }

  for (const { batch, sent } of outcomes) {
    const destination = batch[0]!.destination;
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
    if (rest.length === 0) continue;

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
      const attempted = Math.min(Math.max(sent.attempted ?? batch.length, sent.sent), batch.length);
      const failedRows = batch.slice(sent.sent, attempted);
      const skipped = batch.length - attempted;
      per.unattempted = skipped;
      result.unattempted += skipped;
      const error = sent.error ?? "unknown error";
      per.error = error;
      if (failedRows.length > 0) {
        const attempt = Math.max(...failedRows.map((r) => r.attempts)) + 1;
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

interface Outcome {
  batch: PendingDelivery[];
  /** Null when the destination was paused and nothing was sent. */
  sent: SendResult | null;
}

/** `Promise.all` with at most `limit` calls of `fn` in flight; results keep the input order. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
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
  const waits = REPEATABLE_RPCS.has(fn) ? BOOKKEEPING_RETRY_MS : [];
  for (let attempt = 0;; attempt++) {
    const { error } = await db.rpc(fn, args);
    if (error === null) return progress("bookkeeping");
    const wait = waits[attempt];
    if (wait === undefined) {
      result.errors.push(`${fn}: ${error}`);
      console.error(`deliver: ${fn} failed: ${error}`);
      return;
    }
    console.error(`deliver: ${fn} failed: ${error}; retrying in ${wait} ms`);
    await sleep(wait);
  }
}

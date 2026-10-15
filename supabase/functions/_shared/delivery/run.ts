// One delivery cycle: claim queued deliveries, send them grouped by
// destination, record the outcomes. Shared by the deliver Edge Function and
// the sender process, so it talks to the database only through `DeliveryRpc`
// and imports nothing that needs an import map (it must load under
// `deno run --no-config`).
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
}

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
  error?: string;
}

export interface DeliveryBatchResult {
  claimed: number;
  sent: number;
  failed: number;
  throttled: number;
  skipped_paused: number;
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
    errors: [],
    destinations: [],
  };

  const claimed = await db.rpc("claim_deliveries", {
    p_limit: options.claimLimit ?? CLAIM_LIMIT,
    p_vt: options.visibilitySeconds ?? VISIBILITY_SECONDS,
  });
  if (claimed.error !== null) throw new ClaimError(claimed.error);
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
      return { batch, sent: await send(destination, batch, now) };
    },
  );

  // Bookkeeping in claim order so a cycle's RPCs are the same whatever the
  // concurrency. The ack goes before any throttle: mark_deliveries_sent clears
  // throttled_until, so the other order would lose a 429 that followed a
  // partial success.
  const done: PendingDelivery[] = [];
  for (const { batch, sent } of outcomes) {
    if (sent === null) continue;
    for (const [fn, args] of pushBookkeeping(sent)) await rpcOrLog(db, result, fn, args);
    done.push(...batch.slice(0, sent.sent));
  }
  if (done.length > 0) {
    await rpcOrLog(db, result, "mark_deliveries_sent", {
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
      await rpcOrLog(db, result, "throttle_destination", {
        p_destination_id: destination.id,
        p_msg_ids: rest.map((r) => r.msg_id),
        p_seconds: sent.retryAfterSeconds,
      });
      per.throttled = rest.length;
      result.throttled += rest.length;
    } else {
      const attempt = Math.max(...rest.map((r) => r.attempts)) + 1;
      const error = sent.error ?? "unknown error";
      await rpcOrLog(db, result, "mark_deliveries_failed", {
        p_delivery_ids: rest.map((r) => r.delivery_id),
        p_msg_ids: rest.map((r) => r.msg_id),
        p_error: error,
        p_delay_seconds: backoffSeconds(attempt),
      });
      per.failed = rest.length;
      per.error = error;
      result.failed += rest.length;
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

async function rpcOrLog(
  db: DeliveryRpc,
  result: DeliveryBatchResult,
  fn: string,
  args: Record<string, unknown>,
): Promise<void> {
  const { error } = await db.rpc(fn, args);
  if (error !== null) {
    result.errors.push(`${fn}: ${error}`);
    console.error(`deliver: ${fn} failed: ${error}`);
  }
}

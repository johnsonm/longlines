// Delivery worker. Claims queued deliveries, sends them grouped by
// destination, and records the outcome. Invoked by cron every minute and by
// the matcher as soon as it creates deliveries.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isServiceRole } from "../auth.ts";
import { backoffSeconds } from "../delivery/format.ts";
import { PUSH_TTL_SECONDS, pushBookkeeping, type SendResult } from "../delivery/send.ts";
import type { DeliveryDestination, PendingDelivery } from "../delivery/types.ts";

export const CLAIM_LIMIT = 200;
export const VISIBILITY_SECONDS = 60;
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A push alert is worth sending only while the push service would still deliver it. */
export const PUSH_MAX_AGE_MS = PUSH_TTL_SECONDS * 1000;

export interface DeliverSummary {
  claimed: number;
  sent: number;
  failed: number;
  delayed: number;
  dropped: number;
  skipped_paused: number;
  errors: string[];
}

export interface DeliverDeps {
  serviceRoleKey: string | undefined;
  db: () => SupabaseClient;
  send: (
    destination: DeliveryDestination,
    deliveries: readonly PendingDelivery[],
  ) => Promise<SendResult>;
}

export async function handleDeliver(
  req: Request,
  deps: DeliverDeps,
  now: Date = new Date(),
): Promise<Response> {
  // Only the service role (cron, the matcher) may run the worker.
  if (!isServiceRole(req, deps.serviceRoleKey)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = deps.db();
  const summary: DeliverSummary = {
    claimed: 0,
    sent: 0,
    failed: 0,
    delayed: 0,
    dropped: 0,
    skipped_paused: 0,
    errors: [],
  };

  const claimed = await db.rpc("claim_deliveries", {
    p_limit: CLAIM_LIMIT,
    p_vt: VISIBILITY_SECONDS,
  });
  if (claimed.error) {
    console.error(`deliver: claim failed: ${claimed.error.message}`);
    return Response.json({ error: claimed.error.message }, { status: 500 });
  }
  const rows = (claimed.data ?? []) as PendingDelivery[];
  summary.claimed = rows.length;

  // Too old to keep retrying.
  const maxAge = (r: PendingDelivery) =>
    r.destination.type === "push" ? PUSH_MAX_AGE_MS : MAX_AGE_MS;
  const expired = rows.filter((r) => new Date(r.created_at).getTime() < now.getTime() - maxAge(r));
  if (expired.length > 0) {
    await rpcOrLog(db, summary, "mark_deliveries_dropped", {
      p_delivery_ids: expired.map((r) => r.delivery_id),
      p_msg_ids: expired.map((r) => r.msg_id),
    });
    summary.dropped = expired.length;
  }

  const groups = new Map<string, PendingDelivery[]>();
  for (const row of rows) {
    if (expired.includes(row)) continue;
    const list = groups.get(row.destination.id) ?? [];
    list.push(row);
    groups.set(row.destination.id, list);
  }

  for (const batch of groups.values()) {
    const destination = batch[0]!.destination;
    if (destination.health === "paused") {
      summary.skipped_paused += batch.length; // messages reappear after the visibility timeout
      continue;
    }

    const result = await deps.send(destination, batch);
    for (const [fn, args] of pushBookkeeping(result)) await rpcOrLog(db, summary, fn, args);

    const done = batch.slice(0, result.sent);
    const rest = batch.slice(result.sent);
    if (done.length > 0) {
      await rpcOrLog(db, summary, "mark_deliveries_sent", {
        p_delivery_ids: done.map((r) => r.delivery_id),
        p_msg_ids: done.map((r) => r.msg_id),
      });
      summary.sent += done.length;
    }
    if (rest.length === 0) continue;

    if (result.retryAfterSeconds !== undefined) {
      // Rate limited, not broken: wait without counting a failure.
      await rpcOrLog(db, summary, "delay_deliveries", {
        p_msg_ids: rest.map((r) => r.msg_id),
        p_delay_seconds: result.retryAfterSeconds,
      });
      summary.delayed += rest.length;
    } else {
      const attempt = Math.max(...rest.map((r) => r.attempts)) + 1;
      await rpcOrLog(db, summary, "mark_deliveries_failed", {
        p_delivery_ids: rest.map((r) => r.delivery_id),
        p_msg_ids: rest.map((r) => r.msg_id),
        p_error: result.error ?? "unknown error",
        p_delay_seconds: backoffSeconds(attempt),
      });
      summary.failed += rest.length;
      console.error(`deliver: ${destination.type} "${destination.name}" failed: ${result.error}`);
    }
  }

  console.log(JSON.stringify(summary));
  return Response.json(summary);
}

async function rpcOrLog(
  db: SupabaseClient,
  summary: DeliverSummary,
  fn: string,
  args: Record<string, unknown>,
): Promise<void> {
  const { error } = await db.rpc(fn, args);
  if (error) {
    summary.errors.push(`${fn}: ${error.message}`);
    console.error(`deliver: ${fn} failed: ${error.message}`);
  }
}

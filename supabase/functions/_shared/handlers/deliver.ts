// Delivery worker: the deliver Edge Function. Invoked by cron every minute and
// by the matcher as soon as it creates deliveries, until the sender process
// takes over. Auth, a supabase-js adapter and one `runDeliveryBatch`; the
// loop itself is `_shared/delivery/run.ts`.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isServiceRole } from "../auth.ts";
import {
  ClaimError,
  type DeliveryBatchResult,
  type DeliveryRpc,
  type DeliverySender,
  runDeliveryBatch,
} from "../delivery/run.ts";

export type DeliverSummary = DeliveryBatchResult;

export interface DeliverDeps {
  serviceRoleKey: string | undefined;
  db: () => SupabaseClient;
  send: DeliverySender;
}

/** The loop's database surface over supabase-js: the same RPCs, the error flattened to its message. */
export function supabaseDeliveryRpc(client: SupabaseClient): DeliveryRpc {
  return {
    async rpc(fn, args) {
      const { data, error } = await client.rpc(fn, args);
      return { data, error: error?.message ?? null };
    },
  };
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

  let summary: DeliverSummary;
  try {
    summary = await runDeliveryBatch(supabaseDeliveryRpc(deps.db()), deps.send, now);
  } catch (error) {
    if (!(error instanceof ClaimError)) throw error;
    console.error(`deliver: claim failed: ${error.message}`);
    return Response.json({ error: error.message }, { status: 500 });
  }

  console.log(JSON.stringify(summary));
  return Response.json(summary);
}

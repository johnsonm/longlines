import { createServiceClient } from "../_shared/db.ts";
import { type SendResult, sendToDestination } from "../_shared/delivery/send.ts";
import type { DeliveryDestination, PendingDelivery } from "../_shared/delivery/types.ts";
import { vapidKeysFromEnv } from "../_shared/delivery/webpush.ts";
import { type ApiDeps, handleApi } from "../_shared/handlers/api.ts";

// LONGLINES_ALLOW_INSECURE_DESTINATIONS is for local development only, as in
// send-test. Never set on the hosted project.
const allowInsecure = Deno.env.get("LONGLINES_ALLOW_INSECURE_DESTINATIONS") === "1";
// LONGLINES_VAPID_*: without them push sends fail and Discord and webhooks are unaffected.
const vapid = vapidKeysFromEnv((name) => Deno.env.get(name));

function send(
  destination: DeliveryDestination,
  deliveries: readonly PendingDelivery[],
): Promise<SendResult> {
  return sendToDestination(destination, deliveries, { allowInsecure, vapid });
}

const deps: ApiDeps = { db: createServiceClient, send };

async function handler(req: Request): Promise<Response> {
  return await handleApi(req, deps, new Date());
}

Deno.serve(handler);

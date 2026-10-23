import { createServiceClient } from "../_shared/db.ts";
import { type SendResult, sendToDestination } from "../_shared/delivery/send.ts";
import type { DeliveryDestination, PendingDelivery } from "../_shared/delivery/types.ts";
import { vapidKeysFromEnv } from "../_shared/delivery/webpush.ts";
import { handleSendTest, type SendTestDeps } from "../_shared/handlers/test_delivery.ts";

// LONGLINES_ALLOW_INSECURE_DESTINATIONS is for local development only: it lets
// a plain-http receiver on the Docker host stand in for a real destination.
// Never set on the hosted project.
const allowInsecure = Deno.env.get("LONGLINES_ALLOW_INSECURE_DESTINATIONS") === "1";
// LONGLINES_VAPID_*: without them push sends fail and Discord and webhooks are unaffected.
const vapid = vapidKeysFromEnv((name) => Deno.env.get(name));

function send(
  destination: DeliveryDestination,
  deliveries: readonly PendingDelivery[],
): Promise<SendResult> {
  return sendToDestination(destination, deliveries, { allowInsecure, vapid });
}

const deps: SendTestDeps = { admin: createServiceClient, send };

async function handler(req: Request): Promise<Response> {
  return await handleSendTest(req, deps);
}

Deno.serve(handler);

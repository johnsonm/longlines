import { createServiceClient } from "../_shared/db.ts";
import { sendToDestination } from "../_shared/delivery/send.ts";
import { vapidKeysFromEnv } from "../_shared/delivery/webpush.ts";
import { handleDeliver } from "../_shared/handlers/deliver.ts";

// LONGLINES_ALLOW_INSECURE_DESTINATIONS is for local development only: it lets
// a plain-http receiver on the Docker host stand in for a real destination.
// Never set on the hosted project.
const allowInsecure = Deno.env.get("LONGLINES_ALLOW_INSECURE_DESTINATIONS") === "1";
// LONGLINES_VAPID_*: without them push sends fail and Discord and webhooks are unaffected.
const vapid = vapidKeysFromEnv((name) => Deno.env.get(name));

Deno.serve((req) =>
  handleDeliver(req, {
    serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    db: createServiceClient,
    send: (destination, deliveries) =>
      sendToDestination(destination, deliveries, { allowInsecure, vapid }),
  })
);

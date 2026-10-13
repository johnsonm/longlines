import { createServiceClient } from "../_shared/db.ts";
import { sendToDestination } from "../_shared/delivery/send.ts";
import { handleApi } from "../_shared/handlers/api.ts";

// LONGLINES_ALLOW_INSECURE_DESTINATIONS is for local development only, as in
// send-test. Never set on the hosted project.
const allowInsecure = Deno.env.get("LONGLINES_ALLOW_INSECURE_DESTINATIONS") === "1";

Deno.serve((req) =>
  handleApi(req, {
    db: createServiceClient,
    send: (destination, deliveries) =>
      sendToDestination(destination, deliveries, { allowInsecure }),
  })
);

import { createServiceClient } from "../_shared/db.ts";
import { handleRelayStatus } from "../_shared/handlers/relay_status.ts";

async function handler(req: Request): Promise<Response> {
  return await handleRelayStatus(req, {
    secret: Deno.env.get("LONGLINES_RELAY_SECRET"),
    db: createServiceClient,
  });
}

Deno.serve(handler);

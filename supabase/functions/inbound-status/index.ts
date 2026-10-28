import { createServiceClient } from "../_shared/db.ts";
import { handleInboundStatus } from "../_shared/handlers/inbound_status.ts";

async function handler(req: Request): Promise<Response> {
  return await handleInboundStatus(req, {
    secret: Deno.env.get("LONGLINES_INBOUND_SECRET"),
    db: createServiceClient,
  });
}

Deno.serve(handler);

import { createServiceClient } from "../_shared/db.ts";
import { handleHealth, type HealthDeps } from "../_shared/handlers/health.ts";

const deps: HealthDeps = { db: createServiceClient };

async function handler(req: Request): Promise<Response> {
  return await handleHealth(req, deps);
}

Deno.serve(handler);

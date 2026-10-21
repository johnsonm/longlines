import { createServiceClient } from "../_shared/db.ts";
import { handleHealth } from "../_shared/handlers/health.ts";

Deno.serve((req) => handleHealth(req, { db: createServiceClient }));

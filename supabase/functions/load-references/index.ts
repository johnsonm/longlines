import { createReferenceDb, createServiceClient } from "../_shared/db.ts";
import { handleLoadReferences } from "../_shared/handlers/load_references.ts";
import type { ReferenceDb } from "../_shared/types.ts";

function referenceDb(): ReferenceDb {
  return createReferenceDb(createServiceClient());
}

async function handler(req: Request): Promise<Response> {
  return await handleLoadReferences(req, {
    secret: Deno.env.get("LONGLINES_RELAY_SECRET"),
    db: referenceDb,
  });
}

Deno.serve(handler);

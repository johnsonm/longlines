import { fetchCty } from "../_shared/cty.ts";
import { createServiceClient } from "../_shared/db.ts";
import { handleImportCty } from "../_shared/handlers/import_cty.ts";

// cty.dat from its default URL.
function downloadCty(): Promise<string> {
  return fetchCty();
}

async function handler(req: Request): Promise<Response> {
  return await handleImportCty(req, {
    serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    db: createServiceClient,
    fetchCty: downloadCty,
  });
}

Deno.serve(handler);

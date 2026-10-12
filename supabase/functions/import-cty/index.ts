import { fetchCty } from "../_shared/cty.ts";
import { createServiceClient } from "../_shared/db.ts";
import { handleImportCty } from "../_shared/handlers/import_cty.ts";

Deno.serve((req) =>
  handleImportCty(req, {
    serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    db: createServiceClient,
    fetchCty: () => fetchCty(),
  })
);

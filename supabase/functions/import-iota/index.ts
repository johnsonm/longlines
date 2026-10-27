import { createServiceClient } from "../_shared/db.ts";
import { handleImportIota } from "../_shared/handlers/import_iota.ts";
import { fetchIotaGroups, IOTA_GROUPS_URL } from "../_shared/iota.ts";

// groups.json from iota-world.org.
function downloadGroups(): Promise<unknown> {
  return fetchIotaGroups(IOTA_GROUPS_URL);
}

async function handler(req: Request): Promise<Response> {
  return await handleImportIota(req, {
    serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    db: createServiceClient,
    fetchGroups: downloadGroups,
  });
}

Deno.serve(handler);

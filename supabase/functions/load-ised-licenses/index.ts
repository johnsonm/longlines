import { createIsedLicenseDb, createServiceClient } from "../_shared/db.ts";
import { handleLoadIsedLicenses } from "../_shared/handlers/load_ised_licenses.ts";
import type { IsedLicenseDb } from "../_shared/types.ts";

function isedLicenseDb(): IsedLicenseDb {
  return createIsedLicenseDb(createServiceClient());
}

async function handler(req: Request): Promise<Response> {
  return await handleLoadIsedLicenses(req, {
    secret: Deno.env.get("LONGLINES_INBOUND_SECRET"),
    db: isedLicenseDb,
  });
}

Deno.serve(handler);

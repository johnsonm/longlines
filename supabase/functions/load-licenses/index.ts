import { createLicenseDb, createServiceClient } from "../_shared/db.ts";
import { handleLoadLicenses } from "../_shared/handlers/load_licenses.ts";
import type { LicenseDb } from "../_shared/types.ts";

function licenseDb(): LicenseDb {
  return createLicenseDb(createServiceClient());
}

async function handler(req: Request): Promise<Response> {
  return await handleLoadLicenses(req, {
    secret: Deno.env.get("LONGLINES_INBOUND_SECRET"),
    db: licenseDb,
  });
}

Deno.serve(handler);

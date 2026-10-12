import { createLicenseDb, createServiceClient } from "../_shared/db.ts";
import { handleLoadLicenses } from "../_shared/handlers/load_licenses.ts";

Deno.serve((req) =>
  handleLoadLicenses(req, {
    secret: Deno.env.get("LONGLINES_RELAY_SECRET"),
    db: () => createLicenseDb(createServiceClient()),
  })
);

// The country-file import, called weekly by pg_cron with the service-role key
// (Vault). Downloads cty.dat, parses it and swaps it into cty_entities and
// cty_prefixes through load_cty. Any failure leaves the loaded set as it was
// and answers 500, so it shows up in net._http_response.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isServiceRole } from "../auth.ts";
import { parseCty } from "../cty.ts";
import { loadCty } from "../db.ts";
import { performanceClock, timed } from "../timing.ts";

// cty.dat lists about 340 DXCC entities. Fewer means a truncated or wrong file;
// loading it would leave spotters without a country.
const MIN_ENTITIES = 300;

export interface ImportCtyDeps {
  serviceRoleKey: string | undefined;
  db: () => SupabaseClient;
  fetchCty: () => Promise<string>;
}

/** The import, stamped with its run time for the Health page (timing.ts). */
export function handleImportCty(req: Request, deps: ImportCtyDeps): Promise<Response> {
  return timed(() => importCty(req, deps), performanceClock);
}

async function importCty(req: Request, deps: ImportCtyDeps): Promise<Response> {
  // Only the service role (cron, or an operator) may replace the country tables.
  if (!await isServiceRole(req, deps.serviceRoleKey)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const data = parseCty(await deps.fetchCty());
    if (data.entities.length < MIN_ENTITIES) {
      throw new Error(
        `cty.dat has ${String(data.entities.length)} entities, expected at least ${
          String(MIN_ENTITIES)
        }`,
      );
    }
    await loadCty(deps.db(), data);
    const summary = {
      version: data.version,
      entities: data.entities.length,
      prefixes: data.prefixes.length,
    };
    console.log(JSON.stringify(summary));
    return Response.json(summary);
  } catch (err) {
    let message: string;
    if (err instanceof Error) {
      message = err.message;
    } else {
      message = String(err);
    }
    console.error(`import-cty: ${message}`);
    return Response.json({ error: message }, { status: 500 });
  }
}

// The IOTA list import, called monthly by pg_cron with the service-role key
// (Vault). Downloads iota-world.org's groups.json, parses it and replaces
// iota_groups through load_iota_groups, which ingest_spots reads to name the
// island a DX Cluster spot gives. Any failure leaves the list as it was and
// answers 500, so it shows up on the Health page.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isServiceRole } from "../auth.ts";
import { loadIotaGroups } from "../db.ts";
import { ValidationError } from "../errors.ts";
import { MIN_IOTA_GROUPS, parseIotaGroups } from "../iota.ts";
import { performanceClock, timed } from "../timing.ts";

export interface ImportIotaDeps {
  serviceRoleKey: string | undefined;
  db: () => SupabaseClient;
  fetchGroups: () => Promise<unknown>;
}

/** The import, stamped with its run time for the Health page (timing.ts). */
export function handleImportIota(req: Request, deps: ImportIotaDeps): Promise<Response> {
  return timed(() => importIota(req, deps), performanceClock);
}

async function importIota(req: Request, deps: ImportIotaDeps): Promise<Response> {
  // Only the service role (cron, or an operator) may replace the list.
  if (!await isServiceRole(req, deps.serviceRoleKey)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  // The boundary: a failed download (FunctionCallError), a file that does not parse or is too short
  // (ValidationError), a failed load_iota_groups, or anything else answers 500 with its message.
  try {
    const groups = parseIotaGroups(await deps.fetchGroups());
    if (groups.length < MIN_IOTA_GROUPS) {
      throw new ValidationError(
        `groups.json has ${String(groups.length)} groups, expected at least ${
          String(MIN_IOTA_GROUPS)
        }`,
        { cause: undefined, where: "importIota: groups.json" },
      );
    }
    const stored = await loadIotaGroups(deps.db(), groups);
    const summary = { groups: stored };
    console.log(JSON.stringify(summary));
    return Response.json(summary);
  } catch (err) {
    let message: string;
    if (err instanceof Error) {
      message = err.message;
    } else {
      message = String(err);
    }
    console.error(`import-iota: ${message}`);
    return Response.json({ error: message }, { status: 500 });
  }
}

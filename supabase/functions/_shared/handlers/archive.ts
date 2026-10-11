// The archive worker, called by pg_cron every 10 minutes with the service-role
// key (Vault). Runs runArchive over the slice RPCs and the archive bucket and
// returns its summary; 500 when any slice failed, so the failure shows up in
// net._http_response.

import type { SupabaseClient } from "@supabase/supabase-js";
import { runArchive } from "../archive.ts";
import { isServiceRole } from "../auth.ts";
import { createArchiveDb, createArchiveStore } from "../db.ts";

export interface ArchiveDeps {
  serviceRoleKey: string | undefined;
  db: () => SupabaseClient;
}

export async function handleArchive(
  req: Request,
  deps: ArchiveDeps,
  now: Date = new Date(),
): Promise<Response> {
  // Only the service role (cron) may run the archive.
  if (!isServiceRole(req, deps.serviceRoleKey)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  const client = deps.db();
  const summary = await runArchive(createArchiveDb(client), createArchiveStore(client), now);
  console.log(JSON.stringify(summary));
  return Response.json(summary, { status: summary.errors.length > 0 ? 500 : 200 });
}

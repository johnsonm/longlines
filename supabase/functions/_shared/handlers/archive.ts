// The archive worker, called by pg_cron with the service-role key (Vault):
// every 10 minutes for the default sources, and every 5 minutes with
// {"sources": ["aprs"]} for APRS-IS. Runs runArchive over the slice RPCs and
// the archive bucket (B2) and returns its summary; 500 when any slice failed or
// the bucket is not configured, so the failure shows up in net._http_response.

import type { SupabaseClient } from "@supabase/supabase-js";
import { archiveSources, runArchive } from "../archive.ts";
import { isServiceRole } from "../auth.ts";
import { createArchiveDb } from "../db.ts";
import { timed } from "../timing.ts";
import type { ArchiveStore, Source } from "../types.ts";

export interface ArchiveDeps {
  serviceRoleKey: string | undefined;
  db: () => SupabaseClient;
  /** Throws when the LONGLINES_ARCHIVE_S3_* secrets are missing or bad. */
  store: () => ArchiveStore;
}

/** The archive run, stamped with its run time for the Health page (timing.ts). */
export function handleArchive(
  req: Request,
  deps: ArchiveDeps,
  now: Date = new Date(),
): Promise<Response> {
  return timed(() => archive(req, deps, now));
}

async function archive(req: Request, deps: ArchiveDeps, now: Date): Promise<Response> {
  // Only the service role (cron) may run the archive.
  if (!await isServiceRole(req, deps.serviceRoleKey)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  let sources: readonly Source[];
  try {
    const text = await req.text();
    let body: unknown = undefined;
    if (text.trim() !== "") {
      body = JSON.parse(text);
    }
    sources = archiveSources(body);
  } catch (error) {
    const message = errorMessage(error);
    return Response.json({ error: `Bad request: ${message}` }, { status: 400 });
  }
  let store: ArchiveStore;
  try {
    store = deps.store();
  } catch (error) {
    // Nothing is lost: every slice stays pending until a run can upload it.
    const message = errorMessage(error);
    console.error(message);
    return Response.json({ error: message }, { status: 500 });
  }
  const summary = await runArchive(createArchiveDb(deps.db()), store, now, sources);
  console.log(JSON.stringify(summary));
  let status = 200;
  if (summary.errors.length > 0) {
    status = 500;
  }
  return Response.json(summary, { status });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

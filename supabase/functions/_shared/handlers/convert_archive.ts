// The one-off NDJSON-to-Parquet conversion (issue #174, archive_convert.ts),
// invoked by hand with the service-role key; no cron job calls it. Answers the
// run's summary, 500 when any slice failed, the listing failed or the bucket is
// not configured. Remove it with the function once nothing is left to convert.

import type { SupabaseClient } from "@supabase/supabase-js";
import { type ConvertRequest, convertRequest, runConvert } from "../archive_convert.ts";
import { isServiceRole } from "../auth.ts";
import { createConvertDb } from "../db.ts";
import { ValidationError } from "../errors.ts";
import { performanceClock, timed } from "../timing.ts";
import type { ArchiveObjectStore } from "../types.ts";

export interface ConvertArchiveDeps {
  serviceRoleKey: string | undefined;
  db: () => SupabaseClient;
  /** Throws when the LONGLINES_ARCHIVE_S3_* secrets are missing or bad. */
  store: () => ArchiveObjectStore;
}

/** The conversion run, stamped with its run time (timing.ts). */
export function handleConvertArchive(req: Request, deps: ConvertArchiveDeps): Promise<Response> {
  return timed(() => convert(req, deps), performanceClock);
}

function failure(error: unknown, status: number, prefix: string): Response {
  let message: string;
  if (error instanceof Error) {
    message = error.message;
  } else {
    message = String(error);
  }
  if (status >= 500) {
    console.error(message);
  }
  return Response.json({ error: `${prefix}${message}` }, { status });
}

async function convert(req: Request, deps: ConvertArchiveDeps): Promise<Response> {
  if (!await isServiceRole(req, deps.serviceRoleKey)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  let request: ConvertRequest;
  try {
    const text = await req.text();
    let body: unknown = undefined;
    if (text.trim() !== "") {
      body = JSON.parse(text);
    }
    request = convertRequest(body);
  } catch (error) {
    // Not JSON, or not a conversion request: the caller's fault. Anything else (a broken stream)
    // is ours.
    if (error instanceof SyntaxError || error instanceof ValidationError) {
      return failure(error, 400, "Bad request: ");
    }
    return failure(error, 500, "");
  }
  let store: ArchiveObjectStore;
  try {
    store = deps.store();
  } catch (error) {
    // A ConfigError when the LONGLINES_ARCHIVE_S3_* secrets are missing or bad; any failure is a 500.
    return failure(error, 500, "");
  }
  // The boundary: a failed listing or RPC, or anything else runConvert throws, answers 500 with
  // its message; a failed slice is in the summary instead.
  try {
    const summary = await runConvert(createConvertDb(deps.db()), store, request);
    console.log(JSON.stringify(summary));
    let status = 200;
    if (summary.failed.length > 0) {
      status = 500;
    }
    return Response.json(summary, { status });
  } catch (error) {
    return failure(error, 500, "");
  }
}

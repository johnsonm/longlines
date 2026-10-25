// The HTTP shell for the pulled sources (POTA, SOTAwatch, WWFF), invoked by
// pg_cron with the service-role key from Vault. Each run fetches the live
// upstream feed, so only the service role may start one: the gateway's
// verify_jwt also lets the public anon key and signed-in users through.
//
// This lives apart from serve.ts because it imports isServiceRole, which trusts
// a JWT's role claim unverified; the relay's push functions run with
// verify_jwt = false and import serve.ts, so they must never reach it
// (function_config.test.ts checks).

import { isServiceRole } from "./auth.ts";
import { createIngestDb, createServiceClient } from "./db.ts";
import { runIngest } from "./ingest.ts";
import { respond } from "./serve.ts";
import { performanceClock, timed } from "./timing.ts";
import type { IngestDb, SourceAdapter } from "./types.ts";

export interface IngestDeps {
  serviceRoleKey: string | undefined;
  db: () => IngestDb;
}

export function ingestHandler(
  adapter: SourceAdapter,
  deps: IngestDeps,
): (req: Request) => Promise<Response> {
  function handler(req: Request): Promise<Response> {
    async function run(): Promise<Response> {
      if (!await isServiceRole(req, deps.serviceRoleKey)) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
      return await respond(adapter.source, () => runIngest(adapter, deps.db()));
    }
    return timed(run, performanceClock);
  }
  return handler;
}

export function serveIngest(adapter: SourceAdapter): void {
  const ingest = ingestHandler(adapter, {
    serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    db: () => createIngestDb(createServiceClient()),
  });
  async function handler(req: Request): Promise<Response> {
    return await ingest(req);
  }
  Deno.serve(handler);
}

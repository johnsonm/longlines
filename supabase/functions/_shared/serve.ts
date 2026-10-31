// HTTP shells shared by the ingest functions: run the orchestrator, return the
// summary as JSON, or a 500 whose body and log line carry the error (reported to Sentry unless
// it is an UpstreamError).
//
// Pushed sources (RBN, DX Cluster, APRS-IS) are invoked by the inbound worker, which holds
// only the inbound secret, with POST batches of lines. Pulled sources (POTA,
// SOTAwatch, WWFF, WWBOTA) are served by serve_ingest.ts, which checks for the service
// role; keep that check out of this module, which the verify_jwt = false push
// functions import.

import type { SupabaseClient } from "@supabase/supabase-js";
import { secretsMatch } from "./auth.ts";
import type { AprsPushDb } from "./aprs.ts";
import {
  createAprsDb,
  createIngestDb,
  createRbnDb,
  createServiceClient,
  createWatchlistDb,
} from "./db.ts";
import { UpstreamError } from "./ingest.ts";
import type { RbnPushDb } from "./rbn_push.ts";
import type { IngestSummary, Source } from "./types.ts";
import { logError } from "./sentry.ts";

const INBOUND_SECRET_ENV = "LONGLINES_INBOUND_SECRET";

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export async function respond(
  source: Source,
  run: () => Promise<IngestSummary>,
): Promise<Response> {
  try {
    const summary = await run();
    console.log(JSON.stringify(summary));
    return Response.json(summary);
  } catch (error) {
    const message = errorMessage(error);
    const line = `ingest-${source} failed: ${message}`;
    // Upstream feed trouble is only logged; ingest_state already holds the failed run.
    if (error instanceof UpstreamError) {
      console.error(line);
    } else {
      logError(line, error);
    }
    return Response.json({ source, error: message }, { status: 500 });
  }
}

export interface PushDeps<D> {
  db: () => D;
  /** The shared secret the inbound worker sends in x-inbound-secret; undefined when unset. */
  secret: () => string | undefined;
}

export function pushIngestHandler<D>(
  source: Source,
  run: (body: unknown, db: D, now: Date) => Promise<IngestSummary>,
  deps: PushDeps<D>,
): (req: Request) => Promise<Response> {
  async function handler(req: Request): Promise<Response> {
    const expected = deps.secret();
    if (expected === undefined || expected === "") {
      const message = `missing environment variable ${INBOUND_SECRET_ENV}`;
      logError(`ingest-${source}: ${message}`, undefined);
      return Response.json({ source, error: message }, { status: 500 });
    }
    let provided = req.headers.get("x-inbound-secret");
    if (provided === null) {
      provided = "";
    }
    if (!await secretsMatch(provided, expected)) {
      return Response.json({ source, error: "unauthorized" }, { status: 401 });
    }

    if (req.method === "POST") {
      let body: unknown;
      try {
        body = await req.json();
      } catch (error) {
        // Bad JSON is the inbound worker's fault; anything else (a broken stream) is ours.
        if (error instanceof SyntaxError) {
          return Response.json({ source, error: "request body is not JSON" }, { status: 400 });
        }
        const message = errorMessage(error);
        logError(`ingest-${source}: reading the request body failed: ${message}`, error);
        return Response.json({ source, error: message }, { status: 500 });
      }
      return respond(source, () => run(body, deps.db(), new Date()));
    }

    return Response.json({ source, error: "method not allowed" }, { status: 405 });
  }
  return handler;
}

/** The database ingest-rbn needs: raw_spots, the watchlist and rbn_spots. */
export function createRbnPushDb(client: SupabaseClient): RbnPushDb {
  // Object.assign copies the same own keys in the same order as the spread did.
  return Object.assign({}, createIngestDb(client), createWatchlistDb(client), createRbnDb(client));
}

/** The database ingest-aprs needs: aprs_packets, ingest_failures and ingest_state. */
export function createAprsPushDb(client: SupabaseClient): AprsPushDb {
  return Object.assign({}, createIngestDb(client), createAprsDb(client));
}

/** Serve a pushed source; makeDb builds only the database surface its run needs. */
export function servePush<D>(
  source: Source,
  run: (body: unknown, db: D, now: Date) => Promise<IngestSummary>,
  makeDb: (client: SupabaseClient) => D,
): void {
  const push = pushIngestHandler(source, run, {
    db: () => makeDb(createServiceClient()),
    secret: () => Deno.env.get(INBOUND_SECRET_ENV),
  });
  async function handler(req: Request): Promise<Response> {
    return await push(req);
  }
  Deno.serve(handler);
}

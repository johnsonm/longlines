// HTTP shells shared by the ingest functions: run the orchestrator, return the
// summary as JSON, or a 500 whose body and log line carry the error.
//
// Pulled sources (POTA, SOTAwatch) are invoked by pg_cron with the service-role
// key. Pushed sources (RBN) are invoked by the relay, which holds only the
// relay secret: GET returns the watchlist, POST ingests a batch of lines.

import { createIngestDb, createServiceClient, createWatchlistDb } from "./db.ts";
import { runIngest } from "./ingest.ts";
import type { IngestDb, Source, SourceAdapter, WatchlistDb } from "./types.ts";

const RELAY_SECRET_ENV = "LONGLINES_RELAY_SECRET";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runAndRespond(adapter: SourceAdapter, makeDb: () => IngestDb): Promise<Response> {
  try {
    const summary = await runIngest(adapter, makeDb());
    console.log(JSON.stringify(summary));
    return Response.json(summary);
  } catch (error) {
    const message = errorMessage(error);
    console.error(`ingest-${adapter.source} failed: ${message}`);
    return Response.json({ source: adapter.source, error: message }, { status: 500 });
  }
}

export function ingestHandler(
  adapter: SourceAdapter,
  makeDb: () => IngestDb,
): (req: Request) => Promise<Response> {
  return (_req: Request) => runAndRespond(adapter, makeDb);
}

export function serveIngest(adapter: SourceAdapter): void {
  Deno.serve(ingestHandler(adapter, () => createIngestDb(createServiceClient())));
}

/** Compare two secrets in time independent of where they differ. */
async function secretsMatch(provided: string, expected: string): Promise<boolean> {
  const digest = async (s: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(provided), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export interface PushDeps {
  db: () => IngestDb & WatchlistDb;
  /** The shared secret the relay sends in x-relay-secret; undefined when unset. */
  secret: () => string | undefined;
}

export function pushIngestHandler(
  source: Source,
  makeAdapter: (body: unknown) => SourceAdapter,
  deps: PushDeps,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const expected = deps.secret();
    if (!expected) {
      const message = `missing environment variable ${RELAY_SECRET_ENV}`;
      console.error(`ingest-${source}: ${message}`);
      return Response.json({ source, error: message }, { status: 500 });
    }
    if (!await secretsMatch(req.headers.get("x-relay-secret") ?? "", expected)) {
      return Response.json({ source, error: "unauthorized" }, { status: 401 });
    }

    if (req.method === "GET") {
      try {
        const callsigns = await deps.db().watchedCallsigns(source);
        return Response.json({ source, callsigns });
      } catch (error) {
        const message = errorMessage(error);
        console.error(`ingest-${source} watchlist failed: ${message}`);
        return Response.json({ source, error: message }, { status: 500 });
      }
    }

    if (req.method === "POST") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ source, error: "request body is not JSON" }, { status: 400 });
      }
      return runAndRespond(makeAdapter(body), deps.db);
    }

    return Response.json({ source, error: "method not allowed" }, { status: 405 });
  };
}

export function servePush(source: Source, makeAdapter: (body: unknown) => SourceAdapter): void {
  Deno.serve(pushIngestHandler(source, makeAdapter, {
    db: () => {
      const client = createServiceClient();
      return { ...createIngestDb(client), ...createWatchlistDb(client) };
    },
    secret: () => Deno.env.get(RELAY_SECRET_ENV),
  }));
}

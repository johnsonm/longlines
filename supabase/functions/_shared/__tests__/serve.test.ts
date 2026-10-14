import { assertEquals } from "@std/assert";
import { runIngest } from "../ingest.ts";
import { createAprsPushDb, createRbnPushDb, ingestHandler, pushIngestHandler } from "../serve.ts";
import { fakeSupabase } from "./fake_supabase.ts";
import type { IngestDb, SourceAdapter } from "../types.ts";

function adapter(feed: unknown): SourceAdapter {
  return {
    source: "sotawatch",
    fetchSpots: () => Promise.resolve(feed),
    parseFeed: (body) => body as [],
    normalize: () => Promise.resolve({ kind: "skip", reason: "too_old" }),
  };
}

const db: IngestDb = {
  getLastEpoch: () => Promise.resolve(null),
  ingestSpots: () => Promise.resolve([]),
  recordSpotFailures: () => Promise.resolve(),
  recordSuccess: () => Promise.resolve(),
  recordFailure: () => Promise.resolve(),
  matchPendingSpots: () => Promise.resolve(0),
};

Deno.test("ingestHandler returns the run summary as JSON", async () => {
  const res = await ingestHandler(adapter([]), () => db)(new Request("http://x/"));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.source, "sotawatch");
  assertEquals(body.fetched, 0);
});

Deno.test("ingestHandler turns a thrown error into a 500 naming the source", async () => {
  const res = await ingestHandler(adapter([]), () => {
    throw new Error("missing environment variable SUPABASE_URL");
  })(new Request("http://x/"));
  assertEquals(res.status, 500);
  assertEquals(await res.json(), {
    source: "sotawatch",
    error: "missing environment variable SUPABASE_URL",
  });
});

Deno.test("ingestHandler stringifies non-Error throws", async () => {
  const res = await ingestHandler(adapter([]), () => {
    throw "plain string";
  })(new Request("http://x/"));
  assertEquals((await res.json()).error, "plain string");
});

// Push handler (relay -> ingest-rbn).

const SECRET = "relay-secret";

function pushHandler(
  overrides: { secret?: string } = {},
): { handler: (req: Request) => Promise<Response>; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const handler = pushIngestHandler("rbn", (body, d: IngestDb) => {
    bodies.push(body);
    return runIngest({ ...adapter([]), source: "rbn" }, d);
  }, {
    db: () => db,
    secret: () => "secret" in overrides ? overrides.secret : SECRET,
  });
  return { handler, bodies };
}

function relayRequest(method: string, secret: string | null, body?: string): Request {
  const headers = new Headers();
  if (secret !== null) headers.set("x-relay-secret", secret);
  return new Request("http://x/", { method, headers, body });
}

Deno.test("pushIngestHandler rejects a missing or wrong relay secret", async () => {
  const { handler, bodies } = pushHandler();
  for (const secret of [null, "", "relay-secreT", "relay-secret2"]) {
    const res = await handler(relayRequest("POST", secret, "{}"));
    assertEquals(res.status, 401);
    assertEquals(await res.json(), { source: "rbn", error: "unauthorized" });
  }
  assertEquals(bodies, []);
});

Deno.test("pushIngestHandler fails closed when the secret is not configured", async () => {
  const { handler } = pushHandler({ secret: undefined });
  const res = await handler(relayRequest("POST", "", "{}"));
  assertEquals(res.status, 500);
  assertEquals((await res.json()).error, "missing environment variable LONGLINES_RELAY_SECRET");
});

Deno.test("pushIngestHandler POST runs the ingest over the request body", async () => {
  const { handler, bodies } = pushHandler();
  const res = await handler(relayRequest("POST", SECRET, JSON.stringify({ lines: [] })));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).source, "rbn");
  assertEquals(bodies, [{ lines: [] }]);
});

Deno.test("pushIngestHandler POST rejects a body that is not JSON", async () => {
  const { handler, bodies } = pushHandler();
  const res = await handler(relayRequest("POST", SECRET, "not json"));
  assertEquals(res.status, 400);
  assertEquals(bodies, []);
});

Deno.test("pushIngestHandler refuses other methods", async () => {
  const { handler } = pushHandler();
  assertEquals((await handler(relayRequest("DELETE", SECRET))).status, 405);
});

Deno.test("pushIngestHandler POST turns a run error into a 500 naming the source", async () => {
  const handler = pushIngestHandler("rbn", () => Promise.reject(new Error("disk full")), {
    db: () => db,
    secret: () => SECRET,
  });
  const res = await handler(relayRequest("POST", SECRET, JSON.stringify({ lines: [] })));
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { source: "rbn", error: "disk full" });
});

Deno.test("pushIngestHandler refuses GET now that the relay no longer reads a watchlist", async () => {
  const { handler } = pushHandler();
  assertEquals((await handler(relayRequest("GET", SECRET))).status, 405);
});

Deno.test("createRbnPushDb combines the ingest, watchlist and rbn_spots surfaces", () => {
  const db = createRbnPushDb(fakeSupabase().client);
  for (const method of ["ingestSpots", "recordSuccess", "watchedAmong", "ingestRbnSpots"]) {
    assertEquals(typeof (db as unknown as Record<string, unknown>)[method], "function", method);
  }
});

Deno.test("createAprsPushDb combines the ingest-state and aprs_packets surfaces", () => {
  const db = createAprsPushDb(fakeSupabase().client);
  for (
    const method of ["recordSpotFailures", "recordSuccess", "recordFailure", "ingestAprsPackets"]
  ) {
    assertEquals(typeof (db as unknown as Record<string, unknown>)[method], "function", method);
  }
});

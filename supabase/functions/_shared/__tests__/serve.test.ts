import { assertEquals } from "@std/assert";
import { runIngest } from "../ingest.ts";
import { ingestHandler, pushIngestHandler } from "../serve.ts";
import type { IngestDb, Source, SourceAdapter, WatchlistDb } from "../types.ts";

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
  overrides: { secret?: string; watchlist?: () => Promise<string[]> } = {},
): { handler: (req: Request) => Promise<Response>; bodies: unknown[]; watched: Source[] } {
  const bodies: unknown[] = [];
  const watched: Source[] = [];
  const pushDb: IngestDb & WatchlistDb = {
    ...db,
    watchedCallsigns: (source) => {
      watched.push(source);
      return overrides.watchlist?.() ?? Promise.resolve(["K1ABC", "W1AW"]);
    },
  };
  const handler = pushIngestHandler("rbn", (body, d) => {
    bodies.push(body);
    return runIngest({ ...adapter([]), source: "rbn" }, d);
  }, {
    db: () => pushDb,
    secret: () => "secret" in overrides ? overrides.secret : SECRET,
  });
  return { handler, bodies, watched };
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
  const res = await handler(relayRequest("GET", ""));
  assertEquals(res.status, 500);
  assertEquals((await res.json()).error, "missing environment variable LONGLINES_RELAY_SECRET");
});

Deno.test("pushIngestHandler GET returns the watchlist for its source", async () => {
  const { handler, watched } = pushHandler();
  const res = await handler(relayRequest("GET", SECRET));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { source: "rbn", callsigns: ["K1ABC", "W1AW"] });
  assertEquals(watched, ["rbn"]);
});

Deno.test("pushIngestHandler GET reports a watchlist failure as a 500", async () => {
  const { handler } = pushHandler({ watchlist: () => Promise.reject(new Error("db down")) });
  const res = await handler(relayRequest("GET", SECRET));
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { source: "rbn", error: "db down" });
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
    db: () => ({ ...db, watchedCallsigns: () => Promise.resolve([]) }),
    secret: () => SECRET,
  });
  const res = await handler(relayRequest("POST", SECRET, JSON.stringify({ lines: [] })));
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { source: "rbn", error: "disk full" });
});

import { assertEquals } from "@std/assert";
import { runIngest } from "../ingest.ts";
import { createAprsPushDb, createRbnPushDb, pushIngestHandler } from "../serve.ts";
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

// Push handler (inbound -> ingest-rbn).

const SECRET = "inbound-secret";

function pushHandler(
  overrides: { secret?: string },
): { handler: (req: Request) => Promise<Response>; bodies: unknown[] } {
  const bodies: unknown[] = [];
  function run(body: unknown, d: IngestDb): ReturnType<typeof runIngest> {
    bodies.push(body);
    const base = adapter([]);
    return runIngest(
      {
        source: "rbn",
        fetchSpots: base.fetchSpots,
        parseFeed: base.parseFeed,
        normalize: base.normalize,
      },
      d,
      new Date(),
    );
  }
  function secret(): string | undefined {
    if ("secret" in overrides) {
      return overrides.secret;
    }
    return SECRET;
  }
  const handler = pushIngestHandler("rbn", run, { db: () => db, secret });
  return { handler, bodies };
}

function inboundRequest(method: string, secret: string | null, body: string | undefined): Request {
  const headers = new Headers();
  if (secret !== null) {
    headers.set("x-inbound-secret", secret);
  }
  return new Request("http://x/", { method, headers, body });
}

Deno.test(
  "pushIngestHandler rejects a missing or wrong inbound secret",
  async function (): Promise<void> {
    const pushed = pushHandler({});
    const handler = pushed.handler;
    const bodies = pushed.bodies;
    for (const secret of [null, "", "inbound-secreT", "inbound-secret2"]) {
      const res = await handler(inboundRequest("POST", secret, "{}"));
      assertEquals(res.status, 401);
      assertEquals(await res.json(), { source: "rbn", error: "unauthorized" });
    }
    assertEquals(bodies, []);
  },
);

Deno.test(
  "pushIngestHandler fails closed when the secret is not configured",
  async function (): Promise<void> {
    const handler = pushHandler({ secret: undefined }).handler;
    const res = await handler(inboundRequest("POST", "", "{}"));
    assertEquals(res.status, 500);
    assertEquals((await res.json()).error, "missing environment variable LONGLINES_INBOUND_SECRET");
  },
);

Deno.test(
  "pushIngestHandler POST runs the ingest over the request body",
  async function (): Promise<void> {
    const pushed = pushHandler({});
    const handler = pushed.handler;
    const bodies = pushed.bodies;
    const res = await handler(inboundRequest("POST", SECRET, JSON.stringify({ lines: [] })));
    assertEquals(res.status, 200);
    assertEquals((await res.json()).source, "rbn");
    assertEquals(bodies, [{ lines: [] }]);
  },
);

Deno.test(
  "pushIngestHandler POST rejects a body that is not JSON",
  async function (): Promise<void> {
    const pushed = pushHandler({});
    const handler = pushed.handler;
    const bodies = pushed.bodies;
    const res = await handler(inboundRequest("POST", SECRET, "not json"));
    assertEquals(res.status, 400);
    assertEquals(bodies, []);
  },
);

Deno.test(
  "pushIngestHandler POST answers 500 when the body cannot be read",
  async function (): Promise<void> {
    const pushed = pushHandler({});
    const broken = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.error(new Error("connection reset"));
      },
    });
    const req = new Request("http://x/", {
      method: "POST",
      headers: { "x-inbound-secret": SECRET },
      body: broken,
    });
    const res = await pushed.handler(req);
    assertEquals(res.status, 500);
    assertEquals((await res.json()).source, "rbn");
    assertEquals(pushed.bodies, []);
  },
);

Deno.test("pushIngestHandler refuses other methods", async function (): Promise<void> {
  const handler = pushHandler({}).handler;
  assertEquals((await handler(inboundRequest("DELETE", SECRET, undefined))).status, 405);
});

Deno.test(
  "pushIngestHandler POST turns a run error into a 500 naming the source",
  async function (): Promise<void> {
    const handler = pushIngestHandler("rbn", () => Promise.reject(new Error("disk full")), {
      db: () => db,
      secret: () => SECRET,
    });
    const res = await handler(inboundRequest("POST", SECRET, JSON.stringify({ lines: [] })));
    assertEquals(res.status, 500);
    assertEquals(await res.json(), { source: "rbn", error: "disk full" });
  },
);

Deno.test(
  "pushIngestHandler refuses GET now that the inbound worker no longer reads a watchlist",
  async function (): Promise<void> {
    const handler = pushHandler({}).handler;
    assertEquals((await handler(inboundRequest("GET", SECRET, undefined))).status, 405);
  },
);

Deno.test(
  "createRbnPushDb combines the ingest, watchlist and rbn_spots surfaces",
  function (): void {
    const db = createRbnPushDb(fakeSupabase({}).client);
    for (const method of ["ingestSpots", "recordSuccess", "watchedAmong", "ingestRbnSpots"]) {
      assertEquals(typeof (db as unknown as Record<string, unknown>)[method], "function", method);
    }
  },
);

Deno.test(
  "createAprsPushDb combines the ingest-state and aprs_packets surfaces",
  function (): void {
    const db = createAprsPushDb(fakeSupabase({}).client);
    for (
      const method of ["recordSpotFailures", "recordSuccess", "recordFailure", "ingestAprsPackets"]
    ) {
      assertEquals(typeof (db as unknown as Record<string, unknown>)[method], "function", method);
    }
  },
);

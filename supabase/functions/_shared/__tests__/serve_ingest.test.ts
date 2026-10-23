import { assertEquals, assertMatch } from "@std/assert";
import { ingestHandler } from "../serve_ingest.ts";
import type { IngestDb, SourceAdapter } from "../types.ts";

const SERVICE_KEY = "sb_secret_test";

function adapter(): SourceAdapter & { fetches: number } {
  function fetchSpots(): Promise<unknown> {
    a.fetches++;
    return Promise.resolve([]);
  }
  const a: SourceAdapter & { fetches: number } = {
    source: "sotawatch",
    fetches: 0,
    fetchSpots,
    parseFeed: (body) => body as [],
    normalize: () => Promise.resolve({ kind: "skip", reason: "too_old" }),
  };
  return a;
}

const db: IngestDb = {
  getLastEpoch: () => Promise.resolve(null),
  ingestSpots: () => Promise.resolve([]),
  recordSpotFailures: () => Promise.resolve(),
  recordSuccess: () => Promise.resolve(),
  recordFailure: () => Promise.resolve(),
  matchPendingSpots: () => Promise.resolve(0),
};

function b64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function jwt(role: string): string {
  return `${b64url({ alg: "HS256" })}.${b64url({ role })}.sig`;
}

function request(token?: string): Request {
  let headers: Record<string, string> = {};
  if (token) {
    headers = { authorization: `Bearer ${token}` };
  }
  return new Request("http://x/", { method: "POST", headers });
}

Deno.test(
  "ingestHandler runs for the service-role key and returns the summary as JSON",
  async function (): Promise<void> {
    const a = adapter();
    const res = await ingestHandler(a, { serviceRoleKey: SERVICE_KEY, db: () => db })(
      request(SERVICE_KEY),
    );
    assertEquals(res.status, 200);
    let timing = res.headers.get("Server-Timing");
    if (timing === null) {
      timing = "";
    }
    assertMatch(timing, /^total;dur=\d+\.\d$/);
    const body = await res.json();
    assertEquals(body.source, "sotawatch");
    assertEquals(body.fetched, 0);
    assertEquals(a.fetches, 1);
  },
);

Deno.test(
  "ingestHandler runs for the service-role JWT pg_cron sends",
  async function (): Promise<void> {
    const a = adapter();
    const res = await ingestHandler(a, { serviceRoleKey: SERVICE_KEY, db: () => db })(
      request(jwt("service_role")),
    );
    assertEquals(res.status, 200);
    assertEquals(a.fetches, 1);
  },
);

Deno.test(
  "ingestHandler refuses anon, users and no token without fetching upstream",
  async function (): Promise<void> {
    let opened = false;
    function openDb(): IngestDb {
      opened = true;
      return db;
    }
    for (const token of [jwt("anon"), jwt("authenticated"), "sb_publishable_x", undefined]) {
      const a = adapter();
      opened = false;
      const res = await ingestHandler(a, { serviceRoleKey: SERVICE_KEY, db: openDb })(
        request(token),
      );
      assertEquals(res.status, 403, String(token));
      assertEquals(await res.json(), { error: "Forbidden" });
      assertEquals(a.fetches, 0, String(token));
      assertEquals(opened, false, String(token));
    }
  },
);

Deno.test(
  "ingestHandler turns a thrown error into a 500 naming the source",
  async function (): Promise<void> {
    function failDb(): IngestDb {
      throw new Error("missing environment variable SUPABASE_URL");
    }
    const res = await ingestHandler(adapter(), { serviceRoleKey: SERVICE_KEY, db: failDb })(
      request(SERVICE_KEY),
    );
    assertEquals(res.status, 500);
    assertEquals(await res.json(), {
      source: "sotawatch",
      error: "missing environment variable SUPABASE_URL",
    });
  },
);

Deno.test("ingestHandler stringifies non-Error throws", async function (): Promise<void> {
  function failDb(): IngestDb {
    // Typed unknown so the test can throw a non-Error, which is what it checks.
    const thrown: unknown = "plain string";
    throw thrown;
  }
  const res = await ingestHandler(adapter(), { serviceRoleKey: SERVICE_KEY, db: failDb })(
    request(SERVICE_KEY),
  );
  assertEquals((await res.json()).error, "plain string");
});

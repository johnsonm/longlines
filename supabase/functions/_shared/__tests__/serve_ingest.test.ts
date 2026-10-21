import { assertEquals, assertMatch } from "@std/assert";
import { ingestHandler } from "../serve_ingest.ts";
import type { IngestDb, SourceAdapter } from "../types.ts";

const SERVICE_KEY = "sb_secret_test";

function adapter(): SourceAdapter & { fetches: number } {
  const a: SourceAdapter & { fetches: number } = {
    source: "sotawatch",
    fetches: 0,
    fetchSpots: () => {
      a.fetches++;
      return Promise.resolve([]);
    },
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
  return new Request("http://x/", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

Deno.test("ingestHandler runs for the service-role key and returns the summary as JSON", async () => {
  const a = adapter();
  const res = await ingestHandler(a, { serviceRoleKey: SERVICE_KEY, db: () => db })(
    request(SERVICE_KEY),
  );
  assertEquals(res.status, 200);
  assertMatch(res.headers.get("Server-Timing") ?? "", /^total;dur=\d+\.\d$/);
  const body = await res.json();
  assertEquals(body.source, "sotawatch");
  assertEquals(body.fetched, 0);
  assertEquals(a.fetches, 1);
});

Deno.test("ingestHandler runs for the service-role JWT pg_cron sends", async () => {
  const a = adapter();
  const res = await ingestHandler(a, { serviceRoleKey: SERVICE_KEY, db: () => db })(
    request(jwt("service_role")),
  );
  assertEquals(res.status, 200);
  assertEquals(a.fetches, 1);
});

Deno.test("ingestHandler refuses anon, users and no token without fetching upstream", async () => {
  for (const token of [jwt("anon"), jwt("authenticated"), "sb_publishable_x", undefined]) {
    const a = adapter();
    let opened = false;
    const res = await ingestHandler(a, {
      serviceRoleKey: SERVICE_KEY,
      db: () => {
        opened = true;
        return db;
      },
    })(request(token));
    assertEquals(res.status, 403, String(token));
    assertEquals(await res.json(), { error: "Forbidden" });
    assertEquals(a.fetches, 0, String(token));
    assertEquals(opened, false, String(token));
  }
});

Deno.test("ingestHandler turns a thrown error into a 500 naming the source", async () => {
  const res = await ingestHandler(adapter(), {
    serviceRoleKey: SERVICE_KEY,
    db: () => {
      throw new Error("missing environment variable SUPABASE_URL");
    },
  })(request(SERVICE_KEY));
  assertEquals(res.status, 500);
  assertEquals(await res.json(), {
    source: "sotawatch",
    error: "missing environment variable SUPABASE_URL",
  });
});

Deno.test("ingestHandler stringifies non-Error throws", async () => {
  const res = await ingestHandler(adapter(), {
    serviceRoleKey: SERVICE_KEY,
    db: () => {
      throw "plain string";
    },
  })(request(SERVICE_KEY));
  assertEquals((await res.json()).error, "plain string");
});

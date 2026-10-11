import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { loadConfig } from "../config.ts";
import { RBN_FEED } from "../feeds.ts";
import { functionClient } from "../functions.ts";
import { healthHandler } from "../health.ts";
import { Watchlist } from "../watchlist.ts";

const env = (values: Record<string, string>) => (name: string) => values[name];
const BASE = {
  LONGLINES_FUNCTIONS_URL: "https://abc.supabase.co/functions/v1/",
  LONGLINES_RELAY_SECRET: "s3cret",
  RELAY_LOGIN_CALL: "kk4pwj",
};

Deno.test("loadConfig reads the environment and normalises values", () => {
  assertEquals(loadConfig(env(BASE)), {
    functionsUrl: "https://abc.supabase.co/functions/v1",
    relaySecret: "s3cret",
    loginCall: "KK4PWJ",
    healthPort: 8080,
  });
});

Deno.test("loadConfig rejects missing values, plain http off localhost and bad ports", () => {
  assertThrows(
    () => loadConfig(env({ ...BASE, LONGLINES_RELAY_SECRET: " " })),
    Error,
    "LONGLINES_RELAY_SECRET",
  );
  assertThrows(() =>
    loadConfig(env({ ...BASE, LONGLINES_FUNCTIONS_URL: "http://abc.supabase.co" }))
  );
  assertThrows(() => loadConfig(env({ ...BASE, RELAY_HEALTH_PORT: "x" })));
  assertEquals(
    loadConfig(env({ ...BASE, LONGLINES_FUNCTIONS_URL: "http://127.0.0.1:54321/functions/v1" }))
      .functionsUrl,
    "http://127.0.0.1:54321/functions/v1",
  );
});

Deno.test("RBN_FEED.callsignOf reads the station from every fixture spot line", () => {
  const fixture = Deno.readTextFileSync(
    new URL("../../supabase/functions/_shared/__tests__/fixtures/rbn-telnet.txt", import.meta.url),
  ).split("\n");
  const calls = fixture.map((l) => RBN_FEED.callsignOf(l));
  assertEquals(
    calls.filter((c) => c !== null).length,
    fixture.filter((l) => l.startsWith("DX de")).length,
  );
  assertEquals(
    RBN_FEED.callsignOf(fixture.find((l) => l.startsWith("DX de SM1HEV-#"))!),
    "CT1JGA/P",
  );
  assertEquals(RBN_FEED.callsignOf("Local users: 586"), null);
});

Deno.test("Watchlist normalises callsigns and keeps the last good list on failure", async () => {
  const w = new Watchlist();
  const logs: string[] = [];
  assertEquals(w.loaded, false);
  assertEquals(
    await w.refresh(() => Promise.resolve([" k1abc ", "W1AW", ""]), (m) => logs.push(m)),
    true,
  );
  assertEquals([w.has("K1ABC"), w.has("W1AW"), w.size], [true, true, 2]);
  assertEquals(
    await w.refresh(() => Promise.reject(new Error("HTTP 500")), (m) => logs.push(m)),
    false,
  );
  assertEquals(w.size, 2);
  assertEquals(logs, ["watchlist: 2 callsigns", "watchlist refresh failed: HTTP 500"]);
});

Deno.test("Watchlist logs the first load even when it is empty", async () => {
  const logs: string[] = [];
  await new Watchlist().refresh(() => Promise.resolve([]), (m) => logs.push(m));
  assertEquals(logs, ["watchlist: 0 callsigns"]);
});

function fakeFetch(status: number, body: string) {
  const requests: Request[] = [];
  const fn = (input: string | URL | Request, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return Promise.resolve(new Response(body, { status }));
  };
  return { fn: fn as typeof fetch, requests };
}

Deno.test("functionClient GETs the watchlist with the secret and a User-Agent", async () => {
  const f = fakeFetch(200, JSON.stringify({ source: "rbn", callsigns: ["K1ABC"] }));
  const client = functionClient("https://x/functions/v1", "ingest-rbn", "s3cret", f.fn);
  assertEquals(await client.watchlist(), ["K1ABC"]);
  const req = f.requests[0]!;
  assertEquals([req.method, req.url], ["GET", "https://x/functions/v1/ingest-rbn"]);
  assertEquals(req.headers.get("x-relay-secret"), "s3cret");
  assertEquals(req.headers.get("user-agent")?.startsWith("LongLines/"), true);
});

Deno.test("functionClient POSTs a batch as JSON", async () => {
  const f = fakeFetch(200, "{}");
  const lines = [{ line: "DX de ...", received_at: "2026-10-11T00:00:00Z" }];
  await functionClient("https://x", "ingest-rbn", "s", f.fn).push(lines);
  const req = f.requests[0]!;
  assertEquals(req.method, "POST");
  assertEquals(req.headers.get("content-type"), "application/json");
  assertEquals(await req.json(), { lines });
});

Deno.test("functionClient throws on non-2xx and on a malformed watchlist", async () => {
  await assertRejects(
    () => functionClient("https://x", "ingest-rbn", "s", fakeFetch(401, "{}").fn).watchlist(),
    Error,
    "HTTP 401",
  );
  await assertRejects(
    () =>
      functionClient("https://x", "ingest-rbn", "s", fakeFetch(200, '{"callsigns":[1]}').fn)
        .watchlist(),
  );
});

Deno.test("healthHandler is healthy while data is fresh and during the startup grace", async () => {
  const started = new Date("2026-10-11T00:00:00Z");
  let now = new Date("2026-10-11T00:05:00Z");
  const status = { connected: true, lastDataAt: null as Date | null, connects: 1 };
  const handler = healthHandler(
    [{ id: "rbn", status, watching: () => 2, buffered: () => 0, pushed: () => 7 }],
    started,
    10 * 60_000,
    () => now,
  );
  const get = (path = "/healthz") => handler(new Request(`http://x${path}`));

  assertEquals(get().status, 200); // no data yet, inside grace
  now = new Date("2026-10-11T00:11:00Z");
  assertEquals(get().status, 503);
  status.lastDataAt = new Date("2026-10-11T00:10:30Z");
  const res = get();
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.feeds[0].watching, 2);
  assertEquals(body.feeds[0].last_data_at, "2026-10-11T00:10:30.000Z");
  assertEquals(get("/").status, 404);
});

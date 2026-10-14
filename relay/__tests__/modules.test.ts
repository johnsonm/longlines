import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { FCC_AMATEUR_ZIP, loadConfig } from "../config.ts";
import {
  APRS_DEFAULT_HOST,
  APRS_DEFAULT_PORT,
  aprsFeed,
  aprsLoginCall,
  DXCLUSTER_DEFAULT_HOST,
  dxclusterFeed,
  RBN_FEED,
} from "../feeds.ts";
import { functionClient } from "../functions.ts";
import { healthHandler } from "../health.ts";

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
    licenseZipUrl: FCC_AMATEUR_ZIP,
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

Deno.test("loadConfig turns the license load off, off locally, or points it at another file", () => {
  assertEquals(loadConfig(env({ ...BASE, RELAY_LICENSES: " OFF " })).licenseZipUrl, null);
  // Local functions: off unless RELAY_LICENSES asks for a file.
  const local = { ...BASE, LONGLINES_FUNCTIONS_URL: "http://127.0.0.1:54321/functions/v1" };
  assertEquals(loadConfig(env(local)).licenseZipUrl, null);
  assertEquals(
    loadConfig(env({ ...local, RELAY_LICENSES: FCC_AMATEUR_ZIP })).licenseZipUrl,
    FCC_AMATEUR_ZIP,
  );
  assertEquals(
    loadConfig(env({ ...BASE, RELAY_LICENSES: "http://127.0.0.1:8000/l_amat" })).licenseZipUrl,
    "http://127.0.0.1:8000/l_amat",
  );
  assertThrows(
    () => loadConfig(env({ ...BASE, RELAY_LICENSES: "http://mirror.example.org/l_amat" })),
    Error,
    "https",
  );
  assertThrows(() => loadConfig(env({ ...BASE, RELAY_LICENSES: "no" })), Error, "RELAY_LICENSES");
});

Deno.test("the Docker image allows every environment variable the relay reads", () => {
  const read = new Set<string>(["LONGLINES_USER_AGENT_URL"]); // read by userAgent() in _shared/http.ts
  const recorder = (name: string) => {
    read.add(name);
    return (BASE as Record<string, string>)[name];
  };
  loadConfig(recorder);
  dxclusterFeed(recorder);
  aprsFeed((name) => {
    read.add(name);
    return name === "APRS_LOGIN_CALL" ? "N0CALL-LL" : undefined;
  });
  const dockerfile = Deno.readTextFileSync(new URL("../Dockerfile", import.meta.url));
  const allowed = /--allow-env=([^"]+)"/.exec(dockerfile)?.[1]?.split(",") ?? [];
  assertEquals([...read].filter((name) => !allowed.includes(name)), []);
});

Deno.test("RBN_FEED.isSpot accepts every fixture spot line and nothing else", () => {
  const fixture = Deno.readTextFileSync(
    new URL("../../supabase/functions/_shared/__tests__/fixtures/rbn-telnet.txt", import.meta.url),
  ).split("\n");
  for (const l of fixture) assertEquals(RBN_FEED.isSpot(l), l.startsWith("DX de"), l);
});

Deno.test("dxclusterFeed defaults to G1FEF-2 and takes a host and port from the environment", () => {
  const feed = dxclusterFeed(env({}));
  assertEquals([feed.id, feed.host, feed.port], ["dxcluster", DXCLUSTER_DEFAULT_HOST, 7300]);
  assertEquals(feed.functionName, "ingest-dxcluster");
  assertEquals([feed.idleMs, feed.staleMs], [15 * 60_000, 20 * 60_000]);
  assertEquals(feed.loginPrompt.test("login: "), true);
  const other = dxclusterFeed(env({ DXCLUSTER_HOST: " dxc.nc7j.com ", DXCLUSTER_PORT: "7373" }));
  assertEquals([other.host, other.port], ["dxc.nc7j.com", 7373]);
  assertEquals(dxclusterFeed(env({ DXCLUSTER_HOST: " ", DXCLUSTER_PORT: "" })).port, 7300);
  assertThrows(() => dxclusterFeed(env({ DXCLUSTER_PORT: "telnet" })), Error, "DXCLUSTER_PORT");
  assertThrows(() => dxclusterFeed(env({ DXCLUSTER_PORT: "70000" })), Error, "DXCLUSTER_PORT");
});

Deno.test("dxclusterFeed.isSpot accepts every fixture spot line, nothing else and no skimmers", () => {
  const feed = dxclusterFeed(env({}));
  const fixture = Deno.readTextFileSync(
    new URL(
      "../../supabase/functions/_shared/__tests__/fixtures/dxcluster-telnet.txt",
      import.meta.url,
    ),
  ).split("\n");
  for (const l of fixture) assertEquals(feed.isSpot(l), l.startsWith("DX de"), l);
  const skimmer = "DX de SM1HEV-#: 14038.30  CT1JGA/P       CW     8 dB  24 WPM  CQ      1454Z";
  assertEquals(feed.isSpot(skimmer), false);
});

Deno.test("aprsFeed is off until APRS_LOGIN_CALL is set", () => {
  assertEquals(aprsFeed(env({})), null);
  assertEquals(aprsFeed(env({ APRS_LOGIN_CALL: "  " })), null);
});

Deno.test("aprsFeed holds the full feed on rotate.aprs2.net with a receive-only login", () => {
  const feed = aprsFeed(env({ APRS_LOGIN_CALL: " n0call-ll " }))!;
  assertEquals([feed.id, feed.host, feed.port], ["aprs", APRS_DEFAULT_HOST, APRS_DEFAULT_PORT]);
  assertEquals(APRS_DEFAULT_PORT, 10152);
  assertEquals(feed.functionName, "ingest-aprs");
  assertEquals(feed.telnet, false);
  assertEquals(feed.loginCall, "N0CALL-LL");
  // No filter command: the full feed is deliberate.
  assertEquals(feed.loginLine?.("N0CALL-LL"), "user N0CALL-LL pass -1 vers LongLines 0.1");
  assertEquals(feed.loginPrompt.test("# aprsc 2.1.19-g730c5c0"), true);
  assertEquals(feed.loginPrompt.test("N0CALL>APRS:# not a comment"), false);
  assertEquals([feed.idleMs, feed.staleMs, feed.maxBuffer], [2 * 60_000, 5 * 60_000, 150_000]);
  const other = aprsFeed(
    env({ APRS_LOGIN_CALL: "N0CALL", APRS_HOST: " euro.aprs2.net ", APRS_PORT: "14580" }),
  )!;
  assertEquals([other.host, other.port], ["euro.aprs2.net", 14580]);
  assertThrows(
    () => aprsFeed(env({ APRS_LOGIN_CALL: "N0CALL", APRS_PORT: "aprs" })),
    Error,
    "APRS_PORT",
  );
});

Deno.test("aprsLoginCall accepts a call or call-SSID of at most nine characters", () => {
  assertEquals(aprsLoginCall("kk4pwj-10"), "KK4PWJ-10");
  assertEquals(aprsLoginCall("N0CALL"), "N0CALL");
  for (
    const bad of ["", "N0CALL-LLL", "KK4PWJ-123", "N0 CALL", "N0CALL/P", "ABCDEFGHIJ", "AB-CD-1"]
  ) {
    assertThrows(() => aprsLoginCall(bad), Error, "APRS_LOGIN_CALL", bad);
  }
  // Ten characters with an SSID is still too long.
  assertThrows(() => aprsLoginCall("KK4PWJA-10"), Error, "nine");
});

Deno.test("aprsFeed.isSpot accepts every fixture packet and no server comment", () => {
  const feed = aprsFeed(env({ APRS_LOGIN_CALL: "N0CALL" }))!;
  const fixture = Deno.readTextFileSync(
    new URL("../../supabase/functions/_shared/__tests__/fixtures/aprs-is.txt", import.meta.url),
  ).split("\n").filter((l) => l !== "");
  const forwarded = fixture.filter((l) => feed.isSpot(l));
  assertEquals(forwarded.length, 20);
  assertEquals(forwarded.some((l) => l.startsWith("#")), false);
});

function fakeFetch(status: number, body: string) {
  const requests: Request[] = [];
  const fn = (input: string | URL | Request, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return Promise.resolve(new Response(body, { status }));
  };
  return { fn: fn as typeof fetch, requests };
}

Deno.test("functionClient POSTs a batch as JSON", async () => {
  const f = fakeFetch(200, "{}");
  const lines = [{ line: "DX de ...", received_at: "2026-10-11T00:00:00Z" }];
  await functionClient("https://x", "ingest-rbn", "s", f.fn).push(lines);
  const req = f.requests[0]!;
  assertEquals([req.method, req.url], ["POST", "https://x/ingest-rbn"]);
  assertEquals(req.headers.get("content-type"), "application/json");
  assertEquals(req.headers.get("x-relay-secret"), "s");
  assertEquals(req.headers.get("user-agent")?.startsWith("LongLines/"), true);
  assertEquals(await req.json(), { lines });
});

Deno.test("functionClient throws on non-2xx", async () => {
  await assertRejects(
    () => functionClient("https://x", "ingest-rbn", "s", fakeFetch(401, "{}").fn).push([]),
    Error,
    "HTTP 401",
  );
});

Deno.test("healthHandler is healthy while data is fresh and during the startup grace", async () => {
  const started = new Date("2026-10-11T00:00:00Z");
  let now = new Date("2026-10-11T00:05:00Z");
  const status = { connected: true, lastDataAt: null as Date | null, connects: 1 };
  const handler = healthHandler(
    [{ id: "rbn", status, dropped: () => 3, buffered: () => 0, pushed: () => 7 }],
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
  assertEquals(body.feeds[0].dropped, 3);
  assertEquals(body.feeds[0].last_data_at, "2026-10-11T00:10:30.000Z");
  assertEquals(get("/").status, 404);
});

Deno.test("healthHandler uses a feed's own stale threshold when it sets one", async () => {
  const started = new Date("2026-10-11T00:00:00Z");
  const lastDataAt = new Date("2026-10-11T00:00:00Z");
  const feed = (id: string, staleMs?: number) => ({
    id,
    status: { connected: true, lastDataAt, connects: 1 },
    dropped: () => 0,
    buffered: () => 0,
    pushed: () => 0,
    ...(staleMs === undefined ? {} : { staleMs }),
  });
  const now = () => new Date("2026-10-11T00:15:00Z");
  const quiet = healthHandler([feed("dxcluster", 20 * 60_000)], started, 10 * 60_000, now);
  assertEquals(quiet(new Request("http://x/healthz")).status, 200);
  const both = healthHandler(
    [feed("rbn"), feed("dxcluster", 20 * 60_000)],
    started,
    10 * 60_000,
    now,
  );
  const res = both(new Request("http://x/healthz"));
  assertEquals(res.status, 503);
  assertEquals((await res.json()).feeds.map((f: { healthy: boolean }) => f.healthy), [false, true]);
});

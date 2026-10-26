import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  ConfigError,
  FunctionCallError,
  ValidationError,
} from "../../supabase/functions/_shared/errors.ts";
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
import { type FeedHealth, healthHandler } from "../health.ts";

function env(values: Record<string, string>): (name: string) => string | undefined {
  return (name: string) => values[name];
}

/** `base` with `extra`'s values added or replaced, keys in first-seen order. */
function withValues(
  base: Record<string, string>,
  extra: Record<string, string>,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of Object.keys(base)) {
    values[key] = base[key]!;
  }
  for (const key of Object.keys(extra)) {
    values[key] = extra[key]!;
  }
  return values;
}

const BASE = {
  LONGLINES_FUNCTIONS_URL: "https://abc.supabase.co/functions/v1/",
  LONGLINES_RELAY_SECRET: "s3cret",
  RELAY_LOGIN_CALL: "kk4pwj",
};

Deno.test("loadConfig reads the environment and normalises values", function (): void {
  assertEquals(loadConfig(env(BASE)), {
    functionsUrl: "https://abc.supabase.co/functions/v1",
    relaySecret: "s3cret",
    loginCall: "KK4PWJ",
    healthPort: 8080,
    licenseZipUrl: FCC_AMATEUR_ZIP,
  });
});

Deno.test("loadConfig rejects missing values, plain http off localhost and bad ports", function (): void {
  assertThrows(
    () => loadConfig(env(withValues(BASE, { LONGLINES_RELAY_SECRET: " " }))),
    ConfigError,
    "LONGLINES_RELAY_SECRET",
  );
  assertThrows(
    () => loadConfig(env(withValues(BASE, { LONGLINES_FUNCTIONS_URL: "http://abc.supabase.co" }))),
    ConfigError,
    "https",
  );
  assertThrows(
    () => loadConfig(env(withValues(BASE, { LONGLINES_FUNCTIONS_URL: "not a url" }))),
    ConfigError,
    "LONGLINES_FUNCTIONS_URL must be a URL",
  );
  assertThrows(
    () => loadConfig(env(withValues(BASE, { RELAY_HEALTH_PORT: "x" }))),
    ConfigError,
    "RELAY_HEALTH_PORT",
  );
  assertEquals(
    loadConfig(
      env(withValues(BASE, { LONGLINES_FUNCTIONS_URL: "http://127.0.0.1:54321/functions/v1" })),
    )
      .functionsUrl,
    "http://127.0.0.1:54321/functions/v1",
  );
});

Deno.test("loadConfig turns the license load off, off locally, or points it at another file", function (): void {
  assertEquals(loadConfig(env(withValues(BASE, { RELAY_LICENSES: " OFF " }))).licenseZipUrl, null);
  // Local functions: off unless RELAY_LICENSES asks for a file.
  const local = withValues(BASE, {
    LONGLINES_FUNCTIONS_URL: "http://127.0.0.1:54321/functions/v1",
  });
  assertEquals(loadConfig(env(local)).licenseZipUrl, null);
  assertEquals(
    loadConfig(env(withValues(local, { RELAY_LICENSES: FCC_AMATEUR_ZIP }))).licenseZipUrl,
    FCC_AMATEUR_ZIP,
  );
  assertEquals(
    loadConfig(env(withValues(BASE, { RELAY_LICENSES: "http://127.0.0.1:8000/l_amat" })))
      .licenseZipUrl,
    "http://127.0.0.1:8000/l_amat",
  );
  assertThrows(
    () => loadConfig(env(withValues(BASE, { RELAY_LICENSES: "http://mirror.example.org/l_amat" }))),
    Error,
    "https",
  );
  assertThrows(
    () => loadConfig(env(withValues(BASE, { RELAY_LICENSES: "no" }))),
    ConfigError,
    "RELAY_LICENSES must be off or a URL",
  );
});

Deno.test("the Docker image allows every environment variable the relay reads", function (): void {
  const read = new Set<string>(["LONGLINES_USER_AGENT_URL"]); // read by userAgent() in _shared/http.ts
  function recorder(name: string) {
    read.add(name);
    return (BASE as Record<string, string>)[name];
  }
  function aprsRecorder(name: string) {
    read.add(name);
    if (name === "APRS_LOGIN_CALL") {
      return "N0CALL-LL";
    }
    return undefined;
  }
  loadConfig(recorder);
  dxclusterFeed(recorder);
  aprsFeed(aprsRecorder);
  const dockerfile = Deno.readTextFileSync(new URL("../Dockerfile", import.meta.url));
  let allowed: string[] = [];
  const match = /--allow-env=([^"]+)"/.exec(dockerfile);
  if (match !== null && match[1] !== undefined) {
    allowed = match[1].split(",");
  }
  assertEquals(Array.from(read).filter((name) => !allowed.includes(name)), []);
});

Deno.test("RBN_FEED.isSpot accepts every fixture spot line and nothing else", function (): void {
  const fixture = Deno.readTextFileSync(
    new URL("../../supabase/functions/_shared/__tests__/fixtures/rbn-telnet.txt", import.meta.url),
  ).split("\n");
  for (const l of fixture) {
    assertEquals(RBN_FEED.isSpot(l), l.startsWith("DX de"), l);
  }
});

Deno.test("dxclusterFeed defaults to G1FEF-2 and takes a host and port from the environment", function (): void {
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

Deno.test("dxclusterFeed.isSpot accepts every fixture spot line, nothing else and no skimmers", function (): void {
  const feed = dxclusterFeed(env({}));
  const fixture = Deno.readTextFileSync(
    new URL(
      "../../supabase/functions/_shared/__tests__/fixtures/dxcluster-telnet.txt",
      import.meta.url,
    ),
  ).split("\n");
  for (const l of fixture) {
    assertEquals(feed.isSpot(l), l.startsWith("DX de"), l);
  }
  const skimmer = "DX de SM1HEV-#: 14038.30  CT1JGA/P       CW     8 dB  24 WPM  CQ      1454Z";
  assertEquals(feed.isSpot(skimmer), false);
});

Deno.test("aprsFeed is off until APRS_LOGIN_CALL is set", function (): void {
  assertEquals(aprsFeed(env({})), null);
  assertEquals(aprsFeed(env({ APRS_LOGIN_CALL: "  " })), null);
});

Deno.test("aprsFeed holds the full feed on rotate.aprs2.net with a receive-only login", function (): void {
  const feed = aprsFeed(env({ APRS_LOGIN_CALL: " n0call-ll " }))!;
  assertEquals([feed.id, feed.host, feed.port], ["aprs", APRS_DEFAULT_HOST, APRS_DEFAULT_PORT]);
  assertEquals(APRS_DEFAULT_PORT, 10152);
  assertEquals(feed.functionName, "ingest-aprs");
  assertEquals(feed.telnet, false);
  assertEquals(feed.loginCall, "N0CALL-LL");
  // No filter command: the full feed is deliberate.
  let loginLine: string | undefined;
  if (feed.loginLine !== undefined) {
    loginLine = feed.loginLine("N0CALL-LL");
  }
  assertEquals(loginLine, "user N0CALL-LL pass -1 vers LongLines 0.1");
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

Deno.test("aprsLoginCall accepts a call or call-SSID of at most nine characters", function (): void {
  assertEquals(aprsLoginCall("kk4pwj-10"), "KK4PWJ-10");
  assertEquals(aprsLoginCall("N0CALL"), "N0CALL");
  for (
    const bad of ["", "N0CALL-LLL", "KK4PWJ-123", "N0 CALL", "N0CALL/P", "ABCDEFGHIJ", "AB-CD-1"]
  ) {
    assertThrows(() => aprsLoginCall(bad), ConfigError, "APRS_LOGIN_CALL", bad);
  }
  // Ten characters with an SSID is still too long.
  assertThrows(() => aprsLoginCall("KK4PWJA-10"), Error, "nine");
});

Deno.test("aprsFeed.isSpot accepts every fixture packet and no server comment", function (): void {
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
  function fn(input: string | URL | Request, init: RequestInit | undefined): Promise<Response> {
    requests.push(new Request(input, init));
    return Promise.resolve(new Response(body, { status }));
  }
  return { fn, requests };
}

Deno.test("functionClient POSTs a batch as JSON", async function (): Promise<void> {
  const f = fakeFetch(200, "{}");
  const lines = [{ line: "DX de ...", received_at: "2026-10-11T00:00:00Z" }];
  await functionClient({
    functionsUrl: "https://x",
    functionName: "ingest-rbn",
    secret: "s",
    fetchFn: f.fn,
  }).push(lines, undefined);
  const req = f.requests[0]!;
  assertEquals([req.method, req.url], ["POST", "https://x/ingest-rbn"]);
  assertEquals(req.headers.get("content-type"), "application/json");
  assertEquals(req.headers.get("x-relay-secret"), "s");
  const userAgent = req.headers.get("user-agent");
  assertEquals(userAgent !== null && userAgent.startsWith("LongLines/"), true);
  assertEquals(await req.json(), { lines });
});

Deno.test(
  "functionClient aborts the request when the caller's signal aborts",
  async function (): Promise<void> {
    const f = fakeFetch(200, "{}");
    const client = functionClient({
      functionsUrl: "https://x",
      functionName: "ingest-rbn",
      secret: "s",
      fetchFn: f.fn,
    });
    await client.push([], undefined);
    assertEquals(f.requests[0]!.signal.aborted, false);
    const stop = new AbortController();
    await client.push([], stop.signal);
    stop.abort();
    assertEquals(f.requests[1]!.signal.aborted, true);
  },
);

Deno.test("functionClient throws on non-2xx", async function (): Promise<void> {
  const client = functionClient({
    functionsUrl: "https://x",
    functionName: "ingest-rbn",
    secret: "s",
    fetchFn: fakeFetch(401, "{}").fn,
  });
  const error = await assertRejects(
    () => client.push([], undefined),
    FunctionCallError,
    "HTTP 401",
  );
  assertEquals(error.status, 401);
});

Deno.test("functionClient throws a ValidationError for a 2xx reply that is not JSON", async function (): Promise<
  void
> {
  const client = functionClient({
    functionsUrl: "https://x",
    functionName: "ingest-rbn",
    secret: "s",
    fetchFn: fakeFetch(200, "ok").fn,
  });
  const error = await assertRejects(
    () => client.push([], undefined),
    ValidationError,
    "FunctionPoster.post: ingest-rbn reply: not JSON",
  );
  assertEquals(error.cause instanceof SyntaxError, true);
});

Deno.test(
  "healthHandler is healthy while data is fresh and during the startup grace",
  async function (): Promise<void> {
    const started = new Date("2026-10-11T00:00:00Z");
    let now = new Date("2026-10-11T00:05:00Z");
    const status = { connected: true, lastDataAt: null as Date | null, connects: 1 };
    const handler = healthHandler(
      [{ id: "rbn", status, dropped: () => 3, buffered: () => 0, pushed: () => 7 }],
      started,
      10 * 60_000,
      () => now,
    );
    function get(path: string) {
      return handler(new Request(`http://x${path}`));
    }

    assertEquals(get("/healthz").status, 200); // no data yet, inside grace
    now = new Date("2026-10-11T00:11:00Z");
    assertEquals(get("/healthz").status, 503);
    status.lastDataAt = new Date("2026-10-11T00:10:30Z");
    const res = get("/healthz");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.feeds[0].dropped, 3);
    assertEquals(body.feeds[0].last_data_at, "2026-10-11T00:10:30.000Z");
    assertEquals(get("/").status, 404);
  },
);

Deno.test(
  "healthHandler uses a feed's own stale threshold when it sets one",
  async function (): Promise<void> {
    const started = new Date("2026-10-11T00:00:00Z");
    const lastDataAt = new Date("2026-10-11T00:00:00Z");
    function feed(id: string, staleMs: number | undefined): FeedHealth {
      const f: FeedHealth = {
        id,
        status: { connected: true, lastDataAt, connects: 1 },
        dropped: () => 0,
        buffered: () => 0,
        pushed: () => 0,
      };
      if (staleMs !== undefined) {
        f.staleMs = staleMs;
      }
      return f;
    }
    function now() {
      return new Date("2026-10-11T00:15:00Z");
    }
    const quiet = healthHandler([feed("dxcluster", 20 * 60_000)], started, 10 * 60_000, now);
    assertEquals(quiet(new Request("http://x/healthz")).status, 200);
    const both = healthHandler(
      [feed("rbn", undefined), feed("dxcluster", 20 * 60_000)],
      started,
      10 * 60_000,
      now,
    );
    const res = both(new Request("http://x/healthz"));
    assertEquals(res.status, 503);
    assertEquals((await res.json()).feeds.map((f: { healthy: boolean }) => f.healthy), [
      false,
      true,
    ]);
  },
);

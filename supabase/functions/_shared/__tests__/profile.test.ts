import { assertEquals, assertMatch } from "@std/assert";
import {
  clientIp,
  clientKey,
  handleProfile,
  INVALID_CALLSIGN,
  LOOKUP_UNAVAILABLE,
  MAX_LOOKUPS_PER_MINUTE,
  parseCallsign,
  PROFILE_CACHE_CONTROL,
  TOO_MANY_LOOKUPS,
} from "../profile.ts";
import { fakeSupabase, type FakeSupabaseOptions } from "./fake_supabase.ts";

const PROFILE = { callsign: "KK4PWJ", heard: null, license: null };

function get(query: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://x/callsign-profile${query}`, { headers });
}

async function run(req: Request, options: FakeSupabaseOptions = {}) {
  const fake = fakeSupabase({
    rpc: {
      record_profile_lookup: { data: 1 },
      cached_callsign_profile: { data: PROFILE },
      ...options.rpc,
    },
  });
  const res = await handleProfile(req, { db: () => fake.client });
  return { res, body: res.status === 204 ? null : await res.json(), calls: fake.calls };
}

Deno.test("parseCallsign uppercases and trims callsigns", () => {
  assertEquals(parseCallsign(" kk4pwj "), "KK4PWJ");
  assertEquals(parseCallsign("kk4pwj/p"), "KK4PWJ/P");
  assertEquals(parseCallsign("W4/KK4PWJ/QRP"), "W4/KK4PWJ/QRP");
  assertEquals(parseCallsign("4X1AB"), "4X1AB");
});

Deno.test("parseCallsign rejects what cannot be a callsign", () => {
  for (
    const raw of [
      null,
      "",
      "   ",
      "KKPWJ", // no digit
      "12345", // no letter
      "KK4PWJ/",
      "/KK4PWJ",
      "KK4 PWJ",
      "KK4PWJ-1",
      "A/B1/C/D",
      "K1" + "A".repeat(19),
      "<script>",
    ]
  ) {
    assertEquals(parseCallsign(raw), null, `${raw} should be rejected`);
  }
});

Deno.test("clientIp prefers the proxy's client header, then the first forwarded address", () => {
  const both = new Request("http://x/", {
    headers: { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1, 10.0.0.1" },
  });
  assertEquals(clientIp(both), "203.0.113.7");
  const forwarded = new Request("http://x/", {
    headers: { "x-forwarded-for": " 198.51.100.1 , 10.0.0.1" },
  });
  assertEquals(clientIp(forwarded), "198.51.100.1");
  assertEquals(clientIp(new Request("http://x/")), "unknown");
});

Deno.test("clientKey is a SHA-256 hex digest, never the address", async () => {
  const req = new Request("http://x/", { headers: { "x-forwarded-for": "198.51.100.1" } });
  const key = await clientKey(req);
  assertMatch(key, /^[0-9a-f]{64}$/);
  assertEquals(key.includes("198"), false);
  assertEquals(key, await clientKey(req));
});

Deno.test("handleProfile answers preflight and rejects other methods", async () => {
  const pre = await run(new Request("http://x/", { method: "OPTIONS" }));
  assertEquals(pre.res.status, 204);
  assertEquals(pre.res.headers.get("Access-Control-Allow-Methods")?.includes("GET"), true);
  const post = await run(new Request("http://x/?callsign=KK4PWJ", { method: "POST" }));
  assertEquals(post.res.status, 405);
  assertEquals(post.calls.rpc, []);
});

Deno.test("handleProfile returns 400 for invalid input without touching the database", async () => {
  for (const query of ["", "?callsign=", "?callsign=nope", "?call=KK4PWJ"]) {
    const { res, body, calls } = await run(get(query));
    assertEquals(res.status, 400, query);
    assertEquals(body, { error: INVALID_CALLSIGN });
    assertEquals(calls.rpc, []);
  }
});

Deno.test("handleProfile returns the cached profile with a public Cache-Control", async () => {
  const { res, body, calls } = await run(
    get("?callsign=kk4pwj/p", { "x-forwarded-for": "198.51.100.1" }),
  );
  assertEquals(res.status, 200);
  assertEquals(body, PROFILE);
  assertEquals(res.headers.get("Cache-Control"), PROFILE_CACHE_CONTROL);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals(calls.rpc.map((c) => c.fn), ["record_profile_lookup", "cached_callsign_profile"]);
  assertEquals(calls.rpc[0]?.args, {
    p_client: await clientKey(
      new Request("http://x/", {
        headers: { "x-forwarded-for": "198.51.100.1" },
      }),
    ),
  });
  assertEquals(calls.rpc[1]?.args, { p_callsign: "KK4PWJ/P" });
});

Deno.test("handleProfile allows 30 lookups a minute and refuses the 31st", async () => {
  const last = await run(get("?callsign=KK4PWJ"), {
    rpc: { record_profile_lookup: { data: MAX_LOOKUPS_PER_MINUTE } },
  });
  assertEquals(last.res.status, 200);

  const over = await run(get("?callsign=KK4PWJ"), {
    rpc: { record_profile_lookup: { data: MAX_LOOKUPS_PER_MINUTE + 1 } },
  });
  assertEquals(over.res.status, 429);
  assertEquals(over.body, { error: TOO_MANY_LOOKUPS });
  assertEquals(over.res.headers.get("Retry-After"), "60");
  assertEquals(over.res.headers.get("Cache-Control"), null);
  assertEquals(over.calls.rpc.map((c) => c.fn), ["record_profile_lookup"]);
});

Deno.test("handleProfile returns 500 when the rate limit or the profile fails", async () => {
  const limit = await run(get("?callsign=KK4PWJ"), {
    rpc: { record_profile_lookup: { error: { message: "down" } } },
  });
  assertEquals(limit.res.status, 500);
  assertEquals(limit.body, { error: LOOKUP_UNAVAILABLE });
  assertEquals(limit.calls.rpc.map((c) => c.fn), ["record_profile_lookup"]);

  const profile = await run(get("?callsign=KK4PWJ"), {
    rpc: { cached_callsign_profile: { error: { message: "timeout" } } },
  });
  assertEquals(profile.res.status, 500);
  assertEquals(profile.body, { error: LOOKUP_UNAVAILABLE });
  assertEquals(profile.res.headers.get("Cache-Control"), null);

  const empty = await run(get("?callsign=KK4PWJ"), {
    rpc: { cached_callsign_profile: { data: null } },
  });
  assertEquals(empty.res.status, 500);
});

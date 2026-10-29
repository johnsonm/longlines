import { assertEquals } from "@std/assert";
import {
  clientSubject,
  handleProfile,
  INVALID_CALLSIGN,
  LOOKUP_UNAVAILABLE,
  MAX_LOOKUPS_PER_MINUTE,
  parseCallsign,
  PROFILE_CACHE_CONTROL,
  TOO_MANY_LOOKUPS,
} from "../handlers/callsign_profile.ts";
import { rateLimitSubject } from "../client_address.ts";
import { hmacKey, hmacSha256Hex } from "../hmac.ts";
import { fakeSupabase, type FakeSupabaseOptions } from "./fake_supabase.ts";

const PROFILE = { callsign: "KK4PWJ", heard: null, license: null };
const KEY = await hmacKey("test-secret");
function clientKey(subject: string): Promise<string> {
  return hmacSha256Hex(KEY, subject);
}

function get(query: string, headers: Record<string, string>): Request {
  return new Request(`http://x/callsign-profile${query}`, { headers });
}

async function run(
  req: Request,
  options: FakeSupabaseOptions,
  key: CryptoKey | undefined,
  clientIpHeader: string | undefined,
) {
  const rpc: NonNullable<FakeSupabaseOptions["rpc"]> = {
    record_profile_lookup: { data: 1 },
    cached_callsign_profile: { data: PROFILE },
  };
  if (options.rpc !== undefined) {
    for (const entry of Object.entries(options.rpc)) {
      rpc[entry[0]] = entry[1];
    }
  }
  const fake = fakeSupabase({ rpc });
  const res = await handleProfile(req, {
    db: () => fake.client,
    clientIpHeader,
    key,
  });
  let body: unknown = null;
  if (res.status !== 204) {
    body = await res.json();
  }
  return { res, body, calls: fake.calls };
}

Deno.test("parseCallsign uppercases and trims callsigns", function (): void {
  assertEquals(parseCallsign(" kk4pwj "), "KK4PWJ");
  assertEquals(parseCallsign("kk4pwj/p"), "KK4PWJ/P");
  assertEquals(parseCallsign("W4/KK4PWJ/QRP"), "W4/KK4PWJ/QRP");
  assertEquals(parseCallsign("4X1AB"), "4X1AB");
});

Deno.test("parseCallsign rejects what cannot be a callsign", function (): void {
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

Deno.test(
  "clientSubject prefers the trusted header, then the address the nearest proxy appended",
  function (): void {
    const both = new Request("http://x/", {
      headers: { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1, 10.0.0.1" },
    });
    assertEquals(clientSubject(both, "cf-connecting-ip"), {
      subject: "203.0.113.7",
      trusted: true,
    });
    assertEquals(clientSubject(both, "x-real-ip"), { subject: "10.0.0.1", trusted: false });
    // The first entry is whatever the client sent, so it is never the key.
    const spoofed = new Request("http://x/", {
      headers: { "x-forwarded-for": " 1.2.3.4 , 198.51.100.1 " },
    });
    assertEquals(clientSubject(spoofed, "cf-connecting-ip").subject, "198.51.100.1");
    // A list-valued trusted header gives its last entry, never the client-written first one.
    assertEquals(clientSubject(spoofed, "x-forwarded-for"), {
      subject: "198.51.100.1",
      trusted: true,
    });
    assertEquals(clientSubject(new Request("http://x/"), "cf-connecting-ip"), {
      subject: "unknown",
      trusted: false,
    });
  },
);

Deno.test("clientSubject ignores a trusted header that is not an address", function (): void {
  const junk = new Request("http://x/", {
    headers: { "cf-connecting-ip": "not-an-ip", "x-forwarded-for": "198.51.100.1" },
  });
  assertEquals(clientSubject(junk, "cf-connecting-ip"), {
    subject: "198.51.100.1",
    trusted: false,
  });
  const nothing = new Request("http://x/", { headers: { "x-forwarded-for": "garbage" } });
  assertEquals(clientSubject(nothing, "cf-connecting-ip").subject, "unknown");
});

Deno.test("rateLimitSubject keys IPv4 by address and IPv6 by /64", function (): void {
  assertEquals(rateLimitSubject(" 198.51.100.1 "), "198.51.100.1");
  assertEquals(rateLimitSubject("198.51.100.1:443"), "198.51.100.1");
  assertEquals(rateLimitSubject("2001:db8:aa:bb:1:2:3:4"), "2001:db8:aa:bb::/64");
  // Every address in one /64 is one client.
  assertEquals(rateLimitSubject("2001:DB8:AA:BB::99"), "2001:db8:aa:bb::/64");
  assertEquals(rateLimitSubject("[2001:db8::1]:443"), "2001:db8:0:0::/64");
  assertEquals(rateLimitSubject("fe80::1%eth0"), "fe80:0:0:0::/64");
  assertEquals(rateLimitSubject("::1"), "0:0:0:0::/64");
  assertEquals(rateLimitSubject("::ffff:198.51.100.1"), "198.51.100.1");
  assertEquals(rateLimitSubject("64:ff9b::198.51.100.1"), "64:ff9b:0:0::/64");
  for (
    const raw of [
      "",
      "unknown",
      "256.1.1.1",
      "1.2.3",
      "1.2.3.4.5",
      "2001:db8::1::2",
      "2001:db8:1:2:3:4:5:6:7",
      "2001:db8:1:2:3:4:5",
      "12345::1",
      "::ffff:999.1.1.1",
    ]
  ) {
    assertEquals(rateLimitSubject(raw), null, raw);
  }
});

Deno.test(
  "handleProfile answers preflight and rejects other methods",
  async function (): Promise<void> {
    const pre = await run(new Request("http://x/", { method: "OPTIONS" }), {}, KEY, undefined);
    assertEquals(pre.res.status, 204);
    assertEquals(pre.res.headers.get("Access-Control-Allow-Methods")!.includes("GET"), true);
    const post = await run(
      new Request("http://x/?callsign=KK4PWJ", { method: "POST" }),
      {},
      KEY,
      undefined,
    );
    assertEquals(post.res.status, 405);
    assertEquals(post.calls.rpc, []);
  },
);

Deno.test(
  "handleProfile returns 400 for invalid input without touching the database",
  async function (): Promise<void> {
    for (const query of ["", "?callsign=", "?callsign=nope", "?call=KK4PWJ"]) {
      const result = await run(get(query, {}), {}, KEY, undefined);
      assertEquals(result.res.status, 400, query);
      assertEquals(result.body, { error: INVALID_CALLSIGN });
      assertEquals(result.calls.rpc, []);
    }
  },
);

Deno.test(
  "handleProfile returns the cached profile with a public Cache-Control",
  async function (): Promise<void> {
    const result = await run(
      get("?callsign=kk4pwj/p", { "cf-connecting-ip": "198.51.100.1" }),
      {},
      KEY,
      undefined,
    );
    assertEquals(result.res.status, 200);
    assertEquals(result.body, PROFILE);
    assertEquals(result.res.headers.get("Cache-Control"), PROFILE_CACHE_CONTROL);
    assertEquals(result.res.headers.get("Access-Control-Allow-Origin"), "*");
    assertEquals(result.calls.rpc.map((c) => c.fn), [
      "record_profile_lookup",
      "cached_callsign_profile",
    ]);
    assertEquals(result.calls.rpc[0]!.args, { p_client: await clientKey("198.51.100.1") });
    assertEquals(result.calls.rpc[1]!.args, { p_callsign: "KK4PWJ/P" });
  },
);

Deno.test(
  "handleProfile allows 30 lookups a minute and refuses the 31st",
  async function (): Promise<void> {
    const last = await run(
      get("?callsign=KK4PWJ", {}),
      {
        rpc: { record_profile_lookup: { data: MAX_LOOKUPS_PER_MINUTE } },
      },
      KEY,
      undefined,
    );
    assertEquals(last.res.status, 200);

    const over = await run(
      get("?callsign=KK4PWJ", {}),
      {
        rpc: { record_profile_lookup: { data: MAX_LOOKUPS_PER_MINUTE + 1 } },
      },
      KEY,
      undefined,
    );
    assertEquals(over.res.status, 429);
    assertEquals(over.body, { error: TOO_MANY_LOOKUPS });
    assertEquals(over.res.headers.get("Retry-After"), "60");
    assertEquals(over.res.headers.get("Cache-Control"), null);
    assertEquals(over.calls.rpc.map((c) => c.fn), ["record_profile_lookup"]);
  },
);

Deno.test(
  "handleProfile returns 500 when the rate limit or the profile fails",
  async function (): Promise<void> {
    const limit = await run(
      get("?callsign=KK4PWJ", {}),
      {
        rpc: { record_profile_lookup: { error: { message: "down" } } },
      },
      KEY,
      undefined,
    );
    assertEquals(limit.res.status, 500);
    assertEquals(limit.body, { error: LOOKUP_UNAVAILABLE });
    assertEquals(limit.calls.rpc.map((c) => c.fn), ["record_profile_lookup"]);

    // A result that is not a count fails closed rather than skipping the limit.
    for (const data of [null, "31", { lookups: 31 }]) {
      const odd = await run(
        get("?callsign=KK4PWJ", {}),
        { rpc: { record_profile_lookup: { data } } },
        KEY,
        undefined,
      );
      assertEquals(odd.res.status, 500, JSON.stringify(data));
      assertEquals(odd.calls.rpc.map((c) => c.fn), ["record_profile_lookup"]);
    }

    const profile = await run(
      get("?callsign=KK4PWJ", {}),
      {
        rpc: { cached_callsign_profile: { error: { message: "timeout" } } },
      },
      KEY,
      undefined,
    );
    assertEquals(profile.res.status, 500);
    assertEquals(profile.body, { error: LOOKUP_UNAVAILABLE });
    assertEquals(profile.res.headers.get("Cache-Control"), null);

    // A profile is an object or null; anything else is a broken read.
    const odd = await run(
      get("?callsign=KK4PWJ", {}),
      { rpc: { cached_callsign_profile: { data: "KK4PWJ" } } },
      KEY,
      undefined,
    );
    assertEquals([odd.res.status, odd.body], [500, { error: LOOKUP_UNAVAILABLE }]);

    const fake = fakeSupabase({});
    const unset = await handleProfile(get("?callsign=KK4PWJ", {}), {
      db: () => fake.client,
      clientIpHeader: undefined,
      key: undefined,
    });
    assertEquals(unset.status, 500);
    assertEquals(fake.calls.rpc, []);
  },
);

Deno.test(
  "handleProfile returns 400 when SQL finds no base call in the input",
  async function (): Promise<void> {
    const result = await run(
      get("?callsign=P/1", {}),
      {
        rpc: { cached_callsign_profile: { data: null } },
      },
      KEY,
      undefined,
    );
    assertEquals(result.res.status, 400);
    assertEquals(result.body, { error: INVALID_CALLSIGN });
    assertEquals(result.res.headers.get("Cache-Control"), null);
    assertEquals(result.calls.rpc[1]!.args, { p_callsign: "P/1" });
  },
);

Deno.test(
  "handleProfile keys the limit on the configured header, warning once when it falls back",
  async function (): Promise<void> {
    const warn = console.warn;
    const warnings: unknown[] = [];
    console.warn = (...args: unknown[]) => warnings.push(args[0]);
    try {
      const custom = await run(
        get("?callsign=KK4PWJ", { "x-real-ip": "2001:db8:aa:bb::7" }),
        {},
        KEY,
        " x-real-ip ",
      );
      assertEquals(custom.calls.rpc[0]!.args, { p_client: await clientKey("2001:db8:aa:bb::/64") });
      assertEquals(warnings, []);

      // A header no other test uses: the warning is once per isolate and header.
      for (let i = 0; i < 2; i++) {
        const fallback = await run(
          get("?callsign=KK4PWJ", { "x-forwarded-for": "198.51.100.9" }),
          {},
          KEY,
          "x-once-ip",
        );
        assertEquals(fallback.res.status, 200);
        assertEquals(fallback.calls.rpc[0]!.args, { p_client: await clientKey("198.51.100.9") });
      }
      assertEquals(warnings.length, 1);
      assertEquals(String(warnings[0]).includes("no client address in x-once-ip"), true);
    } finally {
      console.warn = warn;
    }
  },
);

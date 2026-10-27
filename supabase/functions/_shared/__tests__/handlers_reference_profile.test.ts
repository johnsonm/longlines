import { assertEquals } from "@std/assert";
import {
  handleReferenceProfile,
  parseProgram,
  parseReference,
  REFERENCE_NOT_FOUND,
  REFERENCE_UNAVAILABLE,
  referenceProfileSchema,
} from "../handlers/reference_profile.ts";
import {
  MAX_LOOKUPS_PER_MINUTE,
  PROFILE_CACHE_CONTROL,
  TOO_MANY_LOOKUPS,
} from "../handlers/callsign_profile.ts";
import { hmacKey, hmacSha256Hex } from "../hmac.ts";
import { fakeSupabase, type FakeSupabaseOptions } from "./fake_supabase.ts";

// Every key of ReferenceProfile (web/src/references/types.ts), each list with one item.
const PROFILE = {
  program: "pota",
  reference: "US-2763",
  sourceUrl: "https://pota.app/#/park/US-2763",
  catalog: {
    name: "Mount Mitchell State Park",
    active: true,
    location: "US-NC",
    association: null,
    region: null,
    country: null,
    latitude: 35.765,
    longitude: -82.2652,
    grid: "EM85",
    altitudeM: null,
    points: null,
    validFrom: null,
    validTo: null,
  },
  totals: { activations: 412, activators: 168, spots: 9120 },
  firstActivation: { day: "2025-11-02", callsign: "KK4PWJ", base: "KK4PWJ" },
  last: {
    callsign: "KK4PWJ/P",
    base: "KK4PWJ",
    time: "2026-10-26T18:51:00Z",
    frequencyKhz: 14062,
    mode: "CW",
    band: "20m",
    source: "pota",
    today: { spots: 18, bands: ["20m", "40m"] },
  },
  calendar: {
    days: [{ day: "2026-10-26", activators: ["KK4PWJ"] }],
    periods: [{
      period: "past",
      from: "2025-10-27",
      to: "2026-10-26",
      days: 365,
      activations: 1,
      daysActivated: 1,
      longestStreak: 1,
      busiest: { day: "2026-10-26", activators: 1 },
    }],
  },
  monthly: [{ month: "2026-10", activations: 1 }],
  bands: [{ band: "20m", spots: 18 }],
  modes: [{ label: "CW", spots: 18, percent: 100 }],
  topActivators: [{ callsign: "KK4PWJ", base: "KK4PWJ", activations: 1, lastDay: "2026-10-26" }],
  recentActivations: [{
    day: "2026-10-26",
    callsign: "KK4PWJ",
    base: "KK4PWJ",
    spots: 18,
    bands: ["20m"],
    modes: ["CW"],
  }],
  recentSpots: [{
    time: "2026-10-26T18:51:00Z",
    callsign: "KK4PWJ/P",
    base: "KK4PWJ",
    frequencyKhz: 14062,
    mode: "CW",
    band: "20m",
    spotter: "W1AW",
    comment: null,
    source: "pota",
  }],
};

// A reference outside the list that was spotted, and never activated: every nullable key null.
const UNLISTED = {
  program: "wwff",
  reference: "KFF-99999",
  sourceUrl: null,
  catalog: null,
  totals: { activations: 0, activators: 0, spots: 0 },
  firstActivation: null,
  last: null,
  calendar: { days: [], periods: [] },
  monthly: [],
  bands: [],
  modes: [],
  topActivators: [],
  recentActivations: [],
  recentSpots: [],
};

const KEY = await hmacKey("test-secret");

/** A copy of PROFILE with the value at path (keys, list indexes as strings) set. */
function changed(path: string[], value: unknown): Record<string, unknown> {
  const copy = structuredClone(PROFILE) as unknown as Record<string, unknown>;
  let at = copy;
  for (const key of path.slice(0, -1)) {
    at = at[key] as Record<string, unknown>;
  }
  at[path.at(-1)!] = value;
  return copy;
}

function get(query: string, headers: Record<string, string>): Request {
  return new Request(`http://x/reference-profile${query}`, { headers });
}

// null for no key, so each call passes the key explicitly.
async function run(req: Request, options: FakeSupabaseOptions, key: CryptoKey | null) {
  const rpc: NonNullable<FakeSupabaseOptions["rpc"]> = {
    record_profile_lookup: { data: 1 },
    cached_reference_profile: { data: PROFILE },
  };
  if (options.rpc !== undefined) {
    for (const entry of Object.entries(options.rpc)) {
      rpc[entry[0]] = entry[1];
    }
  }
  const fake = fakeSupabase({ rpc });
  let hmac: CryptoKey | undefined;
  if (key !== null) {
    hmac = key;
  }
  const res = await handleReferenceProfile(req, {
    db: () => fake.client,
    clientIpHeader: undefined,
    key: hmac,
  });
  let body: unknown = null;
  if (res.status !== 204) {
    body = await res.json();
  }
  return { res, body, calls: fake.calls };
}

/** Runs fn with console.error captured, returning what it logged. */
async function capturingErrors(fn: () => Promise<void>): Promise<string[]> {
  const error = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => logged.push(String(args[0]));
  try {
    await fn();
  } finally {
    console.error = error;
  }
  return logged;
}

Deno.test("parseProgram takes the three programs with a list, in any case", function (): void {
  assertEquals(parseProgram("pota"), "pota");
  assertEquals(parseProgram(" SOTA "), "sota");
  assertEquals(parseProgram("Wwff"), "wwff");
  for (const raw of [null, "", "iota", "bota", "wwbota", "pota2", "po ta"]) {
    assertEquals(parseProgram(raw), null, `${raw} should be rejected`);
  }
});

Deno.test("parseReference uppercases and trims references", function (): void {
  assertEquals(parseReference(" us-2763 "), "US-2763");
  assertEquals(parseReference("w4c/cm-001"), "W4C/CM-001");
  assertEquals(parseReference("KFF-6101"), "KFF-6101");
  assertEquals(parseReference("A".repeat(64)), "A".repeat(64));
});

Deno.test("parseReference rejects what cannot be a reference", function (): void {
  for (
    const raw of [
      null,
      "",
      "   ",
      "US 2763",
      "US_2763",
      "US-2763%",
      "<script>",
      "US-2763?x=1",
      "A".repeat(65),
    ]
  ) {
    assertEquals(parseReference(raw), null, `${raw} should be rejected`);
  }
});

Deno.test("referenceProfileSchema reads the whole contract", function (): void {
  assertEquals(referenceProfileSchema.safeParse(PROFILE).success, true);
  assertEquals(referenceProfileSchema.safeParse(UNLISTED).success, true);
  // A key added by a later deploy is kept, not refused.
  const later = referenceProfileSchema.safeParse(changed(["extra"], 1));
  assertEquals(later.success, true);
  // A program without a list, a missing section or a wrong type is a broken read.
  for (
    const broken of [
      changed(["program"], "iota"),
      changed(["totals"], undefined),
      changed(["calendar"], { days: [] }),
      changed(["last", "today", "spots"], "18"),
      changed(["catalog", "active"], null),
      changed(["recentSpots", "0", "spotter"], null),
    ]
  ) {
    assertEquals(referenceProfileSchema.safeParse(broken).success, false, JSON.stringify(broken));
  }
});

Deno.test(
  "reference-profile returns the cached profile with a public Cache-Control",
  async function (): Promise<void> {
    const result = await run(
      get("?program=POTA&reference=us-2763", { "cf-connecting-ip": "192.0.2.7" }),
      {},
      KEY,
    );
    assertEquals(result.res.status, 200);
    assertEquals(result.body, PROFILE);
    assertEquals(result.res.headers.get("Cache-Control"), PROFILE_CACHE_CONTROL);
    assertEquals(result.res.headers.get("Access-Control-Allow-Origin"), "*");
    assertEquals(result.calls.rpc, [
      { fn: "record_profile_lookup", args: { p_client: await hmacSha256Hex(KEY, "192.0.2.7") } },
      { fn: "cached_reference_profile", args: { p_program: "pota", p_reference: "US-2763" } },
    ]);
  },
);

Deno.test(
  "reference-profile passes a SOTA summit with its slash and serves an unlisted reference",
  async function (): Promise<void> {
    const sota = await run(get("?program=sota&reference=W4C%2FCM-001", {}), {}, KEY);
    assertEquals(sota.res.status, 200);
    assertEquals(sota.calls.rpc[1], {
      fn: "cached_reference_profile",
      args: { p_program: "sota", p_reference: "W4C/CM-001" },
    });

    const unlisted = await run(
      get("?program=wwff&reference=KFF-99999", {}),
      { rpc: { cached_reference_profile: { data: UNLISTED } } },
      KEY,
    );
    assertEquals(unlisted.res.status, 200);
    assertEquals(unlisted.body, UNLISTED);
  },
);

Deno.test(
  "reference-profile answers a malformed pair with the 404 before touching the database",
  async function (): Promise<void> {
    for (
      const query of [
        "",
        "?program=pota",
        "?reference=US-2763",
        "?program=&reference=US-2763",
        "?program=iota&reference=EU-005",
        "?program=pota&reference=",
        "?program=pota&reference=US%202763",
        `?program=pota&reference=${"A".repeat(65)}`,
      ]
    ) {
      const result = await run(get(query, {}), {}, KEY);
      assertEquals(result.res.status, 404, query);
      assertEquals(result.body, { error: REFERENCE_NOT_FOUND }, query);
      assertEquals(result.res.headers.get("Cache-Control"), null, query);
      assertEquals(result.calls.rpc, [], query);
    }
  },
);

Deno.test(
  "reference-profile answers a reference in neither the list nor any spot with the same 404",
  async function (): Promise<void> {
    const result = await run(
      get("?program=pota&reference=US-99999", {}),
      { rpc: { cached_reference_profile: { data: null } } },
      KEY,
    );
    assertEquals(result.res.status, 404);
    assertEquals(result.body, { error: REFERENCE_NOT_FOUND });
    assertEquals(result.res.headers.get("Cache-Control"), null);
    assertEquals(result.calls.rpc.map((c) => c.fn), [
      "record_profile_lookup",
      "cached_reference_profile",
    ]);
  },
);

Deno.test(
  "reference-profile is GET only and answers the CORS preflight",
  async function (): Promise<void> {
    const post = await run(
      new Request("http://x/reference-profile?program=pota&reference=US-2763", { method: "POST" }),
      {},
      KEY,
    );
    assertEquals(post.res.status, 405);
    assertEquals(post.calls.rpc, []);
    const pre = await run(
      new Request("http://x/reference-profile", { method: "OPTIONS" }),
      {},
      KEY,
    );
    assertEquals(pre.res.status, 204);
    assertEquals(pre.res.headers.get("Access-Control-Allow-Methods")!.includes("GET"), true);
    assertEquals(pre.calls.rpc, []);
  },
);

Deno.test(
  "reference-profile shares the profile's rate limit",
  async function (): Promise<void> {
    const last = await run(
      get("?program=pota&reference=US-2763", {}),
      { rpc: { record_profile_lookup: { data: MAX_LOOKUPS_PER_MINUTE } } },
      KEY,
    );
    assertEquals(last.res.status, 200);

    const over = await run(
      get("?program=pota&reference=US-2763", {}),
      { rpc: { record_profile_lookup: { data: MAX_LOOKUPS_PER_MINUTE + 1 } } },
      KEY,
    );
    assertEquals(over.res.status, 429);
    assertEquals(over.body, { error: TOO_MANY_LOOKUPS });
    assertEquals(over.res.headers.get("Retry-After"), "60");
    assertEquals(over.res.headers.get("Cache-Control"), null);
    assertEquals(over.calls.rpc.map((c) => c.fn), ["record_profile_lookup"]);
  },
);

Deno.test(
  "reference-profile fails closed when the limit can't be read or the key is unset",
  async function (): Promise<void> {
    const logged = await capturingErrors(async function (): Promise<void> {
      const down = await run(
        get("?program=pota&reference=US-2763", {}),
        { rpc: { record_profile_lookup: { error: { message: "down" } } } },
        KEY,
      );
      assertEquals([down.res.status, down.body], [500, { error: REFERENCE_UNAVAILABLE }]);
      assertEquals(down.calls.rpc.map((c) => c.fn), ["record_profile_lookup"]);

      const odd = await run(
        get("?program=pota&reference=US-2763", {}),
        { rpc: { record_profile_lookup: { data: "31" } } },
        KEY,
      );
      assertEquals(odd.res.status, 500);
      assertEquals(odd.calls.rpc.map((c) => c.fn), ["record_profile_lookup"]);

      const unset = await run(get("?program=pota&reference=US-2763", {}), {}, null);
      assertEquals([unset.res.status, unset.body], [500, { error: REFERENCE_UNAVAILABLE }]);
      assertEquals(unset.calls.rpc, []);
    });
    assertEquals(logged.length, 3);
  },
);

Deno.test(
  "reference-profile reports a failed or broken read without the reference",
  async function (): Promise<void> {
    const logged = await capturingErrors(async function (): Promise<void> {
      const failed = await run(
        get("?program=pota&reference=US-2763", {}),
        { rpc: { cached_reference_profile: { error: { message: "timeout" } } } },
        KEY,
      );
      assertEquals([failed.res.status, failed.body], [500, { error: REFERENCE_UNAVAILABLE }]);
      assertEquals(failed.res.headers.get("Cache-Control"), null);

      for (const data of ["US-2763", changed(["totals"], null)]) {
        const broken = await run(
          get("?program=pota&reference=US-2763", {}),
          { rpc: { cached_reference_profile: { data } } },
          KEY,
        );
        assertEquals([broken.res.status, broken.body], [500, { error: REFERENCE_UNAVAILABLE }]);
      }
    });
    assertEquals(logged.length, 3);
    assertEquals(logged[0], "reference-profile: timeout");
    for (const line of logged) {
      assertEquals(line.startsWith("reference-profile: "), true, line);
      assertEquals(line.includes("US-2763"), false, line);
    }
  },
);

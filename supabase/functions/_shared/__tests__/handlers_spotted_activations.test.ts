import { assertEquals } from "@std/assert";
import {
  ACTIVATION_NOT_FOUND,
  ACTIVATIONS_UNAVAILABLE,
  callsignActivationsSchema,
  handleSpottedActivations,
  parseActivationId,
  spottedActivationSchema,
} from "../handlers/spotted_activations.ts";
import {
  INVALID_CALLSIGN,
  MAX_LOOKUPS_PER_MINUTE,
  PROFILE_CACHE_CONTROL,
  TOO_MANY_LOOKUPS,
} from "../handlers/callsign_profile.ts";
import { hmacKey, hmacSha256Hex } from "../hmac.ts";
import { fakeSupabase, type FakeSupabaseOptions } from "./fake_supabase.ts";

// spotted_activation and callsign_spotted_activations' real replies on the local seed
// (supabase/seed.sql, assembled by its closing passes): a POTA two-fer with RBN and DX Cluster
// spots, both halves of a midnight split, a single spot, a WWFF activation heard in two
// countries, a SOTA activation with a null spotter, a WWBOTA activation of three bunkers (names
// null past the first) and an IOTA one (no location); KK4PWJ's list and an empty one.
const CAPTURED = JSON.parse(
  Deno.readTextFileSync(new URL("./fixtures/spotted-activations.json", import.meta.url)),
) as { activations: Record<string, unknown>; lists: Record<string, unknown> };

const ACTIVATION = CAPTURED.activations.twofer as Record<string, unknown>;
const LIST = CAPTURED.lists.kk4pwj as Record<string, unknown>;
const ID = ACTIVATION.id as string;
const NOW = new Date("2026-11-01T12:00:00Z");
const KEY = await hmacKey("test-secret");

/** A copy of `of` with the value at path (keys, list indexes as strings) set. */
function changed(
  of: Record<string, unknown>,
  path: string[],
  value: unknown,
): Record<string, unknown> {
  const copy = structuredClone(of);
  let at = copy;
  for (const key of path.slice(0, -1)) {
    at = at[key] as Record<string, unknown>;
  }
  at[path.at(-1)!] = value;
  return copy;
}

function get(query: string, headers: Record<string, string>): Request {
  return new Request(`http://x/spotted-activations${query}`, { headers });
}

// null for no key, so each call passes the key explicitly.
async function run(req: Request, options: FakeSupabaseOptions, key: CryptoKey | null) {
  const rpc: NonNullable<FakeSupabaseOptions["rpc"]> = {
    record_profile_lookup: { data: 1 },
    spotted_activation: { data: ACTIVATION },
    callsign_spotted_activations: { data: LIST },
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
  const res = await handleSpottedActivations(req, {
    db: () => fake.client,
    clientIpHeader: undefined,
    key: hmac,
  }, NOW);
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

Deno.test("parseActivationId takes only new_activation_id()'s shape", function (): void {
  assertEquals(parseActivationId("kjw2khkyj47f"), "kjw2khkyj47f");
  assertEquals(parseActivationId("abcdefgh2345"), "abcdefgh2345");
  for (
    const raw of [
      null,
      "",
      "kjw2khkyj47",
      "kjw2khkyj47fa",
      "KJW2KHKYJ47F",
      "kjw2khkyj470",
      "kjw2khkyj418",
      " kjw2khkyj47f",
      "kjw2khkyj47f ",
      "kjw2-hkyj47f",
    ]
  ) {
    assertEquals(parseActivationId(raw), null, `${raw} should be rejected`);
  }
});

Deno.test("the schemas read every captured reply", function (): void {
  const activations = Object.entries(CAPTURED.activations);
  assertEquals(activations.map((entry) => entry[0]).sort(), [
    "continued",
    "countries",
    "iota",
    "null_spotter",
    "single",
    "split",
    "twofer",
    "wwbota",
  ]);
  const programs = new Set<string>();
  const sources = new Set<string>();
  let located = 0;
  let nullSpotters = 0;
  let nullNames = 0;
  for (const entry of activations) {
    const parsed = spottedActivationSchema.safeParse(entry[1]);
    assertEquals(parsed.success, true, `${entry[0]}: ${JSON.stringify(parsed.error)}`);
    const activation = parsed.data!;
    programs.add(activation.program);
    for (const spot of activation.spots) {
      sources.add(spot.source);
      if (spot.spotter === null) {
        nullSpotters += 1;
      }
    }
    if (activation.location !== null) {
      located += 1;
    }
    nullNames += activation.referenceNames.filter((name) => name === null).length;
  }
  assertEquals(Array.from(programs).sort(), ["iota", "pota", "sota", "wwbota", "wwff"]);
  assertEquals(Array.from(sources).sort(), [
    "dxcluster",
    "pota",
    "rbn",
    "sotawatch",
    "wwbota",
    "wwff",
  ]);
  assertEquals([located > 0, located < activations.length], [true, true]);
  assertEquals([nullSpotters > 0, nullNames > 0], [true, true]);

  const split = spottedActivationSchema.parse(CAPTURED.activations.split);
  const continued = spottedActivationSchema.parse(CAPTURED.activations.continued);
  assertEquals(split.split.continuedFrom, continued.id);
  assertEquals(continued.split.continuedBy, split.id);
  const countries = spottedActivationSchema.parse(CAPTURED.activations.countries);
  assertEquals(countries.farthest !== null && countries.farthest.kind === "country", true);

  for (const entry of Object.entries(CAPTURED.lists)) {
    const parsed = callsignActivationsSchema.safeParse(entry[1]);
    assertEquals(parsed.success, true, `${entry[0]}: ${JSON.stringify(parsed.error)}`);
  }
  const list = callsignActivationsSchema.parse(LIST);
  assertEquals(list.callsign, "KK4PWJ");
  assertEquals(list.recent.length > 0, true);
  assertEquals(list.summary.mostActivated !== null, true);
  assertEquals(list.recent.some((card) => card.continuedFrom !== null), true);
  const none = callsignActivationsSchema.parse(CAPTURED.lists.none);
  assertEquals([none.recent, none.summary.mostActivated, none.more], [[], null, false]);
});

Deno.test("the schemas keep new keys and refuse a broken reply", function (): void {
  assertEquals(spottedActivationSchema.safeParse(changed(ACTIVATION, ["extra"], 1)).success, true);
  assertEquals(callsignActivationsSchema.safeParse(changed(LIST, ["extra"], 1)).success, true);
  for (
    const broken of [
      changed(ACTIVATION, ["program"], "bota"),
      changed(ACTIVATION, ["references"], null),
      changed(ACTIVATION, ["split"], undefined),
      changed(ACTIVATION, ["split", "continuedBy"], 1),
      changed(ACTIVATION, ["location", "latitude"], "35.67"),
      changed(ACTIVATION, ["sources", "rbn"], "3"),
      changed(ACTIVATION, ["heard", "0", "kind"], "county"),
      changed(ACTIVATION, ["farthest", "km"], null),
      changed(ACTIVATION, ["spots", "0", "selfSpot"], null),
      changed(ACTIVATION, ["spots", "0", "frequencyKhz"], "14239.1"),
    ]
  ) {
    assertEquals(spottedActivationSchema.safeParse(broken).success, false, JSON.stringify(broken));
  }
  for (
    const broken of [
      changed(LIST, ["more"], "false"),
      changed(LIST, ["summary", "references", "iota"], undefined),
      changed(LIST, ["summary", "mostActivated", "times"], null),
      changed(LIST, ["recent", "0", "states"], "2"),
      changed(LIST, ["recent", "0", "program"], "rbn"),
    ]
  ) {
    assertEquals(
      callsignActivationsSchema.safeParse(broken).success,
      false,
      JSON.stringify(broken),
    );
  }
});

Deno.test(
  "spotted-activations returns an activation with a public Cache-Control",
  async function (): Promise<void> {
    const result = await run(get(`?id=${ID}`, { "cf-connecting-ip": "192.0.2.7" }), {}, KEY);
    assertEquals(result.res.status, 200);
    assertEquals(result.body, ACTIVATION);
    assertEquals(result.res.headers.get("Cache-Control"), PROFILE_CACHE_CONTROL);
    assertEquals(result.res.headers.get("Access-Control-Allow-Origin"), "*");
    assertEquals(result.calls.rpc, [
      { fn: "record_profile_lookup", args: { p_client: await hmacSha256Hex(KEY, "192.0.2.7") } },
      { fn: "spotted_activation", args: { p_id: ID } },
    ]);
  },
);

Deno.test(
  "spotted-activations returns a callsign's list with the request's time",
  async function (): Promise<void> {
    const result = await run(get("?callsign=%20kk4pwj/p%20", {}), {}, KEY);
    assertEquals(result.res.status, 200);
    assertEquals(result.body, LIST);
    assertEquals(result.res.headers.get("Cache-Control"), PROFILE_CACHE_CONTROL);
    assertEquals(result.calls.rpc[1], {
      fn: "callsign_spotted_activations",
      args: { p_callsign: "KK4PWJ/P", p_now: "2026-11-01T12:00:00.000Z" },
    });
  },
);

Deno.test(
  "spotted-activations answers a malformed id or route with the 404 before the database",
  async function (): Promise<void> {
    for (
      const query of [
        "",
        "?id=",
        "?id=KJW2KHKYJ47F",
        "?id=kjw2khkyj47",
        "?id=kjw2khkyj470",
        "?id=%3Cscript%3E",
        `?id=${ID}&callsign=KK4PWJ`,
        "?other=1",
      ]
    ) {
      const result = await run(get(query, {}), {}, KEY);
      assertEquals(result.res.status, 404, query);
      assertEquals(result.body, { error: ACTIVATION_NOT_FOUND }, query);
      assertEquals(result.res.headers.get("Cache-Control"), null, query);
      assertEquals(result.calls.rpc, [], query);
    }
  },
);

Deno.test(
  "spotted-activations answers a callsign that cannot be one with a 400 before the database",
  async function (): Promise<void> {
    for (const query of ["?callsign=", "?callsign=KK4PWJ%25", "?callsign=ABC", "?callsign=1234"]) {
      const result = await run(get(query, {}), {}, KEY);
      assertEquals(result.res.status, 400, query);
      assertEquals(result.body, { error: INVALID_CALLSIGN }, query);
      assertEquals(result.res.headers.get("Cache-Control"), null, query);
      assertEquals(result.calls.rpc, [], query);
    }
  },
);

Deno.test(
  "spotted-activations answers SQL's null with the same 404 on both routes",
  async function (): Promise<void> {
    const activation = await run(
      get(`?id=${ID}`, {}),
      { rpc: { spotted_activation: { data: null } } },
      KEY,
    );
    assertEquals([activation.res.status, activation.body], [404, { error: ACTIVATION_NOT_FOUND }]);
    assertEquals(activation.res.headers.get("Cache-Control"), null);
    assertEquals(activation.calls.rpc.map((c) => c.fn), [
      "record_profile_lookup",
      "spotted_activation",
    ]);

    const list = await run(
      get("?callsign=P1A", {}),
      { rpc: { callsign_spotted_activations: { data: null } } },
      KEY,
    );
    assertEquals([list.res.status, list.body], [404, { error: ACTIVATION_NOT_FOUND }]);
    assertEquals(list.res.headers.get("Cache-Control"), null);
    assertEquals(list.calls.rpc.map((c) => c.fn), [
      "record_profile_lookup",
      "callsign_spotted_activations",
    ]);
  },
);

Deno.test(
  "spotted-activations is GET only and answers the CORS preflight",
  async function (): Promise<void> {
    const post = await run(
      new Request(`http://x/spotted-activations?id=${ID}`, { method: "POST" }),
      {},
      KEY,
    );
    assertEquals([post.res.status, post.body], [405, { error: "Method not allowed." }]);
    assertEquals(post.calls.rpc, []);
    const pre = await run(
      new Request("http://x/spotted-activations", { method: "OPTIONS" }),
      {},
      KEY,
    );
    assertEquals(pre.res.status, 204);
    assertEquals(pre.res.headers.get("Access-Control-Allow-Methods")!.includes("GET"), true);
    assertEquals(pre.calls.rpc, []);
  },
);

Deno.test(
  "spotted-activations shares the profile's rate limit",
  async function (): Promise<void> {
    const last = await run(
      get(`?id=${ID}`, {}),
      { rpc: { record_profile_lookup: { data: MAX_LOOKUPS_PER_MINUTE } } },
      KEY,
    );
    assertEquals(last.res.status, 200);

    for (const query of [`?id=${ID}`, "?callsign=KK4PWJ"]) {
      const over = await run(
        get(query, {}),
        { rpc: { record_profile_lookup: { data: MAX_LOOKUPS_PER_MINUTE + 1 } } },
        KEY,
      );
      assertEquals(over.res.status, 429, query);
      assertEquals(over.body, { error: TOO_MANY_LOOKUPS }, query);
      assertEquals(over.res.headers.get("Retry-After"), "60", query);
      assertEquals(over.res.headers.get("Cache-Control"), null, query);
      assertEquals(over.calls.rpc.map((c) => c.fn), ["record_profile_lookup"], query);
    }
  },
);

Deno.test(
  "spotted-activations fails closed when the limit can't be read or the key is unset",
  async function (): Promise<void> {
    const logged = await capturingErrors(async function (): Promise<void> {
      const down = await run(
        get(`?id=${ID}`, {}),
        { rpc: { record_profile_lookup: { error: { message: "down" } } } },
        KEY,
      );
      assertEquals([down.res.status, down.body], [500, { error: ACTIVATIONS_UNAVAILABLE }]);
      assertEquals(down.calls.rpc.map((c) => c.fn), ["record_profile_lookup"]);

      const odd = await run(
        get("?callsign=KK4PWJ", {}),
        { rpc: { record_profile_lookup: { data: "31" } } },
        KEY,
      );
      assertEquals(odd.res.status, 500);
      assertEquals(odd.calls.rpc.map((c) => c.fn), ["record_profile_lookup"]);

      const unset = await run(get(`?id=${ID}`, {}), {}, null);
      assertEquals([unset.res.status, unset.body], [500, { error: ACTIVATIONS_UNAVAILABLE }]);
      assertEquals(unset.calls.rpc, []);
    });
    assertEquals(logged.length, 3);
  },
);

Deno.test(
  "spotted-activations reports a failed or broken read without the id or the call",
  async function (): Promise<void> {
    const logged = await capturingErrors(async function (): Promise<void> {
      const failed = await run(
        get(`?id=${ID}`, {}),
        { rpc: { spotted_activation: { error: { message: "timeout" } } } },
        KEY,
      );
      assertEquals([failed.res.status, failed.body], [500, { error: ACTIVATIONS_UNAVAILABLE }]);
      assertEquals(failed.res.headers.get("Cache-Control"), null);

      const failedList = await run(
        get("?callsign=KK4PWJ", {}),
        { rpc: { callsign_spotted_activations: { error: { message: "timeout" } } } },
        KEY,
      );
      assertEquals(failedList.res.status, 500);

      for (const data of [ID, changed(ACTIVATION, ["spots"], null)]) {
        const broken = await run(
          get(`?id=${ID}`, {}),
          { rpc: { spotted_activation: { data } } },
          KEY,
        );
        assertEquals([broken.res.status, broken.body], [500, { error: ACTIVATIONS_UNAVAILABLE }]);
        assertEquals(broken.res.headers.get("Cache-Control"), null);
      }

      const brokenList = await run(
        get("?callsign=KK4PWJ", {}),
        { rpc: { callsign_spotted_activations: { data: changed(LIST, ["summary"], null) } } },
        KEY,
      );
      assertEquals([brokenList.res.status, brokenList.body], [500, {
        error: ACTIVATIONS_UNAVAILABLE,
      }]);
    });
    assertEquals(logged.length, 5);
    assertEquals(logged[0], "spotted-activations: timeout");
    for (const line of logged) {
      assertEquals(line.startsWith("spotted-activations: "), true, line);
      assertEquals(line.includes(ID), false, line);
      assertEquals(line.includes("KK4PWJ"), false, line);
    }
  },
);

import { assertEquals } from "@std/assert";
import {
  handleReferenceSearch,
  MAX_QUERY_LENGTH,
  MAX_QUERY_WORDS,
  MIN_QUERY_LENGTH,
  parseQuery,
  parseSearchProgram,
  PROGRAM_INVALID,
  referenceSearchSchema,
  SEARCH_INVALID,
  SEARCH_UNAVAILABLE,
} from "../handlers/reference_search.ts";
import {
  MAX_LOOKUPS_PER_MINUTE,
  PROFILE_CACHE_CONTROL,
  TOO_MANY_LOOKUPS,
} from "../handlers/callsign_profile.ts";
import { hmacKey, hmacSha256Hex } from "../hmac.ts";
import { fakeSupabase, type FakeSupabaseOptions } from "./fake_supabase.ts";

// Every key of ReferenceSearchResult (web/src/references/types.ts): one result per program,
// the WWFF one retired and never activated, so every nullable key is null somewhere.
const SEARCH = {
  results: [
    {
      program: "pota",
      reference: "US-2763",
      name: "Mount Mitchell State Park",
      active: true,
      validTo: null,
      location: "US-NC",
      association: null,
      region: null,
      country: null,
      grid: "EM85",
      altitudeM: null,
      points: null,
      activations: 412,
      lastDay: "2026-10-26",
    },
    {
      program: "sota",
      reference: "W4C/CM-001",
      name: "Mount Mitchell",
      active: true,
      validTo: "2099-12-31",
      location: null,
      association: "W4C",
      region: "Central Mountains",
      country: null,
      grid: "EM85",
      altitudeM: 2037,
      points: 10,
      activations: 96,
      lastDay: "2026-10-21",
    },
    {
      program: "wwff",
      reference: "KFF-9999",
      name: null,
      active: false,
      validTo: "2020-01-01",
      location: null,
      association: null,
      region: null,
      country: null,
      grid: null,
      altitudeM: null,
      points: null,
      activations: 0,
      lastDay: null,
    },
  ],
  more: true,
};

const EMPTY = { results: [], more: false };

const KEY = await hmacKey("test-secret");

/** A copy of SEARCH with the value at path (keys, list indexes as strings) set. */
function changed(path: string[], value: unknown): Record<string, unknown> {
  const copy = structuredClone(SEARCH) as unknown as Record<string, unknown>;
  let at = copy;
  for (const key of path.slice(0, -1)) {
    at = at[key] as Record<string, unknown>;
  }
  at[path.at(-1)!] = value;
  return copy;
}

function get(query: string, headers: Record<string, string>): Request {
  return new Request(`http://x/reference-search${query}`, { headers });
}

// null for no key, so each call passes the key explicitly.
async function run(req: Request, options: FakeSupabaseOptions, key: CryptoKey | null) {
  const rpc: NonNullable<FakeSupabaseOptions["rpc"]> = {
    record_profile_lookup: { data: 1 },
    search_references: { data: SEARCH },
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
  const res = await handleReferenceSearch(req, {
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

Deno.test("parseQuery trims and keeps a query of 2 to 64 characters in 6 words", function (): void {
  assertEquals(parseQuery(" mitchell "), "mitchell");
  assertEquals(parseQuery("us"), "us");
  assertEquals(parseQuery("Mount  Mitchell"), "Mount  Mitchell");
  assertEquals(parseQuery("100%_ok"), "100%_ok");
  assertEquals(parseQuery("a".repeat(MAX_QUERY_LENGTH)), "a".repeat(MAX_QUERY_LENGTH));
  assertEquals(parseQuery(Array(MAX_QUERY_WORDS).fill("a").join(" ")), "a a a a a a");
  // Characters are code points, as Postgres counts them: 64 astral characters fit.
  assertEquals(parseQuery("\u{1F3D4}".repeat(64)), "\u{1F3D4}".repeat(64));
  assertEquals(parseQuery("ét"), "ét");
  assertEquals(MIN_QUERY_LENGTH, 2);
});

Deno.test("parseQuery rejects what cannot be a search", function (): void {
  for (
    const raw of [
      null,
      "",
      "   ",
      "u",
      " u ",
      "a".repeat(MAX_QUERY_LENGTH + 1),
      "\u{1F3D4}".repeat(65),
      Array(MAX_QUERY_WORDS + 1).fill("a").join(" "),
      "a\tb\nc d e f g",
      "us\u0000",
    ]
  ) {
    assertEquals(parseQuery(raw), null, `${JSON.stringify(raw)} should be rejected`);
  }
});

Deno.test("parseSearchProgram is every program unless one with a list is named", function (): void {
  assertEquals(parseSearchProgram(null), null);
  assertEquals(parseSearchProgram(""), null);
  assertEquals(parseSearchProgram("  "), null);
  assertEquals(parseSearchProgram("pota"), "pota");
  assertEquals(parseSearchProgram(" SOTA "), "sota");
  assertEquals(parseSearchProgram("Wwff"), "wwff");
  for (const raw of ["iota", "bota", "wwbota", "sotawatch", "all"]) {
    assertEquals(parseSearchProgram(raw), undefined, `${raw} should be rejected`);
  }
});

Deno.test("referenceSearchSchema reads the whole contract", function (): void {
  assertEquals(referenceSearchSchema.safeParse(SEARCH).success, true);
  assertEquals(referenceSearchSchema.safeParse(EMPTY).success, true);
  // A key added by a later deploy is kept, not refused.
  assertEquals(referenceSearchSchema.safeParse(changed(["extra"], 1)).success, true);
  assertEquals(
    referenceSearchSchema.safeParse(changed(["results", "0", "extra"], 1)).success,
    true,
  );
  // A program without a list, a missing key or a wrong type is a broken read.
  for (
    const broken of [
      changed(["more"], undefined),
      changed(["more"], "true"),
      changed(["results"], null),
      changed(["results", "0", "program"], "iota"),
      changed(["results", "0", "reference"], null),
      changed(["results", "0", "active"], null),
      changed(["results", "1", "altitudeM"], "2037"),
      changed(["results", "1", "points"], undefined),
      changed(["results", "2", "activations"], null),
      changed(["results", "2", "lastDay"], 0),
      changed(["results", "2", "validTo"], undefined),
    ]
  ) {
    assertEquals(referenceSearchSchema.safeParse(broken).success, false, JSON.stringify(broken));
  }
});

// search_references' real replies on the local seed (supabase/seed.sql): every program, more
// than 25 matches, retired WWFF references and no matches.
const CAPTURED: unknown = JSON.parse(
  Deno.readTextFileSync(new URL("./fixtures/reference-search.json", import.meta.url)),
);

Deno.test("referenceSearchSchema reads search_references' captured replies", function (): void {
  const replies = Object.entries(CAPTURED as Record<string, unknown>);
  assertEquals(replies.map((entry) => entry[0]).sort(), ["ff_wwff", "mi", "none", "sota"]);
  const programs = new Set<string>();
  let retired = 0;
  for (const entry of replies) {
    const parsed = referenceSearchSchema.safeParse(entry[1]);
    assertEquals(parsed.success, true, entry[0]);
    for (const result of parsed.data!.results) {
      programs.add(result.program);
      if (!result.active) {
        retired += 1;
      }
    }
  }
  assertEquals(Array.from(programs).sort(), ["pota", "sota", "wwff"]);
  assertEquals(retired > 0, true);
});

Deno.test(
  "reference-search returns the results with a public Cache-Control",
  async function (): Promise<void> {
    const result = await run(
      get("?q=%20Mount%20Mitchell%20&program=SOTA", { "cf-connecting-ip": "192.0.2.7" }),
      {},
      KEY,
    );
    assertEquals(result.res.status, 200);
    assertEquals(result.body, SEARCH);
    assertEquals(result.res.headers.get("Cache-Control"), PROFILE_CACHE_CONTROL);
    assertEquals(result.res.headers.get("Access-Control-Allow-Origin"), "*");
    assertEquals(result.calls.rpc, [
      { fn: "record_profile_lookup", args: { p_client: await hmacSha256Hex(KEY, "192.0.2.7") } },
      { fn: "search_references", args: { p_query: "Mount Mitchell", p_program: "sota" } },
    ]);
  },
);

Deno.test(
  "reference-search without a program searches every list and passes % and _ as they are",
  async function (): Promise<void> {
    for (const query of ["?q=us", "?q=us&program=", "?q=us&program=%20"]) {
      const all = await run(get(query, {}), {}, KEY);
      assertEquals(all.res.status, 200, query);
      assertEquals(all.calls.rpc[1], {
        fn: "search_references",
        args: { p_query: "us", p_program: null },
      }, query);
    }

    const literal = await run(get("?q=100%25_x", {}), {
      rpc: { search_references: { data: EMPTY } },
    }, KEY);
    assertEquals(literal.res.status, 200);
    assertEquals(literal.body, EMPTY);
    assertEquals(literal.calls.rpc[1], {
      fn: "search_references",
      args: { p_query: "100%_x", p_program: null },
    });
  },
);

Deno.test(
  "reference-search answers a bad query with a 400 before touching the database",
  async function (): Promise<void> {
    for (
      const query of [
        "",
        "?program=pota",
        "?q=",
        "?q=%20%20",
        "?q=u",
        "?q=%20u%20&program=pota",
        `?q=${"a".repeat(MAX_QUERY_LENGTH + 1)}`,
        "?q=a+b+c+d+e+f+g",
        "?q=us%00",
      ]
    ) {
      const result = await run(get(query, {}), {}, KEY);
      assertEquals(result.res.status, 400, query);
      assertEquals(result.body, { error: SEARCH_INVALID }, query);
      assertEquals(result.res.headers.get("Cache-Control"), null, query);
      assertEquals(result.res.headers.get("Access-Control-Allow-Origin"), "*", query);
      assertEquals(result.calls.rpc, [], query);
    }
  },
);

Deno.test(
  "reference-search answers a program without a list with a 400 before touching the database",
  async function (): Promise<void> {
    for (const program of ["iota", "wwbota", "sotawatch", "dxcluster", "all"]) {
      const result = await run(get(`?q=mitchell&program=${program}`, {}), {}, KEY);
      assertEquals(result.res.status, 400, program);
      assertEquals(result.body, { error: PROGRAM_INVALID }, program);
      assertEquals(result.calls.rpc, [], program);
    }
  },
);

Deno.test(
  "reference-search reads SQL refusing the query as the same 400, never a 404",
  async function (): Promise<void> {
    const result = await run(
      get("?q=mitchell", {}),
      { rpc: { search_references: { data: null } } },
      KEY,
    );
    assertEquals(result.res.status, 400);
    assertEquals(result.body, { error: SEARCH_INVALID });
    assertEquals(result.res.headers.get("Cache-Control"), null);
    assertEquals(result.calls.rpc.map((c) => c.fn), ["record_profile_lookup", "search_references"]);

    const none = await run(
      get("?q=zzzz", {}),
      { rpc: { search_references: { data: EMPTY } } },
      KEY,
    );
    assertEquals(none.res.status, 200);
    assertEquals(none.body, EMPTY);
  },
);

Deno.test(
  "reference-search is GET only and answers the CORS preflight",
  async function (): Promise<void> {
    const post = await run(
      new Request("http://x/reference-search?q=mitchell", { method: "POST" }),
      {},
      KEY,
    );
    assertEquals(post.res.status, 405);
    assertEquals(post.body, { error: "Method not allowed." });
    assertEquals(post.calls.rpc, []);
    const pre = await run(
      new Request("http://x/reference-search", { method: "OPTIONS" }),
      {},
      KEY,
    );
    assertEquals(pre.res.status, 204);
    assertEquals(pre.res.headers.get("Access-Control-Allow-Origin"), "*");
    assertEquals(pre.res.headers.get("Access-Control-Allow-Methods")!.includes("GET"), true);
    assertEquals(pre.calls.rpc, []);
  },
);

Deno.test(
  "reference-search shares the profile's rate limit",
  async function (): Promise<void> {
    const last = await run(
      get("?q=mitchell", {}),
      { rpc: { record_profile_lookup: { data: MAX_LOOKUPS_PER_MINUTE } } },
      KEY,
    );
    assertEquals(last.res.status, 200);

    const over = await run(
      get("?q=mitchell", {}),
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
  "reference-search fails closed when the limit can't be read or the key is unset",
  async function (): Promise<void> {
    const logged = await capturingErrors(async function (): Promise<void> {
      const down = await run(
        get("?q=mitchell", {}),
        { rpc: { record_profile_lookup: { error: { message: "down" } } } },
        KEY,
      );
      assertEquals([down.res.status, down.body], [500, { error: SEARCH_UNAVAILABLE }]);
      assertEquals(down.calls.rpc.map((c) => c.fn), ["record_profile_lookup"]);

      const odd = await run(
        get("?q=mitchell", {}),
        { rpc: { record_profile_lookup: { data: "31" } } },
        KEY,
      );
      assertEquals([odd.res.status, odd.body], [500, { error: SEARCH_UNAVAILABLE }]);
      assertEquals(odd.calls.rpc.map((c) => c.fn), ["record_profile_lookup"]);

      const unset = await run(get("?q=mitchell", {}), {}, null);
      assertEquals([unset.res.status, unset.body], [500, { error: SEARCH_UNAVAILABLE }]);
      assertEquals(unset.calls.rpc, []);
    });
    assertEquals(logged.length, 3);
    for (const line of logged) {
      assertEquals(line.startsWith("reference-search: "), true, line);
      assertEquals(line.toLowerCase().includes("mitchell"), false, line);
    }
  },
);

Deno.test(
  "reference-search reports a failed or broken read without the query",
  async function (): Promise<void> {
    const logged = await capturingErrors(async function (): Promise<void> {
      const failed = await run(
        get("?q=mitchell", {}),
        { rpc: { search_references: { error: { message: "timeout" } } } },
        KEY,
      );
      assertEquals([failed.res.status, failed.body], [500, { error: SEARCH_UNAVAILABLE }]);
      assertEquals(failed.res.headers.get("Cache-Control"), null);

      for (
        const data of [
          "mitchell",
          [SEARCH.results[0]],
          changed(["more"], null),
          changed(["results", "0", "program"], "mitchell"),
        ]
      ) {
        const broken = await run(
          get("?q=mitchell", {}),
          { rpc: { search_references: { data } } },
          KEY,
        );
        assertEquals([broken.res.status, broken.body], [500, { error: SEARCH_UNAVAILABLE }]);
        assertEquals(broken.res.headers.get("Cache-Control"), null);
      }
    });
    assertEquals(logged.length, 5);
    assertEquals(logged[0], "reference-search: timeout");
    for (const line of logged) {
      assertEquals(line.startsWith("reference-search: "), true, line);
      assertEquals(line.toLowerCase().includes("mitchell"), false, line);
    }
  },
);

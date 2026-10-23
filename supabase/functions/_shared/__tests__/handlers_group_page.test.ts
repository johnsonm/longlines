import { assertEquals } from "@std/assert";
import { GROUP_PAGE_UNAVAILABLE, handleGroupPage, PAGE_PRIVATE } from "../handlers/group_page.ts";
import { MAX_LOOKUPS_PER_MINUTE, TOO_MANY_LOOKUPS } from "../handlers/callsign_profile.ts";
import { hmacKey, hmacSha256Hex } from "../hmac.ts";
import { fakeSupabase, type FakeSupabaseOptions } from "./fake_supabase.ts";

const PAGE = {
  period: "30d",
  memberCount: 24,
  group: { name: "Piedmont ARC", member_count: 24, show_callsigns: false },
};
const KEY = await hmacKey("test-secret");
const CODE = "7f3kq6xm2a";

function get(query: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://x/group-page${query}`, { headers });
}

// null for no key: an undefined argument would take the default.
async function run(
  req: Request,
  options: FakeSupabaseOptions = {},
  key: CryptoKey | null = KEY,
) {
  const rpc: NonNullable<FakeSupabaseOptions["rpc"]> = {
    record_profile_lookup: { data: 1 },
    public_group_statistics: { data: PAGE },
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
  const res = await handleGroupPage(req, {
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

Deno.test("group-page serves a public page, never cached", async function (): Promise<void> {
  const result = await run(get(`?slug=${CODE}`, { "cf-connecting-ip": "192.0.2.7" }));
  assertEquals(result.res.status, 200);
  assertEquals(result.body, PAGE);
  assertEquals(result.res.headers.get("Cache-Control"), "no-store");
  assertEquals(result.calls.rpc, [
    { fn: "record_profile_lookup", args: { p_client: await hmacSha256Hex(KEY, "192.0.2.7") } },
    { fn: "public_group_statistics", args: { p_slug: CODE, p_period: "30d" } },
  ]);
});

Deno.test("group-page passes the 7-day period", async function (): Promise<void> {
  const result = await run(get(`?slug=${CODE}&period=7d`));
  assertEquals(result.calls.rpc.at(-1), {
    fn: "public_group_statistics",
    args: { p_slug: CODE, p_period: "7d" },
  });
});

Deno.test(
  "group-page answers a private or unknown code with the same 404",
  async function (): Promise<void> {
    const result = await run(get(`?slug=${CODE}`), {
      rpc: { public_group_statistics: { data: null } },
    });
    assertEquals(result.res.status, 404);
    assertEquals(result.body, { error: PAGE_PRIVATE });
    assertEquals(result.res.headers.get("Cache-Control"), "no-store");
  },
);

Deno.test(
  "group-page refuses a malformed code or period without touching the database",
  async function (): Promise<void> {
    for (
      const query of [
        "",
        "?slug=",
        "?slug=7F3KQ9XM2A",
        "?slug=7f3kq9xm2",
        "?slug=7f3kq9xm2a1",
        "?slug=7f3kq9xm0a",
        `?slug=${CODE}&period=1y`,
      ]
    ) {
      const result = await run(get(query));
      assertEquals(result.res.status, 404, query);
      assertEquals(result.body, { error: PAGE_PRIVATE }, query);
      assertEquals(result.res.headers.get("Cache-Control"), "no-store", query);
      assertEquals(result.calls.rpc, [], query);
    }
  },
);

Deno.test(
  "group-page is GET only and answers the CORS preflight",
  async function (): Promise<void> {
    const post = await run(new Request(`http://x/group-page?slug=${CODE}`, { method: "POST" }));
    assertEquals(post.res.status, 405);
    const preflight = await run(
      new Request(`http://x/group-page?slug=${CODE}`, { method: "OPTIONS" }),
    );
    assertEquals(preflight.res.status, 204);
  },
);

Deno.test("group-page shares the profile's rate limit", async function (): Promise<void> {
  const result = await run(get(`?slug=${CODE}`), {
    rpc: { record_profile_lookup: { data: MAX_LOOKUPS_PER_MINUTE + 1 } },
  });
  assertEquals(result.res.status, 429);
  assertEquals(result.res.headers.get("Retry-After"), "60");
  assertEquals(result.res.headers.get("Cache-Control"), "no-store");
  assertEquals(result.body, { error: TOO_MANY_LOOKUPS });
  assertEquals(result.calls.rpc.map((c) => c.fn), ["record_profile_lookup"]);
});

Deno.test("group-page fails closed when the limit can't be read", async function (): Promise<void> {
  for (const result of [{ error: { message: "boom" } }, { data: "x" }]) {
    const got = await run(get(`?slug=${CODE}`), {
      rpc: { record_profile_lookup: result },
    });
    assertEquals(got.res.status, 500);
    assertEquals(got.body, { error: GROUP_PAGE_UNAVAILABLE });
    assertEquals(got.res.headers.get("Cache-Control"), "no-store");
    assertEquals(got.calls.rpc.map((c) => c.fn), ["record_profile_lookup"]);
  }
});

Deno.test("group-page reports a failed read without the code", async function (): Promise<void> {
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => errors.push(a.join(" "));
  try {
    const result = await run(get(`?slug=${CODE}`), {
      rpc: { public_group_statistics: { error: { message: "timeout" } } },
    });
    assertEquals(result.res.status, 500);
    assertEquals(result.body, { error: GROUP_PAGE_UNAVAILABLE });
  } finally {
    console.error = original;
  }
  assertEquals(errors, ["group-page: timeout"]);
});

Deno.test("group-page needs the HMAC key", async function (): Promise<void> {
  const original = console.error;
  console.error = () => undefined;
  try {
    const result = await run(get(`?slug=${CODE}`), {}, null);
    assertEquals(result.res.status, 500);
    assertEquals(result.calls.rpc, []);
  } finally {
    console.error = original;
  }
});

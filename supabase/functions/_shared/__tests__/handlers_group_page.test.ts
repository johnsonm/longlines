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
  const fake = fakeSupabase({
    rpc: {
      record_profile_lookup: { data: 1 },
      public_group_statistics: { data: PAGE },
      ...options.rpc,
    },
  });
  const res = await handleGroupPage(req, {
    db: () => fake.client,
    clientIpHeader: undefined,
    key: key ?? undefined,
  });
  return { res, body: res.status === 204 ? null : await res.json(), calls: fake.calls };
}

Deno.test("group-page serves a public page, never cached", async () => {
  const { res, body, calls } = await run(get(`?slug=${CODE}`, { "cf-connecting-ip": "192.0.2.7" }));
  assertEquals(res.status, 200);
  assertEquals(body, PAGE);
  assertEquals(res.headers.get("Cache-Control"), "no-store");
  assertEquals(calls.rpc, [
    { fn: "record_profile_lookup", args: { p_client: await hmacSha256Hex(KEY, "192.0.2.7") } },
    { fn: "public_group_statistics", args: { p_slug: CODE, p_period: "30d" } },
  ]);
});

Deno.test("group-page passes the 7-day period", async () => {
  const { calls } = await run(get(`?slug=${CODE}&period=7d`));
  assertEquals(calls.rpc.at(-1), {
    fn: "public_group_statistics",
    args: { p_slug: CODE, p_period: "7d" },
  });
});

Deno.test("group-page answers a private or unknown code with the same 404", async () => {
  const { res, body } = await run(get(`?slug=${CODE}`), {
    rpc: { public_group_statistics: { data: null } },
  });
  assertEquals(res.status, 404);
  assertEquals(body, { error: PAGE_PRIVATE });
  assertEquals(res.headers.get("Cache-Control"), "no-store");
});

Deno.test("group-page refuses a malformed code or period without touching the database", async () => {
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
    const { res, body, calls } = await run(get(query));
    assertEquals(res.status, 404, query);
    assertEquals(body, { error: PAGE_PRIVATE }, query);
    assertEquals(res.headers.get("Cache-Control"), "no-store", query);
    assertEquals(calls.rpc, [], query);
  }
});

Deno.test("group-page is GET only and answers the CORS preflight", async () => {
  const post = await run(new Request(`http://x/group-page?slug=${CODE}`, { method: "POST" }));
  assertEquals(post.res.status, 405);
  const preflight = await run(
    new Request(`http://x/group-page?slug=${CODE}`, { method: "OPTIONS" }),
  );
  assertEquals(preflight.res.status, 204);
});

Deno.test("group-page shares the profile's rate limit", async () => {
  const { res, body, calls } = await run(get(`?slug=${CODE}`), {
    rpc: { record_profile_lookup: { data: MAX_LOOKUPS_PER_MINUTE + 1 } },
  });
  assertEquals(res.status, 429);
  assertEquals(res.headers.get("Retry-After"), "60");
  assertEquals(body, { error: TOO_MANY_LOOKUPS });
  assertEquals(calls.rpc.map((c) => c.fn), ["record_profile_lookup"]);
});

Deno.test("group-page fails closed when the limit can't be read", async () => {
  for (const result of [{ error: { message: "boom" } }, { data: "x" }]) {
    const { res, body, calls } = await run(get(`?slug=${CODE}`), {
      rpc: { record_profile_lookup: result },
    });
    assertEquals(res.status, 500);
    assertEquals(body, { error: GROUP_PAGE_UNAVAILABLE });
    assertEquals(calls.rpc.map((c) => c.fn), ["record_profile_lookup"]);
  }
});

Deno.test("group-page reports a failed read without the code", async () => {
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => errors.push(a.join(" "));
  try {
    const { res, body } = await run(get(`?slug=${CODE}`), {
      rpc: { public_group_statistics: { error: { message: "timeout" } } },
    });
    assertEquals(res.status, 500);
    assertEquals(body, { error: GROUP_PAGE_UNAVAILABLE });
  } finally {
    console.error = original;
  }
  assertEquals(errors, ["group-page: timeout"]);
});

Deno.test("group-page needs the HMAC key", async () => {
  const original = console.error;
  console.error = () => {};
  try {
    const { res, calls } = await run(get(`?slug=${CODE}`), {}, null);
    assertEquals(res.status, 500);
    assertEquals(calls.rpc, []);
  } finally {
    console.error = original;
  }
});

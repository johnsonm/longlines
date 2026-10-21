import { assertEquals } from "@std/assert";
import { handleHealth, HEALTH_CACHE_CONTROL, HEALTH_UNAVAILABLE } from "../handlers/health.ts";
import { fakeSupabase, type FakeSupabaseOptions } from "./fake_supabase.ts";

const PAYLOAD = { range: "24h", checks: {}, generated_at: "2026-10-21T13:45:00+00:00" };

async function run(req: Request, options: FakeSupabaseOptions = {}) {
  const fake = fakeSupabase(options);
  const res = await handleHealth(req, { db: () => fake.client });
  return { res, calls: fake.calls };
}

Deno.test("serves the cached payload for 24 hours by default, with a short public cache", async () => {
  const { res, calls } = await run(new Request("http://x/health"), {
    rpc: { cached_health: { data: PAYLOAD } },
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), PAYLOAD);
  assertEquals(res.headers.get("Cache-Control"), HEALTH_CACHE_CONTROL);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals(calls.rpc, [{ fn: "cached_health", args: { p_range: "24h" } }]);
});

Deno.test("passes a known range through", async () => {
  for (const range of ["1h", "7d"]) {
    const { res, calls } = await run(new Request(`http://x/health?range=${range}`), {
      rpc: { cached_health: { data: PAYLOAD } },
    });
    assertEquals(res.status, 200);
    assertEquals(calls.rpc, [{ fn: "cached_health", args: { p_range: range } }]);
  }
});

Deno.test("refuses an unknown range without touching the database", async () => {
  const { res, calls } = await run(new Request("http://x/health?range=30d"));
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Unknown range." });
  assertEquals(calls.rpc, []);
});

Deno.test("answers a preflight and refuses anything but GET", async () => {
  const preflight = await run(new Request("http://x/health", { method: "OPTIONS" }));
  assertEquals(preflight.res.status, 204);
  const post = await run(new Request("http://x/health", { method: "POST" }));
  assertEquals(post.res.status, 405);
  assertEquals([...preflight.calls.rpc, ...post.calls.rpc], []);
});

Deno.test("a database error or a null result is a 500 that names no detail", async () => {
  for (const responder of [{ error: { message: "permission denied" } }, { data: null }]) {
    const { res } = await run(new Request("http://x/health"), {
      rpc: { cached_health: responder },
    });
    assertEquals(res.status, 500);
    assertEquals(await res.json(), { error: HEALTH_UNAVAILABLE });
    assertEquals(res.headers.get("Cache-Control"), null);
  }
});

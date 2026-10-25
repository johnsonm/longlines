import { assertEquals } from "@std/assert";
import { handleHealth, HEALTH_CACHE_CONTROL, HEALTH_UNAVAILABLE } from "../handlers/health.ts";
import { fakeSupabase, type FakeSupabaseOptions } from "./fake_supabase.ts";

const PAYLOAD = { range: "24h", checks: {}, generated_at: "2026-10-21T13:45:00+00:00" };

async function run(req: Request, options: FakeSupabaseOptions) {
  const fake = fakeSupabase(options);
  const res = await handleHealth(req, { db: () => fake.client });
  return { res, calls: fake.calls };
}

Deno.test(
  "serves the cached payload for 24 hours by default, with a short public cache",
  async function (): Promise<void> {
    const result = await run(new Request("http://x/health"), {
      rpc: { cached_health: { data: PAYLOAD } },
    });
    assertEquals(result.res.status, 200);
    assertEquals(await result.res.json(), PAYLOAD);
    assertEquals(result.res.headers.get("Cache-Control"), HEALTH_CACHE_CONTROL);
    assertEquals(result.res.headers.get("Access-Control-Allow-Origin"), "*");
    assertEquals(result.calls.rpc, [{ fn: "cached_health", args: { p_range: "24h" } }]);
  },
);

Deno.test("passes a known range through", async function (): Promise<void> {
  for (const range of ["1h", "7d"]) {
    const result = await run(new Request(`http://x/health?range=${range}`), {
      rpc: { cached_health: { data: PAYLOAD } },
    });
    assertEquals(result.res.status, 200);
    assertEquals(result.calls.rpc, [{ fn: "cached_health", args: { p_range: range } }]);
  }
});

Deno.test(
  "refuses an unknown range without touching the database",
  async function (): Promise<void> {
    const result = await run(new Request("http://x/health?range=30d"), {});
    assertEquals(result.res.status, 400);
    assertEquals(await result.res.json(), { error: "Unknown range." });
    assertEquals(result.calls.rpc, []);
  },
);

Deno.test("answers a preflight and refuses anything but GET", async function (): Promise<void> {
  const preflight = await run(new Request("http://x/health", { method: "OPTIONS" }), {});
  assertEquals(preflight.res.status, 204);
  const post = await run(new Request("http://x/health", { method: "POST" }), {});
  assertEquals(post.res.status, 405);
  assertEquals(preflight.calls.rpc.concat(post.calls.rpc), []);
});

Deno.test(
  "a database error or a null result is a 500 that names no detail",
  async function (): Promise<void> {
    for (const responder of [{ error: { message: "permission denied" } }, { data: null }]) {
      const result = await run(new Request("http://x/health"), {
        rpc: { cached_health: responder },
      });
      assertEquals(result.res.status, 500);
      assertEquals(await result.res.json(), { error: HEALTH_UNAVAILABLE });
      assertEquals(result.res.headers.get("Cache-Control"), null);
    }
  },
);

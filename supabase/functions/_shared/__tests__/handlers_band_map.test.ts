import { assertEquals } from "@std/assert";
import {
  BAND_MAP_CACHE_CONTROL,
  BAND_MAP_UNAVAILABLE,
  handleBandMap,
} from "../handlers/band_map.ts";
import { fakeSupabase, type FakeSupabaseOptions } from "./fake_supabase.ts";

const PAYLOAD = { bands: [{ band: "20m", spots: [] }], generated_at: "2026-10-14T13:45:00+00:00" };

async function run(req: Request, options: FakeSupabaseOptions = {}) {
  const fake = fakeSupabase(options);
  const res = await handleBandMap(req, { db: () => fake.client });
  return { res, calls: fake.calls };
}

Deno.test("serves the cached band map with a short public cache", async function (): Promise<void> {
  const result = await run(new Request("http://x/band-map"), {
    rpc: { cached_band_map: { data: PAYLOAD } },
  });
  assertEquals(result.res.status, 200);
  assertEquals(await result.res.json(), PAYLOAD);
  assertEquals(result.res.headers.get("Cache-Control"), BAND_MAP_CACHE_CONTROL);
  assertEquals(result.res.headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals(result.calls.rpc.map((c) => c.fn), ["cached_band_map"]);
});

Deno.test("answers a preflight without touching the database", async function (): Promise<void> {
  const result = await run(new Request("http://x/band-map", { method: "OPTIONS" }));
  assertEquals(result.res.status, 204);
  assertEquals(result.calls.rpc, []);
});

Deno.test("refuses anything but GET", async function (): Promise<void> {
  const result = await run(new Request("http://x/band-map", { method: "POST" }));
  assertEquals(result.res.status, 405);
  assertEquals(result.calls.rpc, []);
});

Deno.test("a database error is a 500 that names no detail", async function (): Promise<void> {
  const result = await run(new Request("http://x/band-map"), {
    rpc: { cached_band_map: { error: { message: "permission denied" } } },
  });
  assertEquals(result.res.status, 500);
  assertEquals(await result.res.json(), { error: BAND_MAP_UNAVAILABLE });
  assertEquals(result.res.headers.get("Cache-Control"), null);
});

Deno.test("a null result is a 500 too", async function (): Promise<void> {
  const result = await run(new Request("http://x/band-map"), {
    rpc: { cached_band_map: { data: null } },
  });
  assertEquals(result.res.status, 500);
});

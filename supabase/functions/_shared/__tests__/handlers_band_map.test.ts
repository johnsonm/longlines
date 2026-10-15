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

Deno.test("serves the cached band map with a short public cache", async () => {
  const { res, calls } = await run(new Request("http://x/band-map"), {
    rpc: { cached_band_map: { data: PAYLOAD } },
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), PAYLOAD);
  assertEquals(res.headers.get("Cache-Control"), BAND_MAP_CACHE_CONTROL);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals(calls.rpc.map((c) => c.fn), ["cached_band_map"]);
});

Deno.test("answers a preflight without touching the database", async () => {
  const { res, calls } = await run(new Request("http://x/band-map", { method: "OPTIONS" }));
  assertEquals(res.status, 204);
  assertEquals(calls.rpc, []);
});

Deno.test("refuses anything but GET", async () => {
  const { res, calls } = await run(new Request("http://x/band-map", { method: "POST" }));
  assertEquals(res.status, 405);
  assertEquals(calls.rpc, []);
});

Deno.test("a database error is a 500 that names no detail", async () => {
  const { res } = await run(new Request("http://x/band-map"), {
    rpc: { cached_band_map: { error: { message: "permission denied" } } },
  });
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { error: BAND_MAP_UNAVAILABLE });
  assertEquals(res.headers.get("Cache-Control"), null);
});

Deno.test("a null result is a 500 too", async () => {
  const { res } = await run(new Request("http://x/band-map"), {
    rpc: { cached_band_map: { data: null } },
  });
  assertEquals(res.status, 500);
});

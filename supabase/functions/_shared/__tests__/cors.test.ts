import { assertEquals } from "@std/assert";
import { corsHeaders, json, preflightResponse } from "../cors.ts";

Deno.test("corsHeaders allow the browser to call functions with auth headers", () => {
  const h = corsHeaders();
  assertEquals(h["Access-Control-Allow-Origin"], "*");
  assertEquals(h["Access-Control-Allow-Headers"]?.includes("authorization"), true);
  assertEquals(h["Access-Control-Allow-Methods"]?.includes("POST"), true);
  assertEquals(h["Access-Control-Allow-Methods"]?.includes("GET"), true);
});

Deno.test("json adds extra headers to the CORS and content-type ones", async () => {
  const res = json({ ok: true }, 201, { "Cache-Control": "no-store" });
  assertEquals(res.status, 201);
  assertEquals(res.headers.get("Cache-Control"), "no-store");
  assertEquals(res.headers.get("Content-Type"), "application/json");
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals(await res.json(), { ok: true });
});

Deno.test("preflightResponse answers OPTIONS with 204 and the CORS headers", async () => {
  const res = preflightResponse(new Request("http://x/", { method: "OPTIONS" }));
  assertEquals(res?.status, 204);
  assertEquals(res?.headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals(res?.headers.get("Access-Control-Max-Age"), "600");
  assertEquals(res?.headers.get("Access-Control-Allow-Methods"), "GET, POST, OPTIONS");
  await res?.body?.cancel();
});

Deno.test("preflightResponse takes a function's own methods", async () => {
  const res = preflightResponse(new Request("http://x/", { method: "OPTIONS" }), "GET, PUT");
  assertEquals(res?.headers.get("Access-Control-Allow-Methods"), "GET, PUT");
  await res?.body?.cancel();
});

Deno.test("json lets browser code read Retry-After and Allow", async () => {
  const res = json({ error: "slow down" }, 429, { "Retry-After": "15" });
  assertEquals(res.headers.get("Access-Control-Expose-Headers"), "Retry-After, Allow");
  await res.body?.cancel();
});

Deno.test("preflightResponse returns null for non-OPTIONS requests", () => {
  assertEquals(preflightResponse(new Request("http://x/", { method: "POST" })), null);
});

import { assertEquals, assertExists } from "@std/assert";
import { corsHeaders, DEFAULT_METHODS, json, preflightResponse } from "../cors.ts";

Deno.test("corsHeaders allow the browser to call functions with auth headers", function (): void {
  const h = corsHeaders(DEFAULT_METHODS);
  assertEquals(h["Access-Control-Allow-Origin"], "*");
  const allowHeaders = h["Access-Control-Allow-Headers"];
  assertExists(allowHeaders);
  assertEquals(allowHeaders.includes("authorization"), true);
  const allowMethods = h["Access-Control-Allow-Methods"];
  assertExists(allowMethods);
  assertEquals(allowMethods.includes("POST"), true);
  assertEquals(allowMethods.includes("GET"), true);
});

Deno.test(
  "json adds extra headers to the CORS and content-type ones",
  async function (): Promise<void> {
    const res = json({ ok: true }, 201, { "Cache-Control": "no-store" });
    assertEquals(res.status, 201);
    assertEquals(res.headers.get("Cache-Control"), "no-store");
    assertEquals(res.headers.get("Content-Type"), "application/json");
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
    assertEquals(await res.json(), { ok: true });
  },
);

Deno.test(
  "preflightResponse answers OPTIONS with 204 and the CORS headers",
  async function (): Promise<void> {
    const res = preflightResponse(new Request("http://x/", { method: "OPTIONS" }), DEFAULT_METHODS);
    assertExists(res);
    assertEquals(res.status, 204);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
    assertEquals(res.headers.get("Access-Control-Max-Age"), "600");
    assertEquals(res.headers.get("Access-Control-Allow-Methods"), "GET, POST, OPTIONS");
    if (res.body !== null) {
      await res.body.cancel();
    }
  },
);

Deno.test("preflightResponse takes a function's own methods", async function (): Promise<void> {
  const res = preflightResponse(new Request("http://x/", { method: "OPTIONS" }), "GET, PUT");
  assertExists(res);
  assertEquals(res.headers.get("Access-Control-Allow-Methods"), "GET, PUT");
  if (res.body !== null) {
    await res.body.cancel();
  }
});

Deno.test("json lets browser code read Retry-After and Allow", async function (): Promise<void> {
  const res = json({ error: "slow down" }, 429, { "Retry-After": "15" });
  assertEquals(res.headers.get("Access-Control-Expose-Headers"), "Retry-After, Allow");
  if (res.body !== null) {
    await res.body.cancel();
  }
});

Deno.test("preflightResponse returns null for non-OPTIONS requests", function (): void {
  assertEquals(
    preflightResponse(new Request("http://x/", { method: "POST" }), DEFAULT_METHODS),
    null,
  );
});

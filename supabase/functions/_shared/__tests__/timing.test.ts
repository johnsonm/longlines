import { assertEquals } from "@std/assert";
import { SERVER_TIMING, serverTiming, timed } from "../timing.ts";

Deno.test("serverTiming writes total milliseconds to one decimal, never negative", () => {
  assertEquals(serverTiming(1234.56), "total;dur=1234.6");
  assertEquals(serverTiming(0), "total;dur=0.0");
  assertEquals(serverTiming(-3), "total;dur=0.0");
});

Deno.test("timed stamps the response with the handler's run time", async () => {
  const ticks = [100, 350.25];
  const res = await timed(
    () => Promise.resolve(Response.json({ ok: true }, { status: 500 })),
    () => ticks.shift()!,
  );
  assertEquals(res.status, 500);
  assertEquals(res.headers.get(SERVER_TIMING), "total;dur=250.3");
  assertEquals(await res.json(), { ok: true });
});

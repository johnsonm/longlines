import { assertEquals, assertStringIncludes } from "@std/assert";
import type { SendResult } from "../delivery/send.ts";
import type { DeliveryDestination, PendingDelivery } from "../delivery/types.ts";
import { handleSendTest } from "../handlers/test_delivery.ts";
import { fakeSupabase, type FakeSupabaseOptions } from "./fake_supabase.ts";

const NOW = new Date("2026-10-05T14:00:00Z");
const USER = { data: { user: { id: "u1" } } };
const DEST: DeliveryDestination = {
  id: "d1",
  type: "discord",
  name: "Shack",
  url: "https://discord.com/api/webhooks/1/x",
  signing_secret: null,
  health: "ok",
  consecutive_failures: 0,
};

function post(body: unknown, token: string | null = "jwt"): Request {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  return new Request("http://x/", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function run(
  req: Request,
  options: FakeSupabaseOptions = {},
  result: SendResult = { ok: true, sent: 1 },
) {
  const { client, calls } = fakeSupabase({
    getUser: USER,
    from: { destinations: { data: DEST } },
    ...options,
  });
  const sent: Array<{ destination: DeliveryDestination; batch: readonly PendingDelivery[] }> = [];
  const res = await handleSendTest(req, {
    admin: () => client,
    send: (destination, batch) => {
      sent.push({ destination, batch });
      return Promise.resolve(result);
    },
  }, NOW);
  return { res, body: res.status === 204 ? null : await res.json(), calls, sent };
}

Deno.test("handleSendTest answers preflight and rejects other methods", async () => {
  assertEquals((await run(new Request("http://x/", { method: "OPTIONS" }))).res.status, 204);
  assertEquals((await run(new Request("http://x/"))).res.status, 405);
});

Deno.test("handleSendTest requires a signed-in user", async () => {
  const none = await run(post({ destination_id: "d1" }, null));
  assertEquals(none.res.status, 401);
  const bad = await run(post({ destination_id: "d1" }), { getUser: { error: { message: "jwt" } } });
  assertEquals(bad.res.status, 401);
  assertEquals(bad.calls.getUser, ["jwt"]);
});

Deno.test("handleSendTest requires a destination id", async () => {
  assertEquals((await run(post("nope"))).body, { error: "Pick a destination." });
  assertEquals((await run(post({ destination_id: 5 }))).res.status, 400);
});

Deno.test("handleSendTest only loads destinations the caller owns", async () => {
  const { res, body, calls, sent } = await run(post({ destination_id: "d1" }));
  assertEquals(res.status, 200);
  assertEquals(body, { ok: true });
  const ops = calls.from[0]!.ops;
  assertEquals(ops.filter(([op]) => op === "eq").map(([, a]) => a), [["id", "d1"], [
    "user_id",
    "u1",
  ]]);
  assertEquals(sent.length, 1);
  assertEquals(sent[0]!.batch[0]!.created_at, NOW.toISOString());
  assertStringIncludes(sent[0]!.batch[0]!.spot.comment, "Shack");
});

Deno.test("handleSendTest reports lookup errors and missing destinations", async () => {
  const err = await run(post({ destination_id: "d1" }), {
    from: { destinations: { error: { message: "x" } } },
  });
  assertEquals(err.res.status, 500);
  const missing = await run(post({ destination_id: "d1" }), {
    from: { destinations: { data: null } },
  });
  assertEquals(missing.res.status, 404);
  assertEquals(missing.sent, []);
});

Deno.test("handleSendTest returns 502 with the delivery error", async () => {
  const failed = await run(post({ destination_id: "d1" }), {}, {
    ok: false,
    sent: 0,
    error: "HTTP 404",
  });
  assertEquals(failed.res.status, 502);
  assertEquals(failed.body, { error: "HTTP 404" });
  const silent = await run(post({ destination_id: "d1" }), {}, { ok: false, sent: 0 });
  assertEquals(silent.body, { error: "Delivery failed." });
});

const PUSH: DeliveryDestination = {
  id: "p1",
  type: "push",
  name: "Push notifications",
  url: null,
  signing_secret: null,
  health: "ok",
  consecutive_failures: 0,
};
const DEVICES = [{ endpoint: "https://fcm.googleapis.com/fcm/send/a", p256dh: "k", auth: "a" }];

Deno.test("handleSendTest loads the owner's devices for a push destination", async () => {
  const { res, sent, calls } = await run(post({ destination_id: "p1" }), {
    from: { destinations: { data: PUSH }, push_devices: { data: DEVICES } },
  });
  assertEquals(res.status, 200);
  assertEquals(sent[0]!.destination.devices, DEVICES);
  assertEquals(sent[0]!.batch[0]!.spot.base_callsign, "N0CALL");
  const devices = calls.from.find((f) => f.table === "push_devices")!;
  assertEquals(devices.ops, [["select", ["endpoint, p256dh, auth"]], ["eq", ["user_id", "u1"]]]);
});

Deno.test("handleSendTest reports a device lookup error", async () => {
  const { res, sent } = await run(post({ destination_id: "p1" }), {
    from: { destinations: { data: PUSH }, push_devices: { error: { message: "x" } } },
  });
  assertEquals(res.status, 500);
  assertEquals(sent, []);
});

Deno.test("handleSendTest prunes and records devices after a push test", async () => {
  const { body, calls } = await run(
    post({ destination_id: "p1" }),
    { from: { destinations: { data: PUSH }, push_devices: { data: [] } } },
    {
      ok: false,
      sent: 0,
      error: "Turn on notifications on a device first.",
      expiredEndpoints: ["https://fcm.googleapis.com/gone"],
      deviceResults: { ok: [], errors: {} },
    },
  );
  assertEquals(body, { error: "Turn on notifications on a device first." });
  assertEquals(calls.rpc, [{
    fn: "prune_push_devices",
    args: { p_endpoints: ["https://fcm.googleapis.com/gone"] },
  }]);
});

Deno.test("handleSendTest leaves other destinations' devices alone", async () => {
  const { calls } = await run(post({ destination_id: "d1" }));
  assertEquals(calls.from.map((f) => f.table), ["destinations"]);
  assertEquals(calls.rpc, []);
});

import { assertEquals } from "@std/assert";
import type { SendResult } from "../delivery/send.ts";
import type { DeliveryDestination, PendingDelivery } from "../delivery/types.ts";
import { handleSendTest } from "../handlers/test_delivery.ts";
import { fakeSupabase, type FakeSupabaseOptions } from "./fake_supabase.ts";

const NOW = new Date("2026-10-05T14:00:00Z");
const USER = { data: { user: { id: "u1" } } };
// A webhook; every type's test spot comes from SQL (webhook_test_delivery here).
const DEST: DeliveryDestination = {
  id: "00000000-0000-4000-8000-0000000000d1",
  type: "webhook",
  name: "Shack",
  url: "https://shack.example.com/spots",
  signing_secret: "whsec_x",
  health: "ok",
  consecutive_failures: 0,
};

const WEBHOOK_TEST = {
  webhook: { batch_seconds: 0, headers: [{ name: "Authorization", value: "Bearer abc" }] },
  spot: {
    id: 0,
    source: "pota",
    spot_time: NOW.toISOString(),
    callsign: "N0CALL",
    base_callsign: "N0CALL",
    spotter: "LONGLINES",
    frequency_khz: 14062,
    band: "20m",
    mode: "cw",
    mode_family: "cw",
    comment: "Test spot from Long Lines. Not a real activation.",
    pota_reference: "US-0000",
    pota_park_name: "Test Park",
    pota_location: "US-TEST",
    sota_summit_ref: null,
    wwff_reference: null,
    wwff_reference_name: null,
    webhook_connection: "Test",
    webhook_fields: [{ key: "id", value: 0 }, { key: "callsign", value: "N0CALL" }],
  },
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
    rpc: { webhook_test_delivery: { data: WEBHOOK_TEST } },
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
  const none = await run(post({ destination_id: "00000000-0000-4000-8000-0000000000d1" }, null));
  assertEquals(none.res.status, 401);
  const bad = await run(post({ destination_id: "00000000-0000-4000-8000-0000000000d1" }), {
    getUser: { error: { message: "jwt" } },
  });
  assertEquals(bad.res.status, 401);
  assertEquals(bad.calls.getUser, ["jwt"]);
});

Deno.test("handleSendTest requires a destination id", async () => {
  assertEquals((await run(post("nope"))).body, { error: "Pick a destination." });
  assertEquals((await run(post({ destination_id: 5 }))).res.status, 400);
});

Deno.test("handleSendTest only loads destinations the caller owns", async () => {
  const { res, body, calls, sent } = await run(
    post({ destination_id: "00000000-0000-4000-8000-0000000000d1" }),
  );
  assertEquals(res.status, 200);
  assertEquals(body, { ok: true });
  const ops = calls.from[0]!.ops;
  assertEquals(ops.filter(([op]) => op === "eq").map(([, a]) => a), [[
    "id",
    "00000000-0000-4000-8000-0000000000d1",
  ], [
    "user_id",
    "u1",
  ]]);
  assertEquals(sent.length, 1);
  assertEquals(sent[0]!.batch[0]!.created_at, NOW.toISOString());
  assertEquals(sent[0]!.batch[0]!.test, true);
});

Deno.test("handleSendTest reports lookup errors and missing destinations", async () => {
  const err = await run(post({ destination_id: "00000000-0000-4000-8000-0000000000d1" }), {
    from: { destinations: { error: { message: "x" } } },
  });
  assertEquals(err.res.status, 500);
  const missing = await run(post({ destination_id: "00000000-0000-4000-8000-0000000000d1" }), {
    from: { destinations: { data: null } },
  });
  assertEquals(missing.res.status, 404);
  assertEquals(missing.sent, []);
});

Deno.test("handleSendTest answers 404 for a destination_id that is not a uuid", async () => {
  const { res, body, calls, sent } = await run(post({ destination_id: "abc" }));
  assertEquals(res.status, 404);
  assertEquals(body, { error: "Destination not found." });
  assertEquals(calls.from, []);
  assertEquals(sent, []);
});

Deno.test("handleSendTest returns 502 with the delivery error", async () => {
  const failed = await run(post({ destination_id: "00000000-0000-4000-8000-0000000000d1" }), {}, {
    ok: false,
    sent: 0,
    error: "HTTP 404",
  });
  assertEquals(failed.res.status, 502);
  assertEquals(failed.body, { error: "HTTP 404" });
  const silent = await run(post({ destination_id: "00000000-0000-4000-8000-0000000000d1" }), {}, {
    ok: false,
    sent: 0,
  });
  assertEquals(silent.body, { error: "Delivery failed." });
});

const PUSH: DeliveryDestination = {
  id: "00000000-0000-4000-8000-0000000000f1",
  type: "push",
  name: "Push notifications",
  url: null,
  signing_secret: null,
  health: "ok",
  consecutive_failures: 0,
};
const DEVICES = [{ endpoint: "https://fcm.googleapis.com/fcm/send/a", p256dh: "k", auth: "a" }];

const TEST_SPOT = {
  id: 0,
  source: "pota",
  spot_time: NOW.toISOString(),
  callsign: "N0CALL",
  base_callsign: "N0CALL",
  spotter: "LONGLINES",
  frequency_khz: 14062,
  band: "20m",
  mode: "cw",
  mode_family: "cw",
  comment: "Test spot from Long Lines. Not a real activation.",
  pota_reference: "US-0000",
  pota_park_name: "Test Park",
  pota_location: "US-TEST",
  sota_summit_ref: null,
  wwff_reference: null,
  wwff_reference_name: null,
  push_title: "N0CALL · 14.062 MHz · CW",
  push_body: "POTA · US-0000 · Test Park · TEST",
  push_url: "/call/N0CALL",
  push_source_url: "https://pota.app/#/park/US-0000",
};
const PUSH_TEST = {
  push: { urgency: "normal", ttl_seconds: 1800 },
  quiet_now: false,
  devices: DEVICES,
  spot: TEST_SPOT,
};

Deno.test("handleSendTest sends a push destination's members the text SQL built from its fields", async () => {
  const { res, sent, calls } = await run(
    post({ destination_id: "00000000-0000-4000-8000-0000000000f1" }),
    {
      from: { destinations: { data: PUSH } },
      rpc: { push_test_delivery: { data: PUSH_TEST } },
    },
  );
  assertEquals(res.status, 200);
  assertEquals(calls.rpc[0], {
    fn: "push_test_delivery",
    args: { p_destination_id: "00000000-0000-4000-8000-0000000000f1", p_spot_id: null },
  });
  assertEquals(sent[0]!.destination.devices, DEVICES);
  assertEquals(sent[0]!.destination.push, PUSH_TEST.push);
  assertEquals(sent[0]!.destination.quiet_now, false);
  assertEquals(sent[0]!.batch[0]!.spot.push_title, "N0CALL · 14.062 MHz · CW");
  // Members come from SQL, never from the owner's device list.
  assertEquals(calls.from.map((f) => f.table), ["destinations"]);
});

Deno.test("handleSendTest renders the spot the preview shows", async () => {
  const { calls } = await run(
    post({ destination_id: "00000000-0000-4000-8000-0000000000f1", spot_id: 42 }),
    {
      from: { destinations: { data: PUSH } },
      rpc: { push_test_delivery: { data: PUSH_TEST } },
    },
  );
  assertEquals(calls.rpc[0]?.args, {
    p_destination_id: "00000000-0000-4000-8000-0000000000f1",
    p_spot_id: 42,
  });
});

Deno.test("handleSendTest refuses a spot id that is not an integer", async () => {
  for (const spotId of ["42", 1.5, {}]) {
    const { body, sent } = await run(
      post({ destination_id: "00000000-0000-4000-8000-0000000000f1", spot_id: spotId }),
    );
    assertEquals(body, { error: "Pick a spot." });
    assertEquals(sent, []);
  }
});

Deno.test("handleSendTest reports a push lookup error and an unknown spot", async () => {
  const failed = await run(post({ destination_id: "00000000-0000-4000-8000-0000000000f1" }), {
    from: { destinations: { data: PUSH } },
    rpc: { push_test_delivery: { error: { message: "x" } } },
  });
  assertEquals(failed.res.status, 500);
  assertEquals(failed.sent, []);
  const missing = await run(
    post({ destination_id: "00000000-0000-4000-8000-0000000000f1", spot_id: 7 }),
    {
      from: { destinations: { data: PUSH } },
      rpc: { push_test_delivery: { data: null } },
    },
  );
  assertEquals(missing.res.status, 404);
  assertEquals(missing.body, { error: "Spot not found." });
  // Without a spot, null can only mean the destination has no settings row.
  const noSettings = await run(post({ destination_id: "00000000-0000-4000-8000-0000000000f1" }), {
    from: { destinations: { data: PUSH } },
    rpc: { push_test_delivery: { data: null } },
  });
  assertEquals(noSettings.res.status, 404);
  assertEquals(noSettings.body, { error: "Destination not found." });
});

Deno.test("handleSendTest prunes and records devices after a push test", async () => {
  const { body, calls } = await run(
    post({ destination_id: "00000000-0000-4000-8000-0000000000f1" }),
    {
      from: { destinations: { data: PUSH } },
      rpc: { push_test_delivery: { data: { ...PUSH_TEST, devices: [] } } },
    },
    {
      ok: false,
      sent: 0,
      error: "Turn on notifications on a device first.",
      expiredEndpoints: ["https://fcm.googleapis.com/gone"],
      deviceResults: { ok: [], errors: {} },
    },
  );
  assertEquals(body, { error: "Turn on notifications on a device first." });
  assertEquals(calls.rpc.slice(1), [{
    fn: "prune_push_devices",
    args: { p_endpoints: ["https://fcm.googleapis.com/gone"] },
  }]);
});

Deno.test("handleSendTest leaves other destinations' devices alone", async () => {
  const { calls } = await run(post({ destination_id: "00000000-0000-4000-8000-0000000000d1" }));
  assertEquals(calls.from.map((f) => f.table), ["destinations"]);
  assertEquals(calls.rpc.map((c) => c.fn), ["webhook_test_delivery"]);
});

const DISCORD: DeliveryDestination = {
  id: "00000000-0000-4000-8000-0000000000e1",
  type: "discord",
  name: "Club",
  url: "https://discord.com/api/webhooks/1/x",
  signing_secret: null,
  health: "ok",
  consecutive_failures: 0,
};
const DISCORD_SETTINGS = {
  style: "card",
  title_fields: ["callsign", "frequency", "mode"],
  detail_fields: ["source", "reference", "place_name", "state"],
  grid_fields: ["band", "spotter"],
  title_link: "profile",
  card_color: "source",
  footer: true,
  line_fields: ["callsign", "frequency", "mode", "source", "reference", "place_name"],
  bold_first: true,
  link_preview: "hidden",
  show_field_names: false,
  separator: "dot",
  batch_seconds: 0,
};
const { push_title: _t, push_body: _b, push_url: _u, push_source_url: _s, ...SAMPLE } = TEST_SPOT;
const DISCORD_TEST = {
  discord: DISCORD_SETTINGS,
  spot: {
    ...SAMPLE,
    discord_style: "card" as const,
    discord_title: "N0CALL · 14.062 MHz · CW",
    discord_description: "POTA · US-0000 · Test Park · TEST",
    discord_grid: [{ name: "Band", value: "20m" }, { name: "Spotter", value: "LONGLINES" }],
    discord_footer: "Test message from Long Lines · POTA · 14:00 UTC",
    discord_color: 3066993,
    discord_url: "https://longlines.io/call/N0CALL",
    discord_line: "Test message from Long Lines · **[N0CALL](https://longlines.io/call/N0CALL)**",
    discord_suppress_embeds: false,
  },
};

Deno.test("handleSendTest sends a Discord destination the message SQL rendered from its settings", async () => {
  const { res, sent, calls } = await run(
    post({ destination_id: "00000000-0000-4000-8000-0000000000e1" }),
    {
      from: { destinations: { data: DISCORD } },
      rpc: { discord_test_delivery: { data: DISCORD_TEST } },
    },
  );
  assertEquals(res.status, 200);
  assertEquals(calls.rpc, [{
    fn: "discord_test_delivery",
    args: { p_destination_id: "00000000-0000-4000-8000-0000000000e1", p_spot_id: null },
  }]);
  assertEquals(sent[0]!.destination.discord, DISCORD_TEST.discord);
  assertEquals(sent[0]!.batch[0]!.spot, DISCORD_TEST.spot);
  assertEquals(sent[0]!.batch[0]!.created_at, NOW.toISOString());
  assertEquals(calls.from.map((f) => f.table), ["destinations"]);
});

Deno.test("handleSendTest renders the spot the Discord preview shows", async () => {
  const { calls } = await run(
    post({ destination_id: "00000000-0000-4000-8000-0000000000e1", spot_id: 42 }),
    {
      from: { destinations: { data: DISCORD } },
      rpc: { discord_test_delivery: { data: DISCORD_TEST } },
    },
  );
  assertEquals(calls.rpc[0]?.args, {
    p_destination_id: "00000000-0000-4000-8000-0000000000e1",
    p_spot_id: 42,
  });
});

Deno.test("handleSendTest reports a Discord lookup error and an unknown spot", async () => {
  const failed = await run(post({ destination_id: "00000000-0000-4000-8000-0000000000e1" }), {
    from: { destinations: { data: DISCORD } },
    rpc: { discord_test_delivery: { error: { message: "x" } } },
  });
  assertEquals(failed.res.status, 500);
  assertEquals(failed.body, { error: "Couldn't load that destination." });
  assertEquals(failed.sent, []);
  const missing = await run(
    post({ destination_id: "00000000-0000-4000-8000-0000000000e1", spot_id: 7 }),
    {
      from: { destinations: { data: DISCORD } },
      rpc: { discord_test_delivery: { data: null } },
    },
  );
  assertEquals(missing.res.status, 404);
  assertEquals(missing.body, { error: "Spot not found." });
  assertEquals(missing.sent, []);
  const noSettings = await run(post({ destination_id: "00000000-0000-4000-8000-0000000000e1" }), {
    from: { destinations: { data: DISCORD } },
    rpc: { discord_test_delivery: { data: null } },
  });
  assertEquals(noSettings.res.status, 404);
  assertEquals(noSettings.body, { error: "Destination not found." });
});

Deno.test("handleSendTest sends a webhook the body SQL rendered, marked as a test", async () => {
  const { res, body, sent, calls } = await run(
    post({ destination_id: "00000000-0000-4000-8000-0000000000d1", spot_id: 42 }),
    {},
    { ok: true, sent: 1, attempted: 1, status: 204 },
  );
  assertEquals(calls.rpc, [{
    fn: "webhook_test_delivery",
    args: { p_destination_id: "00000000-0000-4000-8000-0000000000d1", p_spot_id: 42 },
  }]);
  assertEquals(sent[0]!.destination.webhook, WEBHOOK_TEST.webhook);
  assertEquals(sent[0]!.batch[0]!.spot, WEBHOOK_TEST.spot);
  assertEquals(sent[0]!.batch[0]!.test, true);
  assertEquals(sent[0]!.batch[0]!.delivery_id, 0);
  assertEquals(res.status, 200);
  assertEquals(body, { ok: true, status: 204 });
});

Deno.test("handleSendTest answers a failed webhook test with the receiver's status", async () => {
  const failed = await run(post({ destination_id: "00000000-0000-4000-8000-0000000000d1" }), {}, {
    ok: false,
    sent: 0,
    attempted: 1,
    status: 500,
    error: "Webhook HTTP 500",
  });
  assertEquals(failed.res.status, 502);
  assertEquals(failed.body, { error: "Webhook HTTP 500", status: 500 });
  // A request that never got a status has none.
  const unreached = await run(
    post({ destination_id: "00000000-0000-4000-8000-0000000000d1" }),
    {},
    {
      ok: false,
      sent: 0,
      attempted: 1,
      error: "Webhook request failed: refused",
    },
  );
  assertEquals(unreached.body, { error: "Webhook request failed: refused" });
});

Deno.test("handleSendTest reports a webhook lookup error and an unknown spot", async () => {
  const failed = await run(post({ destination_id: "00000000-0000-4000-8000-0000000000d1" }), {
    rpc: { webhook_test_delivery: { error: { message: "x" } } },
  });
  assertEquals(failed.res.status, 500);
  assertEquals(failed.body, { error: "Couldn't load that destination." });
  assertEquals(failed.sent, []);
  const missing = await run(
    post({ destination_id: "00000000-0000-4000-8000-0000000000d1", spot_id: 7 }),
    { rpc: { webhook_test_delivery: { data: null } } },
  );
  assertEquals(missing.res.status, 404);
  assertEquals(missing.body, { error: "Spot not found." });
  const notWebhook = await run(post({ destination_id: "00000000-0000-4000-8000-0000000000d1" }), {
    rpc: { webhook_test_delivery: { data: null } },
  });
  assertEquals(notWebhook.body, { error: "Destination not found." });
  assertEquals(notWebhook.sent, []);
});

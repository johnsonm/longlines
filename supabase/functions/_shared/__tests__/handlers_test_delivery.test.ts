import { assertEquals } from "@std/assert";
import type { SendResult } from "../delivery/send.ts";
import type { DeliveryDestination, PendingDelivery } from "../delivery/types.ts";
import {
  DESTINATION_THROTTLED,
  handleSendTest,
  TOO_MANY_TESTS,
} from "../handlers/test_delivery.ts";
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

/** A destination as sendTestTo's select returns it: every column, throttled_until included. */
function loaded(destination: DeliveryDestination): unknown {
  return Object.assign({}, destination, { throttled_until: null });
}

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
    wwbota_references: null,
    wwbota_reference_name: null,
    iota_reference: null,
    webhook_connection: "Test",
    webhook_fields: [{ key: "id", value: 0 }, { key: "callsign", value: "N0CALL" }],
  },
};

function post(body: unknown, token: string | null): Request {
  const headers: Record<string, string> = {};
  if (token !== null && token !== "") {
    headers.Authorization = `Bearer ${token}`;
  }
  let text: string;
  if (typeof body === "string") {
    text = body;
  } else {
    text = JSON.stringify(body);
  }
  return new Request("http://x/", {
    method: "POST",
    headers,
    body: text,
  });
}

const SENT_ONE: SendResult = { ok: true, sent: 1 };

async function run(
  req: Request,
  options: FakeSupabaseOptions,
  result: SendResult,
) {
  const ran = fakeSupabase(Object.assign(
    { getUser: USER, from: { destinations: { data: loaded(DEST) } } },
    options,
    {
      rpc: Object.assign({
        record_send_test: { data: true },
        webhook_test_delivery: { data: WEBHOOK_TEST },
      }, options.rpc),
    },
  ));
  const client = ran.client;
  const calls = ran.calls;
  const sent: Array<{ destination: DeliveryDestination; batch: readonly PendingDelivery[] }> = [];
  function send(destination: DeliveryDestination, batch: readonly PendingDelivery[]) {
    sent.push({ destination, batch });
    return Promise.resolve(result);
  }
  const res = await handleSendTest(req, { admin: () => client, send }, NOW);
  let body = null;
  if (res.status !== 204) {
    body = await res.json();
  }
  return { res, body, calls, sent };
}

Deno.test(
  "handleSendTest answers preflight and rejects other methods",
  async function (): Promise<void> {
    assertEquals(
      (await run(new Request("http://x/", { method: "OPTIONS" }), {}, SENT_ONE)).res.status,
      204,
    );
    assertEquals((await run(new Request("http://x/"), {}, SENT_ONE)).res.status, 405);
  },
);

Deno.test("handleSendTest requires a signed-in user", async function (): Promise<void> {
  const none = await run(
    post({ destination_id: "00000000-0000-4000-8000-0000000000d1" }, null),
    {},
    SENT_ONE,
  );
  assertEquals(none.res.status, 401);
  const bad = await run(post({ destination_id: "00000000-0000-4000-8000-0000000000d1" }, "jwt"), {
    getUser: { error: { message: "jwt" } },
  }, SENT_ONE);
  assertEquals(bad.res.status, 401);
  assertEquals(bad.calls.getUser, ["jwt"]);
});

Deno.test("handleSendTest requires a destination id", async function (): Promise<void> {
  assertEquals((await run(post("nope", "jwt"), {}, SENT_ONE)).body, {
    error: "Pick a destination.",
  });
  assertEquals((await run(post({ destination_id: 5 }, "jwt"), {}, SENT_ONE)).res.status, 400);
  for (const body of [null, [], { spot_id: 1 }]) {
    assertEquals((await run(post(body, "jwt"), {}, SENT_ONE)).body, {
      error: "Pick a destination.",
    });
  }
  // Strict: the web app sends only destination_id and spot_id.
  const extra = await run(
    post({ destination_id: "00000000-0000-4000-8000-0000000000d1", force: true }, "jwt"),
    {},
    SENT_ONE,
  );
  assertEquals([extra.res.status, extra.body], [400, { error: "Pick a destination." }]);
  assertEquals(extra.calls.rpc, []);
});

Deno.test(
  "handleSendTest answers 500 for database results of the wrong shape",
  async function (): Promise<void> {
    const id = "00000000-0000-4000-8000-0000000000d1";
    const unavailable = { error: "Couldn't load that destination." };
    const limit = await run(post({ destination_id: id }, "jwt"), {
      rpc: { record_send_test: { data: "yes" } },
    }, SENT_ONE);
    assertEquals([limit.res.status, limit.body], [500, unavailable]);
    assertEquals(limit.sent, []);

    const row = await run(post({ destination_id: id }, "jwt"), {
      from: { destinations: { data: Object.assign({}, DEST, { health: "sick" }) } },
    }, SENT_ONE);
    assertEquals([row.res.status, row.body], [500, unavailable]);
    assertEquals(row.sent, []);

    const test = await run(post({ destination_id: id }, "jwt"), {
      rpc: { webhook_test_delivery: { data: { webhook: { batch_seconds: 0 }, spot: {} } } },
    }, SENT_ONE);
    assertEquals([test.res.status, test.body], [500, unavailable]);
    assertEquals(test.sent, []);
  },
);

Deno.test(
  "handleSendTest only loads destinations the caller owns",
  async function (): Promise<void> {
    const ran = await run(
      post({ destination_id: "00000000-0000-4000-8000-0000000000d1" }, "jwt"),
      {},
      SENT_ONE,
    );
    const res = ran.res;
    const body = ran.body;
    const calls = ran.calls;
    const sent = ran.sent;
    assertEquals(res.status, 200);
    assertEquals(body, { ok: true });
    const ops = calls.from[0]!.ops;
    assertEquals(ops.filter((o) => o[0] === "eq").map((o) => o[1]), [[
      "id",
      "00000000-0000-4000-8000-0000000000d1",
    ], [
      "user_id",
      "u1",
    ]]);
    assertEquals(sent.length, 1);
    assertEquals(sent[0]!.batch[0]!.created_at, NOW.toISOString());
    assertEquals(sent[0]!.batch[0]!.test, true);
  },
);

Deno.test(
  "handleSendTest reports lookup errors and missing destinations",
  async function (): Promise<void> {
    const err = await run(post({ destination_id: "00000000-0000-4000-8000-0000000000d1" }, "jwt"), {
      from: { destinations: { error: { message: "x" } } },
    }, SENT_ONE);
    assertEquals(err.res.status, 500);
    const missing = await run(
      post({ destination_id: "00000000-0000-4000-8000-0000000000d1" }, "jwt"),
      {
        from: { destinations: { data: null } },
      },
      SENT_ONE,
    );
    assertEquals(missing.res.status, 404);
    assertEquals(missing.sent, []);
  },
);

Deno.test(
  "handleSendTest answers 404 for a destination_id that is not a uuid",
  async function (): Promise<void> {
    const ran = await run(post({ destination_id: "abc" }, "jwt"), {}, SENT_ONE);
    const res = ran.res;
    const body = ran.body;
    const calls = ran.calls;
    const sent = ran.sent;
    assertEquals(res.status, 404);
    assertEquals(body, { error: "Destination not found." });
    assertEquals(calls.from, []);
    assertEquals(sent, []);
  },
);

Deno.test("handleSendTest returns 502 with the delivery error", async function (): Promise<void> {
  const failed = await run(
    post({ destination_id: "00000000-0000-4000-8000-0000000000d1" }, "jwt"),
    {},
    {
      ok: false,
      sent: 0,
      error: "HTTP 404",
    },
  );
  assertEquals(failed.res.status, 502);
  assertEquals(failed.body, { error: "HTTP 404" });
  const silent = await run(
    post({ destination_id: "00000000-0000-4000-8000-0000000000d1" }, "jwt"),
    {},
    {
      ok: false,
      sent: 0,
    },
  );
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
  wwbota_references: null,
  wwbota_reference_name: null,
  iota_reference: null,
  push_title: "N0CALL · 14.062 MHz · CW",
  push_body: "POTA · US-0000 · Test Park · TEST",
  push_url: "/call/N0CALL",
  push_source_url: "https://pota.app/#/park/US-0000",
};
// push_destination_settings as to_jsonb gives it, less destination_id.
const PUSH_SETTINGS = {
  title_fields: ["callsign", "frequency", "mode"],
  body_fields: ["source", "reference", "place_name", "state"],
  show_field_names: false,
  body_separator: "dot",
  tap_target: "profile",
  action_buttons: true,
  urgency: "normal",
  ttl_seconds: 1800,
  replace_same_station: true,
  sound: true,
  quiet_enabled: false,
  quiet_from: "22:00:00",
  quiet_until: "07:00:00",
  quiet_mode: "silent",
};
const PUSH_TEST = {
  push: PUSH_SETTINGS,
  quiet_now: false,
  devices: DEVICES,
  spot: TEST_SPOT,
};

Deno.test(
  "handleSendTest sends a push destination's members the text SQL built from its fields",
  async function (): Promise<void> {
    const ran = await run(
      post({ destination_id: "00000000-0000-4000-8000-0000000000f1" }, "jwt"),
      {
        from: { destinations: { data: loaded(PUSH) } },
        rpc: { push_test_delivery: { data: PUSH_TEST } },
      },
      SENT_ONE,
    );
    const res = ran.res;
    const sent = ran.sent;
    const calls = ran.calls;
    assertEquals(res.status, 200);
    assertEquals(calls.rpc[1], {
      fn: "push_test_delivery",
      args: { p_destination_id: "00000000-0000-4000-8000-0000000000f1", p_spot_id: null },
    });
    assertEquals(sent[0]!.destination.devices, DEVICES);
    assertEquals(sent[0]!.destination.push, PUSH_TEST.push);
    assertEquals(sent[0]!.destination.quiet_now, false);
    assertEquals(sent[0]!.batch[0]!.spot.push_title, "N0CALL · 14.062 MHz · CW");
    // Members come from SQL, never from the owner's device list.
    assertEquals(calls.from.map((f) => f.table), ["destinations"]);
  },
);

Deno.test("handleSendTest renders the spot the preview shows", async function (): Promise<void> {
  const ran = await run(
    post({ destination_id: "00000000-0000-4000-8000-0000000000f1", spot_id: 42 }, "jwt"),
    {
      from: { destinations: { data: loaded(PUSH) } },
      rpc: { push_test_delivery: { data: PUSH_TEST } },
    },
    SENT_ONE,
  );
  const calls = ran.calls;
  const call = calls.rpc[1];
  let args: Record<string, unknown> | undefined;
  if (call !== undefined) {
    args = call.args;
  }
  assertEquals(args, {
    p_destination_id: "00000000-0000-4000-8000-0000000000f1",
    p_spot_id: 42,
  });
});

Deno.test(
  "handleSendTest refuses a spot id that is not an integer",
  async function (): Promise<void> {
    for (const spotId of ["42", 1.5, {}]) {
      const ran = await run(
        post({ destination_id: "00000000-0000-4000-8000-0000000000f1", spot_id: spotId }, "jwt"),
        {},
        SENT_ONE,
      );
      const body = ran.body;
      const sent = ran.sent;
      assertEquals(body, { error: "Pick a spot." });
      assertEquals(sent, []);
    }
  },
);

Deno.test(
  "handleSendTest reports a push lookup error and an unknown spot",
  async function (): Promise<void> {
    const failed = await run(
      post({ destination_id: "00000000-0000-4000-8000-0000000000f1" }, "jwt"),
      {
        from: { destinations: { data: loaded(PUSH) } },
        rpc: { push_test_delivery: { error: { message: "x" } } },
      },
      SENT_ONE,
    );
    assertEquals(failed.res.status, 500);
    assertEquals(failed.sent, []);
    const missing = await run(
      post({ destination_id: "00000000-0000-4000-8000-0000000000f1", spot_id: 7 }, "jwt"),
      {
        from: { destinations: { data: loaded(PUSH) } },
        rpc: { push_test_delivery: { data: null } },
      },
      SENT_ONE,
    );
    assertEquals(missing.res.status, 404);
    assertEquals(missing.body, { error: "Spot not found." });
    // Without a spot, null can only mean the destination has no settings row.
    const noSettings = await run(
      post({ destination_id: "00000000-0000-4000-8000-0000000000f1" }, "jwt"),
      {
        from: { destinations: { data: loaded(PUSH) } },
        rpc: { push_test_delivery: { data: null } },
      },
      SENT_ONE,
    );
    assertEquals(noSettings.res.status, 404);
    assertEquals(noSettings.body, { error: "Destination not found." });
  },
);

Deno.test(
  "handleSendTest prunes and records devices after a push test",
  async function (): Promise<void> {
    const ran = await run(
      post({ destination_id: "00000000-0000-4000-8000-0000000000f1" }, "jwt"),
      {
        from: { destinations: { data: loaded(PUSH) } },
        rpc: { push_test_delivery: { data: Object.assign({}, PUSH_TEST, { devices: [] }) } },
      },
      {
        ok: false,
        sent: 0,
        error: "Turn on notifications on a device first.",
        expiredEndpoints: ["https://fcm.googleapis.com/gone"],
        deviceResults: { ok: [], errors: {} },
      },
    );
    const body = ran.body;
    const calls = ran.calls;
    assertEquals(body, { error: "Turn on notifications on a device first." });
    assertEquals(calls.rpc.slice(2), [{
      fn: "prune_push_devices",
      args: { p_endpoints: ["https://fcm.googleapis.com/gone"] },
    }]);
  },
);

Deno.test(
  "handleSendTest leaves other destinations' devices alone",
  async function (): Promise<void> {
    const ran = await run(
      post({ destination_id: "00000000-0000-4000-8000-0000000000d1" }, "jwt"),
      {},
      SENT_ONE,
    );
    const calls = ran.calls;
    assertEquals(calls.from.map((f) => f.table), ["destinations"]);
    assertEquals(calls.rpc.map((c) => c.fn), ["record_send_test", "webhook_test_delivery"]);
  },
);

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
// TEST_SPOT without the push keys.
const SAMPLE = {
  id: TEST_SPOT.id,
  source: TEST_SPOT.source,
  spot_time: TEST_SPOT.spot_time,
  callsign: TEST_SPOT.callsign,
  base_callsign: TEST_SPOT.base_callsign,
  spotter: TEST_SPOT.spotter,
  frequency_khz: TEST_SPOT.frequency_khz,
  band: TEST_SPOT.band,
  mode: TEST_SPOT.mode,
  mode_family: TEST_SPOT.mode_family,
  comment: TEST_SPOT.comment,
  pota_reference: TEST_SPOT.pota_reference,
  pota_park_name: TEST_SPOT.pota_park_name,
  pota_location: TEST_SPOT.pota_location,
  sota_summit_ref: TEST_SPOT.sota_summit_ref,
  wwff_reference: TEST_SPOT.wwff_reference,
  wwff_reference_name: TEST_SPOT.wwff_reference_name,
};
const DISCORD_TEST = {
  discord: DISCORD_SETTINGS,
  spot: Object.assign({}, SAMPLE, {
    discord_style: "card" as const,
    discord_title: "N0CALL · 14.062 MHz · CW",
    discord_description: "POTA · US-0000 · Test Park · TEST",
    discord_grid: [{ name: "Band", value: "20m" }, { name: "Spotter", value: "LONGLINES" }],
    discord_footer: "Test message from Long Lines · POTA · 14:00 UTC",
    discord_color: 3066993,
    discord_url: "https://longlines.io/call/N0CALL",
    discord_line: "Test message from Long Lines · **[N0CALL](https://longlines.io/call/N0CALL)**",
    discord_suppress_embeds: false,
  }),
};

Deno.test(
  "handleSendTest sends a Discord destination the message SQL rendered from its settings",
  async function (): Promise<void> {
    const ran = await run(
      post({ destination_id: "00000000-0000-4000-8000-0000000000e1" }, "jwt"),
      {
        from: { destinations: { data: loaded(DISCORD) } },
        rpc: { discord_test_delivery: { data: DISCORD_TEST } },
      },
      SENT_ONE,
    );
    const res = ran.res;
    const sent = ran.sent;
    const calls = ran.calls;
    assertEquals(res.status, 200);
    assertEquals(calls.rpc.slice(1), [{
      fn: "discord_test_delivery",
      args: { p_destination_id: "00000000-0000-4000-8000-0000000000e1", p_spot_id: null },
    }]);
    assertEquals(sent[0]!.destination.discord, DISCORD_TEST.discord);
    assertEquals(sent[0]!.batch[0]!.spot, DISCORD_TEST.spot);
    assertEquals(sent[0]!.batch[0]!.created_at, NOW.toISOString());
    assertEquals(calls.from.map((f) => f.table), ["destinations"]);
  },
);

Deno.test(
  "handleSendTest renders the spot the Discord preview shows",
  async function (): Promise<void> {
    const ran = await run(
      post({ destination_id: "00000000-0000-4000-8000-0000000000e1", spot_id: 42 }, "jwt"),
      {
        from: { destinations: { data: loaded(DISCORD) } },
        rpc: { discord_test_delivery: { data: DISCORD_TEST } },
      },
      SENT_ONE,
    );
    const calls = ran.calls;
    const call = calls.rpc[1];
    let args: Record<string, unknown> | undefined;
    if (call !== undefined) {
      args = call.args;
    }
    assertEquals(args, {
      p_destination_id: "00000000-0000-4000-8000-0000000000e1",
      p_spot_id: 42,
    });
  },
);

Deno.test(
  "handleSendTest reports a Discord lookup error and an unknown spot",
  async function (): Promise<void> {
    const failed = await run(
      post({ destination_id: "00000000-0000-4000-8000-0000000000e1" }, "jwt"),
      {
        from: { destinations: { data: loaded(DISCORD) } },
        rpc: { discord_test_delivery: { error: { message: "x" } } },
      },
      SENT_ONE,
    );
    assertEquals(failed.res.status, 500);
    assertEquals(failed.body, { error: "Couldn't load that destination." });
    assertEquals(failed.sent, []);
    const missing = await run(
      post({ destination_id: "00000000-0000-4000-8000-0000000000e1", spot_id: 7 }, "jwt"),
      {
        from: { destinations: { data: loaded(DISCORD) } },
        rpc: { discord_test_delivery: { data: null } },
      },
      SENT_ONE,
    );
    assertEquals(missing.res.status, 404);
    assertEquals(missing.body, { error: "Spot not found." });
    assertEquals(missing.sent, []);
    const noSettings = await run(
      post({ destination_id: "00000000-0000-4000-8000-0000000000e1" }, "jwt"),
      {
        from: { destinations: { data: loaded(DISCORD) } },
        rpc: { discord_test_delivery: { data: null } },
      },
      SENT_ONE,
    );
    assertEquals(noSettings.res.status, 404);
    assertEquals(noSettings.body, { error: "Destination not found." });
  },
);

Deno.test(
  "handleSendTest sends a webhook the body SQL rendered, marked as a test",
  async function (): Promise<void> {
    const ran = await run(
      post({ destination_id: "00000000-0000-4000-8000-0000000000d1", spot_id: 42 }, "jwt"),
      {},
      { ok: true, sent: 1, attempted: 1, status: 204 },
    );
    const res = ran.res;
    const body = ran.body;
    const sent = ran.sent;
    const calls = ran.calls;
    assertEquals(calls.rpc.slice(1), [{
      fn: "webhook_test_delivery",
      args: { p_destination_id: "00000000-0000-4000-8000-0000000000d1", p_spot_id: 42 },
    }]);
    assertEquals(sent[0]!.destination.webhook, WEBHOOK_TEST.webhook);
    assertEquals(sent[0]!.batch[0]!.spot, WEBHOOK_TEST.spot);
    assertEquals(sent[0]!.batch[0]!.test, true);
    assertEquals(sent[0]!.batch[0]!.delivery_id, 0);
    assertEquals(res.status, 200);
    assertEquals(body, { ok: true, status: 204 });
  },
);

Deno.test(
  "handleSendTest skips a webhook header whose Vault value no longer decrypts, as the claim does",
  async function (): Promise<void> {
    // webhook_header_values reads decrypted_secret, which is null when the secret cannot be read.
    const headers = [
      { name: "X-Gone", value: null },
      { name: "Authorization", value: "Bearer abc" },
    ];
    const ran = await run(
      post({ destination_id: "00000000-0000-4000-8000-0000000000d1" }, "jwt"),
      {
        rpc: {
          webhook_test_delivery: {
            data: { webhook: { batch_seconds: 0, headers }, spot: WEBHOOK_TEST.spot },
          },
        },
      },
      { ok: true, sent: 1, attempted: 1, status: 204 },
    );
    assertEquals(ran.res.status, 200);
    assertEquals(ran.sent[0]!.destination.webhook, WEBHOOK_TEST.webhook);
  },
);

Deno.test(
  "handleSendTest answers a failed webhook test with the receiver's status",
  async function (): Promise<void> {
    const failed = await run(
      post({ destination_id: "00000000-0000-4000-8000-0000000000d1" }, "jwt"),
      {},
      {
        ok: false,
        sent: 0,
        attempted: 1,
        status: 500,
        error: "Webhook HTTP 500",
      },
    );
    assertEquals(failed.res.status, 502);
    assertEquals(failed.body, { error: "Webhook HTTP 500", status: 500 });
    // A request that never got a status has none.
    const unreached = await run(
      post({ destination_id: "00000000-0000-4000-8000-0000000000d1" }, "jwt"),
      {},
      {
        ok: false,
        sent: 0,
        attempted: 1,
        error: "Webhook request failed: refused",
      },
    );
    assertEquals(unreached.body, { error: "Webhook request failed: refused" });
  },
);

Deno.test(
  "handleSendTest reports a webhook lookup error and an unknown spot",
  async function (): Promise<void> {
    const failed = await run(
      post({ destination_id: "00000000-0000-4000-8000-0000000000d1" }, "jwt"),
      {
        rpc: { webhook_test_delivery: { error: { message: "x" } } },
      },
      SENT_ONE,
    );
    assertEquals(failed.res.status, 500);
    assertEquals(failed.body, { error: "Couldn't load that destination." });
    assertEquals(failed.sent, []);
    const missing = await run(
      post({ destination_id: "00000000-0000-4000-8000-0000000000d1", spot_id: 7 }, "jwt"),
      { rpc: { webhook_test_delivery: { data: null } } },
      SENT_ONE,
    );
    assertEquals(missing.res.status, 404);
    assertEquals(missing.body, { error: "Spot not found." });
    const notWebhook = await run(
      post({ destination_id: "00000000-0000-4000-8000-0000000000d1" }, "jwt"),
      {
        rpc: { webhook_test_delivery: { data: null } },
      },
      SENT_ONE,
    );
    assertEquals(notWebhook.body, { error: "Destination not found." });
    assertEquals(notWebhook.sent, []);
  },
);

Deno.test(
  "handleSendTest records the test before sending and refuses one over the limit",
  async function (): Promise<void> {
    const ok = await run(
      post({ destination_id: "00000000-0000-4000-8000-0000000000d1" }, "jwt"),
      {},
      SENT_ONE,
    );
    assertEquals(ok.calls.rpc[0], {
      fn: "record_send_test",
      args: { p_user_id: "u1", p_destination_id: "00000000-0000-4000-8000-0000000000d1" },
    });
    const limited = await run(
      post({ destination_id: "00000000-0000-4000-8000-0000000000d1" }, "jwt"),
      {
        rpc: { record_send_test: { data: false } },
      },
      SENT_ONE,
    );
    assertEquals(limited.res.status, 429);
    assertEquals(limited.body, { error: TOO_MANY_TESTS });
    assertEquals(limited.calls.from, []);
    assertEquals(limited.sent, []);
    // Null: not the caller's destination, which the lookup then answers with 404.
    const notOwned = await run(
      post({ destination_id: "00000000-0000-4000-8000-0000000000d1" }, "jwt"),
      {
        rpc: { record_send_test: { data: null } },
        from: { destinations: { data: null } },
      },
      SENT_ONE,
    );
    assertEquals(notOwned.res.status, 404);
    const failed = await run(
      post({ destination_id: "00000000-0000-4000-8000-0000000000d1" }, "jwt"),
      {
        rpc: { record_send_test: { error: { message: "x" } } },
      },
      SENT_ONE,
    );
    assertEquals(failed.res.status, 500);
    assertEquals(failed.sent, []);
  },
);

Deno.test(
  "handleSendTest refuses a destination that is throttled",
  async function (): Promise<void> {
    const throttled = await run(
      post({ destination_id: "00000000-0000-4000-8000-0000000000d1" }, "jwt"),
      {
        from: {
          destinations: {
            data: Object.assign({}, DEST, { throttled_until: "2026-10-05T14:01:00Z" }),
          },
        },
      },
      SENT_ONE,
    );
    assertEquals(throttled.res.status, 429);
    assertEquals(throttled.body, { error: DESTINATION_THROTTLED });
    assertEquals(throttled.sent, []);
    // A throttle that has run out is no longer in the way, and never reaches the sender.
    const over = await run(
      post({ destination_id: "00000000-0000-4000-8000-0000000000d1" }, "jwt"),
      {
        from: {
          destinations: {
            data: Object.assign({}, DEST, { throttled_until: "2026-10-05T13:59:00Z" }),
          },
        },
      },
      SENT_ONE,
    );
    assertEquals(over.res.status, 200);
    assertEquals("throttled_until" in over.sent[0]!.destination, false);
    assertEquals(over.calls.from[0]!.ops[0], [
      "select",
      ["id, type, name, url, signing_secret, health, consecutive_failures, throttled_until"],
    ]);
  },
);

Deno.test(
  "handleSendTest refuses a Local DX cluster: only the relay's own test spot reaches it",
  async function (): Promise<void> {
    const relay: DeliveryDestination = Object.assign({}, DEST, {
      type: "local_cluster",
      url: null,
      signing_secret: null,
    });
    const ran = await run(post({ destination_id: DEST.id }, "jwt"), {
      from: { destinations: { data: loaded(relay) } },
    }, SENT_ONE);
    assertEquals(ran.res.status, 400);
    assertEquals(ran.body, { error: "Send a test spot from the relay." });
    assertEquals(ran.sent, []);
    // No test RPC renders a spot for it.
    assertEquals(ran.calls.rpc.map((c: { fn: string }) => c.fn), ["record_send_test"]);
  },
);

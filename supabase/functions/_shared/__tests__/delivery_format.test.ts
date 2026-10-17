import { assertEquals } from "@std/assert";
import {
  backoffSeconds,
  discordMessages,
  embedForSpot,
  LEGACY_PUSH_SETTINGS,
  pushNotifications,
  pushPayload,
  pushSettingsOf,
  pushSkipped,
  sampleSpot,
  sourceLabel,
  webhookPayloads,
  webhookSpot,
} from "../delivery/format.ts";
import { MAX_PUSH_PLAINTEXT_BYTES } from "../delivery/webpush.ts";
import type { DeliverySpot, PendingDelivery, PushSettings } from "../delivery/types.ts";

const spot: DeliverySpot = {
  id: 42,
  source: "pota",
  spot_time: "2026-10-05T14:32:08.000Z",
  callsign: "KK4PWJ",
  base_callsign: "KK4PWJ",
  spotter: "W4ABC",
  frequency_khz: 14062,
  band: "20m",
  mode: "cw",
  mode_family: "cw",
  comment: "CQ POTA",
  pota_reference: "US-2763",
  pota_park_name: "Eno River State Park",
  pota_location: "US-NC",
  sota_summit_ref: null,
  wwff_reference: null,
  wwff_reference_name: null,
};

function delivery(id: number, s: DeliverySpot = spot): PendingDelivery {
  return {
    msg_id: 1000 + id,
    delivery_id: id,
    subscription_id: "11111111-1111-1111-1111-111111111111",
    attempts: 0,
    created_at: "2026-10-05T14:32:09.000Z",
    destination: {
      id: "d1",
      type: "webhook",
      name: "Shack",
      url: "https://shack.example.com/spots",
      signing_secret: "whsec_x",
      health: "ok",
      consecutive_failures: 0,
    },
    spot: s,
  };
}

Deno.test("embedForSpot titles with the callsign and lists the spot facts", () => {
  const e = embedForSpot(spot);
  assertEquals(e.title, "KK4PWJ");
  assertEquals(e.description, "14062.0 kHz CW (20m)");
  const names = e.fields.map((f) => f.name);
  assertEquals(names, ["Reference", "Park", "Source", "Spotter", "Time (UTC)"]);
  assertEquals(e.fields.find((f) => f.name === "Reference")?.value, "US-2763");
  assertEquals(e.fields.find((f) => f.name === "Source")?.value, "POTA");
  assertEquals(e.fields.find((f) => f.name === "Time (UTC)")?.value, "14:32:08");
  assertEquals(e.timestamp, "2026-10-05T14:32:08.000Z");
});

Deno.test("embedForSpot shows the summit for SOTAwatch spots and omits empty facts", () => {
  const e = embedForSpot({
    ...spot,
    source: "sotawatch",
    pota_reference: null,
    pota_park_name: null,
    pota_location: null,
    sota_summit_ref: "W4C/CM-001",
    spotter: null,
    mode: null,
    mode_family: null,
    band: null,
  });
  assertEquals(e.description, "14062.0 kHz");
  assertEquals(e.fields.map((f) => [f.name, f.value]), [
    ["Summit", "W4C/CM-001"],
    ["Source", "SOTAwatch"],
    ["Time (UTC)", "14:32:08"],
  ]);
});

Deno.test("embedForSpot shows the WWFF reference and its name for WWFF spots", () => {
  const e = embedForSpot({
    ...spot,
    source: "wwff",
    pota_reference: null,
    pota_park_name: null,
    pota_location: null,
    wwff_reference: "KFF-6101",
    wwff_reference_name: "State Game Land PA 013",
  });
  assertEquals(e.fields.map((f) => [f.name, f.value]).slice(0, 3), [
    ["WWFF", "KFF-6101"],
    ["Reserve", "State Game Land PA 013"],
    ["Source", "WWFF"],
  ]);
});

Deno.test("discordMessages batches at most 10 embeds per message", () => {
  const spots = Array.from({ length: 25 }, (_, i) => ({ ...spot, id: i }));
  const msgs = discordMessages(spots);
  assertEquals(msgs.map((m) => m.embeds.length), [10, 10, 5]);
  assertEquals(msgs[0]?.embeds[0]?.title, "KK4PWJ");
});

Deno.test("webhookPayloads carry delivery and connection ids with the normalized spot, 50 per request", () => {
  const ds = Array.from({ length: 51 }, (_, i) => delivery(i + 1));
  const payloads = webhookPayloads(ds);
  assertEquals(payloads.map((p) => p.deliveries.length), [50, 1]);
  const first = payloads[0]?.deliveries[0];
  assertEquals(first?.delivery_id, 1);
  assertEquals(first?.connection_id, "11111111-1111-1111-1111-111111111111");
  assertEquals(first?.spot.callsign, "KK4PWJ");
  assertEquals("raw_payload" in (first?.spot ?? {}), false);
});

Deno.test("backoffSeconds follows 30s, 1m, 2m, 5m, 15m, then every 30m", () => {
  assertEquals([1, 2, 3, 4, 5, 6, 7, 40].map(backoffSeconds), [
    30,
    60,
    120,
    300,
    900,
    1800,
    1800,
    1800,
  ]);
});

Deno.test("sourceLabel names every source and passes an unknown one through", () => {
  assertEquals(
    ["pota", "sotawatch", "rbn", "dxcluster", "wwff", "other"].map(sourceLabel),
    ["POTA", "SOTAwatch", "RBN", "DX Cluster", "WWFF", "other"],
  );
});

Deno.test("webhookPayloads leaves out the push-only fields SQL adds", () => {
  const pushedSpot: DeliverySpot = {
    ...spot,
    push_title: "t",
    push_body: "b",
    push_url: "/call/KK4PWJ",
    push_source_url: null,
  };
  const [payload] = webhookPayloads([delivery(1, pushedSpot)]);
  assertEquals(payload?.deliveries[0]?.spot, spot);
  assertEquals(webhookSpot(spot), spot);
});

// A spot as claim_deliveries hands it to a push destination: text and URLs built in SQL.
const pushed = (callsign: string, id = 0, more: Partial<DeliverySpot> = {}): DeliverySpot => ({
  ...spot,
  id,
  callsign,
  base_callsign: callsign,
  push_title: `${callsign} · 14.062 MHz · CW`,
  push_body: "POTA · US-2763 · Eno River State Park · NC",
  push_url: `/call/${callsign}`,
  push_source_url: "https://pota.app/#/park/US-2763",
  ...more,
});

// The defaults as push_default_settings() stores them.
const SETTINGS: PushSettings = {
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

Deno.test("pushNotifications passes SQL's text and URLs through, with both buttons", () => {
  assertEquals(pushNotifications([pushed("KK4PWJ", 7)], SETTINGS), [{
    title: "KK4PWJ · 14.062 MHz · CW",
    body: "POTA · US-2763 · Eno River State Park · NC",
    tag: "spot:KK4PWJ",
    url: "/call/KK4PWJ",
    sourceUrl: "https://pota.app/#/park/US-2763",
    actions: [{ action: "profile", title: "Open profile" }, {
      action: "source",
      title: "Open on POTA",
    }],
    silent: false,
    renotify: true,
  }]);
});

Deno.test("pushNotifications follows the tap URL SQL chose", () => {
  const [n] = pushNotifications(
    [pushed("KK4PWJ", 7, { push_url: "https://pota.app/#/park/US-2763" })],
    { ...SETTINGS, tap_target: "source" },
  );
  assertEquals(n?.url, "https://pota.app/#/park/US-2763");
});

Deno.test("pushNotifications offers the source button only when the spot has a source page", () => {
  const [rbn] = pushNotifications(
    [pushed("W1AW", 1, { source: "rbn", push_source_url: null })],
    SETTINGS,
  );
  assertEquals(rbn?.actions, [{ action: "profile", title: "Open profile" }]);
  assertEquals("sourceUrl" in (rbn ?? {}), false);
  const [none] = pushNotifications([pushed("W1AW")], { ...SETTINGS, action_buttons: false });
  assertEquals("actions" in (none ?? {}), false);
  const [wwff] = pushNotifications(
    [pushed("W1AW", 1, {
      source: "wwff",
      push_source_url: "https://wwff.co/directory/?showRef=KFF-6101",
    })],
    SETTINGS,
  );
  assertEquals(wwff?.actions?.[1], { action: "source", title: "Open on WWFF" });
});

Deno.test("a push payload at SQL's text limits still fits one push record", () => {
  // push_spot_fields clips the title to 160 characters and the body to 400
  // (push_clip). The worst character for the payload is a control character,
  // which JSON writes as six bytes (\u0001); a long call and source URL too.
  const call = "VP2V/KK4PWJ/QRP";
  const [n] = pushNotifications([pushed(call, Number.MAX_SAFE_INTEGER, {
    push_title: "\u0001".repeat(159) + "…",
    push_body: "\u0001".repeat(399) + "…",
    push_url: "https://summits.sota.org.uk/summit/" + "W".repeat(40),
    push_source_url: "https://summits.sota.org.uk/summit/" + "W".repeat(40),
  })], { ...SETTINGS, replace_same_station: false });
  const bytes = new TextEncoder().encode(pushPayload(n!)).length;
  assertEquals(bytes <= MAX_PUSH_PLAINTEXT_BYTES, true, `${bytes} bytes`);
});

Deno.test("pushNotifications tags per station, or per spot when replacing is off", () => {
  const spots = [pushed("w1aw", 1), pushed("w1aw", 2)];
  assertEquals(pushNotifications(spots, SETTINGS).map((n) => n.tag), ["spot:W1AW", "spot:W1AW"]);
  assertEquals(
    pushNotifications(spots, { ...SETTINGS, replace_same_station: false }).map((n) => n.tag),
    ["spot:W1AW:1", "spot:W1AW:2"],
  );
});

Deno.test("pushNotifications is silent without sound, or in quiet hours set to send silently", () => {
  const flags = (settings: PushSettings, quietNow: boolean) => {
    const [n] = pushNotifications([pushed("W1AW")], settings, quietNow);
    return [n?.silent, n?.renotify];
  };
  assertEquals(flags(SETTINGS, false), [false, true]);
  assertEquals(flags({ ...SETTINGS, sound: false }, false), [true, false]);
  assertEquals(flags(SETTINGS, true), [true, false]);
  // "Don't send" never reaches the formatter (sendPush skips the batch); if it did, nothing is silenced.
  assertEquals(flags({ ...SETTINGS, quiet_mode: "skip" }, true), [false, true]);
});

Deno.test("pushSkipped: only quiet hours on a Don't send destination", () => {
  const skip = { ...SETTINGS, quiet_mode: "skip" as const };
  assertEquals(pushSkipped({ push: skip, quiet_now: true }), true);
  assertEquals(pushSkipped({ push: SETTINGS, quiet_now: true }), false);
  assertEquals(pushSkipped({ push: skip, quiet_now: false }), false);
  assertEquals(pushSkipped({ push: skip }), false);
  assertEquals(pushSkipped({ quiet_now: true }), false);
});

Deno.test("pushSettingsOf falls back to the legacy settings when the claim carried none", () => {
  assertEquals(pushSettingsOf({}), LEGACY_PUSH_SETTINGS);
  assertEquals(pushSettingsOf({ push: SETTINGS }), SETTINGS);
  assertEquals([LEGACY_PUSH_SETTINGS.urgency, LEGACY_PUSH_SETTINGS.ttl_seconds], ["high", 900]);
});

Deno.test("a spot claimed without push fields sends today's text with the legacy settings", () => {
  assertEquals(pushNotifications([spot]), [{
    title: "KK4PWJ",
    body: "14062.0 kHz CW (20m)\nUS-2763 · Eno River State Park · POTA",
    tag: "spot:KK4PWJ",
    url: "/call/KK4PWJ",
    silent: false,
    renotify: true,
  }]);
  const [sota] = pushNotifications([{
    ...spot,
    source: "sotawatch",
    callsign: "W4/KK4PWJ/P",
    base_callsign: "KK4PWJ",
    pota_reference: null,
    pota_park_name: null,
    sota_summit_ref: "W4C/CM-001",
    mode: null,
    band: null,
  }]);
  assertEquals([sota?.title, sota?.body, sota?.tag, sota?.url], [
    "W4/KK4PWJ/P",
    "14062.0 kHz\nW4C/CM-001 · SOTAwatch",
    "spot:W4/KK4PWJ/P",
    "/call/KK4PWJ",
  ]);
  const [rbn] = pushNotifications([{
    ...spot,
    callsign: "w1aw",
    base_callsign: null,
    source: "rbn",
    pota_reference: null,
    pota_park_name: null,
  }]);
  assertEquals([rbn?.tag, rbn?.url, rbn?.body.split("\n")[1]], ["spot:W1AW", "/call/w1aw", "RBN"]);
});

Deno.test("pushNotifications sends one notification per spot at any count, never a summary", () => {
  for (const count of [1, 3, 4, 50]) {
    const spots = Array.from({ length: count }, (_, i) => pushed(`A${i}A`, i));
    const notifications = pushNotifications(spots, SETTINGS);
    assertEquals(notifications.length, count);
    assertEquals(notifications.map((n) => n.tag), spots.map((s) => `spot:${s.callsign}`));
  }
});

Deno.test("a worst-case push payload stays under 3,000 bytes with both buttons", () => {
  // SQL clips the title at 160 characters and the body at 400 (push_clip in push_spot_fields).
  const worst = (i: number): DeliverySpot =>
    pushed(`${"X".repeat(25)}${i}`, 9_999_999_999 + i, {
      source: "dxcluster",
      push_title: "Ä".repeat(160),
      push_body: "Ä".repeat(400),
      push_url: `https://summits.sota.org.uk/summit/${"X".repeat(40)}`,
      push_source_url: `https://summits.sota.org.uk/summit/${"X".repeat(40)}`,
    });
  const notifications = pushNotifications(
    Array.from({ length: 50 }, (_, i) => worst(i)),
    { ...SETTINGS, replace_same_station: false },
  );
  for (const n of notifications) {
    const bytes = new TextEncoder().encode(pushPayload(n)).length;
    if (bytes >= 3000) throw new Error(`${n.tag}: ${bytes} bytes`);
  }
  assertEquals(notifications[0]?.actions?.length, 2);
  assertEquals(JSON.parse(pushPayload(notifications[0]!)), notifications[0]);
});

Deno.test("sampleSpot is the labeled test spot for Discord and webhooks", () => {
  const s = sampleSpot({ ...delivery(1).destination, name: "Phone" });
  assertEquals([s.callsign, s.base_callsign, s.pota_reference], ["N0CALL", "N0CALL", "US-0000"]);
  assertEquals(s.comment.includes('"Phone"'), true);
});

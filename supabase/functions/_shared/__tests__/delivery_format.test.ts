import { assertEquals } from "@std/assert";
import {
  backoffSeconds,
  discordMessages,
  embedForSpot,
  PUSH_NOTIFICATIONS_PER_RUN,
  pushNotifications,
  pushPayload,
  sampleSpot,
  sourceLabel,
  webhookPayloads,
} from "../delivery/format.ts";
import type { DeliverySpot, PendingDelivery } from "../delivery/types.ts";

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

Deno.test("discordMessages batches at most 10 embeds per message", () => {
  const spots = Array.from({ length: 25 }, (_, i) => ({ ...spot, id: i }));
  const msgs = discordMessages(spots);
  assertEquals(msgs.map((m) => m.embeds.length), [10, 10, 5]);
  assertEquals(msgs[0]?.embeds[0]?.title, "KK4PWJ");
});

Deno.test("webhookPayloads carry delivery and subscription ids with the normalized spot, 50 per request", () => {
  const ds = Array.from({ length: 51 }, (_, i) => delivery(i + 1));
  const payloads = webhookPayloads(ds);
  assertEquals(payloads.map((p) => p.deliveries.length), [50, 1]);
  const first = payloads[0]?.deliveries[0];
  assertEquals(first?.delivery_id, 1);
  assertEquals(first?.subscription_id, "11111111-1111-1111-1111-111111111111");
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
    ["pota", "sotawatch", "rbn", "dxcluster", "other"].map(sourceLabel),
    ["POTA", "SOTAwatch", "RBN", "DX Cluster", "other"],
  );
});

const call = (callsign: string, id = 0): DeliverySpot => ({
  ...spot,
  id,
  callsign,
  base_callsign: callsign,
});

Deno.test("pushNotifications titles a spot with its call and two lines of facts", () => {
  assertEquals(pushNotifications([spot]), [{
    title: "KK4PWJ",
    body: "14062.0 kHz CW (20m)\nUS-2763 · Eno River State Park · POTA",
    tag: "spot:KK4PWJ",
    url: "/call/KK4PWJ",
  }]);
});

Deno.test("pushNotifications lists only the facts present and links the base call from SQL", () => {
  const [n] = pushNotifications([{
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
  assertEquals(n, {
    title: "W4/KK4PWJ/P",
    body: "14062.0 kHz\nW4C/CM-001 · SOTAwatch",
    tag: "spot:W4/KK4PWJ/P",
    url: "/call/KK4PWJ",
  });
  const [rbn] = pushNotifications([{
    ...call("w1aw"),
    source: "rbn",
    pota_reference: null,
    pota_park_name: null,
    base_callsign: null,
  }]);
  assertEquals(rbn?.tag, "spot:W1AW");
  assertEquals(rbn?.url, "/call/w1aw");
  assertEquals(rbn?.body.split("\n")[1], "RBN");
});

Deno.test("pushNotifications sends at most three spots, then one summary", () => {
  assertEquals(PUSH_NOTIFICATIONS_PER_RUN, 3);
  const three = pushNotifications([call("A1A"), call("B1B"), call("C1C")]);
  assertEquals(three.map((n) => n.tag), ["spot:A1A", "spot:B1B", "spot:C1C"]);

  const four = pushNotifications([call("A1A"), call("B1B"), call("C1C"), call("D1D")]);
  assertEquals(four.length, 4);
  assertEquals(four[3], { title: "1 more spot", body: "D1D", tag: "summary", url: "/sources" });
});

Deno.test("the summary lists the remaining calls in spot order, deduplicated", () => {
  const rest = (...calls: string[]) =>
    pushNotifications([call("A1A"), call("B1B"), call("C1C"), ...calls.map((c) => call(c))])[3];
  assertEquals(rest("D1D", "E1E")?.title, "2 more spots");
  assertEquals(rest("D1D", "E1E")?.body, "D1D and E1E");
  assertEquals(rest("D1D", "E1E", "D1D", "F1F")?.title, "4 more spots");
  assertEquals(rest("D1D", "E1E", "D1D", "F1F")?.body, "D1D, E1E and F1F");
  assertEquals(rest("D1D", "E1E", "F1F", "G1G")?.body, "D1D, E1E, F1F and 1 other");
  assertEquals(rest("D1D", "E1E", "F1F", "G1G", "H1H", "G1G")?.body, "D1D, E1E, F1F and 2 others");
});

Deno.test("a worst-case push payload stays under 3,000 bytes", () => {
  const long = (n: number) => "X".repeat(n);
  const worst: DeliverySpot = {
    ...spot,
    callsign: long(30),
    base_callsign: long(30),
    frequency_khz: 10_000_000.5,
    mode: long(20),
    band: long(10),
    pota_reference: long(40),
    pota_park_name: "Ä".repeat(300),
    sota_summit_ref: long(40),
    source: "dxcluster",
  };
  const notifications = pushNotifications(
    Array.from({ length: 50 }, (_, i) => ({ ...worst, callsign: `${long(25)}${i}` })),
  );
  for (const n of notifications) {
    const bytes = new TextEncoder().encode(pushPayload(n)).length;
    if (bytes >= 3000) throw new Error(`${n.tag}: ${bytes} bytes`);
  }
  assertEquals(JSON.parse(pushPayload(notifications[0]!)), notifications[0]);
});

Deno.test("the test notification is the sample spot through the same formatter", () => {
  const [n] = pushNotifications([sampleSpot({ ...delivery(1).destination, name: "Phone" })]);
  assertEquals(n?.title, "N0CALL");
  assertEquals(n?.body, "14062.0 kHz CW (20m)\nUS-0000 · Test Park · POTA");
  assertEquals(n?.url, "/call/N0CALL");
});

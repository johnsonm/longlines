import { assertEquals } from "@std/assert";
import {
  backoffSeconds,
  discordMessages,
  embedForSpot,
  sourceLabel,
  webhookPayloads,
} from "../delivery/format.ts";
import type { DeliverySpot, PendingDelivery } from "../delivery/types.ts";

const spot: DeliverySpot = {
  id: 42,
  source: "pota",
  spot_time: "2026-10-05T14:32:08.000Z",
  callsign: "KK4PWJ",
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

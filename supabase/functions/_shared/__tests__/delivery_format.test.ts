import { assertEquals } from "@std/assert";
import {
  backoffSeconds,
  cardEmbed,
  DISCORD_EMBED_CHARS_PER_MESSAGE,
  DISCORD_MESSAGES_PER_CLAIM,
  DISCORD_MESSAGES_PER_RUN,
  discordBatches,
  discordMessages,
  embedChars,
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
import type {
  DeliverySpot,
  DiscordSettings,
  PendingDelivery,
  PushSettings,
} from "../delivery/types.ts";

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

Deno.test("discordMessages without settings batches at most 10 legacy embeds per message", () => {
  const spots = Array.from({ length: 25 }, (_, i) => ({ ...spot, id: i }));
  const msgs = discordMessages(spots, {});
  assertEquals(msgs.map((m) => m.embeds?.length), [10, 10, 5]);
  assertEquals(msgs[0]?.embeds?.[0], embedForSpot(spot));
  assertEquals(msgs.map((m) => m.allowed_mentions), [{ parse: [] }, { parse: [] }, { parse: [] }]);
  assertEquals(discordMessages(spots), msgs);
  assertEquals(discordBatches(spots, {}).map((b) => b.spots), [10, 10, 5]);
});

const DISCORD_SETTINGS: DiscordSettings = {
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

// A spot as claim_deliveries hands it to a Discord destination: rendered in SQL.
const rendered = (id: number, more: Partial<DeliverySpot> = {}): DeliverySpot => ({
  ...spot,
  id,
  discord_style: "card",
  discord_title: "KK4PWJ · 14.062 MHz · CW",
  discord_description: "POTA · US-2763 · Eno River State Park · NC",
  discord_grid: [{ name: "Band", value: "20m" }, { name: "Spotter", value: "W4ABC" }],
  discord_footer: "POTA · 14:32 UTC",
  discord_color: 3066993,
  discord_url: "https://app.longlines.io/call/KK4PWJ",
  discord_line:
    "**[KK4PWJ](https://app.longlines.io/call/KK4PWJ)** · 14.062 MHz · CW · POTA · US-2763",
  discord_suppress_embeds: false,
  ...more,
});

Deno.test("cardEmbed shapes SQL's keys into the embed and adds nothing of its own", () => {
  assertEquals(cardEmbed(rendered(1)), {
    title: "KK4PWJ · 14.062 MHz · CW",
    description: "POTA · US-2763 · Eno River State Park · NC",
    url: "https://app.longlines.io/call/KK4PWJ",
    color: 3066993,
    fields: [
      { name: "Band", value: "20m", inline: true },
      { name: "Spotter", value: "W4ABC", inline: true },
    ],
    footer: { text: "POTA · 14:32 UTC" },
  });
});

Deno.test("cardEmbed leaves out an empty description, a missing link and a footer that is off", () => {
  const e = cardEmbed(
    rendered(1, {
      discord_description: "",
      discord_url: null,
      discord_footer: null,
      discord_grid: [],
    }),
  );
  assertEquals(e, {
    title: "KK4PWJ · 14.062 MHz · CW",
    color: 3066993,
    fields: [],
  });
  // No timestamp either: Discord would show it in the footer row the preview leaves empty.
  assertEquals("timestamp" in e, false);
});

Deno.test("cardEmbed falls back to the legacy embed for a spot SQL did not render", () => {
  assertEquals(cardEmbed(spot), embedForSpot(spot));
});

Deno.test("discordBatches with settings sends one card per message when batch_seconds is 0", () => {
  const spots = Array.from({ length: 5 }, (_, i) => rendered(i));
  const batches = discordBatches(spots, { discord: DISCORD_SETTINGS });
  assertEquals(batches.map((b) => b.spots), [1, 1, 1, 1, 1]);
  assertEquals(batches[0]?.message, {
    embeds: [cardEmbed(spots[0]!)],
    allowed_mentions: { parse: [] },
  });
});

Deno.test("discordBatches groups ten spots a message with a batch window", () => {
  const spots = Array.from({ length: 25 }, (_, i) => rendered(i));
  const batches = discordBatches(spots, { discord: { ...DISCORD_SETTINGS, batch_seconds: 30 } });
  assertEquals(batches.map((b) => b.spots), [10, 10, 5]);
  assertEquals(batches.map((b) => b.message.embeds?.length), [10, 10, 5]);
});

Deno.test("discordBatches groups a busy claim into at most five messages, never past ten spots each", () => {
  // Twelve spots with no window: three a message, four messages, not twelve.
  const twelve = Array.from({ length: 12 }, (_, i) => rendered(i));
  assertEquals(discordBatches(twelve, { discord: DISCORD_SETTINGS }).map((b) => b.spots), [
    3,
    3,
    3,
    3,
  ]);
  const forty = Array.from({ length: 40 }, (_, i) => rendered(i));
  assertEquals(discordBatches(forty, { discord: DISCORD_SETTINGS }).map((b) => b.spots), [
    8,
    8,
    8,
    8,
    8,
  ]);
  // One claim's cap, 50 (destination_claim_max): five full messages.
  const fifty = Array.from({ length: 50 }, (_, i) => rendered(i));
  const full = discordBatches(fifty, { discord: DISCORD_SETTINGS });
  assertEquals(full.length, DISCORD_MESSAGES_PER_CLAIM);
  assertEquals(full.every((b) => b.message.embeds?.length === 10), true);
  // Beyond the cap a message still never takes more than ten, and the per-run cap is the safety net.
  const many = Array.from({ length: 300 }, (_, i) => rendered(i));
  const grouped = discordBatches(many, { discord: { ...DISCORD_SETTINGS, batch_seconds: 60 } });
  assertEquals(grouped.length, DISCORD_MESSAGES_PER_RUN);
  assertEquals(grouped.every((b) => b.spots === 10), true);
});

Deno.test("discordBatches packs a split's room into the next message, keeping a claim within five", () => {
  // 650 characters a card: nine fit in 6,000. A 45-spot claim whose first ten
  // cards are that big goes as 9, 10, 10, 10, 6: still five messages, where
  // splitting fixed groups of ten would have sent six.
  const rest = embedChars(cardEmbed(rendered(0, { discord_description: "" })));
  const sized = (i: number, chars: number) =>
    rendered(i, { discord_description: "x".repeat(chars - rest) });
  const spots = Array.from({ length: 45 }, (_, i) => sized(i, i < 10 ? 650 : 300));
  const settings = { discord: { ...DISCORD_SETTINGS, batch_seconds: 30 } };
  const batches = discordBatches(spots, settings);
  assertEquals(batches.map((b) => b.spots), [9, 10, 10, 10, 6]);
  assertEquals(batches.length, DISCORD_MESSAGES_PER_CLAIM);
  assertEquals(batches.reduce((n, b) => n + b.spots, 0), 45);
  // A full claim of 50 such cards cannot fit in five (nine a message): six,
  // never the ten that splitting each group of ten would send.
  const big = Array.from({ length: 50 }, (_, i) => sized(i, 650));
  assertEquals(discordBatches(big, settings).map((b) => b.spots), [9, 9, 9, 9, 9, 5]);
});

Deno.test("discordBatches splits cards whose embeds would pass Discord's 6,000 characters", () => {
  // 800 characters a card: seven fit in 6,000, so ten go as seven and three.
  const rest = embedChars(cardEmbed(rendered(0, { discord_description: "" })));
  const big = (i: number) => rendered(i, { discord_description: "x".repeat(800 - rest) });
  const spots = Array.from({ length: 10 }, (_, i) => big(i));
  assertEquals(embedChars(cardEmbed(spots[0]!)), 800);
  const batches = discordBatches(spots, { discord: { ...DISCORD_SETTINGS, batch_seconds: 30 } });
  assertEquals(batches.map((b) => b.spots), [7, 3]);
  assertEquals(
    batches.every((b) =>
      (b.message.embeds ?? []).reduce((n, e) => n + embedChars(e), 0) <=
        DISCORD_EMBED_CHARS_PER_MESSAGE
    ),
    true,
  );
  // A single card over the total still goes, alone.
  const huge = rendered(1, {
    discord_description: "y".repeat(4096),
    discord_grid: [{ name: "Place name", value: "z".repeat(1024) }, {
      name: "Spotter",
      value: "z".repeat(1024),
    }],
  });
  assertEquals(
    discordBatches([huge, rendered(2)], { discord: { ...DISCORD_SETTINGS, batch_seconds: 30 } })
      .map((b) => b.spots),
    [1, 1],
  );
});

Deno.test("embedChars counts the title, description, field names and values and the footer", () => {
  assertEquals(
    embedChars({
      title: "ab",
      description: "cde",
      fields: [{ name: "f", value: "gh", inline: true }],
      footer: { text: "ij" },
    }),
    10,
  );
  assertEquals(embedChars({ title: "ab", fields: [] }), 2);
});

Deno.test("discordBatches puts plain lines in content, one per line, with flags when SQL suppresses embeds", () => {
  const plain = { ...DISCORD_SETTINGS, style: "plain" as const, batch_seconds: 10 };
  const spots = [
    rendered(1, { discord_style: "plain", discord_line: "a", discord_suppress_embeds: true }),
    rendered(2, { discord_style: "plain", discord_line: "b", discord_suppress_embeds: true }),
  ];
  assertEquals(discordBatches(spots, { discord: plain }), [{
    message: { content: "a\nb", flags: 4, allowed_mentions: { parse: [] } },
    spots: 2,
  }]);
  // A blank line between spots when fields are separated by a new line; no flag when shown.
  const shown = spots.map((s) => ({ ...s, discord_suppress_embeds: false }));
  assertEquals(discordMessages(shown, { discord: { ...plain, separator: "newline" } }), [{
    content: "a\n\nb",
    allowed_mentions: { parse: [] },
  }]);
  // One line per message with no window.
  assertEquals(
    discordMessages(shown, { discord: { ...plain, batch_seconds: 0 } }).map((m) => m.content),
    ["a", "b"],
  );
});

Deno.test("discordBatches falls back to the callsign for a plain spot without a line", () => {
  const plain = { ...DISCORD_SETTINGS, style: "plain" as const };
  assertEquals(discordMessages([spot], { discord: plain }), [{
    content: "KK4PWJ",
    allowed_mentions: { parse: [] },
  }]);
});

Deno.test("every Discord message carries allowed_mentions with nothing to parse", () => {
  const spots = Array.from({ length: 5 }, (_, i) => rendered(i));
  const all = [
    ...discordMessages(spots, {}),
    ...discordMessages(spots, { discord: DISCORD_SETTINGS }),
    ...discordMessages(spots, { discord: { ...DISCORD_SETTINGS, style: "plain" } }),
  ];
  assertEquals(all.every((m) => JSON.stringify(m.allowed_mentions) === '{"parse":[]}'), true);
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

Deno.test("webhookSpot leaves out the Discord fields SQL adds", () => {
  assertEquals(webhookSpot(rendered(42)), spot);
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

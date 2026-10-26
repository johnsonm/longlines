// Pure formatting for Discord, webhook and push deliveries, plus the Discord and
// push retry schedule.

import type {
  DeliveryDestination,
  DeliverySpot,
  DiscordEmbed,
  DiscordEmbedField,
  DiscordGridItem,
  DiscordMessage,
  DiscordSettings,
  PendingDelivery,
  PushNotification,
  PushSettings,
  WebhookField,
  WebhookHeader,
  WebhookItem,
  WebhookRequest,
} from "./types.ts";

export const DISCORD_EMBEDS_PER_MESSAGE = 10; // Discord's per-message limit
/**
 * Discord's total for one message's embeds: titles, descriptions, field names
 * and values and footers together.
 */
export const DISCORD_EMBED_CHARS_PER_MESSAGE = 6000;
// Discord allows ~30 messages/minute per webhook. A safety net here rather
// than in send.ts (which re-exports it): SQL's claim keeps it unreachable.
export const DISCORD_MESSAGES_PER_RUN = 30;
/**
 * Messages per claim, within Discord's ~5 requests per 2 seconds per webhook.
 * The claim hands a Discord destination at most 50 spots (5 of 10) on average
 * every 10 seconds (destination_claim_max, destination_claim_interval), so 5 a
 * claim is 30 messages a minute; discordBatches groups spots to stay within it
 * unless ten of the claim's cards will not fit in 6,000 characters.
 */
export const DISCORD_MESSAGES_PER_CLAIM = 5;
/** Discord's SUPPRESS_EMBEDS message flag: links in `content` do not expand. */
export const DISCORD_SUPPRESS_EMBEDS = 4;
export const WEBHOOK_SPOTS_PER_REQUEST = 50;

const SOURCE_LABELS: Record<string, string> = {
  pota: "POTA",
  sotawatch: "SOTAwatch",
  rbn: "RBN",
  dxcluster: "DX Cluster",
  wwff: "WWFF",
  wwbota: "WWBOTA",
};

export function sourceLabel(source: string): string {
  const label = SOURCE_LABELS[source];
  if (label === undefined) {
    return source;
  }
  return label;
}

/** A WWBOTA spot's bunkers joined with ", ", or null when it names none. */
function bunkers(spot: DeliverySpot): string | null {
  if (spot.wwbota_references === undefined || spot.wwbota_references === null) {
    return null;
  }
  return spot.wwbota_references.join(", ");
}

/** The value when it has text, else null: what a truthiness test on an optional string meant. */
function textOf(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return value;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** "HH:MM:SS" in UTC. */
export function utcClock(iso: string): string {
  return new Date(iso).toISOString().slice(11, 19);
}

/** "14062.0 kHz CW (20m)": the Discord description and the legacy push body's first line. */
export function spotDescription(spot: DeliverySpot): string {
  const parts = [`${spot.frequency_khz.toFixed(1)} kHz`];
  const mode = textOf(spot.mode);
  if (mode !== null) {
    parts.push(mode.toUpperCase());
  }
  const band = textOf(spot.band);
  if (band !== null) {
    parts.push(`(${band})`);
  }
  return parts.join(" ");
}

export function embedForSpot(spot: DeliverySpot): DiscordEmbed {
  const fields: DiscordEmbedField[] = [];
  function add(name: string, value: string | null | undefined): void {
    const text = textOf(value);
    if (text !== null) {
      fields.push({ name, value: text, inline: true });
    }
  }
  add("Reference", spot.pota_reference);
  add("Park", spot.pota_park_name);
  add("Summit", spot.sota_summit_ref);
  add("WWFF", spot.wwff_reference);
  add("Reserve", spot.wwff_reference_name);
  add("WWBOTA", bunkers(spot));
  add("Bunker", spot.wwbota_reference_name);
  add("Source", sourceLabel(spot.source));
  add("Spotter", spot.spotter);
  add("Time (UTC)", utcClock(spot.spot_time));

  return {
    title: spot.callsign,
    description: spotDescription(spot),
    fields,
    timestamp: spot.spot_time,
  };
}

/** Every Discord message carries this: mentions such as @everyone never ping. */
function noMentions(): DiscordMessage["allowed_mentions"] {
  return { parse: [] };
}

/**
 * The card embed for a spot SQL rendered (discord_spot_fields). Only shapes
 * SQL's keys, so it matches the preview: no `timestamp`, since Discord would
 * show it in the footer row even with the footer off, and SQL's footer
 * already carries the time. A spot without the keys (claimed before the
 * migration) gets the legacy embed.
 */
export function cardEmbed(spot: DeliverySpot): DiscordEmbed {
  if (spot.discord_title === undefined) {
    return embedForSpot(spot);
  }
  let grid: DiscordGridItem[] = [];
  if (spot.discord_grid !== undefined) {
    grid = spot.discord_grid;
  }
  const embed: DiscordEmbed = {
    title: spot.discord_title,
    fields: grid.map((f) => ({ name: f.name, value: f.value, inline: true })),
  };
  const description = textOf(spot.discord_description);
  if (description !== null) {
    embed.description = description;
  }
  const url = textOf(spot.discord_url);
  if (url !== null) {
    embed.url = url;
  }
  if (spot.discord_color !== undefined) {
    embed.color = spot.discord_color;
  }
  const footer = textOf(spot.discord_footer);
  if (footer !== null) {
    embed.footer = { text: footer };
  }
  return embed;
}

/** One message and how many spots (deliveries) it carries, so the sender counts `sent` by spots. */
export interface DiscordBatch {
  message: DiscordMessage;
  spots: number;
}

/**
 * The messages for one run. Without settings (a row claimed before migration
 * 20261018000100 is hosted; transitional, so the sender and the migration ship
 * in either order) it is the legacy embed, ten per message. With settings: one
 * spot per message when batch_seconds is 0, ten otherwise, and more per message
 * (up to ten) only when the run would otherwise need more than
 * DISCORD_MESSAGES_PER_CLAIM messages. A card spot is one embed (Discord takes
 * ten per message), and cards are packed in order, a new message starting at
 * the group size or where the next embed would take the message past
 * Discord's 6,000 characters, so a short message's room goes to the next
 * spots. Only cards that big (about 600 characters each) make a claim need
 * more than five messages. A plain spot is one line of `content`, which SQL
 * clips to 190 so ten lines fit in 2,000.
 */
export function discordBatches(
  spots: readonly DeliverySpot[],
  destination: Pick<DeliveryDestination, "discord">,
): DiscordBatch[] {
  const settings: DiscordSettings | undefined = destination.discord;
  if (settings === undefined) {
    return chunk(spots, DISCORD_EMBEDS_PER_MESSAGE).map((group) => ({
      message: { embeds: group.map(embedForSpot), allowed_mentions: noMentions() },
      spots: group.length,
    }));
  }
  let smallest = DISCORD_EMBEDS_PER_MESSAGE;
  if (settings.batch_seconds === 0) {
    smallest = 1;
  }
  const size = Math.min(
    DISCORD_EMBEDS_PER_MESSAGE,
    Math.max(smallest, Math.ceil(spots.length / DISCORD_MESSAGES_PER_CLAIM)),
  );
  if (settings.style === "plain") {
    return chunk(spots, size).map((group) => ({
      message: plainMessage(group, settings),
      spots: group.length,
    }));
  }
  return packCards(spots, size).map((embeds) => ({
    message: { embeds, allowed_mentions: noMentions() },
    spots: embeds.length,
  }));
}

/** What Discord counts toward a message's 6,000 characters for one embed. */
export function embedChars(embed: DiscordEmbed): number {
  let chars = embed.title.length;
  if (embed.description !== undefined) {
    chars += embed.description.length;
  }
  if (embed.footer !== undefined) {
    chars += embed.footer.text.length;
  }
  for (const f of embed.fields) {
    chars += f.name.length + f.value.length;
  }
  return chars;
}

/**
 * The cards in order, a message at most `size` embeds and, unless one card is
 * over it alone, DISCORD_EMBED_CHARS_PER_MESSAGE. Only shapes messages: every
 * spot is sent. Counts UTF-16 units, never fewer than the characters SQL
 * clipped.
 */
function packCards(spots: readonly DeliverySpot[], size: number): DiscordEmbed[][] {
  const out: DiscordEmbed[][] = [];
  let current: DiscordEmbed[] = [];
  let chars = 0;
  for (const embed of spots.map(cardEmbed)) {
    const n = embedChars(embed);
    if (
      current.length > 0 &&
      (current.length >= size || chars + n > DISCORD_EMBED_CHARS_PER_MESSAGE)
    ) {
      out.push(current);
      current = [];
      chars = 0;
    }
    current.push(embed);
    chars += n;
  }
  if (current.length > 0) {
    out.push(current);
  }
  return out;
}

/** A plain spot's line as SQL rendered it, or its call when the claim had no line. */
function plainLine(spot: DeliverySpot): string {
  if (spot.discord_line === undefined) {
    return spot.callsign;
  }
  return spot.discord_line;
}

function plainMessage(spots: readonly DeliverySpot[], settings: DiscordSettings): DiscordMessage {
  let separator = "\n";
  if (settings.separator === "newline") {
    separator = "\n\n";
  }
  const message: DiscordMessage = {
    content: spots.map(plainLine).join(separator),
    allowed_mentions: noMentions(),
  };
  if (spots.some((s) => s.discord_suppress_embeds === true)) {
    message.flags = DISCORD_SUPPRESS_EMBEDS;
  }
  return message;
}

/** The messages alone, for callers that do not count spots. */
export function discordMessages(
  spots: readonly DeliverySpot[],
  destination: Pick<DeliveryDestination, "discord">,
): DiscordMessage[] {
  return discordBatches(spots, destination).map((b) => b.message);
}

/**
 * The legacy body's spot: the stored columns without the push, Discord and
 * webhook fields SQL adds.
 */
export function webhookSpot(spot: DeliverySpot): DeliverySpot {
  // A shallow copy keeps the stored columns in the claim's key order.
  const rest = Object.assign({}, spot);
  delete rest.push_title;
  delete rest.push_body;
  delete rest.push_url;
  delete rest.push_source_url;
  delete rest.discord_style;
  delete rest.discord_title;
  delete rest.discord_description;
  delete rest.discord_grid;
  delete rest.discord_footer;
  delete rest.discord_color;
  delete rest.discord_url;
  delete rest.discord_line;
  delete rest.discord_suppress_embeds;
  delete rest.webhook_fields;
  delete rest.webhook_connection;
  return rest;
}

/**
 * Today's `{deliveries}` body, 50 spots a request. Transitional, like
 * LEGACY_PUSH_SETTINGS: it runs only for rows claimed without the webhook keys
 * (before migration 20261018000300 is on hosted), so the sender and the
 * migration ship in either order. Once the migration is pushed every webhook
 * row carries them, and this can go.
 */
export function webhookPayloads(deliveries: readonly PendingDelivery[]): WebhookRequest[] {
  return chunk(deliveries, WEBHOOK_SPOTS_PER_REQUEST).map((batch) => ({
    body: {
      deliveries: batch.map((d) => ({
        delivery_id: d.delivery_id,
        // Webhook receivers know a subscription as a connection.
        connection_id: d.subscription_id,
        spot: webhookSpot(d.spot),
      })),
    },
    count: batch.length,
  }));
}

/** A row SQL rendered for a webhook (it carries the ordered pairs, possibly none). */
function isRendered(delivery: PendingDelivery): boolean {
  return Array.isArray(delivery.spot.webhook_fields);
}

/**
 * One delivered spot as SQL rendered it. The spot object is built from the
 * pairs in order: every key is a non-numeric string, so JSON.stringify writes
 * them in the destination's picked order. Never formats, converts or names a
 * value.
 */
export function webhookItem(delivery: PendingDelivery): WebhookItem {
  let connection = "";
  if (delivery.spot.webhook_connection !== undefined) {
    connection = delivery.spot.webhook_connection;
  }
  let fields: WebhookField[] = [];
  if (delivery.spot.webhook_fields !== undefined) {
    fields = delivery.spot.webhook_fields;
  }
  return {
    delivery_id: delivery.delivery_id,
    connection,
    spot: Object.fromEntries(fields.map((f) => [f.key, f.value])),
  };
}

/**
 * The requests for one destination's run. With the destination's settings and
 * every row rendered: one request per delivery when batch_seconds is 0, else
 * `{spots}` of up to WEBHOOK_SPOTS_PER_REQUEST. Otherwise (a claim from before
 * the migration) the legacy body. How many rows a run holds, and when a
 * grouped destination's rows go, is SQL's (the claim's cap and hold).
 */
export function webhookRequests(
  destination: Pick<DeliveryDestination, "webhook">,
  deliveries: readonly PendingDelivery[],
): WebhookRequest[] {
  const settings = destination.webhook;
  if (settings === undefined || !deliveries.every(isRendered)) {
    return webhookPayloads(deliveries);
  }
  if (settings.batch_seconds === 0) {
    return deliveries.map((d) => ({ body: webhookItem(d), count: 1 }));
  }
  return chunk(deliveries, WEBHOOK_SPOTS_PER_REQUEST).map((batch) => ({
    body: { spots: batch.map(webhookItem) },
    count: batch.length,
  }));
}

/**
 * Header names an extra header may never take, ignoring case; names starting
 * with WEBHOOK_RESERVED_HEADER_PREFIXES are refused too. The same list is in
 * SQL (webhook_header_name_valid); change both together.
 */
export const WEBHOOK_RESERVED_HEADERS: ReadonlySet<string> = new Set([
  "accept",
  "connection",
  "content-encoding",
  "content-length",
  "content-type",
  "expect",
  "host",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
]);
export const WEBHOOK_RESERVED_HEADER_PREFIXES: readonly string[] = ["proxy-", "x-longlines-"];
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** 1 to 1,024 printable ASCII characters, space to `~`. */
const HEADER_VALUE = /^[\x20-\x7e]{1,1024}$/;

/** True when an extra header may use this name (SQL's webhook_header_name_valid). */
export function extraHeaderAllowed(name: string): boolean {
  if (!HEADER_NAME.test(name)) {
    return false;
  }
  const lower = name.toLowerCase();
  return !WEBHOOK_RESERVED_HEADERS.has(lower) &&
    !WEBHOOK_RESERVED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * The destination's extra headers, in position order, without any SQL should
 * already have refused: a reserved or malformed name, a repeated name, or a
 * value outside printable ASCII. Defence in depth: a line break in a value
 * would otherwise split the request. (A claimed header that is not two strings
 * never gets here: webhookSettingsSchema drops it.)
 */
export function webhookExtraHeaders(
  destination: Pick<DeliveryDestination, "webhook">,
): WebhookHeader[] {
  const seen = new Set<string>();
  const out: WebhookHeader[] = [];
  let headers: WebhookHeader[] = [];
  if (destination.webhook !== undefined) {
    headers = destination.webhook.headers;
  }
  for (const header of headers) {
    const lower = header.name.toLowerCase();
    if (!extraHeaderAllowed(header.name) || !HEADER_VALUE.test(header.value) || seen.has(lower)) {
      continue;
    }
    seen.add(lower);
    out.push({ name: header.name, value: header.value });
  }
  return out;
}

/**
 * Settings for a push destination claimed without them (a row claimed before
 * the migration is pushed): how push behaved before per-destination settings
 * existed. High urgency, 15 minutes, one tag per station, sound, no buttons,
 * no quiet hours. The field lists are unused: SQL did not render text for
 * such a row, so the legacy text below is used instead.
 */
export const LEGACY_PUSH_SETTINGS: PushSettings = {
  title_fields: [],
  body_fields: [],
  show_field_names: false,
  body_separator: "dot",
  tap_target: "profile",
  action_buttons: false,
  urgency: "high",
  ttl_seconds: 900,
  replace_same_station: true,
  sound: true,
  quiet_enabled: false,
  quiet_from: "22:00:00",
  quiet_until: "07:00:00",
  quiet_mode: "silent",
};

/** The push settings a destination carries, or the legacy ones when the claim had none. */
export function pushSettingsOf(destination: Pick<DeliveryDestination, "push">): PushSettings {
  if (destination.push === undefined) {
    return LEGACY_PUSH_SETTINGS;
  }
  return destination.push;
}

/**
 * True when the destination is in its quiet hours (SQL decided, once per
 * destination at claim time) and set to "Don't send": the batch is marked
 * sent without a request, never retried, never a failure.
 */
export function pushSkipped(destination: Pick<DeliveryDestination, "push" | "quiet_now">): boolean {
  return destination.quiet_now === true && pushSettingsOf(destination).quiet_mode === "skip";
}

/**
 * Today's text for a spot the claim did not render: two lines of facts under
 * the call. Transitional: it runs only for rows claimed by the new sender
 * before migration 20261016000400 is on hosted, so the two can ship in either
 * order. Once the migration is pushed every push row carries push_body, and
 * this and the `/call/` fallback in pushForSpot can go.
 */
function legacyPushBody(spot: DeliverySpot): string {
  const facts: string[] = [];
  for (
    const value of [
      spot.pota_reference,
      spot.pota_park_name,
      spot.sota_summit_ref,
      spot.wwff_reference,
      spot.wwff_reference_name,
      bunkers(spot),
      spot.wwbota_reference_name,
    ]
  ) {
    const text = textOf(value);
    if (text !== null) {
      facts.push(text);
    }
  }
  facts.push(sourceLabel(spot.source));
  return `${spotDescription(spot)}\n${facts.join(" · ")}`;
}

/**
 * One notification. The text and URLs come from SQL (push_spot_fields); this
 * only shapes them: the tag (per station, so a re-spot replaces the earlier
 * notification, or per spot), the action buttons, silent and renotify.
 */
function pushForSpot(
  spot: DeliverySpot,
  settings: PushSettings,
  quietNow: boolean,
): PushNotification {
  const call = spot.callsign.toUpperCase();
  const silent = !settings.sound || (quietNow && settings.quiet_mode === "silent");
  let title = spot.callsign;
  if (spot.push_title !== undefined) {
    title = spot.push_title;
  }
  let body: string;
  if (spot.push_body !== undefined) {
    body = spot.push_body;
  } else {
    body = legacyPushBody(spot);
  }
  let tag = `spot:${call}:${String(spot.id)}`;
  if (settings.replace_same_station) {
    tag = `spot:${call}`;
  }
  let url: string;
  if (spot.push_url !== undefined) {
    url = spot.push_url;
  } else {
    // The base call comes from SQL; the profile page resolves a typed call itself.
    let base = spot.callsign;
    if (spot.base_callsign !== null) {
      base = spot.base_callsign;
    }
    url = `/call/${encodeURIComponent(base)}`;
  }
  const notification: PushNotification = {
    title,
    body,
    tag,
    url,
    silent,
    renotify: !silent,
  };
  const sourceUrl = textOf(spot.push_source_url);
  if (sourceUrl !== null) {
    notification.sourceUrl = sourceUrl;
  }
  if (settings.action_buttons) {
    notification.actions = [{ action: "profile", title: "Open profile" }];
    if (sourceUrl !== null) {
      notification.actions.push({ action: "source", title: `Open on ${sourceLabel(spot.source)}` });
    }
  }
  return notification;
}

/**
 * What one device gets for a run: one notification per claimed spot, nothing
 * else. How many spots a run holds is SQL's budget (3 a minute per push
 * destination, newest first), so there is no summary.
 */
export function pushNotifications(
  spots: readonly DeliverySpot[],
  settings: PushSettings,
  quietNow: boolean,
): PushNotification[] {
  return spots.map((s) => pushForSpot(s, settings, quietNow));
}

/** The plaintext the service worker parses, before encryption. */
export function pushPayload(notification: PushNotification): string {
  return JSON.stringify(notification);
}

/**
 * Seconds to wait before retrying after the given (1-based) failed attempt,
 * passed to mark_deliveries_failed for Discord and push. For a webhook SQL's
 * schedule (webhook_retry_delay, the destination's retry policy) wins and this
 * is ignored.
 */
export function backoffSeconds(attempt: number): number {
  const steps = [30, 60, 120, 300, 900];
  const step = steps[Math.max(attempt, 1) - 1];
  if (step === undefined) {
    return 1800;
  }
  return step;
}

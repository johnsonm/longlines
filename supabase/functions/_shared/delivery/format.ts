// Pure formatting for Discord, webhook and push deliveries, plus the retry schedule.

import type {
  DeliveryDestination,
  DeliverySpot,
  DiscordEmbed,
  DiscordEmbedField,
  DiscordMessage,
  DiscordSettings,
  PendingDelivery,
  PushNotification,
  PushSettings,
  WebhookPayload,
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
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** "HH:MM:SS" in UTC. */
export function utcClock(iso: string): string {
  return new Date(iso).toISOString().slice(11, 19);
}

/** "14062.0 kHz CW (20m)": the Discord description and the legacy push body's first line. */
export function spotDescription(spot: DeliverySpot): string {
  const parts = [`${spot.frequency_khz.toFixed(1)} kHz`];
  if (spot.mode) parts.push(spot.mode.toUpperCase());
  if (spot.band) parts.push(`(${spot.band})`);
  return parts.join(" ");
}

export function embedForSpot(spot: DeliverySpot): DiscordEmbed {
  const fields: DiscordEmbedField[] = [];
  const add = (name: string, value: string | null | undefined) => {
    if (value) fields.push({ name, value, inline: true });
  };
  add("Reference", spot.pota_reference);
  add("Park", spot.pota_park_name);
  add("Summit", spot.sota_summit_ref);
  add("WWFF", spot.wwff_reference);
  add("Reserve", spot.wwff_reference_name);
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
  if (spot.discord_title === undefined) return embedForSpot(spot);
  const embed: DiscordEmbed = {
    title: spot.discord_title,
    fields: (spot.discord_grid ?? []).map((f) => ({ name: f.name, value: f.value, inline: true })),
  };
  if (spot.discord_description) embed.description = spot.discord_description;
  if (spot.discord_url) embed.url = spot.discord_url;
  if (spot.discord_color !== undefined) embed.color = spot.discord_color;
  if (spot.discord_footer) embed.footer = { text: spot.discord_footer };
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
  if (!settings) {
    return chunk(spots, DISCORD_EMBEDS_PER_MESSAGE).map((group) => ({
      message: { embeds: group.map(embedForSpot), allowed_mentions: noMentions() },
      spots: group.length,
    }));
  }
  const size = Math.min(
    DISCORD_EMBEDS_PER_MESSAGE,
    Math.max(
      settings.batch_seconds === 0 ? 1 : DISCORD_EMBEDS_PER_MESSAGE,
      Math.ceil(spots.length / DISCORD_MESSAGES_PER_CLAIM),
    ),
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
  return embed.title.length + (embed.description?.length ?? 0) +
    (embed.footer?.text.length ?? 0) +
    embed.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
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
  if (current.length > 0) out.push(current);
  return out;
}

function plainMessage(spots: readonly DeliverySpot[], settings: DiscordSettings): DiscordMessage {
  const message: DiscordMessage = {
    content: spots.map((s) => s.discord_line ?? s.callsign).join(
      settings.separator === "newline" ? "\n\n" : "\n",
    ),
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
  destination: Pick<DeliveryDestination, "discord"> = {},
): DiscordMessage[] {
  return discordBatches(spots, destination).map((b) => b.message);
}

/** The spot as docs/WEBHOOKS.md documents it: without the push and Discord fields SQL adds. */
export function webhookSpot(spot: DeliverySpot): DeliverySpot {
  const {
    push_title: _title,
    push_body: _body,
    push_url: _url,
    push_source_url: _source,
    discord_style: _style,
    discord_title: _discordTitle,
    discord_description: _description,
    discord_grid: _grid,
    discord_footer: _footer,
    discord_color: _color,
    discord_url: _discordUrl,
    discord_line: _line,
    discord_suppress_embeds: _suppress,
    ...rest
  } = spot;
  return rest;
}

export function webhookPayloads(deliveries: readonly PendingDelivery[]): WebhookPayload[] {
  return chunk(deliveries, WEBHOOK_SPOTS_PER_REQUEST).map((batch) => ({
    deliveries: batch.map((d) => ({
      delivery_id: d.delivery_id,
      // Webhook receivers know a subscription as a connection.
      connection_id: d.subscription_id,
      spot: webhookSpot(d.spot),
    })),
  }));
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
  return destination.push ?? LEGACY_PUSH_SETTINGS;
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
  const facts = [
    spot.pota_reference,
    spot.pota_park_name,
    spot.sota_summit_ref,
    spot.wwff_reference,
    spot.wwff_reference_name,
  ]
    .filter((fact): fact is string => !!fact);
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
  const notification: PushNotification = {
    title: spot.push_title ?? spot.callsign,
    body: spot.push_body ?? legacyPushBody(spot),
    tag: settings.replace_same_station ? `spot:${call}` : `spot:${call}:${spot.id}`,
    // The base call comes from SQL; the profile page resolves a typed call itself.
    url: spot.push_url ?? `/call/${encodeURIComponent(spot.base_callsign ?? spot.callsign)}`,
    silent,
    renotify: !silent,
  };
  if (spot.push_source_url) notification.sourceUrl = spot.push_source_url;
  if (settings.action_buttons) {
    notification.actions = [{ action: "profile", title: "Open profile" }];
    if (spot.push_source_url) {
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
  settings: PushSettings = LEGACY_PUSH_SETTINGS,
  quietNow = false,
): PushNotification[] {
  return spots.map((s) => pushForSpot(s, settings, quietNow));
}

/** The plaintext the service worker parses, before encryption. */
export function pushPayload(notification: PushNotification): string {
  return JSON.stringify(notification);
}

/** Seconds to wait before retrying after the given (1-based) failed attempt. */
export function backoffSeconds(attempt: number): number {
  const steps = [30, 60, 120, 300, 900];
  return steps[Math.max(attempt, 1) - 1] ?? 1800;
}

/**
 * The sample spot used by "Send test" for webhooks. Clearly labeled so nobody
 * chases it. A push or Discord test's spot comes from SQL (push_test_delivery,
 * discord_test_delivery), rendered with the destination's settings.
 */
export function sampleSpot(destination: DeliveryDestination): DeliverySpot {
  return {
    id: 0,
    source: "pota",
    spot_time: new Date().toISOString(),
    callsign: "N0CALL",
    base_callsign: "N0CALL",
    spotter: "LONGLINES",
    frequency_khz: 14062,
    band: "20m",
    mode: "cw",
    mode_family: "cw",
    comment: `Test spot from Long Lines for "${destination.name}". Not a real activation.`,
    pota_reference: "US-0000",
    pota_park_name: "Test Park",
    pota_location: "US-TEST",
    sota_summit_ref: null,
    wwff_reference: null,
    wwff_reference_name: null,
  };
}

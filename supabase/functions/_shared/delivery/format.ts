// Pure formatting for Discord, webhook and push deliveries, plus the retry schedule.

import type {
  DeliveryDestination,
  DeliverySpot,
  DiscordEmbed,
  DiscordEmbedField,
  DiscordMessage,
  PendingDelivery,
  PushNotification,
  PushSettings,
  WebhookPayload,
} from "./types.ts";

export const DISCORD_EMBEDS_PER_MESSAGE = 10; // Discord's per-message limit
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

export function discordMessages(spots: readonly DeliverySpot[]): DiscordMessage[] {
  return chunk(spots.map(embedForSpot), DISCORD_EMBEDS_PER_MESSAGE).map((embeds) => ({ embeds }));
}

/** The spot as docs/WEBHOOKS.md documents it: without the push-only fields SQL adds. */
export function webhookSpot(spot: DeliverySpot): DeliverySpot {
  const {
    push_title: _title,
    push_body: _body,
    push_url: _url,
    push_source_url: _source,
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

/** Today's text for a spot the claim did not render: the call, then two lines of facts. */
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
 * The sample spot used by "Send test" for Discord and webhooks. Clearly
 * labeled so nobody chases it. A push test's spot comes from SQL
 * (push_test_delivery), rendered with the destination's fields.
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

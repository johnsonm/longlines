// Pure formatting for Discord, webhook and push deliveries, plus the retry schedule.

import type {
  DeliveryDestination,
  DeliverySpot,
  DiscordEmbed,
  DiscordEmbedField,
  DiscordMessage,
  PendingDelivery,
  PushNotification,
  WebhookPayload,
} from "./types.ts";

export const DISCORD_EMBEDS_PER_MESSAGE = 10; // Discord's per-message limit
export const WEBHOOK_SPOTS_PER_REQUEST = 50;
/** Spot notifications per device per run; the rest become one summary. */
export const PUSH_NOTIFICATIONS_PER_RUN = 3;

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

/** "14062.0 kHz CW (20m)": the Discord description and a push notification's first line. */
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

export function webhookPayloads(deliveries: readonly PendingDelivery[]): WebhookPayload[] {
  return chunk(deliveries, WEBHOOK_SPOTS_PER_REQUEST).map((batch) => ({
    deliveries: batch.map((d) => ({
      delivery_id: d.delivery_id,
      // Webhook receivers know a subscription as a connection.
      connection_id: d.subscription_id,
      spot: d.spot,
    })),
  }));
}

function pushForSpot(spot: DeliverySpot): PushNotification {
  const facts = [
    spot.pota_reference,
    spot.pota_park_name,
    spot.sota_summit_ref,
    spot.wwff_reference,
    spot.wwff_reference_name,
  ]
    .filter((fact): fact is string => !!fact);
  facts.push(sourceLabel(spot.source));
  return {
    title: spot.callsign,
    body: `${spotDescription(spot)}\n${facts.join(" · ")}`,
    tag: `spot:${spot.callsign.toUpperCase()}`,
    // The base call comes from SQL; the profile page resolves a typed call itself.
    url: `/call/${encodeURIComponent(spot.base_callsign ?? spot.callsign)}`,
  };
}

/** "A", "A and B", "A, B and C", "A, B, C and 2 others". */
function summaryCalls(calls: readonly string[]): string {
  const shown = calls.slice(0, 3);
  const others = calls.length - shown.length;
  if (others > 0) return `${shown.join(", ")} and ${others} ${others === 1 ? "other" : "others"}`;
  if (shown.length === 1) return shown[0] ?? "";
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

/**
 * What one device gets for a run: the first three spots, each tagged by call
 * so a re-spot replaces the older notification, then one summary for the rest.
 */
export function pushNotifications(spots: readonly DeliverySpot[]): PushNotification[] {
  const out = spots.slice(0, PUSH_NOTIFICATIONS_PER_RUN).map(pushForSpot);
  const rest = spots.slice(PUSH_NOTIFICATIONS_PER_RUN);
  if (rest.length > 0) {
    out.push({
      title: rest.length === 1 ? "1 more spot" : `${rest.length} more spots`,
      body: summaryCalls([...new Set(rest.map((s) => s.callsign))]),
      tag: "summary",
      url: "/sources",
    });
  }
  return out;
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

/** The sample spot used by "Send test". Clearly labeled so nobody chases it. */
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

// Pure formatting for Discord and webhook deliveries, plus the retry schedule.

import type {
  DeliveryDestination,
  DeliverySpot,
  DiscordEmbed,
  DiscordEmbedField,
  DiscordMessage,
  PendingDelivery,
  WebhookPayload,
} from "./types.ts";

export const DISCORD_EMBEDS_PER_MESSAGE = 10; // Discord's per-message limit
export const WEBHOOK_SPOTS_PER_REQUEST = 50;

const SOURCE_LABELS: Record<string, string> = {
  pota: "POTA",
  sotawatch: "SOTAwatch",
  rbn: "RBN",
  dxcluster: "DX Cluster",
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

export function embedForSpot(spot: DeliverySpot): DiscordEmbed {
  const parts = [`${spot.frequency_khz.toFixed(1)} kHz`];
  if (spot.mode) parts.push(spot.mode.toUpperCase());
  if (spot.band) parts.push(`(${spot.band})`);

  const fields: DiscordEmbedField[] = [];
  const add = (name: string, value: string | null | undefined) => {
    if (value) fields.push({ name, value, inline: true });
  };
  add("Reference", spot.pota_reference);
  add("Park", spot.pota_park_name);
  add("Summit", spot.sota_summit_ref);
  add("Source", sourceLabel(spot.source));
  add("Spotter", spot.spotter);
  add("Time (UTC)", utcClock(spot.spot_time));

  return { title: spot.callsign, description: parts.join(" "), fields, timestamp: spot.spot_time };
}

export function discordMessages(spots: readonly DeliverySpot[]): DiscordMessage[] {
  return chunk(spots.map(embedForSpot), DISCORD_EMBEDS_PER_MESSAGE).map((embeds) => ({ embeds }));
}

export function webhookPayloads(deliveries: readonly PendingDelivery[]): WebhookPayload[] {
  return chunk(deliveries, WEBHOOK_SPOTS_PER_REQUEST).map((batch) => ({
    deliveries: batch.map((d) => ({
      delivery_id: d.delivery_id,
      subscription_id: d.subscription_id,
      spot: d.spot,
    })),
  }));
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
  };
}

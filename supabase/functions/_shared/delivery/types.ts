// Shapes shared by the sender and the send-test and api functions. `PendingDelivery`
// mirrors a row from the claim_deliveries RPC.

export interface DeliverySpot {
  id: number;
  source: string;
  spot_time: string;
  callsign: string;
  /** From SQL (base_callsign()); profile links use it, never a call worked out here. */
  base_callsign: string | null;
  spotter: string | null;
  frequency_khz: number;
  band: string | null;
  mode: string | null;
  mode_family: string | null;
  comment: string;
  pota_reference: string | null;
  pota_park_name: string | null;
  pota_location: string | null;
  sota_summit_ref: string | null;
  wwff_reference: string | null;
  wwff_reference_name: string | null;
}

/** A browser push subscription. The endpoint and keys are capability secrets. */
export interface PushDevice {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface DeliveryDestination {
  id: string;
  type: "discord" | "webhook" | "push";
  name: string;
  /** Null for push, which fans out to `devices` instead. */
  url: string | null;
  signing_secret: string | null;
  health: "ok" | "failing" | "paused";
  consecutive_failures: number;
  /** Push only: every device registered by the destination's owner. */
  devices?: PushDevice[];
}

export interface PendingDelivery {
  msg_id: number;
  delivery_id: number;
  subscription_id: string;
  attempts: number;
  created_at: string;
  destination: DeliveryDestination;
  spot: DeliverySpot;
}

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline: boolean;
}

export interface DiscordEmbed {
  title: string;
  description: string;
  fields: DiscordEmbedField[];
  timestamp: string;
}

export interface DiscordMessage {
  embeds: DiscordEmbed[];
}

export interface WebhookPayload {
  deliveries: Array<{ delivery_id: number; connection_id: string; spot: DeliverySpot }>;
}

/** One notification as the service worker shows it. */
export interface PushNotification {
  title: string;
  body: string;
  tag: string;
  url: string;
}

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
  /**
   * Push only, from SQL (push_spot_fields): the title and body built from the
   * destination's picked fields, its tap URL and the spot's source page. Never
   * built here; absent on rows claimed before the migration, and stripped from
   * webhook payloads (webhookSpot).
   */
  push_title?: string;
  push_body?: string;
  push_url?: string;
  push_source_url?: string | null;
}

/** A browser push subscription. The endpoint and keys are capability secrets. */
export interface PushDevice {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** A push destination's settings (push_destination_settings), as claim_deliveries hands them over. */
export interface PushSettings {
  title_fields: string[];
  body_fields: string[];
  show_field_names: boolean;
  body_separator: "dot" | "comma" | "newline";
  tap_target: "profile" | "source";
  action_buttons: boolean;
  urgency: "low" | "normal" | "high";
  ttl_seconds: number;
  replace_same_station: boolean;
  sound: boolean;
  quiet_enabled: boolean;
  quiet_from: string;
  quiet_until: string;
  quiet_mode: "silent" | "skip";
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
  /** Push only: the destination's member devices that are not blocked. */
  devices?: PushDevice[];
  /** Push only: its settings. Absent on rows claimed before the migration. */
  push?: PushSettings;
  /** Push only: whether SQL found the destination in its quiet hours at claim time. */
  quiet_now?: boolean;
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

export interface PushAction {
  action: "profile" | "source";
  title: string;
}

/** One notification as the service worker shows it (PushData in web/src/pwa/sw-handlers.ts). */
export interface PushNotification {
  title: string;
  body: string;
  tag: string;
  /** Where a tap goes: the destination's tap target. */
  url: string;
  /** The spot's source page, for the "Open on {Source}" button. */
  sourceUrl?: string;
  actions?: PushAction[];
  silent?: boolean;
  renotify?: boolean;
}

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
  /**
   * Discord only, from SQL (discord_spot_fields): the message rendered from the
   * destination's settings. The sender only shapes these into an embed or a
   * content line, never joins or formats fields. Absent on rows claimed before
   * migration 20261018000100, and stripped from webhook payloads (webhookSpot).
   */
  discord_style?: "card" | "plain";
  discord_title?: string;
  /** May be "" when no detail field has a value. */
  discord_description?: string;
  discord_grid?: Array<{ name: string; value: string }>;
  discord_footer?: string | null;
  discord_color?: number;
  discord_url?: string | null;
  discord_line?: string;
  discord_suppress_embeds?: boolean;
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

/** A Discord destination's settings (discord_destination_settings), as claim_deliveries hands them over. */
export interface DiscordSettings {
  style: "card" | "plain";
  title_fields: string[];
  detail_fields: string[];
  grid_fields: string[];
  title_link: "profile" | "source" | "none";
  card_color: "source" | "blue" | "green" | "purple" | "orange" | "red" | "grey";
  footer: boolean;
  line_fields: string[];
  bold_first: boolean;
  link_preview: "hidden" | "shown";
  show_field_names: boolean;
  separator: "dot" | "comma" | "newline";
  /** 0 (one message per spot), 10, 30 or 60: the claim's hold window. */
  batch_seconds: number;
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
  /** Discord only: its settings. Absent on rows claimed before the migration. */
  discord?: DiscordSettings;
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
  description?: string;
  url?: string;
  color?: number;
  fields: DiscordEmbedField[];
  footer?: { text: string };
  /** The legacy embed's only; a SQL-rendered card leaves it out (its footer carries the time). */
  timestamp?: string;
}

export interface DiscordMessage {
  embeds?: DiscordEmbed[];
  content?: string;
  flags?: number;
  /** Always `{parse: []}`: no message ever pings anyone. */
  allowed_mentions: { parse: never[] };
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

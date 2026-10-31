// Shapes shared by the sender and the send-test and api functions. `PendingDelivery`
// mirrors a row from the claim_deliveries RPC; pendingDeliverySchema validates one.

import { z } from "zod";

export interface DeliverySpot {
  id: number;
  source: string;
  spot_time: string;
  callsign: string;
  /** From SQL (base_callsign()); profile links use it, never a call worked out here. */
  base_callsign: string | null;
  spotter: string | null;
  /** Null only for an APRS-IS spot: a packet carries no frequency. */
  frequency_khz: number | null;
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
  /** Every bunker of a WWBOTA spot; absent on rows claimed before migration 20261026001000. */
  wwbota_references?: string[] | null;
  /** The first bunker's name; absent like wwbota_references. */
  wwbota_reference_name?: string | null;
  /** The IOTA reference of a DX Cluster spot; absent on rows claimed before migration 20261027001000. */
  iota_reference?: string | null;
  /** The IOTA group's name; absent like iota_reference. */
  iota_reference_name?: string | null;
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
  discord_grid?: DiscordGridItem[];
  discord_footer?: string | null;
  discord_color?: number;
  discord_url?: string | null;
  discord_line?: string;
  discord_suppress_embeds?: boolean;
  /**
   * Webhook only, from SQL (webhook_spot_fields): the destination's picked
   * fields as ordered key/value pairs, keys and values rendered by SQL. The
   * sender only builds the spot object from them, in order. `[]` is valid (no
   * picked field had a value) and gives `"spot": {}`. Absent on rows claimed
   * before migration 20261018000300, which get the legacy body (webhookRequests).
   */
  webhook_fields?: WebhookField[];
  /** Webhook only, from SQL: the name of the connection that matched. */
  webhook_connection?: string;
  /**
   * Local DX cluster only, from SQL (local_cluster_spot_fields): the spot event's values
   * (contract v2, 9.4), finished, so the sender only names them. Absent on other types' rows,
   * and stripped from webhook payloads (webhookSpot).
   */
  cluster_spotter?: string;
  /** Null only if a spot without a frequency were claimed; the claim never hands a relay one. */
  cluster_frequency_khz?: number | null;
  cluster_callsign?: string;
  /** The finished comment: mode word, then the picked fields, at most 30 characters. */
  cluster_comment?: string;
  /** HHMM, UTC. */
  cluster_time?: string;
  cluster_mode?: string | null;
  cluster_reference?: string | null;
  cluster_source?: string;
  cluster_source_label?: string;
  /** spot_time as YYYY-MM-DDTHH:MM:SSZ. */
  cluster_spot_time?: string;
  /** The name of the connection that matched. */
  cluster_connection?: string;
}

/** One field of a Discord card's grid, its name and value rendered by SQL (discord_grid). */
export interface DiscordGridItem {
  name: string;
  value: string;
}

/** One rendered spot field of a webhook body, in the destination's order. */
export interface WebhookField {
  key: string;
  value: string | number | null;
}

/** An extra header a webhook destination sends, its value from Vault. */
export interface WebhookHeader {
  name: string;
  value: string;
}

/** A webhook destination's settings as claim_deliveries hands them over. */
export interface WebhookSettings {
  /** 0 (one request per spot), 10, 30 or 60: the claim's hold window. */
  batch_seconds: number;
  /** In position order. */
  headers: WebhookHeader[];
}

/**
 * A Local DX cluster destination's relay, as claim_deliveries hands it over: the relay token's
 * id (the spots stream's key) and its device name. The claim takes a row only while the relay's
 * stream is open, so neither is null in practice; a null is a relay that is not connected.
 */
export interface LocalClusterTarget {
  relay_id: string | null;
  device_name: string | null;
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
  type: "discord" | "webhook" | "push" | "local_cluster";
  name: string;
  /** Null for push, which fans out to `devices` instead, and for local_cluster (a relay). */
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
  /** Webhook only: its settings. Absent on rows claimed before the migration. */
  webhook?: WebhookSettings;
  /** Local DX cluster only: the relay whose spots stream takes its spots. */
  local_cluster?: LocalClusterTarget;
}

export interface PendingDelivery {
  msg_id: number;
  delivery_id: number;
  subscription_id: string;
  attempts: number;
  created_at: string;
  destination: DeliveryDestination;
  spot: DeliverySpot;
  /** Set only by Send test (sendTestTo): a webhook request then carries X-LongLines-Test. */
  test?: boolean;
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

/**
 * The body before migration 20261018000300 (docs/WEBHOOKS.md, "Changed
 * 2026-10"), sent only for rows claimed without the webhook keys.
 */
export interface LegacyWebhookPayload {
  deliveries: Array<{ delivery_id: number; connection_id: string; spot: DeliverySpot }>;
}

/** One delivered spot: a single body, or one item of a grouped body's `spots`. */
export interface WebhookItem {
  delivery_id: number;
  /** The connection's name. */
  connection: string;
  spot: Record<string, string | number | null>;
}

export type WebhookBody = WebhookItem | { spots: WebhookItem[] } | LegacyWebhookPayload;

/** One request and how many deliveries it carries, so the sender counts `sent` by spots. */
export interface WebhookRequest {
  body: WebhookBody;
  count: number;
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

// The claim's shapes, derived from the SQL that builds them (claim_deliveries as of
// 20261021000600): delivery_spot_json plus the renderer's keys for the destination's type
// (push_spot_fields, discord_spot_fields, webhook_spot_fields), and the destination's columns
// plus its type's settings (push_member_devices, push_destination_settings, push_quiet_now,
// discord_destination_settings, webhook_header_values; local_cluster_spot_fields and the
// relay for a Local DX cluster, 20261028000500). RPC jsonb can gain keys across deploys,
// so every object is loose. A key format.ts or send.ts reads with a fallback is optional, so a
// claim from before a migration still parses (the sender and the migration ship in either order).

const nullableTextSchema = z.string().nullable();

const discordGridItemSchema: z.ZodType<DiscordGridItem> = z.looseObject({
  name: z.string(),
  value: z.string(),
});

const webhookFieldSchema: z.ZodType<WebhookField> = z.looseObject({
  key: z.string(),
  value: z.union([z.string(), z.number()]).nullable(),
});

/**
 * A spot as the claim hands it over. The stored columns are declared in jsonb's key order
 * (shorter keys first, then bytewise), the order the claim sends them: a looseObject puts its
 * declared keys first, and the legacy webhook body (webhookSpot) keeps the claim's order.
 */
export const deliverySpotSchema: z.ZodType<DeliverySpot> = z.looseObject({
  id: z.number(),
  band: nullableTextSchema,
  mode: nullableTextSchema,
  source: z.string(),
  comment: z.string(),
  spotter: nullableTextSchema,
  callsign: z.string(),
  spot_time: z.string(),
  mode_family: nullableTextSchema,
  base_callsign: nullableTextSchema,
  frequency_khz: z.number().nullable(),
  pota_location: nullableTextSchema,
  iota_reference: nullableTextSchema.optional(),
  pota_park_name: nullableTextSchema,
  pota_reference: nullableTextSchema,
  wwff_reference: nullableTextSchema,
  sota_summit_ref: nullableTextSchema,
  wwbota_references: z.array(z.string()).nullable().optional(),
  iota_reference_name: nullableTextSchema.optional(),
  wwff_reference_name: nullableTextSchema,
  wwbota_reference_name: nullableTextSchema.optional(),
  push_title: z.string().optional(),
  push_body: z.string().optional(),
  push_url: z.string().optional(),
  push_source_url: nullableTextSchema.optional(),
  discord_style: z.enum(["card", "plain"]).optional(),
  discord_title: z.string().optional(),
  discord_description: z.string().optional(),
  discord_grid: z.array(discordGridItemSchema).optional(),
  discord_footer: nullableTextSchema.optional(),
  discord_color: z.number().optional(),
  discord_url: nullableTextSchema.optional(),
  discord_line: z.string().optional(),
  discord_suppress_embeds: z.boolean().optional(),
  webhook_fields: z.array(webhookFieldSchema).optional(),
  webhook_connection: z.string().optional(),
  cluster_spotter: z.string().optional(),
  cluster_frequency_khz: z.number().nullable().optional(),
  cluster_callsign: z.string().optional(),
  cluster_comment: z.string().optional(),
  cluster_time: z.string().optional(),
  cluster_mode: nullableTextSchema.optional(),
  cluster_reference: nullableTextSchema.optional(),
  cluster_source: z.string().optional(),
  cluster_source_label: z.string().optional(),
  cluster_spot_time: z.string().optional(),
  cluster_connection: z.string().optional(),
});

const separatorSchema = z.enum(["dot", "comma", "newline"]);

/** push_destination_settings, less destination_id. */
export const pushSettingsSchema: z.ZodType<PushSettings> = z.looseObject({
  title_fields: z.array(z.string()),
  body_fields: z.array(z.string()),
  show_field_names: z.boolean(),
  body_separator: separatorSchema,
  tap_target: z.enum(["profile", "source"]),
  action_buttons: z.boolean(),
  urgency: z.enum(["low", "normal", "high"]),
  ttl_seconds: z.number(),
  replace_same_station: z.boolean(),
  sound: z.boolean(),
  quiet_enabled: z.boolean(),
  quiet_from: z.string(),
  quiet_until: z.string(),
  quiet_mode: z.enum(["silent", "skip"]),
});

/** push_member_devices: one of the destination's unblocked member devices. */
export const pushDeviceSchema: z.ZodType<PushDevice> = z.looseObject({
  endpoint: z.string(),
  p256dh: z.string(),
  auth: z.string(),
});

/** discord_destination_settings, less destination_id. */
export const discordSettingsSchema: z.ZodType<DiscordSettings> = z.looseObject({
  style: z.enum(["card", "plain"]),
  title_fields: z.array(z.string()),
  detail_fields: z.array(z.string()),
  grid_fields: z.array(z.string()),
  title_link: z.enum(["profile", "source", "none"]),
  card_color: z.enum(["source", "blue", "green", "purple", "orange", "red", "grey"]),
  footer: z.boolean(),
  line_fields: z.array(z.string()),
  bold_first: z.boolean(),
  link_preview: z.enum(["hidden", "shown"]),
  show_field_names: z.boolean(),
  separator: separatorSchema,
  batch_seconds: z.number(),
});

const webhookHeaderSchema: z.ZodType<WebhookHeader> = z.looseObject({
  name: z.string(),
  value: z.string(),
});

/** The headers that are a name and a value, in order; webhookExtraHeaders always skipped the rest. */
function presentHeaders(headers: ReadonlyArray<WebhookHeader | null>): WebhookHeader[] {
  const out: WebhookHeader[] = [];
  for (const header of headers) {
    if (header !== null) {
      out.push(header);
    }
  }
  return out;
}

/**
 * webhook_header_values: the extra headers in position order. A header that is not two strings
 * (a Vault secret that no longer decrypts reads as null) is dropped rather than failing the row.
 */
const webhookHeadersSchema: z.ZodType<WebhookHeader[]> = z
  .array(webhookHeaderSchema.nullable().catch(null))
  .transform(presentHeaders);

/** The claim's webhook settings: the batch window and the extra headers. */
export const webhookSettingsSchema: z.ZodType<WebhookSettings> = z.looseObject({
  batch_seconds: z.number(),
  headers: webhookHeadersSchema,
});

/** local_cluster: {relay_id, device_name} from relay_tokens. */
export const localClusterTargetSchema: z.ZodType<LocalClusterTarget> = z.looseObject({
  relay_id: nullableTextSchema,
  device_name: nullableTextSchema,
});

/** The destination's columns plus its type's settings, as claim_deliveries builds them. */
export const deliveryDestinationSchema: z.ZodType<DeliveryDestination> = z.looseObject({
  id: z.string(),
  type: z.enum(["discord", "webhook", "push", "local_cluster"]),
  name: z.string(),
  url: nullableTextSchema,
  signing_secret: nullableTextSchema,
  health: z.enum(["ok", "failing", "paused"]),
  consecutive_failures: z.number(),
  devices: z.array(pushDeviceSchema).optional(),
  push: pushSettingsSchema.optional(),
  quiet_now: z.boolean().optional(),
  discord: discordSettingsSchema.optional(),
  webhook: webhookSettingsSchema.optional(),
  local_cluster: localClusterTargetSchema.optional(),
});

/**
 * One claim_deliveries row. The sender's postgres.js client returns int8 as a number and
 * timestamps as strings (sender/db.ts clientOptions), as PostgREST does.
 */
export const pendingDeliverySchema: z.ZodType<PendingDelivery> = z.looseObject({
  msg_id: z.number(),
  delivery_id: z.number(),
  subscription_id: z.string(),
  attempts: z.number(),
  created_at: z.string(),
  destination: deliveryDestinationSchema,
  spot: deliverySpotSchema,
  test: z.boolean().optional(),
});

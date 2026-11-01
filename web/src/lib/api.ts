// Typed access to everything the app reads and writes. Pages call these and
// never touch supabase-js directly, so the data contract lives in one file.

import { supabase, SUPABASE_ANON_KEY, SUPABASE_URL } from "../supabase";
import type { Database, Json } from "./database.types";
import type { LatestStats, StatsPayload } from "../stats/types";
import type { CallsignProfile } from "../profile/types";
import type { ReferenceProfile, ReferenceProgram, ReferenceSearch } from "../references/types";
import type { BandMapPayload } from "../bandmap/types";
import type { HealthPayload, HealthRange } from "../health/types";
import type { CallsignGroup, GroupInput, NormalizedCallsigns } from "../groups/types";
import type { GroupPeriod, GroupSummary, OwnerGroupStatistics, PublicGroupStatistics } from "../groups/stats/types";
import type { Rules } from "../subscriptions/model";
import type { HomeFlow } from "../home/types";
import type { RelayAnswer, RelayPairing } from "../relay/types";
import type { GoalCard, GoalInput, GoalProgress, GoalMarking, GoalWindowLoss } from "../goals/types";
import type { CallsignActivations, SpottedActivation } from "../activations/types";

type Tables = Database["public"]["Tables"];
type Views = Database["public"]["Views"];
type Functions = Database["public"]["Functions"];
export type Profile = Tables["profiles"]["Row"];
/** A table row without its computed fields (`api_*_json`), which PostgREST never returns for `*`. */
type Row<T extends keyof Tables> = Omit<Tables[T]["Row"], Tables[T]["ComputedFields"]>;
/** Exactly `DESTINATION_COLUMNS`: never `url`, `signing_secret` or the sender's throttle columns. */
export type Destination = Pick<
  Row<"destinations">,
  | "id"
  | "user_id"
  | "type"
  | "name"
  | "enabled"
  | "url_display"
  | "health"
  | "consecutive_failures"
  | "last_success_at"
  | "last_error"
  | "last_error_at"
  | "created_at"
  | "auto_disabled_at"
>;
export type Subscription = Row<"subscriptions">;
export type SubscriptionLink = Tables["subscription_destinations"]["Row"];
export type RecentSpot = Views["recent_spots"]["Row"];
export type IngestHealth = Database["public"]["Functions"]["list_ingest_health"]["Returns"][number];
export type DestinationType = "discord" | "webhook" | "push" | "local_cluster";
export type ApiToken = Omit<Tables["api_tokens"]["Row"], "token_hash">;
export type ApiTokenScope = "read" | "write";
/** A relay token as its owner reads it: never `token_hash` or the contact window. */
export type RelayToken = Pick<
  Tables["relay_tokens"]["Row"],
  | "id"
  | "user_id"
  | "token_prefix"
  | "device_name"
  | "client_version"
  | "scopes"
  | "created_at"
  | "last_used_at"
  | "platform"
  | "cluster_connected_at"
>;

export const DESTINATION_COLUMNS =
  "id, user_id, type, name, enabled, url_display, health, consecutive_failures, last_success_at, last_error, last_error_at, created_at, auto_disabled_at";

export const RELAY_TOKEN_COLUMNS =
  "id, user_id, token_prefix, device_name, client_version, scopes, created_at, last_used_at, platform, cluster_connected_at";

export const API_TOKEN_COLUMNS =
  "id, user_id, name, scope, token_prefix, lifetime_days, expires_at, created_at, rotated_at, last_used_at";

export class ApiError extends Error {
  code: string | undefined;
  /** A webhook receiver's HTTP status, from send-test's 502 body when the receiver answered with a non-2xx. */
  receiverStatus: number | undefined;
  constructor(message: string, code?: string, receiverStatus?: number) {
    super(message);
    this.code = code;
    this.receiverStatus = receiverStatus;
  }
}

function fail(error: { message: string; code?: string } | null, fallback: string): never {
  throw new ApiError(error?.message || fallback, error?.code);
}

/**
 * RPC arguments with nulls. The generated Args type every argument as its
 * non-null type; these RPCs read a null as "keep what is there" or "none".
 */
function withNulls<F extends keyof Functions>(
  args: { [K in keyof Functions[F]["Args"]]: Functions[F]["Args"][K] | null },
): Functions[F]["Args"] {
  return args as Functions[F]["Args"];
}

// ---- Edge Functions ---------------------------------------------------------

/**
 * Fetch an Edge Function; a non-2xx body's `error` becomes the ApiError message and the status its code.
 * A numeric `status` in the body (send-test's webhook receiver) is kept as `receiverStatus`.
 */
async function fetchFunction<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${SUPABASE_URL}/functions/v1/${path}`, init);
  } catch {
    throw new ApiError("Couldn't reach Long Lines. Check your connection and try again.");
  }
  const data = (await response.json().catch(() => ({}))) as { error?: string; status?: unknown } & T;
  if (!response.ok) {
    const receiver = typeof data.status === "number" ? data.status : undefined;
    throw new ApiError(data.error || `Request failed (HTTP ${response.status}).`, String(response.status), receiver);
  }
  return data;
}

async function callFunction<T>(name: string, body: unknown, accessToken?: string): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return fetchFunction<T>(name, { method: "POST", headers, body: JSON.stringify(body) });
}

export interface SignInTokens {
  access_token: string;
  refresh_token: string;
}

/** Sign in with an email. Resolves the session on success. */
export async function signIn(identifier: string, password: string): Promise<void> {
  const tokens = await callFunction<SignInTokens>("sign-in", { identifier, password });
  const { error } = await supabase.auth.setSession(tokens);
  if (error) throw new ApiError(error.message);
}

/**
 * Re-check the current password without changing the session. The check signs
 * in, so the session it minted is revoked at once; a failed revoke does not
 * fail the check (that session's refresh token is simply never used).
 */
export async function verifyPassword(email: string, password: string): Promise<void> {
  const tokens = await callFunction<SignInTokens>("sign-in", { identifier: email, password });
  await revokeSession(tokens.access_token);
}

/** Signs out only the session `token` belongs to (scope local), leaving this browser's own session alone. */
async function revokeSession(token: string): Promise<void> {
  try {
    await fetch(`${SUPABASE_URL}/auth/v1/logout?scope=local`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
  } catch {
    // Best effort, as above.
  }
}

async function accessToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new ApiError("Sign in again.");
  return data.session.access_token;
}

/** What a successful send-test answers: a webhook's receiver status, null for Discord and push. */
export interface SendTestResult {
  status: number | null;
}

/** Sends the sample spot, or raw_spots row `spotId`, to a destination with its saved settings. */
export async function sendTest(destinationId: string, spotId?: number | null): Promise<SendTestResult> {
  const body = { destination_id: destinationId, ...(spotId === undefined || spotId === null ? {} : { spot_id: spotId }) };
  const data = await callFunction<{ ok: true; status?: number }>("send-test", body, await accessToken());
  return { status: typeof data.status === "number" ? data.status : null };
}

export async function deleteAccount(): Promise<void> {
  await callFunction<{ ok: true }>("delete-account", {}, await accessToken());
}

// ---- Auth ------------------------------------------------------------------

export async function signUp(input: { callsign: string; name: string; email: string; password: string }): Promise<void> {
  const { error } = await supabase.auth.signUp({
    email: input.email,
    password: input.password,
    options: { data: { callsign: input.callsign, name: input.name } },
  });
  if (error) fail(error, "Couldn't create your account.");
}

/**
 * Leaves for Google's sign-in and comes back to the site root, which the Auth
 * redirect allow list holds for every environment; the client reads the
 * session from the URL on load. A new Google user has no profile until
 * completeProfile.
 */
export async function signInWithGoogle(): Promise<void> {
  const { error } = await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.origin } });
  if (error) fail(error, "Couldn't sign in with Google.");
}

/** Creates the signed-in user's profile, for an account made with Google. */
export async function completeProfile(callsign: string, name: string): Promise<void> {
  const { error } = await supabase.rpc("complete_profile", { p_callsign: callsign, p_name: name });
  if (error) fail(error, "Couldn't finish creating your account.");
}

export async function requestPasswordReset(email: string): Promise<void> {
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/set-password` });
  if (error) fail(error, "Couldn't send the reset link.");
}

export async function updatePassword(password: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password });
  if (error) fail(error, "Couldn't change your password.");
}

export async function updateEmail(email: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ email });
  if (error) fail(error, "Couldn't change your email.");
}

/**
 * Signs out this device, or every other one. `cleanup` runs first while the
 * session is still valid (this device's push registration, see pwa/push.ts)
 * and is best effort: its failure never keeps the user signed in.
 */
export async function signOut(scope: "local" | "others" = "local", cleanup?: () => Promise<void>): Promise<void> {
  if (cleanup) await cleanup().catch(() => undefined);
  const { error } = await supabase.auth.signOut({ scope });
  if (error) fail(error, "Couldn't sign out.");
}

// ---- Profile ---------------------------------------------------------------

/** The user's profile, or null for an account made with Google that has no callsign yet. */
export async function loadProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
  if (error) fail(error, "Couldn't load your profile.");
  return data;
}

export async function updateProfile(
  userId: string,
  patch: Pick<Profile, "callsign" | "name" | "timezone" | "utc_times">,
): Promise<void> {
  const { error } = await supabase.from("profiles").update(patch).eq("id", userId);
  if (error) fail(error, "Couldn't save your profile.");
}

// ---- Sources ---------------------------------------------------------------

export async function loadIngestHealth(): Promise<IngestHealth[]> {
  const { data, error } = await supabase.rpc("list_ingest_health");
  if (error) fail(error, "Couldn't load source health.");
  return data;
}

/** The newest spots of one source from the last 24 hours; RBN's come from its whole feed. */
export async function loadRecentSpots(source: string, limit = 100): Promise<RecentSpot[]> {
  const { data, error } = await supabase.rpc("list_recent_spots", { p_source: source, max_rows: limit });
  if (error) fail(error, "Couldn't load recent spots.");
  return data;
}

// ---- Destinations ----------------------------------------------------------

export async function loadDestinations(): Promise<Destination[]> {
  const { data, error } = await supabase.from("destinations").select(DESTINATION_COLUMNS).order("created_at");
  if (error) fail(error, "Couldn't load destinations.");
  return data;
}

export async function rotateSigningSecret(destinationId: string): Promise<string> {
  const { data, error } = await supabase.rpc("rotate_signing_secret", { p_destination_id: destinationId });
  if (error) fail(error, "Couldn't rotate the secret.");
  return data;
}

export async function deleteDestination(destinationId: string): Promise<void> {
  const { error } = await supabase.from("destinations").delete().eq("id", destinationId);
  if (error) fail(error, "Couldn't delete the destination.");
}

/**
 * One row of list_destination_queues: how many spots wait for a destination and whether SQL calls
 * it backed up. The generated type says number; SQL returns a null oldest age when nothing waits.
 */
export type DestinationQueue = Omit<Functions["list_destination_queues"]["Returns"][number], "oldest_waiting_seconds"> & {
  oldest_waiting_seconds: number | null;
};

/** The queue figures of each of the caller's destinations. */
export async function listDestinationQueues(): Promise<DestinationQueue[]> {
  const { data, error } = await supabase.rpc("list_destination_queues");
  if (error) fail(error, "Couldn't load the destination queues.");
  return data ?? [];
}

/** Drops the spots waiting for a destination whose turn has come; resolves to how many were dropped. */
export async function clearDestinationQueue(destinationId: string): Promise<number> {
  const { data, error } = await supabase.rpc("clear_destination_queue", { p_destination_id: destinationId });
  if (error) fail(error, "Couldn't clear the queue.");
  return data;
}

// ---- Push ------------------------------------------------------------------
//
// Devices belong to the account; each push destination picks some of them.
// Endpoints and keys travel to the database once, in registerPushDevice, and
// never come back: list_push_devices and get_push_destination return ids,
// names, descriptors and status only.

/** The browser's subscription, as PushSubscription.toJSON() gives it. */
export interface PushKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** One row of list_push_devices: no endpoint, no keys. */
export interface PushDevice {
  id: string;
  label: string;
  /** "{Browser} on {Platform}", worked out by the browser when it registered. */
  agent: string;
  /** Running as an installed app when it registered. */
  standalone: boolean;
  created_at: string;
  last_success_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  /** Set when the browser reported notifications blocked; cleared by registering again. */
  blocked_at: string | null;
  /** True for the device whose endpoint the caller passed. */
  is_current: boolean;
  /** The push destinations it is a member of. */
  destination_ids: string[];
}

/** The fields a notification can show, rendered and labelled in SQL (push_fields()). */
export type PushField =
  | "callsign" | "first_name" | "last_name" | "frequency" | "band" | "mode" | "source" | "reference" | "place_name" | "state" | "spotter"
  | "comment" | "time";

/** A push destination's settings row, as SQL stores it (push_destination_settings). */
export interface PushSettings {
  title_fields: PushField[];
  body_fields: PushField[];
  show_field_names: boolean;
  body_separator: "dot" | "comma" | "newline";
  tap_target: "profile" | "source";
  action_buttons: boolean;
  urgency: "low" | "normal" | "high";
  /** Drop if the device is offline for: 300, 900, 1800, 3600 or 14400. */
  ttl_seconds: number;
  replace_same_station: boolean;
  sound: boolean;
  quiet_enabled: boolean;
  /** "HH:MM" in the account time zone. */
  quiet_from: string;
  quiet_until: string;
  quiet_mode: "silent" | "skip";
}

/** What the editor saves: without `id` it creates the destination. */
export interface PushDestinationInput {
  id?: string;
  name: string;
  enabled: boolean;
  settings: PushSettings;
  device_ids: string[];
}

/** What the editor loads (get_push_destination). */
export interface PushDestination {
  id: string;
  name: string;
  enabled: boolean;
  settings: PushSettings;
  device_ids: string[];
}

/** The text SQL would send for a field pick, from preview_push_notification. */
export interface PushPreview {
  title: string;
  body: string;
  /** The tap URL: the callsign profile. */
  url: string;
  /** The source's page for the spot, or null when it has none (RBN, DX Cluster). */
  source_url: string | null;
}

/**
 * Registers this browser's subscription, or refreshes it. A null label, agent
 * or standalone keeps what the device already has, so the on-load refresh
 * sends the keys only. `previousEndpoint` is the endpoint this browser last
 * registered when the push service has since rotated it: the account's device
 * with that endpoint takes the new one and keeps its destinations. Returns
 * the device id. The argument is sent only when there is one, so this works
 * against the function before and after `20261017002000` while they deploy.
 */
export async function registerPushDevice(
  keys: PushKeys,
  label: string | null,
  agent: string | null,
  standalone: boolean | null,
  previousEndpoint: string | null = null,
): Promise<string> {
  const { data, error } = await supabase.rpc("register_push_device", withNulls<"register_push_device">({
    p_endpoint: keys.endpoint, p_p256dh: keys.p256dh, p_auth: keys.auth, p_label: label, p_agent: agent, p_standalone: standalone,
    ...(previousEndpoint === null ? {} : { p_previous_endpoint: previousEndpoint }),
  }));
  if (error) fail(error, "Couldn't turn on notifications.");
  return data;
}

export async function unregisterPushDevice(endpoint: string): Promise<void> {
  const { error } = await supabase.rpc("unregister_push_device", { p_endpoint: endpoint });
  if (error) fail(error, "Couldn't turn off notifications.");
}

/** Every device of the account, newest first; `currentEndpoint` marks this browser's as is_current. */
export async function listPushDevices(currentEndpoint: string | null): Promise<PushDevice[]> {
  const { data, error } = await supabase.rpc("list_push_devices", currentEndpoint ? { p_current_endpoint: currentEndpoint } : {});
  if (error) fail(error, "Couldn't load your devices.");
  return data;
}

export async function deletePushDevice(id: string): Promise<void> {
  const { error } = await supabase.rpc("delete_push_device", { p_id: id });
  if (error) fail(error, "Couldn't remove the device.");
}

export async function renamePushDevice(id: string, label: string): Promise<void> {
  const { error } = await supabase.rpc("rename_push_device", { p_id: id, p_label: label });
  if (error) fail(error, "Couldn't rename the device.");
}

/** A browser that finds notifications denied reports the endpoint it last registered. */
export async function reportPushDeviceBlocked(endpoint: string): Promise<void> {
  const { error } = await supabase.rpc("report_push_device_blocked", { p_endpoint: endpoint });
  if (error) fail(error, "Couldn't update the device.");
}

/** Creates (no id) or replaces a push destination's name, enabled, settings and members. Returns the id. */
export async function savePushDestination(input: PushDestinationInput): Promise<string> {
  const settings: Json = { ...input.settings };
  const { data, error } = await supabase.rpc("save_push_destination", withNulls<"save_push_destination">({
    p_id: input.id ?? null, p_name: input.name, p_enabled: input.enabled, p_settings: settings, p_device_ids: input.device_ids,
  }));
  if (error) fail(error, "Couldn't save the destination.");
  return data;
}

export async function getPushDestination(id: string): Promise<PushDestination> {
  const { data, error } = await supabase.rpc("get_push_destination", { p_id: id });
  if (error) fail(error, "Couldn't load the destination.");
  // jsonb in the generated types; its shape is fixed by get_push_destination().
  return data as unknown as PushDestination;
}

/** Copies a destination of any type (settings, and devices, or the URL, secret and headers) as "Copy of {name}", disabled. Returns the new id. */
export async function duplicateDestination(id: string): Promise<string> {
  const { data, error } = await supabase.rpc("duplicate_destination", { p_id: id });
  if (error) fail(error, "Couldn't duplicate the destination.");
  return data;
}

/** The notification SQL would build from a field pick, for the sample spot or raw_spots row `spotId`. */
export async function previewPushNotification(
  titleFields: PushField[],
  bodyFields: PushField[],
  showFieldNames: boolean,
  bodySeparator: PushSettings["body_separator"],
  spotId: number | null,
): Promise<PushPreview> {
  const { data, error } = await supabase.rpc("preview_push_notification", {
    p_title_fields: titleFields, p_body_fields: bodyFields, p_show_field_names: showFieldNames, p_body_separator: bodySeparator,
    ...(spotId === null ? {} : { p_spot_id: spotId }),
  });
  if (error) fail(error, "Couldn't load the preview.");
  const row = data[0];
  if (!row) throw new ApiError("Couldn't load the preview.");
  return row;
}

// ---- Discord ---------------------------------------------------------------
//
// A Discord destination's message settings live in discord_destination_settings,
// which clients cannot read; these RPCs are the only way in. The URL goes in
// through saveDiscordDestination and never comes back (only url_display).

/** The fields a Discord message can show: push_fields() minus comment (discord_fields()). */
export type DiscordField =
  | "callsign" | "first_name" | "last_name" | "frequency" | "band" | "mode" | "source" | "reference" | "place_name" | "state" | "spotter"
  | "time";

/** A Discord destination's settings row, as SQL stores it (discord_destination_settings). */
export interface DiscordSettings {
  style: "card" | "plain";
  /** Card style: 1 to 4. */
  title_fields: DiscordField[];
  /** Card style: 0 to 8. */
  detail_fields: DiscordField[];
  /** Card style: 0 to 6. */
  grid_fields: DiscordField[];
  title_link: "profile" | "source" | "none";
  card_color: "source" | "blue" | "green" | "purple" | "orange" | "red" | "grey";
  footer: boolean;
  /** Plain style: 1 to 8. */
  line_fields: DiscordField[];
  bold_first: boolean;
  link_preview: "hidden" | "shown";
  show_field_names: boolean;
  separator: "dot" | "comma" | "newline";
  /** 0 (one message per spot), 10, 30 or 60. */
  batch_seconds: number;
}

/** What the editor saves: without `id` it creates the destination; a null `url` keeps the stored one. */
export interface DiscordDestinationInput {
  id?: string;
  name: string;
  /** Null keeps what is stored; true on a paused destination resumes it. */
  enabled: boolean | null;
  url: string | null;
  settings: DiscordSettings;
}

/** What the editor loads (get_discord_destination): never the URL. */
export interface DiscordDestination {
  id: string;
  name: string;
  enabled: boolean;
  url_display: string;
  settings: DiscordSettings;
  /** Set while the destination is paused because Discord said the webhook is gone. */
  auto_disabled_at: string | null;
}

/** The message SQL would post for some settings (preview_discord_message, discord_spot_fields). */
export interface DiscordPreview {
  discord_style: "card" | "plain";
  discord_title: string;
  /** May be empty. */
  discord_description: string;
  discord_grid: { name: string; value: string }[];
  /** Null when the footer is off. */
  discord_footer: string | null;
  discord_color: number;
  /** The title link, or null when it links to nothing. */
  discord_url: string | null;
  /** The plain line: markdown with **bold** and [text](url) only. */
  discord_line: string;
  discord_suppress_embeds: boolean;
}

/** One row of list_discord_destination_settings, for the list cards' type line. */
export interface DiscordSettingsSummary {
  destination_id: string;
  style: DiscordSettings["style"];
  /** Card: title + details + grid; plain: the line. */
  field_count: number;
}

/** Creates (no id) or updates a Discord destination's name, enabled, URL (null keeps it) and settings. Returns the id. */
export async function saveDiscordDestination(input: DiscordDestinationInput): Promise<string> {
  const settings: Json = { ...input.settings };
  const { data, error } = await supabase.rpc("save_discord_destination", withNulls<"save_discord_destination">({
    p_id: input.id ?? null, p_name: input.name, p_enabled: input.enabled, p_url: input.url, p_settings: settings,
  }));
  if (error) fail(error, "Couldn't save the destination.");
  return data;
}

export async function getDiscordDestination(id: string): Promise<DiscordDestination> {
  const { data, error } = await supabase.rpc("get_discord_destination", { p_id: id });
  if (error) fail(error, "Couldn't load the destination.");
  // jsonb in the generated types; its shape is fixed by get_discord_destination().
  return data as unknown as DiscordDestination;
}

/** The style and field count of each of the caller's Discord destinations. */
export async function listDiscordDestinationSettings(): Promise<DiscordSettingsSummary[]> {
  const { data, error } = await supabase.rpc("list_discord_destination_settings");
  if (error) fail(error, "Couldn't load destinations.");
  // jsonb array in the generated types; its shape is fixed by list_discord_destination_settings().
  return (data ?? []) as unknown as DiscordSettingsSummary[];
}

/** The message SQL would post with `settings`, for the sample spot or raw_spots row `spotId`. */
export async function previewDiscordMessage(settings: DiscordSettings, spotId: number | null): Promise<DiscordPreview> {
  const p_settings: Json = { ...settings };
  const { data, error } = await supabase.rpc("preview_discord_message", {
    p_settings, ...(spotId === null ? {} : { p_spot_id: spotId }),
  });
  if (error) fail(error, "Couldn't load the preview.");
  if (!data) throw new ApiError("Couldn't load the preview.");
  // jsonb in the generated types; its nine keys are fixed by discord_spot_fields().
  return data as unknown as DiscordPreview;
}

// ---- Webhooks --------------------------------------------------------------
//
// A webhook's settings live in webhook_destination_settings and its extra
// headers in webhook_destination_headers (values in Vault); clients read
// neither table. The URL and header values go in through
// saveWebhookDestination and never come back: get_webhook_destination returns
// the masked URL and header names only, and the signing secret comes back once,
// from the create (here) or rotateSigningSecret.

/** The fields a webhook spot can carry, in webhook_fields()'s order. */
export type WebhookField =
  | "id" | "time" | "callsign" | "first_name" | "last_name" | "frequency" | "mode" | "band" | "source" | "reference" | "place_name"
  | "state" | "spotter" | "country" | "url" | "comment";

/** A webhook destination's settings row, as SQL stores it (webhook_destination_settings). */
export interface WebhookSettings {
  /** 1 to 16, each once, in the order the spot carries them. */
  fields: WebhookField[];
  key_style: "snake" | "camel";
  time_format: "iso_utc" | "unix_seconds";
  frequency_unit: "khz" | "mhz" | "hz";
  missing_values: "omit" | "null";
  /** 0 (one request per spot), 10, 30 or 60. */
  batch_seconds: number;
  retry_policy: "none" | "three_10m" | "day";
  /** Failed requests that turn the destination off (the editor sets 20), or null for never. */
  pause_after_failures: number | null;
}

/**
 * One extra header as saved, in position order. A missing or empty `value`
 * keeps the stored value of the header with that name (ignoring case); a new
 * or renamed header needs one.
 */
export interface WebhookHeaderInput {
  name: string;
  value?: string;
}

/** What the editor saves: without `id` it creates the destination; a null `url` keeps the stored one, null `headers` the stored headers. */
export interface WebhookDestinationInput {
  id?: string;
  name: string;
  /** Null keeps what is stored; true on a paused destination resumes it. */
  enabled: boolean | null;
  url: string | null;
  settings: WebhookSettings;
  headers: WebhookHeaderInput[] | null;
}

/** What the editor loads (get_webhook_destination): never the URL, the secret or a header value. */
export interface WebhookDestination {
  id: string;
  name: string;
  enabled: boolean;
  url_display: string;
  settings: WebhookSettings;
  headers: { name: string }[];
  secret_rotated_at: string | null;
  /** Set while the destination is paused: after repeated failures, or at once on an HTTP 410. */
  auto_disabled_at: string | null;
}

/** saveWebhookDestination's result: the signing secret only when it created the destination, shown once. */
export interface SavedWebhookDestination {
  id: string;
  signingSecret: string | null;
}

/** One row of list_webhook_destination_settings, for the list cards' type line. */
export interface WebhookSettingsSummary {
  destination_id: string;
  field_count: number;
  batch_seconds: number;
}

/** Creates (no id) or updates a webhook's name, enabled, URL (null keeps it), settings and headers (null keeps them). */
export async function saveWebhookDestination(input: WebhookDestinationInput): Promise<SavedWebhookDestination> {
  const settings: Json = { ...input.settings };
  const headers: Json | null = input.headers === null
    ? null
    : input.headers.map((h) => (h.value === undefined ? { name: h.name } : { name: h.name, value: h.value }));
  const { data, error } = await supabase.rpc("save_webhook_destination", withNulls<"save_webhook_destination">({
    p_id: input.id ?? null, p_name: input.name, p_enabled: input.enabled, p_url: input.url, p_settings: settings, p_headers: headers,
  }));
  if (error) fail(error, "Couldn't save the destination.");
  const row = data[0];
  if (!row) throw new ApiError("Couldn't save the destination.");
  // The generated type says string; SQL returns null on an update.
  return { id: row.id, signingSecret: (row.signing_secret as string | null) ?? null };
}

export async function getWebhookDestination(id: string): Promise<WebhookDestination> {
  const { data, error } = await supabase.rpc("get_webhook_destination", { p_id: id });
  if (error) fail(error, "Couldn't load the destination.");
  // jsonb in the generated types; its shape is fixed by get_webhook_destination().
  return data as unknown as WebhookDestination;
}

/** The field count and window of each of the caller's webhooks. */
export async function listWebhookDestinationSettings(): Promise<WebhookSettingsSummary[]> {
  const { data, error } = await supabase.rpc("list_webhook_destination_settings");
  if (error) fail(error, "Couldn't load destinations.");
  // jsonb array in the generated types; its shape is fixed by list_webhook_destination_settings().
  return (data ?? []) as unknown as WebhookSettingsSummary[];
}

/**
 * The request body SQL would send with `settings`, for the sample spot or
 * raw_spots row `spotId`, naming a connection of `destinationId` when it has
 * one. SQL builds it as json, so the parsed object keeps the picked key order
 * (no key is integer-like); the editor pretty-prints it as is.
 */
export async function previewWebhookRequest(
  settings: WebhookSettings,
  spotId: number | null,
  destinationId: string | null,
): Promise<unknown> {
  const p_settings: Json = { ...settings };
  const { data, error } = await supabase.rpc("preview_webhook_request", {
    p_settings,
    ...(spotId === null ? {} : { p_spot_id: spotId }),
    ...(destinationId === null ? {} : { p_destination_id: destinationId }),
  });
  if (error) fail(error, "Couldn't load the preview.");
  if (data === null || data === undefined) throw new ApiError("Couldn't load the preview.");
  return data;
}

// ---- Local DX cluster ------------------------------------------------------
//
// A Local DX cluster destination sends spots to one of the caller's paired
// relays (relay_tokens), which serves them to logging software on that
// computer. Its settings live in local_cluster_destination_settings, which
// clients cannot read; these RPCs are the only way in. SQL renders the line.

/** The fields a spot line's comment can carry after the mode, in local_cluster_fields()'s order. */
export type LocalClusterField = "reference" | "source" | "comment";

/** A Local DX cluster's settings as the RPCs take and return them: the relay, then the comment's fields in order. */
export interface LocalClusterSettings {
  /** The relay token the spots go to; null once that relay is revoked. */
  relay_id: string | null;
  fields: LocalClusterField[];
}

/** What the editor saves: without `id` it creates the destination, which needs a relay. */
export interface LocalClusterDestinationInput {
  id?: string;
  name: string;
  enabled: boolean;
  settings: LocalClusterSettings;
}

/** What the editor loads (get_local_cluster_destination). */
export interface LocalClusterDestination {
  id: string;
  name: string;
  enabled: boolean;
  url_display: string;
  settings: LocalClusterSettings;
}

/** One row of list_local_cluster_destination_settings, for the list cards. The relay keys are null once it is revoked. */
export interface LocalClusterSettingsSummary {
  destination_id: string;
  relay_id: string | null;
  device_name: string | null;
  platform: string | null;
  /** Set while the relay's spots stream is open (set_cluster_stream). */
  cluster_connected_at: string | null;
  fields: LocalClusterField[];
}

/** The line SQL renders for some settings (preview_local_cluster_line), and its parts. */
export interface LocalClusterPreview {
  line: string;
  spotter: string;
  frequency_khz: number;
  callsign: string;
  comment: string;
  /** HHMM, UTC. */
  time_utc: string;
}

/** Creates (no id) or updates a Local DX cluster's name, enabled, relay and fields. Returns the id. */
export async function saveLocalClusterDestination(input: LocalClusterDestinationInput): Promise<string> {
  const settings: Json = { relay_id: input.settings.relay_id, fields: [...input.settings.fields] };
  const { data, error } = await supabase.rpc("save_local_cluster_destination", withNulls<"save_local_cluster_destination">({
    p_id: input.id ?? null, p_name: input.name, p_enabled: input.enabled, p_settings: settings,
  }));
  if (error) fail(error, "Couldn't save the destination.");
  return data;
}

export async function getLocalClusterDestination(id: string): Promise<LocalClusterDestination> {
  const { data, error } = await supabase.rpc("get_local_cluster_destination", { p_id: id });
  if (error) fail(error, "Couldn't load the destination.");
  // jsonb in the generated types; its shape is fixed by get_local_cluster_destination().
  return data as unknown as LocalClusterDestination;
}

/** The relay and fields of each of the caller's Local DX cluster destinations. */
export async function listLocalClusterDestinationSettings(): Promise<LocalClusterSettingsSummary[]> {
  const { data, error } = await supabase.rpc("list_local_cluster_destination_settings");
  if (error) fail(error, "Couldn't load destinations.");
  // jsonb array in the generated types; its shape is fixed by list_local_cluster_destination_settings().
  return (data ?? []) as unknown as LocalClusterSettingsSummary[];
}

/** The line SQL would send with `fields`, for the sample spot or raw_spots row `spotId`. */
export async function previewLocalClusterLine(fields: LocalClusterField[], spotId: number | null): Promise<LocalClusterPreview> {
  const p_settings: Json = { fields: [...fields] };
  const { data, error } = await supabase.rpc("preview_local_cluster_line", {
    p_settings, ...(spotId === null ? {} : { p_spot_id: spotId }),
  });
  if (error) fail(error, "Couldn't load the preview.");
  if (!data) throw new ApiError("Couldn't load the preview.");
  // jsonb in the generated types; its keys are fixed by preview_local_cluster_line().
  return data as unknown as LocalClusterPreview;
}

// ---- API tokens ------------------------------------------------------------

export async function loadApiTokens(): Promise<ApiToken[]> {
  const { data, error } = await supabase.from("api_tokens").select(API_TOKEN_COLUMNS).order("created_at");
  if (error) fail(error, "Couldn't load your tokens.");
  return data;
}

/** Creates a token and returns its secret, which is never readable again. A null lifetime never expires. */
export async function createApiToken(name: string, scope: ApiTokenScope, lifetimeDays: number | null): Promise<string> {
  const { data, error } = await supabase.rpc("create_api_token", {
    p_name: name, p_scope: scope, ...(lifetimeDays === null ? {} : { p_lifetime_days: lifetimeDays }),
  });
  if (error) fail(error, "Couldn't create the token.");
  const row = data[0];
  if (!row) throw new ApiError("Couldn't create the token.");
  return row.token;
}

/** Replaces a token's secret; the old one stops working at once. Returns the new secret. */
export async function rotateApiToken(id: string): Promise<string> {
  const { data, error } = await supabase.rpc("rotate_api_token", { p_id: id });
  if (error) fail(error, "Couldn't rotate the token.");
  const row = data[0];
  if (!row) throw new ApiError("Couldn't rotate the token.");
  return row.token;
}

export async function deleteApiToken(id: string): Promise<void> {
  const { error } = await supabase.from("api_tokens").delete().eq("id", id);
  if (error) fail(error, "Couldn't delete the token.");
}

// ---- Long Lines Relay --------------------------------------------------------

/** A relay's code as the approval page shows it (lookup_relay_pairing); the code may be typed in any form. */
export async function lookupRelayPairing(code: string): Promise<RelayPairing> {
  const { data, error } = await supabase.rpc("lookup_relay_pairing", { p_user_code: code });
  if (error) fail(error, "Couldn't check the code.");
  if (data === null) throw new ApiError("Couldn't check the code.");
  // jsonb in the generated types; its shape is pinned by supabase/tests/relay_pairing.test.sql.
  return data as unknown as RelayPairing;
}

/** Allow or Deny a relay's pairing (answer_relay_pairing). */
export async function answerRelayPairing(code: string, approve: boolean): Promise<RelayAnswer> {
  const { data, error } = await supabase.rpc("answer_relay_pairing", { p_user_code: code, p_approve: approve });
  if (error) fail(error, "Couldn't answer the relay.");
  if (data === null) throw new ApiError("Couldn't answer the relay.");
  return data as unknown as RelayAnswer;
}

export async function loadRelayTokens(): Promise<RelayToken[]> {
  const { data, error } = await supabase.from("relay_tokens").select(RELAY_TOKEN_COLUMNS).order("created_at");
  if (error) fail(error, "Couldn't load your relays.");
  return data;
}

/** Revokes a relay's token: the relay stops posting and signs out on its next request. */
export async function deleteRelayToken(id: string): Promise<void> {
  const { error } = await supabase.from("relay_tokens").delete().eq("id", id);
  if (error) fail(error, "Couldn't disconnect the relay.");
}

// ---- Subscriptions ---------------------------------------------------------

export interface SubscriptionWithLinks extends Subscription {
  destinations: string[];
}

export async function loadSubscriptions(): Promise<SubscriptionWithLinks[]> {
  const [subs, links] = await Promise.all([
    supabase.from("subscriptions").select("*").order("created_at"),
    supabase.from("subscription_destinations").select("*"),
  ]);
  if (subs.error) fail(subs.error, "Couldn't load connections.");
  if (links.error) fail(links.error, "Couldn't load connections.");
  return subs.data.map((s) => ({
    ...s,
    destinations: links.data.filter((l: SubscriptionLink) => l.subscription_id === s.id).map((l: SubscriptionLink) => l.destination_id),
  }));
}

export interface SubscriptionFilter {
  sources: string[];
  rules: Rules;
}

export interface SubscriptionInput extends SubscriptionFilter {
  id?: string;
  name: string;
  enabled: boolean;
  quiet_minutes: number;
  destinations: string[];
}

export async function saveSubscription(input: SubscriptionInput): Promise<string> {
  const payload: Json = { ...input };
  const { data, error } = await supabase.rpc("save_subscription", { payload });
  if (error) fail(error, "Couldn't save the connection.");
  return data;
}

export async function deleteSubscription(id: string): Promise<void> {
  const { error } = await supabase.rpc("delete_subscription", { p_id: id });
  if (error) fail(error, "Couldn't delete the connection.");
}

export async function setSubscriptionEnabled(id: string, enabled: boolean): Promise<void> {
  const { error } = await supabase.from("subscriptions").update({ enabled }).eq("id", id);
  if (error) fail(error, "Couldn't update the connection.");
}

export interface Preview {
  count: number;
  spots: RecentSpot[];
  // Distinct base calls across the "is" callsign rules and the members of "is" group rules, counted in SQL.
  station_count: number;
  // How many recent spots of the filter's sources were checked: "7 of the last 42 POTA spots".
  window_size: number;
  // How many of those passed every other rule but were kept out by the goal rule ("29 more
  // matched your other rules but were skipped"); null when the rules name no goal.
  skipped_worked: number | null;
}

export async function previewSubscription(filter: SubscriptionFilter): Promise<Preview> {
  const { data, error } = await supabase.rpc("preview_subscription", { filter: { ...filter } });
  if (error) fail(error, "Couldn't load the preview.");
  const row = data[0];
  return {
    count: Number(row?.count ?? 0),
    spots: (row?.spots ?? []) as unknown as RecentSpot[],
    station_count: Number(row?.station_count ?? 0),
    window_size: Number(row?.window_size ?? 0),
    // The generated type says number, but SQL returns null without a goal rule.
    skipped_worked: row?.skipped_worked == null ? null : Number(row.skipped_worked),
  };
}

// ---- Home ---------------------------------------------------------------------

/** The Home page's last 24 hours (home_flow): counts only; names, types and links come from the loaded lists. */
export async function loadHomeFlow(): Promise<HomeFlow> {
  const { data, error } = await supabase.rpc("home_flow");
  if (error) fail(error, "Couldn't load your last 24 hours.");
  if (data === null) throw new ApiError("Couldn't load your last 24 hours.");
  // jsonb in the generated types; its shape is pinned by supabase/tests/home_flow.test.sql.
  return data as unknown as HomeFlow;
}

// ---- Callsign groups ---------------------------------------------------------

export async function listGroups(): Promise<CallsignGroup[]> {
  const { data, error } = await supabase.rpc("list_callsign_groups");
  if (error) fail(error, "Couldn't load your groups.");
  return data.map((g) => ({
    ...g,
    member_count: Number(g.member_count),
    subscription_count: Number(g.subscription_count),
    // on_air is jsonb in the generated types; its shape is fixed by list_callsign_groups().
    on_air: g.on_air as unknown as CallsignGroup["on_air"],
  }));
}

/**
 * Creates the group without an id, otherwise replaces its name and whole member list. Returns the id.
 * `public` and `show_callsigns` are optional: left out, SQL keeps the stored values.
 */
export async function saveGroup(input: GroupInput): Promise<string> {
  const payload: Json = { ...input };
  const { data, error } = await supabase.rpc("save_callsign_group", { payload });
  if (error) fail(error, "Couldn't save the group.");
  return data;
}

/** The landing cards: each group's last 30 days and who is on the air (list_group_summaries). */
export async function listGroupSummaries(): Promise<GroupSummary[]> {
  const { data, error } = await supabase.rpc("list_group_summaries");
  if (error) fail(error, "Couldn't load your groups.");
  // The generated row types every column as non-null; a group not built yet has null figures.
  return (data as unknown as GroupSummary[]).map((g) => ({ ...g, spots: g.spots === null ? null : Number(g.spots) }));
}

/** The owner's statistics page for one group and period (get_group_statistics). */
export async function loadGroupStatistics(id: string, period: GroupPeriod): Promise<OwnerGroupStatistics> {
  const { data, error } = await supabase.rpc("get_group_statistics", { p_id: id, p_period: period });
  if (error) fail(error, "Couldn't load the statistics.");
  if (data === null) throw new ApiError("Couldn't load the statistics.");
  // jsonb in the generated types; its shape is pinned by supabase/tests/group_statistics.test.sql.
  return data as unknown as OwnerGroupStatistics;
}

/**
 * A public group page through the group-page function, with no session. Null
 * when the code is unknown or the page is private: the function answers both
 * with the same 404.
 */
export async function loadPublicGroup(slug: string, period: GroupPeriod): Promise<PublicGroupStatistics | null> {
  const query = new URLSearchParams({ slug, period });
  try {
    return await fetchFunction<PublicGroupStatistics>(`group-page?${query.toString()}`, { headers: { apikey: SUPABASE_ANON_KEY } });
  } catch (err) {
    // Only the function's own answer means private; a gateway 404 (the function not deployed) is an outage.
    if (err instanceof ApiError && err.code === "404" && err.message === "private") return null;
    throw err;
  }
}

export async function deleteGroup(id: string): Promise<void> {
  const { error } = await supabase.rpc("delete_callsign_group", { p_id: id });
  if (error) fail(error, "Couldn't delete the group.");
}

/** Raw values to the base calls a group would store, plus the values that aren't callsigns. */
export async function normalizeCallsigns(values: string[]): Promise<NormalizedCallsigns> {
  const { data, error } = await supabase.rpc("normalize_group_callsigns", { p_calls: values });
  if (error) fail(error, "Couldn't check those callsigns.");
  // jsonb in the generated types; normalize_group_callsigns() always returns both arrays.
  return data as unknown as NormalizedCallsigns;
}

// ---- Goals ------------------------------------------------------------
//
// Every write is a definer RPC; every count, status and mark is SQL's
// (20261029001100_goals.sql). These only carry them.

/** The index cards, by name (list_goals). */
export async function listGoals(): Promise<GoalCard[]> {
  const { data, error } = await supabase.rpc("list_goals");
  if (error) fail(error, "Couldn't load your goals.");
  // jsonb in the generated types; each card is goal_card().
  return data as unknown as GoalCard[];
}

/** One list's progress page (get_goal); its shape is pinned by supabase/tests/goals.test.sql. */
export async function loadGoal(id: string): Promise<GoalProgress> {
  const { data, error } = await supabase.rpc("get_goal", { p_id: id });
  if (error) fail(error, "Couldn't load the goal.");
  if (data === null) throw new ApiError("Couldn't load the goal.");
  return data as unknown as GoalProgress;
}

/** Creates the list without an id, otherwise replaces it whole; SQL keeps the worked state of entries that stay. Returns the id. */
export async function saveGoal(input: GoalInput): Promise<string> {
  const payload: Json = { ...input, requirements: input.requirements.map((r) => ({ ...r })) };
  const { data, error } = await supabase.rpc("save_goal", { payload });
  if (error) fail(error, "Couldn't save the goal.");
  return data;
}

/**
 * What saving the list with this window (both null for "No end date") and marking would send back
 * to needed, changing nothing (preview_goal_window); in requirement, then entry order.
 */
export async function previewGoalWindow(
  id: string, startsOn: string | null, endsOn: string | null, marking: GoalMarking,
): Promise<GoalWindowLoss[]> {
  const { data, error } = await supabase.rpc("preview_goal_window", withNulls<"preview_goal_window">({
    p_id: id, p_starts_on: startsOn, p_ends_on: endsOn, p_marking: marking,
  }));
  if (error) fail(error, "Couldn't check the new dates.");
  // jsonb in the generated types; always an array of {requirement_id, kind, value, worked_at, reason}.
  return data as unknown as GoalWindowLoss[];
}

/** Refused with code LL409 while a connection's rules name the list. */
export async function deleteGoal(id: string): Promise<void> {
  const { error } = await supabase.rpc("delete_goal", { p_id: id });
  if (error) fail(error, "Couldn't delete the goal.");
}

/** Marks one entry worked by hand, or sets it back to needed. */
export async function markGoalEntry(requirementId: string, value: string, worked: boolean): Promise<void> {
  const { error } = await supabase.rpc("mark_goal_entry", { p_requirement_id: requirementId, p_value: value, p_worked: worked });
  if (error) fail(error, "Couldn't update the entry.");
}

/** Resolves a "Needs a look" contact: a POTA reference picks its park, null is "Not a park contact". */
export async function resolveGoalReview(id: string, reference: string | null): Promise<void> {
  const { error } = await supabase.rpc("resolve_goal_review", withNulls<"resolve_goal_review">({ p_id: id, p_reference: reference }));
  if (error) fail(error, "Couldn't save that.");
}

/** "Copy for next year": a fresh list with the same requirements, a year on. Returns the copy's id. */
export async function copyGoal(id: string): Promise<string> {
  const { data, error } = await supabase.rpc("copy_goal", { p_id: id });
  if (error) fail(error, "Couldn't copy the goal.");
  return data;
}

// ---- Stats ------------------------------------------------------------------

/**
 * Newest stats snapshot, or null before the first hourly refresh has run.
 * One indexed read; the page caches the result for the session (see
 * web/src/stats/useStats.ts).
 */
export async function loadLatestStats(): Promise<LatestStats | null> {
  const { data, error } = await supabase
    .from("stats_snapshots")
    .select("payload, generated_at")
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) fail(error, "Couldn't load stats.");
  if (!data) return null;
  // payload is jsonb in the generated types. Its shape is fixed by
  // refresh_stats_snapshot() and pinned by supabase/tests/stats_snapshot.test.sql.
  return { payload: data.payload as unknown as StatsPayload, generatedAt: data.generated_at };
}

// ---- Callsign profiles ------------------------------------------------------

/**
 * A station's public profile from the callsign-profile Edge Function, which
 * works signed out, so no session is sent. The callsign goes as typed
 * (KK4PWJ/P); the result's `callsign` is the base call SQL reduced it to.
 * Invalid input rejects with code "400", the rate limit with "429".
 */
export async function loadCallsignProfile(callsign: string): Promise<CallsignProfile> {
  const query = new URLSearchParams({ callsign });
  return fetchFunction<CallsignProfile>(`callsign-profile?${query.toString()}`, { headers: { apikey: SUPABASE_ANON_KEY } });
}

// ---- Reference profiles -----------------------------------------------------

/** The reference-profile function's 404 body: neither in the program's list nor in any spot, or malformed. */
export const REFERENCE_NOT_FOUND = "Reference not found.";

/**
 * A park, summit or WWFF reference's public page from the reference-profile
 * Edge Function, which works signed out, so no session is sent. Null when
 * there is no such page; only the function's own 404 means that, so a gateway
 * 404 (the function not deployed) is an outage. The rate limit rejects with "429".
 */
export async function loadReferenceProfile(program: string, reference: string): Promise<ReferenceProfile | null> {
  const query = new URLSearchParams({ program, reference });
  try {
    return await fetchFunction<ReferenceProfile>(`reference-profile?${query.toString()}`, { headers: { apikey: SUPABASE_ANON_KEY } });
  } catch (err) {
    if (err instanceof ApiError && err.code === "404" && err.message === REFERENCE_NOT_FOUND) return null;
    throw err;
  }
}

/**
 * Up to 25 POTA, SOTA and WWFF list entries whose reference or name holds
 * every word of the query, from the reference-search Edge Function, which
 * works signed out, so no session is sent. A null program searches all three.
 * A query outside 2 to 64 characters or over 6 words rejects with code "400",
 * the rate limit with "429".
 */
export async function searchReferences(query: string, program: ReferenceProgram | null): Promise<ReferenceSearch> {
  const params = new URLSearchParams({ q: query });
  if (program !== null) params.set("program", program);
  return fetchFunction<ReferenceSearch>(`reference-search?${params.toString()}`, { headers: { apikey: SUPABASE_ANON_KEY } });
}

// ---- Spotted activations ----------------------------------------------------

/** The spotted-activations function's 404 body, for either route. */
export const ACTIVATION_NOT_FOUND = "Spotted activation not found.";

/**
 * One spotted activation's page from the spotted-activations Edge Function,
 * which works signed out, so no session is sent. The payload's `id` is the
 * canonical one, which differs from the asked id after a redirect. Null when
 * there is no such page (unknown, still open, or a hidden activator); only the
 * function's own 404 means that, so a gateway 404 is an outage. The rate limit
 * rejects with "429".
 */
export async function loadSpottedActivation(id: string): Promise<SpottedActivation | null> {
  const query = new URLSearchParams({ id });
  try {
    return await fetchFunction<SpottedActivation>(`spotted-activations?${query.toString()}`, { headers: { apikey: SUPABASE_ANON_KEY } });
  } catch (err) {
    if (err instanceof ApiError && err.code === "404" && err.message === ACTIVATION_NOT_FOUND) return null;
    throw err;
  }
}

/**
 * A callsign's Spotted activations tab (summary and recent activations) from
 * the same function. The callsign goes as given; the payload's `callsign` is
 * its base. Null for a hidden call or one with no base (the function's own
 * 404); a callsign that cannot be one rejects with code "400".
 */
export async function loadCallsignActivations(callsign: string): Promise<CallsignActivations | null> {
  const query = new URLSearchParams({ callsign });
  try {
    return await fetchFunction<CallsignActivations>(`spotted-activations?${query.toString()}`, { headers: { apikey: SUPABASE_ANON_KEY } });
  } catch (err) {
    if (err instanceof ApiError && err.code === "404" && err.message === ACTIVATION_NOT_FOUND) return null;
    throw err;
  }
}

// ---- Band map ---------------------------------------------------------------

/**
 * Stations spotted in the last 5 minutes, from the public band-map Edge
 * Function, which works signed out, so no session is sent. Every visitor shares
 * one result cached for 30 seconds in SQL (cached_band_map).
 */
export async function loadBandMap(): Promise<BandMapPayload> {
  return fetchFunction<BandMapPayload>("band-map", { headers: { apikey: SUPABASE_ANON_KEY } });
}

// ---- Health -----------------------------------------------------------------

/**
 * The Health page's checks, series and jobs for a range, from the public
 * health Edge Function, which works signed out, so no session is sent. Every
 * visitor shares one result per range cached for 30 seconds in SQL
 * (cached_health).
 */
export async function loadHealth(range: HealthRange): Promise<HealthPayload> {
  return fetchFunction<HealthPayload>(`health?range=${range}`, { headers: { apikey: SUPABASE_ANON_KEY } });
}

// Typed access to everything the app reads and writes. Pages call these and
// never touch supabase-js directly, so the data contract lives in one file.

import { supabase, SUPABASE_ANON_KEY, SUPABASE_URL } from "../supabase";
import type { Database, Json } from "./database.types";
import type { LatestStats, StatsPayload } from "../stats/types";
import type { CallsignProfile } from "../profile/types";
import type { BandMapPayload } from "../bandmap/types";
import type { CallsignGroup, GroupInput, NormalizedCallsigns } from "../groups/types";
import type { Rules } from "../subscriptions/model";

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
>;
export type Subscription = Row<"subscriptions">;
export type SubscriptionLink = Tables["subscription_destinations"]["Row"];
export type RecentSpot = Views["recent_spots"]["Row"];
export type IngestHealth = Database["public"]["Functions"]["list_ingest_health"]["Returns"][number];
export type DestinationType = "discord" | "webhook" | "push";
export type ApiToken = Omit<Tables["api_tokens"]["Row"], "token_hash">;
export type ApiTokenScope = "read" | "write";

export const DESTINATION_COLUMNS =
  "id, user_id, type, name, enabled, url_display, health, consecutive_failures, last_success_at, last_error, last_error_at, created_at";

export const API_TOKEN_COLUMNS =
  "id, user_id, name, scope, token_prefix, lifetime_days, expires_at, created_at, rotated_at, last_used_at";

export class ApiError extends Error {
  code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
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

/** Fetch an Edge Function; a non-2xx body's `error` becomes the ApiError message and the status its code. */
async function fetchFunction<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${SUPABASE_URL}/functions/v1/${path}`, init);
  } catch {
    throw new ApiError("Couldn't reach Long Lines. Check your connection and try again.");
  }
  const data = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) throw new ApiError(data.error || `Request failed (HTTP ${response.status}).`, String(response.status));
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

/** Sign in with a callsign or email. Resolves the session on success. */
export async function signIn(identifier: string, password: string): Promise<void> {
  const tokens = await callFunction<SignInTokens>("sign-in", { identifier, password });
  const { error } = await supabase.auth.setSession(tokens);
  if (error) throw new ApiError(error.message);
}

/** Re-check the current password without changing the session. */
export async function verifyPassword(email: string, password: string): Promise<void> {
  await callFunction<SignInTokens>("sign-in", { identifier: email, password });
}

async function accessToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new ApiError("Sign in again.");
  return data.session.access_token;
}

/** Sends the sample spot, or raw_spots row `spotId`, to a destination with its saved settings. */
export async function sendTest(destinationId: string, spotId?: number | null): Promise<void> {
  const body = { destination_id: destinationId, ...(spotId === undefined || spotId === null ? {} : { spot_id: spotId }) };
  await callFunction<{ ok: true }>("send-test", body, await accessToken());
}

export async function deleteAccount(): Promise<void> {
  await callFunction<{ ok: true }>("delete-account", {}, await accessToken());
}

// ---- Auth ------------------------------------------------------------------

export async function callsignAvailable(callsign: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("callsign_available", { p_callsign: callsign });
  if (error) fail(error, "Couldn't check that callsign.");
  return data === true;
}

export async function signUp(input: { callsign: string; name: string; email: string; password: string }): Promise<void> {
  const { error } = await supabase.auth.signUp({
    email: input.email,
    password: input.password,
    options: { data: { callsign: input.callsign, name: input.name } },
  });
  if (error) fail(error, "Couldn't create your account.");
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

export async function loadProfile(userId: string): Promise<Profile> {
  const { data, error } = await supabase.from("profiles").select("*").eq("id", userId).single();
  if (error) fail(error, "Couldn't load your profile.");
  return data;
}

export async function updateProfile(
  userId: string,
  patch: Pick<Profile, "callsign" | "name" | "timezone" | "utc_times">,
): Promise<void> {
  const { error } = await supabase.from("profiles").update(patch).eq("id", userId);
  if (error) {
    if (error.code === "23505") throw new ApiError("That callsign is already taken.", error.code);
    fail(error, "Couldn't save your profile.");
  }
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

export interface CreatedDestination {
  id: string;
  type: string;
  name: string;
  url_display: string;
  signing_secret: string | null;
}

/** A Discord or webhook destination from its URL; a push destination has none (`null`). */
export async function createDestination(type: DestinationType, name: string, url: string | null): Promise<CreatedDestination> {
  const { data, error } = await supabase.rpc("create_destination", withNulls<"create_destination">({ p_type: type, p_name: name, p_url: url }));
  if (error) fail(error, "Couldn't add the destination.");
  const row = data[0];
  if (!row) throw new ApiError("Couldn't add the destination.");
  return row;
}

export async function rotateSigningSecret(destinationId: string): Promise<string> {
  const { data, error } = await supabase.rpc("rotate_signing_secret", { p_destination_id: destinationId });
  if (error) fail(error, "Couldn't rotate the secret.");
  return data;
}

/** Renames, re-points or enables a destination; a field left out keeps its value. */
export async function updateDestination(
  destinationId: string,
  patch: { name?: string; url?: string; enabled?: boolean },
): Promise<void> {
  const { error } = await supabase.rpc("update_destination", withNulls<"update_destination">({
    p_id: destinationId, p_name: patch.name ?? null, p_url: patch.url ?? null, p_enabled: patch.enabled ?? null,
  }));
  if (error) fail(error, "Couldn't save the destination.");
}

export async function deleteDestination(destinationId: string): Promise<void> {
  const { error } = await supabase.from("destinations").delete().eq("id", destinationId);
  if (error) {
    if (error.code === "23503") throw new ApiError("Remove it from its connections first.", error.code);
    fail(error, "Couldn't delete the destination.");
  }
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
  | "callsign" | "frequency" | "band" | "mode" | "source" | "reference" | "place_name" | "state" | "spotter" | "comment" | "time";

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
 * sends the keys only. Returns the device id.
 */
export async function registerPushDevice(
  keys: PushKeys,
  label: string | null,
  agent: string | null,
  standalone: boolean | null,
): Promise<string> {
  const { data, error } = await supabase.rpc("register_push_device", withNulls<"register_push_device">({
    p_endpoint: keys.endpoint, p_p256dh: keys.p256dh, p_auth: keys.auth, p_label: label, p_agent: agent, p_standalone: standalone,
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

/** Copies a push destination (settings and devices) as "Copy of {name}", disabled. Returns the new id. */
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
  };
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

/** Creates the group without an id, otherwise replaces its name and whole member list. Returns the id. */
export async function saveGroup(input: GroupInput): Promise<string> {
  const payload: Json = { ...input };
  const { data, error } = await supabase.rpc("save_callsign_group", { payload });
  if (error) fail(error, "Couldn't save the group.");
  return data;
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

// ---- Band map ---------------------------------------------------------------

/**
 * Stations spotted in the last 5 minutes, from the public band-map Edge
 * Function, which works signed out, so no session is sent. Every visitor shares
 * one result cached for 30 seconds in SQL (cached_band_map).
 */
export async function loadBandMap(): Promise<BandMapPayload> {
  return fetchFunction<BandMapPayload>("band-map", { headers: { apikey: SUPABASE_ANON_KEY } });
}

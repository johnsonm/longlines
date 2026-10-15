// Typed access to everything the app reads and writes. Pages call these and
// never touch supabase-js directly, so the data contract lives in one file.

import { supabase, SUPABASE_ANON_KEY, SUPABASE_URL } from "../supabase";
import type { Database, Json } from "./database.types";
import type { LatestStats, StatsPayload } from "../stats/types";
import type { CallsignProfile } from "../profile/types";
import type { CallsignGroup, GroupInput, NormalizedCallsigns } from "../groups/types";
import type { Rules } from "../subscriptions/model";

type Tables = Database["public"]["Tables"];
type Views = Database["public"]["Views"];
export type Profile = Tables["profiles"]["Row"];
export type Destination = Omit<Tables["destinations"]["Row"], "url" | "signing_secret">;
export type Subscription = Tables["subscriptions"]["Row"];
export type SubscriptionLink = Tables["subscription_destinations"]["Row"];
export type RecentSpot = Views["recent_spots"]["Row"];
export type IngestHealth = Views["ingest_health"]["Row"];
export type DestinationType = "discord" | "webhook";
export type ApiToken = Omit<Tables["api_tokens"]["Row"], "token_hash">;
export type ApiTokenScope = "read" | "write";

export const DESTINATION_COLUMNS =
  "id, user_id, type, name, url_display, health, consecutive_failures, last_success_at, last_error, last_error_at, created_at";

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

export async function sendTest(destinationId: string): Promise<void> {
  await callFunction<{ ok: true }>("send-test", { destination_id: destinationId }, await accessToken());
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

export async function signOut(scope: "local" | "others" = "local"): Promise<void> {
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

export async function createDestination(type: DestinationType, name: string, url: string): Promise<CreatedDestination> {
  const { data, error } = await supabase.rpc("create_destination", { p_type: type, p_name: name, p_url: url });
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

export async function deleteDestination(destinationId: string): Promise<void> {
  const { error } = await supabase.from("destinations").delete().eq("id", destinationId);
  if (error) {
    if (error.code === "23503") throw new ApiError("Remove it from its subscriptions first.", error.code);
    fail(error, "Couldn't delete the destination.");
  }
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
  if (subs.error) fail(subs.error, "Couldn't load subscriptions.");
  if (links.error) fail(links.error, "Couldn't load subscriptions.");
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
  if (error) fail(error, "Couldn't save the subscription.");
  return data;
}

export async function deleteSubscription(id: string): Promise<void> {
  const { error } = await supabase.rpc("delete_subscription", { p_id: id });
  if (error) fail(error, "Couldn't delete the subscription.");
}

export async function setSubscriptionEnabled(id: string, enabled: boolean): Promise<void> {
  const { error } = await supabase.from("subscriptions").update({ enabled }).eq("id", id);
  if (error) fail(error, "Couldn't update the subscription.");
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

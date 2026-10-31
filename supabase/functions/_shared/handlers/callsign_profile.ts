// The callsign-profile function: a public read of one station's profile, for
// signed-out browsers too, so it is deployed with verify_jwt = false and
// checks nothing about the caller beyond a per-client rate limit.
//
// GET ?callsign=KK4PWJ/P. The profile is built by callsign_profile() in SQL
// and cached there for 15 minutes (cached_callsign_profile); its shape is
// CallsignProfile in web/src/profile/types.ts. The callsign is only checked
// for shape here: SQL reduces it to the base call, never TypeScript, and
// returns null when there is none (P/1), which is a 400 too.
//
// The rate limit keys on the client address from a header the edge proxy sets
// and a client cannot: LONGLINES_CLIENT_IP_HEADER, cf-connecting-ip by
// default. Without a usable one, the last x-forwarded-for entry, which the
// nearest proxy appended: not spoofable, but it may be that proxy's own
// address, shared by every client, so the first request that falls back logs
// a warning (docs/OPERATIONS.md, "Which client IP the rate limit sees"). Never
// the first entry, which the client writes. An IPv6 client is keyed by its
// /64, since one host usually holds the whole prefix and could otherwise take
// a fresh limit for every address in it. The key is an HMAC of that subject,
// so the stored value cannot be reversed by hashing every IPv4 address.

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { rateLimitSubject } from "../client_address.ts";
import { DEFAULT_METHODS, json, preflightResponse } from "../cors.ts";
import { ValidationError } from "../errors.ts";
import { hmacSha256Hex } from "../hmac.ts";
import { type JsonObject, jsonObjectSchema } from "../types.ts";
import { parseWith } from "../validate.ts";
import { logError } from "../sentry.ts";

export const MAX_LOOKUPS_PER_MINUTE = 30;
export const INVALID_CALLSIGN = "Enter a callsign, like KK4PWJ.";
export const TOO_MANY_LOOKUPS = "Too many lookups. Try again in a minute.";
export const LOOKUP_UNAVAILABLE = "Lookups are unavailable right now.";
/** Browsers and CDNs may keep a profile for 5 minutes; the database cache holds it for 15. */
export const PROFILE_CACHE_CONTROL = "public, max-age=300";
export const DEFAULT_CLIENT_IP_HEADER = "cf-connecting-ip";

// record_profile_lookup returns int: the client's lookups this minute, this one included.
const lookupCountSchema: z.ZodType<number> = z.number();

/**
 * A cached profile or group page (cached_callsign_profile, public_group_statistics): the payload
 * object relayed as built, passed through rather than copied, or null when there is none.
 */
export const inboundedPayloadSchema: z.ZodType<JsonObject | null> = jsonObjectSchema.nullable();

export interface ProfileDeps {
  /** Service-role client for the rate-limit and profile RPCs. */
  db: () => SupabaseClient;
  /** The header the edge proxy sets to the client's address; DEFAULT_CLIENT_IP_HEADER when unset. */
  clientIpHeader: string | undefined;
  /** HMAC key for the rate-limit key, imported once per isolate; undefined when the secret is unset. */
  key: CryptoKey | undefined;
}

/**
 * The callsign uppercased and trimmed, or null when it cannot be one: letters
 * and digits in up to three parts split by "/", at least one letter and one
 * digit, at most 20 characters.
 */
export function parseCallsign(raw: string | null): string | null {
  let text = "";
  if (raw !== null) {
    text = raw;
  }
  const call = text.trim().toUpperCase();
  if (call.length > 20 || !/^[A-Z0-9]+(\/[A-Z0-9]+){0,2}$/.test(call)) {
    return null;
  }
  if (/[A-Z]/.test(call) && /[0-9]/.test(call)) {
    return call;
  }
  return null;
}

/** The last entry of a header that may hold a list: the one the nearest proxy wrote. */
function lastEntry(value: string | null): string {
  if (value === null) {
    return "";
  }
  const last = value.split(",").at(-1);
  if (last === undefined) {
    return "";
  }
  return last;
}

/**
 * The rate limit's subject: from the trusted header (its last entry, should
 * it hold a list), else from the last x-forwarded-for entry, else "unknown"
 * (one shared limit). A value that is not an address counts as missing.
 * `trusted` is false when the trusted header gave nothing usable.
 */
export function clientSubject(
  req: Request,
  trustedHeader: string,
): { subject: string; trusted: boolean } {
  const trusted = rateLimitSubject(lastEntry(req.headers.get(trustedHeader)));
  if (trusted !== null && trusted !== "") {
    return { subject: trusted, trusted: true };
  }
  const forwarded = rateLimitSubject(lastEntry(req.headers.get("x-forwarded-for")));
  if (forwarded === null) {
    return { subject: "unknown", trusted: false };
  }
  return { subject: forwarded, trusted: false };
}

// The fallback warning is logged once per isolate, function and header, not per request.
const warnedFallback = new Set<string>();

/**
 * The stored rate-limit key for a request: an HMAC of clientSubject's subject
 * read from `clientIpHeader` (DEFAULT_CLIENT_IP_HEADER when unset). The first
 * request that falls back logs a warning prefixed with `fn`. Shared with
 * sign-in, which keys its attempt log the same way.
 */
export async function rateLimitKey(
  req: Request,
  clientIpHeader: string | undefined,
  key: CryptoKey,
  fn: string,
): Promise<string> {
  let header = DEFAULT_CLIENT_IP_HEADER;
  if (clientIpHeader !== undefined) {
    const trimmed = clientIpHeader.trim();
    if (trimmed !== "") {
      header = trimmed;
    }
  }
  const client = clientSubject(req, header);
  if (!client.trusted && !warnedFallback.has(`${fn} ${header}`)) {
    warnedFallback.add(`${fn} ${header}`);
    console.warn(
      `${fn}: no client address in ${header}; rate limiting on the last x-forwarded-for ` +
        "entry, which may be shared by every client (see LONGLINES_CLIENT_IP_HEADER)",
    );
  }
  return await hmacSha256Hex(key, client.subject);
}

/**
 * Counts one request against `client`'s per-minute window in record_profile_lookup and returns the
 * window's count, this request included, or null when it cannot be read (logged, prefixed with
 * `fn`). `client` is already a key that names no one (an HMAC), with any bucket prefix.
 */
export async function countRequest(
  db: SupabaseClient,
  client: string,
  fn: string,
): Promise<number | null> {
  const lookups = await db.rpc("record_profile_lookup", { p_client: client });
  if (lookups.error !== null) {
    logError(`${fn}: rate limit failed: ${lookups.error.message}`, lookups.error);
    return null;
  }
  try {
    return parseWith(
      lookupCountSchema,
      lookups.data,
      "countRequest: record_profile_lookup result",
    );
  } catch (error) {
    if (!(error instanceof ValidationError)) {
      throw error;
    }
    logError(`${fn}: rate limit failed: ${error.message}`, error);
    return null;
  }
}

/**
 * Counts one request against the client's per-minute window (countRequest) and returns the
 * window's count, or null when it cannot be read. `bucket` names a separate budget: "" is the
 * shared lookup budget (profiles, group pages, reference pages and searches); relay-api keeps its
 * own buckets, so pairing a relay never spends a visitor's lookups. Shared by lookupLimit and
 * relay-api.
 */
export async function countClientRequest(
  req: Request,
  db: SupabaseClient,
  clientIpHeader: string | undefined,
  key: CryptoKey,
  fn: string,
  bucket: string,
): Promise<number | null> {
  let client = await rateLimitKey(req, clientIpHeader, key, fn);
  if (bucket !== "") {
    client = `${bucket}:${client}`;
  }
  return await countRequest(db, client, fn);
}

/**
 * The per-client lookup limit, shared by callsign-profile and group-page so
 * both count against one budget: null to go on, else the response to send.
 * Anything but a count fails closed: a limit that cannot be read is not a
 * pass. `headers` go on every response this returns.
 */
export async function lookupLimit(
  req: Request,
  db: SupabaseClient,
  deps: Pick<ProfileDeps, "clientIpHeader" | "key">,
  fn: string,
  unavailable: string,
  headers: Record<string, string>,
): Promise<Response | null> {
  if (deps.key === undefined) {
    logError(`${fn}: missing environment variable SUPABASE_SERVICE_ROLE_KEY`, undefined);
    return json({ error: unavailable }, 500, headers);
  }
  const count = await countClientRequest(req, db, deps.clientIpHeader, deps.key, fn, "");
  if (count === null) {
    return json({ error: unavailable }, 500, headers);
  }
  if (count > MAX_LOOKUPS_PER_MINUTE) {
    const limitedHeaders: Record<string, string> = {};
    for (const entry of Object.entries(headers)) {
      limitedHeaders[entry[0]] = entry[1];
    }
    limitedHeaders["Retry-After"] = "60";
    return json({ error: TOO_MANY_LOOKUPS }, 429, limitedHeaders);
  }
  return null;
}

export async function handleProfile(req: Request, deps: ProfileDeps): Promise<Response> {
  const preflight = preflightResponse(req, DEFAULT_METHODS);
  if (preflight !== null) {
    return preflight;
  }
  if (req.method !== "GET") {
    return json({ error: "Method not allowed." }, 405, {});
  }

  const callsign = parseCallsign(new URL(req.url).searchParams.get("callsign"));
  if (callsign === null || callsign === "") {
    return json({ error: INVALID_CALLSIGN }, 400, {});
  }

  const db = deps.db();
  const limited = await lookupLimit(req, db, deps, "callsign-profile", LOOKUP_UNAVAILABLE, {});
  if (limited !== null) {
    return limited;
  }

  const profile = await db.rpc("cached_callsign_profile", { p_callsign: callsign });
  if (profile.error !== null) {
    logError(`callsign-profile: ${profile.error.message}`, profile.error);
    return json({ error: LOOKUP_UNAVAILABLE }, 500, {});
  }
  let payload: JsonObject | null;
  try {
    payload = parseWith(
      inboundedPayloadSchema,
      profile.data,
      "handleProfile: cached_callsign_profile result",
    );
  } catch (error) {
    if (!(error instanceof ValidationError)) {
      throw error;
    }
    logError(`callsign-profile: ${error.message}`, error);
    return json({ error: LOOKUP_UNAVAILABLE }, 500, {});
  }
  // Null: SQL found no base call in it (P/1).
  if (payload === null) {
    return json({ error: INVALID_CALLSIGN }, 400, {});
  }
  return json(payload, 200, { "Cache-Control": PROFILE_CACHE_CONTROL });
}

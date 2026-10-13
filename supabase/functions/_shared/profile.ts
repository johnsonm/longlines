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
// The rate limit keys on the client IP from a header the edge proxy sets and
// a client cannot: LONGLINES_CLIENT_IP_HEADER, cf-connecting-ip by default.
// Without it, the last x-forwarded-for entry, which the nearest proxy appended
// (coarser, since it may be a proxy's address, but not spoofable). Never the
// first entry, which the client writes. The key is an HMAC of the IP, so the
// stored value cannot be reversed by hashing every IPv4 address.

import type { SupabaseClient } from "@supabase/supabase-js";
import { json, preflightResponse } from "./cors.ts";
import { createServiceClient } from "./db.ts";

export const MAX_LOOKUPS_PER_MINUTE = 30;
export const INVALID_CALLSIGN = "Enter a callsign, like KK4PWJ.";
export const TOO_MANY_LOOKUPS = "Too many lookups. Try again in a minute.";
export const LOOKUP_UNAVAILABLE = "Lookups are unavailable right now.";
/** Browsers and CDNs may keep a profile for 5 minutes; the database cache holds it for 15. */
export const PROFILE_CACHE_CONTROL = "public, max-age=300";
export const DEFAULT_CLIENT_IP_HEADER = "cf-connecting-ip";

export interface ProfileDeps {
  /** Service-role client for the rate-limit and profile RPCs. */
  db: () => SupabaseClient;
  /** The header the edge proxy sets to the client's address. */
  clientIpHeader: string;
  /** HMAC key for the rate-limit key; undefined when unset. */
  keySecret: string | undefined;
}

/**
 * The callsign uppercased and trimmed, or null when it cannot be one: letters
 * and digits in up to three parts split by "/", at least one letter and one
 * digit, at most 20 characters.
 */
export function parseCallsign(raw: string | null): string | null {
  const call = (raw ?? "").trim().toUpperCase();
  if (call.length > 20 || !/^[A-Z0-9]+(\/[A-Z0-9]+){0,2}$/.test(call)) return null;
  return /[A-Z]/.test(call) && /[0-9]/.test(call) ? call : null;
}

/**
 * The client's IP: the trusted header, else the last x-forwarded-for entry,
 * else "unknown" (one shared limit).
 */
export function clientIp(req: Request, trustedHeader: string): string {
  const trusted = req.headers.get(trustedHeader)?.trim();
  if (trusted) return trusted;
  const forwarded = req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  return forwarded || "unknown";
}

/** HMAC-SHA-256 of the client IP as hex: the rate limit's key, so no address is stored. */
export async function clientKey(ip: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(ip));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handleProfile(req: Request, deps: ProfileDeps): Promise<Response> {
  const preflight = preflightResponse(req);
  if (preflight) return preflight;
  if (req.method !== "GET") return json({ error: "Method not allowed." }, 405);

  const callsign = parseCallsign(new URL(req.url).searchParams.get("callsign"));
  if (!callsign) return json({ error: INVALID_CALLSIGN }, 400);

  if (!deps.keySecret) {
    console.error("callsign-profile: missing environment variable SUPABASE_SERVICE_ROLE_KEY");
    return json({ error: LOOKUP_UNAVAILABLE }, 500);
  }
  const db = deps.db();
  const client = await clientKey(clientIp(req, deps.clientIpHeader), deps.keySecret);
  const lookups = await db.rpc("record_profile_lookup", { p_client: client });
  if (lookups.error) {
    console.error(`callsign-profile: rate limit failed: ${lookups.error.message}`);
    return json({ error: LOOKUP_UNAVAILABLE }, 500);
  }
  if (typeof lookups.data === "number" && lookups.data > MAX_LOOKUPS_PER_MINUTE) {
    return json({ error: TOO_MANY_LOOKUPS }, 429, { "Retry-After": "60" });
  }

  const profile = await db.rpc("cached_callsign_profile", { p_callsign: callsign });
  if (profile.error) {
    console.error(`callsign-profile: ${callsign}: ${profile.error.message}`);
    return json({ error: LOOKUP_UNAVAILABLE }, 500);
  }
  if (profile.data === null) return json({ error: INVALID_CALLSIGN }, 400);
  return json(profile.data, 200, { "Cache-Control": PROFILE_CACHE_CONTROL });
}

// The service-role key doubles as the HMAC key: every deployment has it and
// it never leaves the server. Rotating it only resets the current minute.
export function serveProfile(): void {
  const clientIpHeader = Deno.env.get("LONGLINES_CLIENT_IP_HEADER")?.trim() ||
    DEFAULT_CLIENT_IP_HEADER;
  Deno.serve((req) =>
    handleProfile(req, {
      db: createServiceClient,
      clientIpHeader,
      keySecret: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    })
  );
}

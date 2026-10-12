// The callsign-profile function: a public read of one station's profile, for
// signed-out browsers too, so it is deployed with verify_jwt = false and
// checks nothing about the caller beyond a per-client rate limit.
//
// GET ?callsign=KK4PWJ/P. The profile is built by callsign_profile() in SQL
// and cached there for 15 minutes (cached_callsign_profile); its shape is
// CallsignProfile in web/src/profile/types.ts. The callsign is only checked
// for shape here: SQL reduces it to the base call, never TypeScript.

import type { SupabaseClient } from "@supabase/supabase-js";
import { json, preflightResponse } from "./cors.ts";
import { createServiceClient } from "./db.ts";

export const MAX_LOOKUPS_PER_MINUTE = 30;
export const INVALID_CALLSIGN = "Enter a callsign, like KK4PWJ.";
export const TOO_MANY_LOOKUPS = "Too many lookups. Try again in a minute.";
export const LOOKUP_UNAVAILABLE = "Lookups are unavailable right now.";
/** Browsers and CDNs may keep a profile for 5 minutes; the database cache holds it for 15. */
export const PROFILE_CACHE_CONTROL = "public, max-age=300";

export interface ProfileDeps {
  /** Service-role client for the rate-limit and profile RPCs. */
  db: () => SupabaseClient;
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

/** The client's IP as the edge proxy reports it, or "unknown". */
export function clientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "unknown";
}

/** SHA-256 of the client IP as hex: the rate limit's key, so no address is stored. */
export async function clientKey(req: Request): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clientIp(req)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handleProfile(req: Request, deps: ProfileDeps): Promise<Response> {
  const preflight = preflightResponse(req);
  if (preflight) return preflight;
  if (req.method !== "GET") return json({ error: "Method not allowed." }, 405);

  const callsign = parseCallsign(new URL(req.url).searchParams.get("callsign"));
  if (!callsign) return json({ error: INVALID_CALLSIGN }, 400);

  const db = deps.db();
  const lookups = await db.rpc("record_profile_lookup", { p_client: await clientKey(req) });
  if (lookups.error) {
    console.error(`callsign-profile: rate limit failed: ${lookups.error.message}`);
    return json({ error: LOOKUP_UNAVAILABLE }, 500);
  }
  if (typeof lookups.data === "number" && lookups.data > MAX_LOOKUPS_PER_MINUTE) {
    return json({ error: TOO_MANY_LOOKUPS }, 429, { "Retry-After": "60" });
  }

  const profile = await db.rpc("cached_callsign_profile", { p_callsign: callsign });
  if (profile.error || profile.data === null) {
    console.error(`callsign-profile: ${callsign}: ${profile.error?.message ?? "no profile"}`);
    return json({ error: LOOKUP_UNAVAILABLE }, 500);
  }
  return json(profile.data, 200, { "Cache-Control": PROFILE_CACHE_CONTROL });
}

export function serveProfile(): void {
  Deno.serve((req) => handleProfile(req, { db: createServiceClient }));
}

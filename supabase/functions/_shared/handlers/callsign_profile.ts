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
import { json, preflightResponse } from "../cors.ts";
import { hmacSha256Hex } from "../hmac.ts";

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
  const call = (raw ?? "").trim().toUpperCase();
  if (call.length > 20 || !/^[A-Z0-9]+(\/[A-Z0-9]+){0,2}$/.test(call)) return null;
  return /[A-Z]/.test(call) && /[0-9]/.test(call) ? call : null;
}

function ipv4Octets(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null;
  const octets = parts.map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

function ipv6Groups(text: string): number[] | null {
  let s = text.toLowerCase();
  // An embedded IPv4 tail (::ffff:192.0.2.1) is the last two groups.
  const tail = /:(\d+\.\d+\.\d+\.\d+)$/.exec(s)?.[1];
  if (tail) {
    const o = ipv4Octets(tail);
    if (!o) return null;
    const [a = 0, b = 0, c = 0, d = 0] = o;
    s = `${s.slice(0, -tail.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const split = (h: string | undefined) => (h ? h.split(":") : []);
  const head = split(halves[0]);
  const rest = split(halves[1]);
  if (![...head, ...rest].every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const zeros = Array<string>(halves.length === 2 ? missing : 0).fill("0");
  return [...head, ...zeros, ...rest].map((g) => parseInt(g, 16));
}

/**
 * What the rate limit counts: an IPv4 address, or an IPv6 address's /64
 * ("2001:db8:0:1::/64"); an IPv4-mapped IPv6 address counts as its IPv4
 * address. Accepts a port on IPv4, and brackets, a port and a zone on IPv6.
 * Null when the value is not an address.
 */
export function rateLimitSubject(raw: string): string | null {
  const value = raw.trim();
  const v4 = ipv4Octets(value.replace(/:\d+$/, ""));
  if (v4) return v4.join(".");
  const groups = ipv6Groups(value.replace(/^\[(.*)\](:\d+)?$/, "$1").replace(/%.*$/, ""));
  if (!groups) return null;
  const [a, b, c, d, e, f, g = 0, h = 0] = groups;
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) {
    return [g >> 8, g & 255, h >> 8, h & 255].join(".");
  }
  return `${groups.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

/** The last entry of a header that may hold a list: the one the nearest proxy wrote. */
function lastEntry(value: string | null): string {
  return value?.split(",").at(-1) ?? "";
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
  if (trusted) return { subject: trusted, trusted: true };
  const forwarded = rateLimitSubject(lastEntry(req.headers.get("x-forwarded-for")));
  return { subject: forwarded ?? "unknown", trusted: false };
}

// The fallback warning is logged once per isolate and header, not per request.
const warnedFallback = new Set<string>();

export async function handleProfile(req: Request, deps: ProfileDeps): Promise<Response> {
  const preflight = preflightResponse(req);
  if (preflight) return preflight;
  if (req.method !== "GET") return json({ error: "Method not allowed." }, 405);

  const callsign = parseCallsign(new URL(req.url).searchParams.get("callsign"));
  if (!callsign) return json({ error: INVALID_CALLSIGN }, 400);

  if (!deps.key) {
    console.error("callsign-profile: missing environment variable SUPABASE_SERVICE_ROLE_KEY");
    return json({ error: LOOKUP_UNAVAILABLE }, 500);
  }
  const header = deps.clientIpHeader?.trim() || DEFAULT_CLIENT_IP_HEADER;
  const { subject, trusted } = clientSubject(req, header);
  if (!trusted && !warnedFallback.has(header)) {
    warnedFallback.add(header);
    console.warn(
      `callsign-profile: no client address in ${header}; rate limiting on the last x-forwarded-for ` +
        "entry, which may be shared by every client (see LONGLINES_CLIENT_IP_HEADER)",
    );
  }
  const db = deps.db();
  const lookups = await db.rpc("record_profile_lookup", {
    p_client: await hmacSha256Hex(deps.key, subject),
  });
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

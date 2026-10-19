// The group-page function: a group's public statistics page (canvas page 10),
// for signed-out browsers too, so it is deployed with verify_jwt = false and
// checks nothing about the caller beyond the profile's per-client rate limit.
//
// GET ?slug=<code>&period=7d|30d (30d by default). The payload is built by
// group_statistics in SQL, cached there for an hour, and read through
// public_group_statistics, which returns null unless the group is public and
// redacts the callsigns unless its owner shows them; its shape is
// GroupStatistics in web/src/groups/stats/types.ts plus a `group` header.
//
// An unknown code, a private group and a malformed code all get the same 404,
// so a caller cannot tell whether a code exists. A malformed one is refused
// before any database call. The 200 is never cached (no-store): turning a page
// off must take effect on the next load ("the link stops working right away").
//
// The rate limit is the profile's (record_profile_lookup, keyed by
// rateLimitKey): one budget per client for profiles and group pages.

import type { SupabaseClient } from "@supabase/supabase-js";
import { json, preflightResponse } from "../cors.ts";
import { MAX_LOOKUPS_PER_MINUTE, rateLimitKey, TOO_MANY_LOOKUPS } from "./callsign_profile.ts";

export const PAGE_PRIVATE = "private";
export const GROUP_PAGE_UNAVAILABLE = "This page is unavailable right now.";
const SLUG = /^[a-z2-7]{10}$/;
const PERIODS = new Set(["7d", "30d"]);

export interface GroupPageDeps {
  /** Service-role client for the rate-limit and page RPCs. */
  db: () => SupabaseClient;
  /** The header the edge proxy sets to the client's address; the profile's default when unset. */
  clientIpHeader: string | undefined;
  /** HMAC key for the rate-limit key, imported once per isolate; undefined when the secret is unset. */
  key: CryptoKey | undefined;
}

export async function handleGroupPage(req: Request, deps: GroupPageDeps): Promise<Response> {
  const preflight = preflightResponse(req);
  if (preflight) return preflight;
  if (req.method !== "GET") return json({ error: "Method not allowed." }, 405);

  const params = new URL(req.url).searchParams;
  const slug = params.get("slug") ?? "";
  const period = params.get("period") ?? "30d";
  if (!SLUG.test(slug) || !PERIODS.has(period)) return json({ error: PAGE_PRIVATE }, 404);

  if (!deps.key) {
    console.error("group-page: missing environment variable SUPABASE_SERVICE_ROLE_KEY");
    return json({ error: GROUP_PAGE_UNAVAILABLE }, 500);
  }
  const client = await rateLimitKey(req, deps.clientIpHeader, deps.key, "group-page");
  const db = deps.db();
  const lookups = await db.rpc("record_profile_lookup", { p_client: client });
  // Anything but a count fails closed: a limit that cannot be read is not a pass.
  if (lookups.error || typeof lookups.data !== "number") {
    const why = lookups.error?.message ?? `unexpected result ${JSON.stringify(lookups.data)}`;
    console.error(`group-page: rate limit failed: ${why}`);
    return json({ error: GROUP_PAGE_UNAVAILABLE }, 500);
  }
  if (lookups.data > MAX_LOOKUPS_PER_MINUTE) {
    return json({ error: TOO_MANY_LOOKUPS }, 429, { "Retry-After": "60" });
  }

  const page = await db.rpc("public_group_statistics", { p_slug: slug, p_period: period });
  if (page.error) {
    // The code is a capability: never log it.
    console.error(`group-page: ${page.error.message}`);
    return json({ error: GROUP_PAGE_UNAVAILABLE }, 500);
  }
  if (page.data === null) {
    return json({ error: PAGE_PRIVATE }, 404, { "Cache-Control": "no-store" });
  }
  return json(page.data, 200, { "Cache-Control": "no-store" });
}

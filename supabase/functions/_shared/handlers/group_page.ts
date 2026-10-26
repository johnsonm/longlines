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
// The rate limit is the profile's (lookupLimit): one budget per client for
// profiles and group pages.

import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_METHODS, json, preflightResponse } from "../cors.ts";
import { ValidationError } from "../errors.ts";
import type { JsonObject } from "../types.ts";
import { parseWith } from "../validate.ts";
import { lookupLimit, relayedPayloadSchema } from "./callsign_profile.ts";

export const PAGE_PRIVATE = "private";
export const GROUP_PAGE_UNAVAILABLE = "This page is unavailable right now.";
const SLUG = /^[a-z2-7]{10}$/;
const PERIODS = new Set(["7d", "30d"]);
/** On every answer, refusals included: no browser or CDN keeps a page past its owner turning it off. */
const NO_STORE = { "Cache-Control": "no-store" };

export interface GroupPageDeps {
  /** Service-role client for the rate-limit and page RPCs. */
  db: () => SupabaseClient;
  /** The header the edge proxy sets to the client's address; the profile's default when unset. */
  clientIpHeader: string | undefined;
  /** HMAC key for the rate-limit key, imported once per isolate; undefined when the secret is unset. */
  key: CryptoKey | undefined;
}

export async function handleGroupPage(req: Request, deps: GroupPageDeps): Promise<Response> {
  const preflight = preflightResponse(req, DEFAULT_METHODS);
  if (preflight !== null) {
    return preflight;
  }
  if (req.method !== "GET") {
    return json({ error: "Method not allowed." }, 405, NO_STORE);
  }

  const params = new URL(req.url).searchParams;
  let slug = "";
  const slugParam = params.get("slug");
  if (slugParam !== null) {
    slug = slugParam;
  }
  let period = "30d";
  const periodParam = params.get("period");
  if (periodParam !== null) {
    period = periodParam;
  }
  if (!SLUG.test(slug) || !PERIODS.has(period)) {
    return json({ error: PAGE_PRIVATE }, 404, NO_STORE);
  }

  const db = deps.db();
  const limited = await lookupLimit(req, db, deps, "group-page", GROUP_PAGE_UNAVAILABLE, NO_STORE);
  if (limited !== null) {
    return limited;
  }

  const page = await db.rpc("public_group_statistics", { p_slug: slug, p_period: period });
  if (page.error !== null) {
    // The code is a capability: never log it.
    console.error(`group-page: ${page.error.message}`);
    return json({ error: GROUP_PAGE_UNAVAILABLE }, 500, NO_STORE);
  }
  let payload: JsonObject | null;
  try {
    payload = parseWith(
      relayedPayloadSchema,
      page.data,
      "handleGroupPage: public_group_statistics result",
    );
  } catch (error) {
    if (!(error instanceof ValidationError)) {
      throw error;
    }
    // The message names the reader and the input, never the code.
    console.error(`group-page: ${error.message}`);
    return json({ error: GROUP_PAGE_UNAVAILABLE }, 500, NO_STORE);
  }
  // Null: unknown, or not public.
  if (payload === null) {
    return json({ error: PAGE_PRIVATE }, 404, NO_STORE);
  }
  return json(payload, 200, NO_STORE);
}

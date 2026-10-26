// The health function: the public Health page's data, for signed-out browsers
// too, so it is deployed with verify_jwt = false and checks nothing about the
// caller.
//
// GET only, `?range=1h|24h|7d` (24h when absent). Every visitor shares one
// result per range: cached_health() in SQL serves health_cache while it is
// under 30 seconds old and rebuilds it under an advisory lock otherwise. There
// is no per-client rate limit: a request is one read of a three-row table. The
// payload is HealthPayload in web/src/health/types.ts and carries numbers and
// statuses only.

import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_METHODS, json, preflightResponse } from "../cors.ts";
import { ValidationError } from "../errors.ts";
import { type JsonObject, jsonObjectSchema } from "../types.ts";
import { parseWith } from "../validate.ts";

export const HEALTH_UNAVAILABLE = "Health is unavailable right now.";
export const HEALTH_RANGES = ["1h", "24h", "7d"] as const;
/** Browsers and CDNs may keep a payload for 15 seconds; the database cache holds it for 30. */
export const HEALTH_CACHE_CONTROL = "public, max-age=15";

export interface HealthDeps {
  /** Service-role client for cached_health(). */
  db: () => SupabaseClient;
}

export async function handleHealth(req: Request, deps: HealthDeps): Promise<Response> {
  const preflight = preflightResponse(req, DEFAULT_METHODS);
  if (preflight !== null) {
    return preflight;
  }
  if (req.method !== "GET") {
    return json({ error: "Method not allowed." }, 405, {});
  }

  let range = "24h";
  const rangeParam = new URL(req.url).searchParams.get("range");
  if (rangeParam !== null) {
    range = rangeParam;
  }
  if (!HEALTH_RANGES.some((known) => known === range)) {
    return json({ error: "Unknown range." }, 400, {});
  }

  const result = await deps.db().rpc("cached_health", { p_range: range });
  if (result.error !== null) {
    console.error(`health: ${result.error.message}`);
    return json({ error: HEALTH_UNAVAILABLE }, 500, {});
  }
  // cached_health returns the HealthPayload object, relayed as built (its shape is pinned by
  // health_snapshot.test.sql); passed through, not copied.
  let payload: JsonObject;
  try {
    payload = parseWith(jsonObjectSchema, result.data, "handleHealth: cached_health result");
  } catch (error) {
    if (!(error instanceof ValidationError)) {
      throw error;
    }
    console.error(`health: ${error.message}`);
    return json({ error: HEALTH_UNAVAILABLE }, 500, {});
  }
  return json(payload, 200, { "Cache-Control": HEALTH_CACHE_CONTROL });
}

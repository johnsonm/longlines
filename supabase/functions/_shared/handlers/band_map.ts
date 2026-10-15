// The band-map function: the public band map's data, for signed-out browsers
// too, so it is deployed with verify_jwt = false and checks nothing about the
// caller.
//
// GET only. Every visitor shares one result: cached_band_map() in SQL serves
// band_map_cache while it is under 30 seconds old and rebuilds it under an
// advisory lock otherwise, so a crowd of visitors costs at most one
// band_map_snapshot() per 30 seconds. There is no per-client rate limit: a
// request is one read of a one-row table. The payload is BandMapPayload in
// web/src/bandmap/types.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import { json, preflightResponse } from "../cors.ts";

export const BAND_MAP_UNAVAILABLE = "The band map is unavailable right now.";
/** Browsers and CDNs may keep a payload for 15 seconds; the database cache holds it for 30. */
export const BAND_MAP_CACHE_CONTROL = "public, max-age=15";

export interface BandMapDeps {
  /** Service-role client for cached_band_map(). */
  db: () => SupabaseClient;
}

export async function handleBandMap(req: Request, deps: BandMapDeps): Promise<Response> {
  const preflight = preflightResponse(req);
  if (preflight) return preflight;
  if (req.method !== "GET") return json({ error: "Method not allowed." }, 405);

  const result = await deps.db().rpc("cached_band_map");
  if (result.error || result.data === null || typeof result.data !== "object") {
    const why = result.error?.message ?? `unexpected result ${JSON.stringify(result.data)}`;
    console.error(`band-map: ${why}`);
    return json({ error: BAND_MAP_UNAVAILABLE }, 500);
  }
  return json(result.data, 200, { "Cache-Control": BAND_MAP_CACHE_CONTROL });
}

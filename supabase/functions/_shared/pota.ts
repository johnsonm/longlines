// POTA source adapter: https://api.pota.app/spot/activator
//
// Upstream record (fields we read):
//   spotId       number   upstream id
//   spotTime     string   ISO 8601 without offset, UTC (e.g. "2026-10-05T13:37:03")
//   activator    string   spotted station
//   spotter      string   reporting station, "-#" suffix marks a skimmer
//   frequency    string   kHz (e.g. "14074.0")
//   mode         string   may be empty
//   comments     string | null
//   reference    string   park reference (e.g. "DE-0858")
//   name         string | null   park name
//   locationDesc string | null   e.g. "US-NC,US-VA"

import { z } from "zod";
import { bandForFrequency } from "./bands.ts";
import { contentHash } from "./hash.ts";
import { fetchJson } from "./http.ts";
import {
  cleanCallsign,
  cleanPotaComment,
  cleanPotaSpotter,
  frequencySchema,
  isTestComment,
  isTooOld,
  optionalTextSchema,
  parseKhz,
  parseUtc,
  requiredTextSchema,
  spotIdSchema,
  spotIdText,
} from "./normalize.ts";
import { modeFamily, resolveMode } from "./modes.ts";
import { parseWith } from "./validate.ts";
import { jsonObjectSchema } from "./types.ts";
import type { JsonObject, NormalizeResult, SourceAdapter } from "./types.ts";

export const POTA_SPOTS_URL = "https://api.pota.app/spot/activator";
const MAX_AGE_MS = 5 * 60 * 1000;

/** The fields of one upstream record that normalize reads (see the header). */
interface PotaSpot {
  spotId: number | string;
  /** parseUtc checks it; a value without an offset is UTC. */
  spotTime: string;
  activator: string;
  spotter: string | null;
  /** parseKhz checks it, after the skip checks. */
  frequency?: number | string | null;
  mode: string | null;
  comments: string | null;
  reference: string | null;
  name: string | null;
  locationDesc: string | null;
}

// Third-party feed: loose, since POTA sends more fields than these and may add some.
const potaSpotSchema: z.ZodType<PotaSpot> = z.looseObject({
  spotId: spotIdSchema,
  spotTime: z.string(),
  activator: requiredTextSchema,
  spotter: optionalTextSchema,
  frequency: frequencySchema,
  mode: optionalTextSchema,
  comments: optionalTextSchema,
  reference: optionalTextSchema,
  name: optionalTextSchema,
  locationDesc: optionalTextSchema,
});

/** The feed envelope: an array of objects. Each spot is validated by normalize. */
const potaFeedSchema: z.ZodType<JsonObject[]> = z.array(jsonObjectSchema);

export const pota: SourceAdapter = {
  source: "pota",

  fetchSpots(): Promise<unknown> {
    return fetchJson(POTA_SPOTS_URL, {});
  },

  parseFeed(body: unknown): JsonObject[] {
    return parseWith(potaFeedSchema, body, "pota.parseFeed: feed");
  },

  async normalize(raw: JsonObject, now: Date): Promise<NormalizeResult> {
    const spot = parseWith(potaSpotSchema, raw, "pota.normalize: spot");
    // The raw values, exactly as POTA sent them, so validation never changes a hash.
    const hash = await contentHash([
      raw["spotTime"],
      raw["activator"],
      raw["reference"],
      raw["frequency"],
      raw["mode"],
      raw["comments"],
    ]);

    const spotTime = parseUtc(spot.spotTime);
    if (isTooOld(spotTime, now, MAX_AGE_MS)) {
      return { kind: "skip", reason: "too_old" };
    }

    const comment = cleanPotaComment(spot.comments);
    if (isTestComment(comment)) {
      return { kind: "skip", reason: "test_comment" };
    }

    const frequencyKhz = parseKhz(spot.frequency, "khz");

    const mode = resolveMode(spot.mode, comment);

    return {
      kind: "spot",
      spot: {
        source: "pota",
        source_spot_id: spotIdText(spot.spotId),
        content_hash: hash,
        spot_time: spotTime.toISOString(),
        callsign: cleanCallsign(spot.activator),
        spotter: cleanPotaSpotter(spot.spotter),
        frequency_khz: frequencyKhz,
        band: bandForFrequency(frequencyKhz),
        mode,
        mode_family: modeFamily(mode),
        comment,
        pota_reference: spot.reference,
        pota_park_name: spot.name,
        pota_location: spot.locationDesc,
        sota_summit_ref: null,
        wwff_reference: null,
        wwff_reference_name: null,
        wwbota_references: null,
        wwbota_reference_name: null,
        iota_reference: null,
        raw_payload: raw,
      },
    };
  },
};

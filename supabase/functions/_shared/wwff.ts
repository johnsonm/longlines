// WWFF source adapter: https://spots.wwff.co/static/spots.json
//
// The feed is the latest spot per activator over roughly the last day, served
// with Cache-Control max-age=60, so it is polled once a minute like POTA.
//
// Upstream record (fields we read):
//   id             number   upstream id
//   spot_time      number   Unix seconds, UTC
//   activator      string   spotted station
//   spotter        string   reporting station
//   frequency_khz  number   kHz (e.g. 14045.4)
//   mode           string   may be empty
//   remarks        string   free text, may be empty
//   reference      string   WWFF reference (e.g. "KFF-5268")
//   reference_name string   reference name

import { z } from "zod";
import { bandForFrequency } from "./bands.ts";
import { contentHash } from "./hash.ts";
import { fetchJson } from "./http.ts";
import {
  cleanCallsign,
  frequencySchema,
  isTestComment,
  isTooOld,
  optionalTextSchema,
  parseKhz,
  requiredTextSchema,
  spotIdSchema,
  spotIdText,
} from "./normalize.ts";
import { modeFamily, resolveMode } from "./modes.ts";
import { parseWith } from "./validate.ts";
import { jsonObjectSchema } from "./types.ts";
import type { JsonObject, NormalizeResult, SourceAdapter } from "./types.ts";

export const WWFF_SPOTS_URL = "https://spots.wwff.co/static/spots.json";
const MAX_AGE_MS = 5 * 60 * 1000;

/** The fields of one upstream record that normalize reads (see the header). */
interface WwffSpot {
  id: number | string;
  /** Unix seconds, UTC. */
  spot_time: number;
  activator: string;
  spotter: string | null;
  /** parseKhz checks it, after the skip checks. */
  frequency_khz?: number | string | null;
  mode: string | null;
  remarks: string | null;
  reference: string | null;
  reference_name: string | null;
}

// Third-party feed: loose, since WWFF sends more fields than these and may add some.
const wwffSpotSchema: z.ZodType<WwffSpot> = z.looseObject({
  id: spotIdSchema,
  // Finite is not enough: 1e13 seconds is past Date's range, and toISOString would throw a
  // RangeError that fails the whole run instead of this spot.
  spot_time: z.number().refine(
    (seconds) => !Number.isNaN(new Date(seconds * 1000).getTime()),
    { error: "spot_time is outside the range of a date" },
  ),
  activator: requiredTextSchema,
  spotter: optionalTextSchema,
  frequency_khz: frequencySchema,
  mode: optionalTextSchema,
  remarks: optionalTextSchema,
  reference: optionalTextSchema,
  reference_name: optionalTextSchema,
});

/** The feed envelope: an array of objects. Each spot is validated by normalize. */
const wwffFeedSchema: z.ZodType<JsonObject[]> = z.array(jsonObjectSchema);

/** The text trimmed, or null when there is none. */
function trimmedText(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }
  return trimmed;
}

export const wwff: SourceAdapter = {
  source: "wwff",

  fetchSpots(): Promise<unknown> {
    return fetchJson(WWFF_SPOTS_URL, {});
  },

  parseFeed(body: unknown): JsonObject[] {
    return parseWith(wwffFeedSchema, body, "wwff.parseFeed: feed");
  },

  async normalize(raw: JsonObject, now: Date): Promise<NormalizeResult> {
    const spot = parseWith(wwffSpotSchema, raw, "wwff.normalize: spot");
    // The raw values, exactly as WWFF sent them, so validation never changes a hash.
    const hash = await contentHash([
      raw["spot_time"],
      raw["activator"],
      raw["reference"],
      raw["frequency_khz"],
      raw["mode"],
      raw["remarks"],
    ]);

    // wwffSpotSchema admits only seconds within Date's range, so this is always a valid date.
    const spotTime = new Date(spot.spot_time * 1000);
    if (isTooOld(spotTime, now, MAX_AGE_MS)) {
      return { kind: "skip", reason: "too_old" };
    }

    let comment = "";
    const remarks = trimmedText(spot.remarks);
    if (remarks !== null) {
      comment = remarks;
    }
    if (isTestComment(comment)) {
      return { kind: "skip", reason: "test_comment" };
    }

    const frequencyKhz = parseKhz(spot.frequency_khz, "khz");

    const mode = resolveMode(trimmedText(spot.mode), comment);

    let spotter: string | null = null;
    const spotterText = trimmedText(spot.spotter);
    if (spotterText !== null) {
      spotter = spotterText.toUpperCase();
    }
    let reference: string | null = null;
    const referenceText = trimmedText(spot.reference);
    if (referenceText !== null) {
      reference = referenceText.toUpperCase();
    }

    return {
      kind: "spot",
      spot: {
        source: "wwff",
        source_spot_id: spotIdText(spot.id),
        content_hash: hash,
        spot_time: spotTime.toISOString(),
        callsign: cleanCallsign(spot.activator),
        spotter,
        frequency_khz: frequencyKhz,
        band: bandForFrequency(frequencyKhz),
        mode,
        mode_family: modeFamily(mode),
        comment,
        pota_reference: null,
        pota_park_name: null,
        pota_location: null,
        sota_summit_ref: null,
        wwff_reference: reference,
        wwff_reference_name: trimmedText(spot.reference_name),
        wwbota_references: null,
        wwbota_reference_name: null,
        iota_reference: null,
        raw_payload: raw,
      },
    };
  },
};

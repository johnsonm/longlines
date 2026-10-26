// SOTAwatch source adapter: https://api-db2.sota.org.uk/api/spots/50/all/all
//
// The epoch endpoint returns an opaque token that changes whenever the spot
// list changes, so a run can skip the spots fetch when nothing is new.
//
// Upstream record (fields we read):
//   id                number   upstream id
//   timeStamp         string   ISO 8601 with offset (e.g. "2026-10-05T13:43:07.025770Z")
//   activatorCallsign string   spotted station
//   callsign          string   reporting station; "RBNHOLE" means see the comment
//   frequency         number   MHz (e.g. 14.074); may be null on QRT spots
//   mode              string
//   comments          string | null   may be the literal "(null)"
//   summitCode        string   e.g. "W4C/CM-001"
//   type              string | null   "NORMAL", "QRT", ...; null is treated as NORMAL

import { z } from "zod";
import { bandForFrequency } from "./bands.ts";
import { contentHash } from "./hash.ts";
import { fetchJson, fetchText } from "./http.ts";
import {
  cleanCallsign,
  cleanSotaComment,
  cleanSotaSpotter,
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

export const SOTAWATCH_EPOCH_URL = "https://api-db2.sota.org.uk/api/spots/epoch";
export const SOTAWATCH_SPOTS_URL = "https://api-db2.sota.org.uk/api/spots/50/all/all";
const MAX_AGE_MS = 5 * 60 * 1000;

/** The fields of one upstream record that normalize reads (see the header). */
interface SotawatchSpot {
  id: number | string;
  timeStamp: string;
  activatorCallsign: string;
  callsign: string | null;
  /** Null on QRT spots, which the type check skips before parseKhz reads it. */
  frequency?: number | string | null;
  mode: string | null;
  comments: string | null;
  summitCode: string | null;
  /** Null or missing is treated as NORMAL. */
  type?: string | null;
}

// Third-party feed: loose, since SOTAwatch sends more fields than these and may add some.
const sotawatchSpotSchema: z.ZodType<SotawatchSpot> = z.looseObject({
  id: spotIdSchema,
  timeStamp: z.string(),
  activatorCallsign: requiredTextSchema,
  callsign: optionalTextSchema,
  frequency: frequencySchema,
  mode: optionalTextSchema,
  comments: optionalTextSchema,
  summitCode: optionalTextSchema,
  type: z.string().nullable().optional(),
});

/** The feed envelope: an array of objects. Each spot is validated by normalize. */
const sotawatchFeedSchema: z.ZodType<JsonObject[]> = z.array(jsonObjectSchema);

// Sorting comes before validation (normalize checks each id), so an id that is not
// a number sorts by Number(), as it always has.
function idOf(item: JsonObject): number {
  const id = item["id"];
  if (typeof id === "number") {
    return id;
  }
  return Number(id);
}

export const sotawatch: SourceAdapter = {
  source: "sotawatch",

  fetchSpots(): Promise<unknown> {
    return fetchJson(SOTAWATCH_SPOTS_URL, {});
  },

  fetchEpoch(): Promise<string> {
    return fetchText(SOTAWATCH_EPOCH_URL, {});
  },

  parseFeed(body: unknown): JsonObject[] {
    const items = parseWith(sotawatchFeedSchema, body, "sotawatch.parseFeed: feed");
    // Upstream order is arbitrary; process oldest first.
    return items.sort((a, b) => idOf(a) - idOf(b));
  },

  async normalize(raw: JsonObject, now: Date): Promise<NormalizeResult> {
    const spot = parseWith(sotawatchSpotSchema, raw, "sotawatch.normalize: spot");
    // The raw values, exactly as SOTAwatch sent them, so validation never changes a hash.
    const hash = await contentHash([
      raw["timeStamp"],
      raw["activatorCallsign"],
      raw["summitCode"],
      raw["frequency"],
      raw["mode"],
      raw["comments"],
    ]);

    const spotTime = parseUtc(spot.timeStamp);
    if (isTooOld(spotTime, now, MAX_AGE_MS)) {
      return { kind: "skip", reason: "too_old" };
    }

    if (spot.type !== null && spot.type !== undefined && spot.type !== "NORMAL") {
      return { kind: "skip", reason: "not_normal" };
    }

    const comment = cleanSotaComment(spot.comments);
    if (isTestComment(comment)) {
      return { kind: "skip", reason: "test_comment" };
    }

    const frequencyKhz = parseKhz(spot.frequency, "mhz");

    const mode = resolveMode(spot.mode, comment);

    let summitRef: string | null = null;
    if (spot.summitCode !== null) {
      summitRef = spot.summitCode.trim().toUpperCase();
    }

    return {
      kind: "spot",
      spot: {
        source: "sotawatch",
        source_spot_id: spotIdText(spot.id),
        content_hash: hash,
        spot_time: spotTime.toISOString(),
        callsign: cleanCallsign(spot.activatorCallsign),
        spotter: cleanSotaSpotter(spot.callsign, comment),
        frequency_khz: frequencyKhz,
        band: bandForFrequency(frequencyKhz),
        mode,
        mode_family: modeFamily(mode),
        comment,
        pota_reference: null,
        pota_park_name: null,
        pota_location: null,
        sota_summit_ref: summitRef,
        wwff_reference: null,
        wwff_reference_name: null,
        wwbota_references: null,
        wwbota_reference_name: null,
        raw_payload: raw,
      },
    };
  },
};

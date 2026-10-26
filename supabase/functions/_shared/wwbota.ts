// WWBOTA source adapter: https://api.wwbota.net/spots/
//
// The feed is the spots of the last hour (the API's default age), served with
// Cache-Control no-cache and an ETag. It is small, so it is polled once a
// minute like WWFF.
//
// Upstream record (fields we read):
//   time        string        ISO 8601 UTC with microseconds; also source_spot_id
//   call        string        spotted station
//   spotter     string        reporting station
//   freq        number|null   MHz; null on some QRT spots
//   mode        string|null
//   comment     string        free text naming the bunkers
//   type        string        "Live", "QRT" or "Test"; state, not part of the spot
//   references  array         every bunker the comment names: {reference, name, ...}
//
// The public spot has no id. `time` stands in: it is unique to the
// microsecond and is the event id of WWBOTA's own SSE stream. `type` stays out
// of the content hash because it flips from Live to QRT after the fact.

import { z } from "zod";
import { bandForFrequency } from "./bands.ts";
import { ValidationError } from "./errors.ts";
import { contentHash } from "./hash.ts";
import { fetchJson } from "./http.ts";
import {
  cleanCallsign,
  frequencySchema,
  isTestComment,
  isTooOld,
  optionalTextSchema,
  parseKhz,
  parseUtc,
  requiredTextSchema,
} from "./normalize.ts";
import { modeFamily, resolveMode } from "./modes.ts";
import { parseWith } from "./validate.ts";
import { jsonObjectSchema } from "./types.ts";
import type { JsonObject, NormalizeResult, SourceAdapter } from "./types.ts";

export const WWBOTA_SPOTS_URL = "https://api.wwbota.net/spots/";
const MAX_AGE_MS = 5 * 60 * 1000;

/** One bunker of a spot's references list (the fields normalize reads). */
interface WwbotaReference {
  reference: string;
  name: string | null;
}

/** The fields of one upstream record that normalize reads (see the header). */
interface WwbotaSpot {
  time: string;
  call: string;
  spotter: string | null;
  /** parseKhz checks it, after the skip checks. */
  freq?: number | string | null;
  mode: string | null;
  comment: string | null;
  /** Missing or null is treated as Live. */
  type: string | null;
  references: WwbotaReference[];
}

// Third-party feed: loose, since WWBOTA sends more fields than these and may add some.
const wwbotaReferenceSchema: z.ZodType<WwbotaReference> = z.looseObject({
  reference: requiredTextSchema,
  name: optionalTextSchema,
});

const wwbotaSpotSchema: z.ZodType<WwbotaSpot> = z.looseObject({
  time: requiredTextSchema,
  call: requiredTextSchema,
  spotter: optionalTextSchema,
  freq: frequencySchema,
  mode: optionalTextSchema,
  comment: optionalTextSchema,
  type: optionalTextSchema,
  references: z.array(wwbotaReferenceSchema),
});

/** The feed envelope: an array of objects. Each spot is validated by normalize. */
const wwbotaFeedSchema: z.ZodType<JsonObject[]> = z.array(jsonObjectSchema);

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

/** The spot's references, uppercased, in the feed's order, each once. */
function referencesOf(references: WwbotaReference[]): string[] {
  const out: string[] = [];
  for (const item of references) {
    const reference = item.reference.trim().toUpperCase();
    if (!out.includes(reference)) {
      out.push(reference);
    }
  }
  return out;
}

export const wwbota: SourceAdapter = {
  source: "wwbota",

  fetchSpots(): Promise<unknown> {
    return fetchJson(WWBOTA_SPOTS_URL, {});
  },

  parseFeed(body: unknown): JsonObject[] {
    return parseWith(wwbotaFeedSchema, body, "wwbota.parseFeed: feed");
  },

  async normalize(raw: JsonObject, now: Date): Promise<NormalizeResult> {
    const spot = parseWith(wwbotaSpotSchema, raw, "wwbota.normalize: spot");
    // The raw values, exactly as WWBOTA sent them, so validation never changes a hash.
    const hash = await contentHash([
      raw["time"],
      raw["call"],
      raw["freq"],
      raw["mode"],
      raw["comment"],
    ]);

    const spotTime = parseUtc(spot.time);
    if (isTooOld(spotTime, now, MAX_AGE_MS)) {
      return { kind: "skip", reason: "too_old" };
    }
    const type = trimmedText(spot.type);
    if (type === "Test") {
      return { kind: "skip", reason: "not_normal" };
    }

    let comment = "";
    const commentText = trimmedText(spot.comment);
    if (commentText !== null) {
      comment = commentText;
    }
    if (isTestComment(comment)) {
      return { kind: "skip", reason: "test_comment" };
    }
    // A QRT spot may have no frequency: nothing to tune to, and none to store.
    if (type === "QRT" && (spot.freq === undefined || spot.freq === null)) {
      return { kind: "skip", reason: "not_normal" };
    }

    const frequencyKhz = parseKhz(spot.freq, "mhz");

    const references = referencesOf(spot.references);
    const first = spot.references[0];
    if (first === undefined) {
      throw new ValidationError("spot names no bunker", {
        cause: undefined,
        where: "wwbota.normalize: references",
      });
    }

    const mode = resolveMode(trimmedText(spot.mode), comment);

    let spotter: string | null = null;
    const spotterText = trimmedText(spot.spotter);
    if (spotterText !== null) {
      spotter = spotterText.toUpperCase();
    }

    return {
      kind: "spot",
      spot: {
        source: "wwbota",
        source_spot_id: spot.time.trim(),
        content_hash: hash,
        spot_time: spotTime.toISOString(),
        callsign: cleanCallsign(spot.call),
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
        wwff_reference: null,
        wwff_reference_name: null,
        wwbota_references: references,
        wwbota_reference_name: trimmedText(first.name),
        raw_payload: raw,
      },
    };
  },
};

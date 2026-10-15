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

import { bandForFrequency } from "./bands.ts";
import { contentHash } from "./hash.ts";
import { fetchJson } from "./http.ts";
import { cleanCallsign, isTestComment, isTooOld, parseKhz } from "./normalize.ts";
import { modeFamily, resolveMode } from "./modes.ts";
import type { JsonObject, NormalizeResult, SourceAdapter } from "./types.ts";

export const WWFF_SPOTS_URL = "https://spots.wwff.co/static/spots.json";
const MAX_AGE_MS = 5 * 60 * 1000;

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function requireString(raw: JsonObject, field: string): string {
  const value = raw[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`missing or empty field "${field}"`);
  }
  return value;
}

function requireId(raw: JsonObject, field: string): string {
  const value = raw[field];
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  throw new Error(`missing field "${field}"`);
}

/** Unix seconds to a Date. Throws when missing or not a finite number. */
function parseUnixSeconds(value: unknown): Date {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`invalid timestamp: ${JSON.stringify(value)}`);
  }
  return new Date(value * 1000);
}

export const wwff: SourceAdapter = {
  source: "wwff",

  fetchSpots(): Promise<unknown> {
    return fetchJson(WWFF_SPOTS_URL);
  },

  parseFeed(body: unknown): JsonObject[] {
    if (!Array.isArray(body)) throw new Error("expected a JSON array from WWFF");
    return body.map((item: unknown, i) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new Error(`WWFF feed item ${i} is not an object`);
      }
      return item as JsonObject;
    });
  },

  async normalize(raw: JsonObject, now: Date): Promise<NormalizeResult> {
    const sourceSpotId = requireId(raw, "id");
    const hash = await contentHash([
      raw["spot_time"],
      raw["activator"],
      raw["reference"],
      raw["frequency_khz"],
      raw["mode"],
      raw["remarks"],
    ]);

    const spotTime = parseUnixSeconds(raw["spot_time"]);
    if (isTooOld(spotTime, now, MAX_AGE_MS)) return { kind: "skip", reason: "too_old" };

    const comment = optionalString(raw["remarks"]) ?? "";
    if (isTestComment(comment)) return { kind: "skip", reason: "test_comment" };

    const frequencyKhz = parseKhz(raw["frequency_khz"], "khz");

    const mode = resolveMode(optionalString(raw["mode"]), comment);

    return {
      kind: "spot",
      spot: {
        source: "wwff",
        source_spot_id: sourceSpotId,
        content_hash: hash,
        spot_time: spotTime.toISOString(),
        callsign: cleanCallsign(requireString(raw, "activator")),
        spotter: optionalString(raw["spotter"])?.toUpperCase() ?? null,
        frequency_khz: frequencyKhz,
        band: bandForFrequency(frequencyKhz),
        mode,
        mode_family: modeFamily(mode),
        comment,
        pota_reference: null,
        pota_park_name: null,
        pota_location: null,
        sota_summit_ref: null,
        wwff_reference: optionalString(raw["reference"])?.toUpperCase() ?? null,
        wwff_reference_name: optionalString(raw["reference_name"]),
        raw_payload: raw,
      },
    };
  },
};

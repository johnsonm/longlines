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

import { bandForFrequency } from "./bands.ts";
import { contentHash } from "./hash.ts";
import { fetchJson } from "./http.ts";
import {
  cleanCallsign,
  cleanPotaComment,
  cleanPotaSpotter,
  isTestComment,
  isTooOld,
  parseKhz,
  parseUtc,
} from "./normalize.ts";
import { modeFamily, resolveMode } from "./modes.ts";
import type { JsonObject, NormalizeResult, SourceAdapter } from "./types.ts";

export const POTA_SPOTS_URL = "https://api.pota.app/spot/activator";
const MAX_AGE_MS = 5 * 60 * 1000;

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
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

export const pota: SourceAdapter = {
  source: "pota",

  fetchSpots(): Promise<unknown> {
    return fetchJson(POTA_SPOTS_URL);
  },

  parseFeed(body: unknown): JsonObject[] {
    if (!Array.isArray(body)) throw new Error("expected a JSON array from POTA");
    return body.map((item: unknown, i) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new Error(`POTA feed item ${i} is not an object`);
      }
      return item as JsonObject;
    });
  },

  async normalize(raw: JsonObject, now: Date): Promise<NormalizeResult> {
    const sourceSpotId = requireId(raw, "spotId");
    const hash = await contentHash([
      raw["spotTime"],
      raw["activator"],
      raw["reference"],
      raw["frequency"],
      raw["mode"],
      raw["comments"],
    ]);

    const spotTime = parseUtc(raw["spotTime"]);
    if (isTooOld(spotTime, now, MAX_AGE_MS)) return { kind: "skip", reason: "too_old" };

    const comment = cleanPotaComment(optionalString(raw["comments"]));
    if (isTestComment(comment)) return { kind: "skip", reason: "test_comment" };

    const frequencyKhz = parseKhz(raw["frequency"], "khz");

    const mode = resolveMode(optionalString(raw["mode"]), comment);

    return {
      kind: "spot",
      spot: {
        source: "pota",
        source_spot_id: sourceSpotId,
        content_hash: hash,
        spot_time: spotTime.toISOString(),
        callsign: cleanCallsign(requireString(raw, "activator")),
        spotter: cleanPotaSpotter(optionalString(raw["spotter"])),
        frequency_khz: frequencyKhz,
        band: bandForFrequency(frequencyKhz),
        mode,
        mode_family: modeFamily(mode),
        comment,
        pota_reference: optionalString(raw["reference"]),
        pota_park_name: optionalString(raw["name"]),
        pota_location: optionalString(raw["locationDesc"]),
        sota_summit_ref: null,
        wwff_reference: null,
        wwff_reference_name: null,
        raw_payload: raw,
      },
    };
  },
};

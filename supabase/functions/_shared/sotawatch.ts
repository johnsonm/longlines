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

import { bandForFrequency } from "./bands.ts";
import { contentHash } from "./hash.ts";
import { fetchJson, fetchText } from "./http.ts";
import {
  cleanCallsign,
  cleanSotaComment,
  cleanSotaSpotter,
  isTestComment,
  isTooOld,
  parseKhz,
  parseUtc,
} from "./normalize.ts";
import { modeFamily, resolveMode } from "./modes.ts";
import type { JsonObject, NormalizeResult, SourceAdapter } from "./types.ts";

export const SOTAWATCH_EPOCH_URL = "https://api-db2.sota.org.uk/api/spots/epoch";
export const SOTAWATCH_SPOTS_URL = "https://api-db2.sota.org.uk/api/spots/50/all/all";
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

function idOf(item: JsonObject): number {
  const id = item["id"];
  return typeof id === "number" ? id : Number(id);
}

export const sotawatch: SourceAdapter = {
  source: "sotawatch",

  fetchSpots(): Promise<unknown> {
    return fetchJson(SOTAWATCH_SPOTS_URL);
  },

  fetchEpoch(): Promise<string> {
    return fetchText(SOTAWATCH_EPOCH_URL);
  },

  parseFeed(body: unknown): JsonObject[] {
    if (!Array.isArray(body)) throw new Error("expected a JSON array from SOTAwatch");
    const items = body.map((item: unknown, i) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new Error(`SOTAwatch feed item ${i} is not an object`);
      }
      return item as JsonObject;
    });
    // Upstream order is arbitrary; process oldest first.
    return items.sort((a, b) => idOf(a) - idOf(b));
  },

  async normalize(raw: JsonObject, now: Date): Promise<NormalizeResult> {
    const sourceSpotId = requireId(raw, "id");
    const hash = await contentHash([
      raw["timeStamp"],
      raw["activatorCallsign"],
      raw["summitCode"],
      raw["frequency"],
      raw["mode"],
      raw["comments"],
    ]);

    const spotTime = parseUtc(raw["timeStamp"]);
    if (isTooOld(spotTime, now, MAX_AGE_MS)) return { kind: "skip", reason: "too_old" };

    const type = raw["type"];
    if (type !== null && type !== undefined && type !== "NORMAL") {
      return { kind: "skip", reason: "not_normal" };
    }

    const comment = cleanSotaComment(optionalString(raw["comments"]));
    if (isTestComment(comment)) return { kind: "skip", reason: "test_comment" };

    const frequencyKhz = parseKhz(raw["frequency"], "mhz");

    const mode = resolveMode(optionalString(raw["mode"]), comment);

    return {
      kind: "spot",
      spot: {
        source: "sotawatch",
        source_spot_id: sourceSpotId,
        content_hash: hash,
        spot_time: spotTime.toISOString(),
        callsign: cleanCallsign(requireString(raw, "activatorCallsign")),
        spotter: cleanSotaSpotter(optionalString(raw["callsign"]), comment),
        frequency_khz: frequencyKhz,
        band: bandForFrequency(frequencyKhz),
        mode,
        mode_family: modeFamily(mode),
        comment,
        pota_reference: null,
        pota_park_name: null,
        pota_location: null,
        sota_summit_ref: optionalString(raw["summitCode"])?.trim().toUpperCase() ?? null,
        wwff_reference: null,
        wwff_reference_name: null,
        raw_payload: raw,
      },
    };
  },
};

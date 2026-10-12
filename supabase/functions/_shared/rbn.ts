// Reverse Beacon Network source adapter. RBN spots are pushed, not pulled: the
// relay (relay/main.ts) holds the telnet stream at telnet.reversebeacon.net:7000
// and POSTs every spot line to ingest-rbn. rbnSpotRow() turns each line into an
// rbn_spots row; rbnAdapter() wraps the watched lines of a request so runIngest
// can treat them like a fetched feed (see rbn_push.ts).
//
// Request body:
//   { "lines": [{ "line": "<telnet line>", "received_at": "<ISO 8601 UTC>" }, ...] }
//
// Telnet spot line (columns are space-padded; RTTY reports BPS instead of WPM):
//   DX de SM1HEV-#: 14038.30  CT1JGA/P       CW     8 dB  24 WPM  CQ      1454Z
//   DX de K3PA-1-#:  7037.50  K3WU           CW    15 dB  26 WPM  CQ      1454Z
//   DX de LZ7AA-#:   7043.73  ON6A           RTTY  13 dB  45 BPS  CQ      1454Z
//   DX de HA1VHF-#:144433.60  9A0BVH         CW    15 dB  15 WPM  DX      1455Z
//
// A line carries no date and no id. The date comes from received_at (see
// spotTimeFromHhmm in relay_lines.ts) and source_spot_id is built from the time, skimmer,
// station and frequency.

import { bandForFrequency } from "./bands.ts";
import { contentHash } from "./hash.ts";
import { cleanCallsign, isTooOld, parseKhz, parseUtc } from "./normalize.ts";
import { modeFamily, resolveMode } from "./modes.ts";
import { parseRelayBody, requireString, spotTimeFromHhmm } from "./relay_lines.ts";
import type { JsonObject, NormalizeResult, RbnSpotRow, SourceAdapter } from "./types.ts";

const MAX_AGE_MS = 5 * 60 * 1000;
// rbn_spots.snr and speed are smallint; a larger value would fail the whole
// batch in Postgres instead of just this line.
const SMALLINT_MAX = 32767;

const SPOT_LINE =
  /^DX de (\S+?)-#:\s*(\d+(?:\.\d+)?)\s+(\S+)\s+(\S+)\s+(-?\d+) dB\s+(\d+) (WPM|BPS)\s+(.*?)\s+(\d{4})Z\s*$/;

/** The fields of one telnet spot line, as text exactly as RBN sent them. */
export interface RbnLine {
  /** Skimmer callsign without the "-#" marker. */
  spotter: string;
  frequency: string;
  callsign: string;
  mode: string;
  snr: string;
  speed: string;
  speedUnit: "WPM" | "BPS";
  /** CQ, BEACON, NCDXF B, DX. */
  type: string;
  hhmm: string;
}

/** Parse one telnet line. Null for anything that is not a spot (banner, prompt, blank). */
export function parseRbnLine(line: string): RbnLine | null {
  const m = SPOT_LINE.exec(line.trim());
  if (!m) return null;
  // Every group in SPOT_LINE is mandatory, so a match always has all nine.
  const group = (i: number): string => m[i] ?? "";
  return {
    spotter: group(1).toUpperCase(),
    frequency: group(2),
    callsign: cleanCallsign(group(3)),
    mode: group(4),
    snr: group(5),
    speed: group(6),
    speedUnit: group(7) === "BPS" ? "BPS" : "WPM",
    type: group(8),
    hhmm: group(9),
  };
}

/** The comment stored in raw_spots: "<snr> dB <speed> <unit> <type>". */
function rbnComment(parsed: RbnLine): string {
  return `${parsed.snr} dB ${parsed.speed} ${parsed.speedUnit} ${parsed.type}`;
}

/**
 * The rbn_spots row for one relay item. No age cutoff: storage keeps late lines.
 * Throws when the line is not a spot or received_at is unusable.
 */
export function rbnSpotRow(raw: JsonObject): RbnSpotRow {
  const line = requireString(raw, "line");
  // jsonb rejects U+0000, so a NUL would fail the whole batch in Postgres.
  if (line.includes("\u0000")) throw new Error("line contains a NUL character");
  const receivedAt = parseUtc(requireString(raw, "received_at"));
  const parsed = parseRbnLine(line);
  if (!parsed) throw new Error("not an RBN spot line");
  const snr = Number(parsed.snr);
  const speed = Number(parsed.speed);
  if (Math.abs(snr) > SMALLINT_MAX) throw new Error(`snr out of range: ${parsed.snr}`);
  if (speed > SMALLINT_MAX) throw new Error(`speed out of range: ${parsed.speed}`);
  const frequencyKhz = parseKhz(parsed.frequency, "khz");
  const mode = resolveMode(parsed.mode, rbnComment(parsed));
  return {
    spot_time: spotTimeFromHhmm(parsed.hhmm, receivedAt).toISOString(),
    received_at: receivedAt.toISOString(),
    spotter: parsed.spotter,
    callsign: parsed.callsign,
    frequency_khz: frequencyKhz,
    band: bandForFrequency(frequencyKhz),
    mode,
    mode_family: modeFamily(mode),
    snr,
    speed,
    speed_unit: parsed.speedUnit,
    spot_type: parsed.type,
    line,
  };
}

/** An adapter whose feed is one relay request body. */
export function rbnAdapter(body: unknown): SourceAdapter {
  return {
    source: "rbn",

    fetchSpots(): Promise<unknown> {
      return Promise.resolve(body);
    },

    parseFeed(feed: unknown): JsonObject[] {
      return parseRelayBody(feed);
    },

    async normalize(raw: JsonObject, now: Date): Promise<NormalizeResult> {
      const line = requireString(raw, "line");
      const receivedAt = parseUtc(requireString(raw, "received_at"));
      const parsed = parseRbnLine(line);
      if (!parsed) throw new Error("not an RBN spot line");

      const spotTime = spotTimeFromHhmm(parsed.hhmm, receivedAt);
      if (isTooOld(spotTime, now, MAX_AGE_MS)) return { kind: "skip", reason: "too_old" };

      const spotTimeIso = spotTime.toISOString();
      // Field order is fixed; changing it would make every stored spot look new.
      const hash = await contentHash([
        spotTimeIso,
        parsed.spotter,
        parsed.callsign,
        parsed.frequency,
        parsed.mode,
        parsed.snr,
        `${parsed.speed} ${parsed.speedUnit}`,
        parsed.type,
      ]);

      const frequencyKhz = parseKhz(parsed.frequency, "khz");
      const comment = rbnComment(parsed);
      const mode = resolveMode(parsed.mode, comment);

      return {
        kind: "spot",
        spot: {
          source: "rbn",
          source_spot_id: `${spotTimeIso}|${parsed.spotter}|${parsed.callsign}|${parsed.frequency}`,
          content_hash: hash,
          spot_time: spotTimeIso,
          callsign: parsed.callsign,
          spotter: parsed.spotter,
          frequency_khz: frequencyKhz,
          band: bandForFrequency(frequencyKhz),
          mode,
          mode_family: modeFamily(mode),
          comment,
          pota_reference: null,
          pota_park_name: null,
          pota_location: null,
          sota_summit_ref: null,
          raw_payload: raw,
        },
      };
    },
  };
}

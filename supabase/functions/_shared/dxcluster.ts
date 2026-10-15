// DX Cluster source adapter. Like RBN, spots are pushed: the relay holds a
// telnet session to a DXSpider node (relay/feeds.ts) and POSTs every human spot
// line to ingest-dxcluster. Unlike RBN there is no firehose table: human spots
// are a few thousand an hour at most, so every one goes through runIngest into
// raw_spots.
//
// Request body: see relay_lines.ts.
//
// Telnet spot line (DXSpider; columns are space-padded, the comment is cut at
// 30 characters, the line ends in two BEL characters, and nodes with
// set/dxgrid append the spotter's locator after the time; other nodes append a
// state or zones there instead):
//   DX de HA7UL:      7146.0  HA7UL/P      CROTA HU-BCS-003               1316Z
//   DX de YB1LVL:    28074.0  F4HKP        FT8 -19dB from JN18 1524Hz     1316Z
//   DX de KB8OTK:    14075.2  VP2MAW                                      1318Z
//   DX de W3LPL:     14025.0  JA1ABC       up 2                           1234Z FN20
//
// A line has no mode field; resolveDxMode reads it from the comment or the band
// plan. Skimmer spots ("-#" spotters, RBN-style "NN dB NN WPM" comments) are not
// spots here: RBN already covers them.

import { bandForFrequency } from "./bands.ts";
import { contentHash } from "./hash.ts";
import { runIngest } from "./ingest.ts";
import { modeFamily, resolveDxMode } from "./modes.ts";
import { cleanCallsign, isTooOld, parseKhz, parseUtc } from "./normalize.ts";
import { relayAdapter, requireString, spotTimeFromHhmm } from "./relay_lines.ts";
import type {
  IngestDb,
  IngestSummary,
  JsonObject,
  NormalizeResult,
  SourceAdapter,
} from "./types.ts";

const MAX_AGE_MS = 5 * 60 * 1000;

// The comment is greedy so the time is the last "HHMMZ" on the line; nodes may
// append a locator, a state or zones after it, which are ignored.
const SPOT_LINE = /^DX de (\S+?):\s*(\d+(?:\.\d+)?)\s+(\S+)\s*(.*)\s(\d{4})Z(?:\s+(.*))?$/;
const LOCATOR = /^[A-R]{2}\d{2}(?:[A-X]{2})?$/i;
// Skimmer comments as RBN writes them, with or without the mode in front: "CW 15 dB 22 WPM CQ".
const SKIMMER_COMMENT = /^(?:\S+\s+)?-?\d+ dB\s+\d+ (?:WPM|BPS)\b/;
// BEL and other C0 controls; DXSpider rings the bell after every spot.
// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** The fields of one spot line, as text exactly as the node sent them. */
export interface DxLine {
  spotter: string;
  frequency: string;
  callsign: string;
  /** Free text, trimmed; may be empty. */
  comment: string;
  hhmm: string;
  /** The spotter's Maidenhead locator, uppercased, when the node appends one after the time. */
  locator: string | null;
}

/** Parse one telnet line. Null for anything that is not a human spot. */
export function parseDxLine(line: string): DxLine | null {
  const m = SPOT_LINE.exec(line.replace(CONTROL, "").trim());
  if (!m) return null;
  // Groups 1-5 are mandatory, so a match always has them.
  const group = (i: number): string => m[i] ?? "";
  const spotter = group(1).toUpperCase();
  const comment = group(4).trim();
  const tail = group(6).trim();
  if (spotter.endsWith("-#") || SKIMMER_COMMENT.test(comment)) return null;
  return {
    spotter,
    frequency: group(2),
    callsign: cleanCallsign(group(3)),
    comment,
    hhmm: group(5),
    locator: LOCATOR.test(tail) ? tail.toUpperCase() : null,
  };
}

/** An adapter whose feed is one relay request body. */
export function dxclusterAdapter(body: unknown): SourceAdapter {
  return relayAdapter(
    "dxcluster",
    body,
    async (raw: JsonObject, now: Date): Promise<NormalizeResult> => {
      const line = requireString(raw, "line");
      const receivedAt = parseUtc(requireString(raw, "received_at"));
      const parsed = parseDxLine(line);
      if (!parsed) throw new Error("not a DX Cluster spot line");

      const spotTime = spotTimeFromHhmm(parsed.hhmm, receivedAt);
      if (isTooOld(spotTime, now, MAX_AGE_MS)) return { kind: "skip", reason: "too_old" };

      const spotTimeIso = spotTime.toISOString();
      // Field order is fixed; changing it would make every stored spot look new.
      const hash = await contentHash([
        spotTimeIso,
        parsed.spotter,
        parsed.callsign,
        parsed.frequency,
        parsed.comment,
      ]);

      const frequencyKhz = parseKhz(parsed.frequency, "khz");
      const mode = resolveDxMode(parsed.comment, frequencyKhz);

      return {
        kind: "spot",
        spot: {
          source: "dxcluster",
          source_spot_id: `${spotTimeIso}|${parsed.spotter}|${parsed.callsign}|${parsed.frequency}`,
          content_hash: hash,
          spot_time: spotTimeIso,
          callsign: parsed.callsign,
          spotter: parsed.spotter,
          frequency_khz: frequencyKhz,
          band: bandForFrequency(frequencyKhz),
          mode,
          mode_family: modeFamily(mode),
          comment: parsed.comment,
          pota_reference: null,
          pota_park_name: null,
          pota_location: null,
          sota_summit_ref: null,
          wwff_reference: null,
          wwff_reference_name: null,
          raw_payload: raw,
        },
      };
    },
  );
}

/** One relay batch for ingest-dxcluster. An empty batch still records the heartbeat. */
export function runDxclusterPush(
  body: unknown,
  db: IngestDb,
  now: Date = new Date(),
): Promise<IngestSummary> {
  return runIngest(dxclusterAdapter(body), db, now);
}

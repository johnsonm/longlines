// APRS-IS source. The relay holds the full feed (port 10152, every packet the
// network carries, no filter) and POSTs every packet line to ingest-aprs, which
// stores all of them in aprs_packets: kept about two days in the database and
// archived to Storage. Packets are not spots: nothing goes to raw_spots, the
// matcher or the rollups.
//
// Request body: see relay_lines.ts.
//
// Packet line (TNC2 format, as APRS-IS sends it):
//   N0CALL-9>APDR16,WIDE1-1,qAR,W1ABC-10:=4237.14N/07120.83W[/A=000164
//   DB0XYZ>APRS,TCPIP*,qAC,T2GER:;LEADER   *092345z4903.50N/07201.75W>
// Everything before the first ":" is the header (source ">" destination, then
// the digipeater path, the q-construct the APRS-IS server added and the station
// that gated it). The info field after it starts with a data type identifier.
// Server comment and keepalive lines start with "#" and are not packets.
//
// Only the header and the packet type are parsed; positions, weather and
// telemetry stay in the stored line for later decoding.

import {
  assertMaxLength,
  assertPlausibleTime,
  MAX_CALLSIGN_LENGTH,
  parseUtc,
} from "./normalize.ts";
import { recordFailureAndThrow } from "./ingest.ts";
import { parseRelayBody, requireString, withoutNul } from "./relay_lines.ts";
import type {
  AprsDb,
  AprsPacketRow,
  IngestDb,
  IngestSummary,
  JsonObject,
  SpotFailure,
} from "./types.ts";

export const APRS_PACKET_TYPES = [
  "position",
  "mic_e",
  "object",
  "item",
  "message",
  "status",
  "weather",
  "telemetry",
  "nmea",
  "third_party",
  "capabilities",
  "query",
  "user_defined",
  "other",
] as const;

export type AprsPacketType = typeof APRS_PACKET_TYPES[number];

export interface AprsLine {
  sourceCall: string;
  destination: string;
  /** Digipeater path before the q-construct, comma-separated; "" when there is none. */
  path: string;
  /** qAR, qAC, qAS, ... or null when the header has none. */
  qConstruct: string | null;
  /** The station after the q-construct (the igate or server), or null. */
  igate: string | null;
  info: string;
}

/** One header field: printable ASCII other than the separators "," ":" and ">". */
const FIELD = /^[!-+\--9;-=?-~]+$/;
const Q_CONSTRUCT = /^q[A-Z]{2}$/;

/** The header of one packet line, or null for a server comment or anything that is not a packet. */
export function parseAprsLine(line: string): AprsLine | null {
  if (line.startsWith("#")) {
    return null;
  }
  const colon = line.indexOf(":");
  if (colon < 0) {
    return null;
  }
  const header = line.slice(0, colon);
  const gt = header.indexOf(">");
  if (gt < 0) {
    return null;
  }
  const sourceCall = header.slice(0, gt);
  const fields = header.slice(gt + 1).split(",");
  let destination = "";
  const first = fields[0];
  if (first !== undefined) {
    destination = first;
  }
  const hops = fields.slice(1);
  if (!FIELD.test(sourceCall) || !FIELD.test(destination) || !hops.every((f) => FIELD.test(f))) {
    return null;
  }
  const q = hops.findIndex((h) => Q_CONSTRUCT.test(h));
  let path = hops.join(",");
  let qConstruct: string | null = null;
  let igate: string | null = null;
  if (q >= 0) {
    path = hops.slice(0, q).join(",");
    const construct = hops[q];
    if (construct === undefined) {
      throw new Error(`parseAprsLine: no hop at the q-construct index ${String(q)}`);
    }
    qConstruct = construct;
    const next = hops[q + 1];
    if (next !== undefined) {
      igate = next;
    }
  }
  return {
    sourceCall,
    destination,
    path,
    qConstruct,
    igate,
    info: line.slice(colon + 1),
  };
}

/** The packet type from the info field's data type identifier (APRS 1.0.1, chapter 5). */
export function aprsPacketType(info: string): AprsPacketType {
  switch (info.charAt(0)) {
    case "!":
    case "=":
    case "/":
    case "@":
      return "position";
    case "`":
    case "'":
    case "\x1c":
    case "\x1d":
      return "mic_e";
    case ";":
      return "object";
    case ")":
      return "item";
    case ":":
      return "message";
    case ">":
      return "status";
    case "_":
      return "weather";
    case "T":
      return "telemetry";
    case "$":
      return "nmea";
    case "}":
      return "third_party";
    case "<":
      return "capabilities";
    case "?":
      return "query";
    case "{":
      return "user_defined";
    default:
      return "other";
  }
}

/**
 * The aprs_packets row for one relay item. Throws when the line is not a
 * packet, received_at is unusable or implausible against now, or a value would
 * fail the whole batch in Postgres.
 */
export function aprsPacketRow(raw: JsonObject, now: Date): AprsPacketRow {
  const line = requireString(raw, "line");
  // jsonb rejects U+0000 and lone surrogates, so either would fail the whole batch in Postgres.
  if (line.includes("\u0000")) {
    throw new Error("line contains a NUL character");
  }
  if (!line.isWellFormed()) {
    throw new Error("line contains a lone surrogate");
  }
  const receivedAt = parseUtc(requireString(raw, "received_at"));
  assertPlausibleTime(receivedAt, now, "received_at");
  const parsed = parseAprsLine(line);
  if (parsed === null) {
    throw new Error("not an APRS packet line");
  }
  // aprs_packets indexes source_call.
  assertMaxLength(parsed.sourceCall, MAX_CALLSIGN_LENGTH, "source call");
  return {
    received_at: receivedAt.toISOString(),
    source_call: parsed.sourceCall,
    destination: parsed.destination,
    path: parsed.path,
    q_construct: parsed.qConstruct,
    igate: parsed.igate,
    packet_type: aprsPacketType(parsed.info),
    line,
  };
}

export type AprsPushDb =
  & AprsDb
  & Pick<IngestDb, "recordSpotFailures" | "recordSuccess" | "recordFailure">;

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * One relay batch: every packet into aprs_packets, unparseable lines into
 * ingest_failures, and ingest_state updated. An empty batch is the relay's
 * heartbeat and still records success.
 */
export async function runAprsPush(
  body: unknown,
  db: AprsPushDb,
  now: Date = new Date(),
): Promise<IngestSummary> {
  const started = performance.now();
  const rows: AprsPacketRow[] = [];
  const failures: SpotFailure[] = [];
  let fetched: number;
  let stored = 0;
  try {
    const items = parseRelayBody(body);
    fetched = items.length;
    for (const raw of items) {
      try {
        rows.push(aprsPacketRow(raw, now));
      } catch (error) {
        failures.push({ source: "aprs", error: errorMessage(error), raw_payload: withoutNul(raw) });
      }
    }
    if (rows.length > 0) {
      stored = await db.ingestAprsPackets(rows);
    }
    if (failures.length > 0) {
      await db.recordSpotFailures(failures);
    }
    await db.recordSuccess("aprs", stored, null);
  } catch (error) {
    return await recordFailureAndThrow(db, "aprs", error);
  }
  return {
    source: "aprs",
    epoch_unchanged: false,
    fetched,
    inserted: 0,
    skipped: { too_old: 0, test_comment: 0, not_normal: 0 },
    failed: failures.length,
    stored,
    matched: null,
    duration_ms: Math.round(performance.now() - started),
  };
}

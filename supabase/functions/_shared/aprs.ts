// APRS-IS source. The inbound worker holds the full feed (port 10152, every packet the
// network carries, no filter) and POSTs every packet line to ingest-aprs, which
// stores all of them in aprs_packets: kept about two days in the database and
// archived to Storage. As with RBN, only the packets whose station a connection
// names (watched_among) go on through runIngest into raw_spots, the spot_events
// queue and the matcher; the rollups, Stats and profiles never see them.
//
// A packet becomes a spot only when it puts a station on a map (position, Mic-E,
// object, item). A beaconing station sends one every 30 seconds to a few
// minutes, so a spot's dedup key is the station and a fixed time bucket
// (APRS_SPOT_BUCKET_MS): the first packet of each window is stored and the rest
// hit the unique constraint.
//
// Request body: see inbound_lines.ts.
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
// telemetry stay in the stored line (and a spot's comment) for later decoding.

import { ValidationError } from "./errors.ts";
import { contentHash } from "./hash.ts";
import {
  assertMaxLength,
  assertPlausibleTime,
  cleanCallsign,
  isTooOld,
  MAX_CALLSIGN_LENGTH,
  parseUtc,
} from "./normalize.ts";
import { recordFailureAndThrow, runIngest } from "./ingest.ts";
import {
  inboundAdapter,
  inboundLineSchema,
  parseInboundBody,
  withoutNul,
} from "./inbound_lines.ts";
import type {
  AprsDb,
  AprsPacketRow,
  IngestDb,
  IngestSummary,
  InsertedSpot,
  JsonObject,
  NormalizedSpot,
  NormalizeResult,
  Source,
  SourceAdapter,
  SpotFailure,
  WatchlistDb,
} from "./types.ts";
import { parseWith } from "./validate.ts";

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
// The APRS-IS q-constructs are "qA" and one letter, and two of them are lower case (qAr,
// qAo), so the last letter may be either.
const Q_CONSTRUCT = /^q[A-Z][A-Za-z]$/;

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
  let path = hops.join(",");
  let qConstruct: string | null = null;
  let igate: string | null = null;
  // The first q-construct splits the hops: the path before it, the igate after it.
  for (const hop of hops.entries()) {
    const index = hop[0];
    if (Q_CONSTRUCT.test(hop[1])) {
      path = hops.slice(0, index).join(",");
      qConstruct = hop[1];
      const next = hops[index + 1];
      if (next !== undefined) {
        igate = next;
      }
      break;
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
 * The aprs_packets row for one inbound item. Throws ValidationError when the item
 * is malformed, the line is not a packet, received_at is unusable or implausible
 * against now, or a value would fail the whole batch in Postgres.
 */
export function aprsPacketRow(raw: JsonObject, now: Date): AprsPacketRow {
  const item = parseWith(inboundLineSchema, raw, "aprsPacketRow: inbound line");
  const line = item.line;
  // jsonb rejects U+0000 and lone surrogates, so either would fail the whole batch in Postgres.
  if (line.includes("\u0000")) {
    throw new ValidationError("line contains a NUL character", {
      cause: undefined,
      where: "aprsPacketRow: line",
    });
  }
  if (!line.isWellFormed()) {
    throw new ValidationError("line contains a lone surrogate", {
      cause: undefined,
      where: "aprsPacketRow: line",
    });
  }
  const receivedAt = parseUtc(item.received_at);
  assertPlausibleTime(receivedAt, now, "received_at");
  const parsed = parseAprsLine(line);
  if (parsed === null) {
    throw new ValidationError("not an APRS packet line", {
      cause: undefined,
      where: "aprsPacketRow: line",
    });
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

/**
 * The window a station's spots are bucketed by: one raw_spots row per station per window.
 * It is part of every APRS spot's source_spot_id and content hash, so changing it makes
 * the next packet of every station look new.
 */
export const APRS_SPOT_BUCKET_MS = 15 * 60 * 1000;

/** A spot older than this at ingest is skipped, as for RBN. */
const MAX_AGE_MS = 5 * 60 * 1000;

/** Packet types that put a station on a map; only these become spots. */
const SPOT_PACKET_TYPES: ReadonlySet<AprsPacketType> = new Set<AprsPacketType>([
  "position",
  "mic_e",
  "object",
  "item",
]);

/**
 * q-constructs whose next hop is the igate that heard the packet on RF (qAR, qAr), a
 * receive-only igate that gated it from RF (qAO), or one that gated it from a client
 * that is not its source (qAo). The others (qAC, qAS, qAX, ...)
 * name a server or the connection, not a station that heard anything.
 */
const SPOTTER_Q_CONSTRUCTS: ReadonlySet<string> = new Set(["qAR", "qAr", "qAO", "qAo"]);

/**
 * Whether an upper-cased source call could be a station: it has a letter and a
 * digit. Gateways and services (WINLINK, MYANET) send under names that are not callsigns.
 */
function isPlausibleCallsign(call: string): boolean {
  return /[A-Z]/.test(call) && /[0-9]/.test(call);
}

/** The start of the bucket a packet received at receivedAt falls in, as ISO 8601 UTC. */
export function aprsSpotBucket(receivedAt: Date): string {
  const ms = receivedAt.getTime();
  return new Date(ms - (ms % APRS_SPOT_BUCKET_MS)).toISOString();
}

/**
 * Normalizes one inbound item (a packet line and when the inbound worker received it).
 * Skips packets that do not put a station on a map (not_normal), sources that are not
 * callsigns (not_callsign) and packets older than five minutes (too_old). Throws
 * ValidationError when the item is malformed or the line is not a packet.
 */
export async function normalizeAprsSpot(raw: JsonObject, now: Date): Promise<NormalizeResult> {
  const item = parseWith(inboundLineSchema, raw, "normalizeAprsSpot: inbound line");
  const receivedAt = parseUtc(item.received_at);
  const parsed = parseAprsLine(item.line);
  if (parsed === null) {
    throw new ValidationError("not an APRS packet line", {
      cause: undefined,
      where: "normalizeAprsSpot: line",
    });
  }
  if (!SPOT_PACKET_TYPES.has(aprsPacketType(parsed.info))) {
    return { kind: "skip", reason: "not_normal" };
  }
  const callsign = cleanCallsign(parsed.sourceCall);
  if (!isPlausibleCallsign(callsign)) {
    return { kind: "skip", reason: "not_callsign" };
  }
  if (isTooOld(receivedAt, now, MAX_AGE_MS)) {
    return { kind: "skip", reason: "too_old" };
  }

  const bucket = aprsSpotBucket(receivedAt);
  // Field order is fixed; changing it would make every stored spot look new.
  const hash = await contentHash([callsign, bucket]);
  let spotter: string | null = null;
  if (
    parsed.qConstruct !== null && SPOTTER_Q_CONSTRUCTS.has(parsed.qConstruct) &&
    parsed.igate !== null
  ) {
    spotter = cleanCallsign(parsed.igate);
  }

  return {
    kind: "spot",
    spot: {
      source: "aprs",
      source_spot_id: `${callsign}|${bucket}`,
      content_hash: hash,
      spot_time: receivedAt.toISOString(),
      callsign,
      spotter,
      // APRS carries no frequency, band or mode.
      frequency_khz: null,
      band: null,
      mode: null,
      mode_family: null,
      // The info field as received; positions are not decoded.
      comment: parsed.info,
      pota_reference: null,
      pota_park_name: null,
      pota_location: null,
      sota_summit_ref: null,
      wwff_reference: null,
      wwff_reference_name: null,
      wwbota_references: null,
      wwbota_reference_name: null,
      iota_reference: null,
      raw_payload: raw,
    },
  };
}

/** An adapter whose feed is one inbound request body (the watched packets of a batch). */
export function aprsAdapter(body: unknown): SourceAdapter {
  return inboundAdapter("aprs", body, normalizeAprsSpot);
}

export type AprsPushDb = IngestDb & WatchlistDb & AprsDb;

/** An inbound item that made an aprs_packets row, and that row. */
interface StoredPacket {
  raw: JsonObject;
  row: AprsPacketRow;
}

/**
 * The database runIngest sees for one APRS-IS batch. ingest_state for aprs counts
 * packets, as it did before APRS-IS connections (its total is what /health and
 * ingest_health have always read), so the run's success records the batch's stored
 * packets instead of runIngest's watched spots.
 */
function packetCountingDb(db: AprsPushDb, stored: number): IngestDb {
  return {
    getLastEpoch(source: Source): Promise<string | null> {
      return db.getLastEpoch(source);
    },
    ingestSpots(spots: NormalizedSpot[]): Promise<InsertedSpot[]> {
      return db.ingestSpots(spots);
    },
    recordSpotFailures(failures: SpotFailure[]): Promise<void> {
      return db.recordSpotFailures(failures);
    },
    // runIngest's own count, the watched spots inserted, is set aside for the packets.
    recordSuccess(source: Source, _spotsInserted: number, epoch: string | null): Promise<void> {
      return db.recordSuccess(source, stored, epoch);
    },
    recordFailure(source: Source, error: string): Promise<void> {
      return db.recordFailure(source, error);
    },
    matchPendingSpots(): Promise<number> {
      return db.matchPendingSpots();
    },
  };
}

/**
 * One inbound batch: every packet into aprs_packets and unparseable lines into
 * ingest_failures; then the packets whose station a connection names go through
 * runIngest into raw_spots and the matcher. runIngest records ingest_state with the
 * stored packet count (packetCountingDb), and runs even with no watched packets, so
 * the inbound worker's empty heartbeat still records success.
 */
export async function runAprsPush(
  body: unknown,
  db: AprsPushDb,
  now: Date,
): Promise<IngestSummary> {
  const packets: StoredPacket[] = [];
  const failures: SpotFailure[] = [];
  const watchedItems: JsonObject[] = [];
  let items: JsonObject[];
  let stored = 0;
  try {
    items = parseInboundBody(body);
    for (const raw of items) {
      try {
        packets.push({ raw, row: aprsPacketRow(raw, now) });
      } catch (error) {
        // Per line: an unparseable line becomes one ingest_failures row, and anything
        // else fails the batch.
        if (!(error instanceof ValidationError)) {
          throw error;
        }
        failures.push({ source: "aprs", error: error.message, raw_payload: withoutNul(raw) });
      }
    }
    const rows = packets.map((packet) => packet.row);
    if (rows.length > 0) {
      stored = await db.ingestAprsPackets(rows);
    }
    if (failures.length > 0) {
      await db.recordSpotFailures(failures);
    }
    // The source call as stored, SSID included: watched_among reduces it to a base call.
    const stations = Array.from(new Set(rows.map((row) => row.source_call)));
    const watched = new Set(await db.watchedAmong("aprs", stations));
    for (const packet of packets) {
      if (watched.has(packet.row.source_call)) {
        watchedItems.push(packet.raw);
      }
    }
  } catch (error) {
    // Records the run's failure in ingest_state, then rethrows it for the handler's 500.
    return await recordFailureAndThrow(db, "aprs", error);
  }

  const summary = await runIngest(
    aprsAdapter({ lines: watchedItems }),
    packetCountingDb(db, stored),
    now,
  );
  // Same keys in the same order as the summary, with fetched and failed
  // replaced in place and stored added last.
  return Object.assign({}, summary, {
    fetched: items.length,
    failed: summary.failed + failures.length,
    stored,
  });
}

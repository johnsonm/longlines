// Shared by the pushed sources (RBN, DX Cluster): the relay request body, the
// adapter shell around it, and the "HHMMZ" time stamp that telnet spot lines
// carry instead of a date.
//
// Request body:
//   { "lines": [{ "line": "<telnet line>", "received_at": "<ISO 8601 UTC>" }, ...] }

import { withoutNul } from "./nul.ts";
import type { JsonObject, NormalizeResult, Source, SourceAdapter } from "./types.ts";

// The push failure paths (rbn_push.ts, aprs.ts) import it from here.
export { withoutNul };

const MAX_LINES = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Validates a relay request body and returns its items in order. Throws on a bad shape. */
export function parseRelayBody(body: unknown): JsonObject[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("expected a JSON object from the relay");
  }
  const lines = (body as JsonObject)["lines"];
  if (!Array.isArray(lines)) throw new Error('expected a "lines" array from the relay');
  if (lines.length > MAX_LINES) {
    throw new Error(`relay batch has ${lines.length} lines; the limit is ${MAX_LINES}`);
  }
  return lines.map((item: unknown, i) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`relay line ${i} is not an object`);
    }
    return item as JsonObject;
  });
}

/**
 * An adapter whose feed is one relay request body, so runIngest can treat a
 * push like a fetched feed. Items lose any NUL before normalize sees them, which
 * keeps raw_payload and ingest_failures rows storable.
 */
export function relayAdapter(
  source: Source,
  body: unknown,
  normalize: (raw: JsonObject, now: Date) => Promise<NormalizeResult>,
): SourceAdapter {
  return {
    source,
    fetchSpots: () => Promise.resolve(body),
    parseFeed: (feed) => parseRelayBody(feed).map(withoutNul),
    normalize,
  };
}

/**
 * The spot time for an "HHMM" stamp: the instant with that UTC time of day
 * closest to receivedAt, so a 2359Z spot received at 0000Z lands on the previous
 * day and a 0001Z spot received a few seconds before midnight on the next.
 * Throws on an impossible stamp.
 */
export function spotTimeFromHhmm(hhmm: string, receivedAt: Date): Date {
  const hours = Number(hhmm.slice(0, 2));
  const minutes = Number(hhmm.slice(2, 4));
  if (!/^\d{4}$/.test(hhmm) || hours > 23 || minutes > 59) {
    throw new Error(`invalid HHMM time: ${JSON.stringify(hhmm)}`);
  }
  const sameDay = Date.UTC(
    receivedAt.getUTCFullYear(),
    receivedAt.getUTCMonth(),
    receivedAt.getUTCDate(),
    hours,
    minutes,
  );
  const candidates = [sameDay - DAY_MS, sameDay, sameDay + DAY_MS];
  const distance = (t: number) => Math.abs(t - receivedAt.getTime());
  return new Date(candidates.reduce((best, t) => distance(t) < distance(best) ? t : best));
}

export function requireString(raw: JsonObject, field: string): string {
  const value = raw[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`missing or empty field "${field}"`);
  }
  return value;
}

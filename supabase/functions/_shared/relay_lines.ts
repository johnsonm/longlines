// Shared by the pushed sources (RBN, DX Cluster): the relay request body, the
// adapter shell around it, and the "HHMMZ" time stamp that telnet spot lines
// carry instead of a date.
//
// Request body:
//   { "lines": [{ "line": "<telnet line>", "received_at": "<ISO 8601 UTC>" }, ...] }

import { z } from "zod";
import { ValidationError } from "./errors.ts";
import { requiredTextSchema } from "./normalize.ts";
import { withoutNul } from "./strip_nul.ts";
import { jsonObjectSchema } from "./types.ts";
import type { JsonObject, NormalizeResult, Source, SourceAdapter } from "./types.ts";
import { parseWith } from "./validate.ts";

// The push failure paths (rbn_push.ts, aprs.ts) import it from here.
export { withoutNul };

const MAX_LINES = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A relay request body, as relay/functions.ts posts it. Each item is validated on its own. */
export interface RelayBody {
  lines: JsonObject[];
}

/** One line of a relay request body (RelayLine in relay/functions.ts). */
export interface RelayLineItem {
  line: string;
  /** ISO 8601 UTC; parseUtc checks it. */
  received_at: string;
}

// Our relay's request body: strict. The items are only objects here, so one bad
// item fails alone, in the adapter that parses it with relayLineSchema.
const relayBodySchema: z.ZodType<RelayBody> = z.strictObject({
  lines: z.array(jsonObjectSchema).max(
    MAX_LINES,
    `a relay batch holds at most ${String(MAX_LINES)} lines`,
  ),
});

/** One relay item: strict, since our relay sends exactly these two keys. */
export const relayLineSchema: z.ZodType<RelayLineItem> = z.strictObject({
  line: requiredTextSchema,
  received_at: requiredTextSchema,
});

/**
 * Validates a relay request body and returns its items in order, as received.
 * Throws ValidationError on a bad shape.
 */
export function parseRelayBody(body: unknown): JsonObject[] {
  return parseWith(relayBodySchema, body, "parseRelayBody: relay body").lines;
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
 * Throws ValidationError on an impossible stamp.
 */
export function spotTimeFromHhmm(hhmm: string, receivedAt: Date): Date {
  const hours = Number(hhmm.slice(0, 2));
  const minutes = Number(hhmm.slice(2, 4));
  if (!/^\d{4}$/.test(hhmm) || hours > 23 || minutes > 59) {
    throw new ValidationError(`invalid HHMM time: ${JSON.stringify(hhmm)}`, {
      cause: undefined,
      where: "spotTimeFromHhmm: HHMM time",
    });
  }
  const sameDay = Date.UTC(
    receivedAt.getUTCFullYear(),
    receivedAt.getUTCMonth(),
    receivedAt.getUTCDate(),
    hours,
    minutes,
  );
  const candidates = [sameDay - DAY_MS, sameDay, sameDay + DAY_MS];
  // The first candidate wins a tie.
  let best = sameDay - DAY_MS;
  for (const t of candidates) {
    if (Math.abs(t - receivedAt.getTime()) < Math.abs(best - receivedAt.getTime())) {
      best = t;
    }
  }
  return new Date(best);
}

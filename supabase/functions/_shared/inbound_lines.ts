// Shared by the pushed sources (RBN, DX Cluster, APRS-IS): the inbound request body, the
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

/** An inbound request body, as inbound/functions.ts posts it. Each item is validated on its own. */
export interface InboundBody {
  lines: JsonObject[];
}

/** One line of an inbound request body (InboundLine in inbound/functions.ts). */
export interface InboundLineItem {
  line: string;
  /** ISO 8601 UTC; parseUtc checks it. */
  received_at: string;
}

// Our inbound's request body: strict. The items are only objects here, so one bad
// item fails alone, in the adapter that parses it with inboundLineSchema.
const inboundBodySchema: z.ZodType<InboundBody> = z.strictObject({
  lines: z.array(jsonObjectSchema).max(
    MAX_LINES,
    `an inbound worker batch holds at most ${String(MAX_LINES)} lines`,
  ),
});

/** One inbound item: strict, since our inbound sends exactly these two keys. */
export const inboundLineSchema: z.ZodType<InboundLineItem> = z.strictObject({
  line: requiredTextSchema,
  received_at: requiredTextSchema,
});

/**
 * Validates an inbound request body and returns its items in order, as received.
 * Throws ValidationError on a bad shape.
 */
export function parseInboundBody(body: unknown): JsonObject[] {
  return parseWith(inboundBodySchema, body, "parseInboundBody: inbound body").lines;
}

/**
 * An adapter whose feed is one inbound request body, so runIngest can treat a
 * push like a fetched feed. Items lose any NUL before normalize sees them, which
 * keeps raw_payload and ingest_failures rows storable.
 */
export function inboundAdapter(
  source: Source,
  body: unknown,
  normalize: (raw: JsonObject, now: Date) => Promise<NormalizeResult>,
): SourceAdapter {
  return {
    source,
    fetchSpots: () => Promise.resolve(body),
    parseFeed: (feed) => parseInboundBody(feed).map(withoutNul),
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

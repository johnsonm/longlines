// Pure normalization helpers shared by the source adapters, and the field schemas
// they validate upstream spots with. No I/O.

import { z } from "zod";
import { ValidationError } from "./errors.ts";
import type { NormalizedSpot } from "./types.ts";

const TEST_COMMENT = /\btest(ing)?\b/i;
const RBNHOLE_SPOTTER = /\[RBNHole\]\s+at\s+(\S+)/i;
const HAS_UTC_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

/** A text field the code requires: a string with something other than whitespace. */
export const requiredTextSchema: z.ZodType<string> = z.string().refine(
  (value) => value.trim() !== "",
  "missing or empty",
);

/**
 * A text field the code reads as absent unless it is a string: a missing, null or
 * non-string value becomes null. The adapters have always read these fields that
 * way, so this never rejects a spot.
 */
export const optionalTextSchema: z.ZodType<string | null> = z.string().nullable().catch(null);

/** An upstream spot id: a finite number, or a string with something other than whitespace. */
export const spotIdSchema: z.ZodType<number | string> = z.union([z.number(), requiredTextSchema]);

/** A frequency as a feed may send it; parseKhz checks the value, after the skip checks. */
export const frequencySchema: z.ZodType<number | string | null | undefined> = z
  .union([z.number(), z.string()])
  .nullable()
  .optional();

/** source_spot_id from a validated spot id: the number as text, or the string trimmed. */
export function spotIdText(id: number | string): string {
  if (typeof id === "number") {
    return String(id);
  }
  return id.trim();
}

/** Uppercase with every whitespace character removed. */
export function cleanCallsign(value: string): string {
  return value.toUpperCase().replace(/\s/g, "");
}

/** POTA spotter: uppercase, trimmed, trailing "-#" skimmer marker removed. Null when blank. */
export function cleanPotaSpotter(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const cleaned = value.trim().toUpperCase().replace(/-#$/, "");
  if (cleaned === "") {
    return null;
  }
  return cleaned;
}

/**
 * SOTAwatch spotter: uppercase, trimmed. RBNHOLE spots carry the real spotter
 * in the comment ("[RBNHole] at DL1HWS 21 WPM ..."); use it when present, and
 * null (unknown) when it is not, since RBNHOLE is the bot, not a station.
 */
export function cleanSotaSpotter(
  value: string | null | undefined,
  comment: string,
): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const cleaned = value.trim().toUpperCase();
  if (cleaned === "") {
    return null;
  }
  if (cleaned === "RBNHOLE") {
    const match = RBNHOLE_SPOTTER.exec(comment);
    if (match === null) {
      return null;
    }
    const spotter = match[1];
    if (spotter === undefined || spotter === "") {
      return null;
    }
    return spotter.toUpperCase();
  }
  return cleaned;
}

/** Trimmed; null becomes "". */
export function cleanPotaComment(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  return value.trim();
}

/** Leading ". " or "*" removed, trimmed; null and the literal "(null)" become "". */
export function cleanSotaComment(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return "";
  }
  const cleaned = value.replace(/^(\. |\*)/, "").trim();
  if (cleaned === "(null)") {
    return "";
  }
  return cleaned;
}

export function isTestComment(comment: string): boolean {
  return TEST_COMMENT.test(comment);
}

// raw_spots.frequency_khz is numeric(12,3); anything from 1e9 kHz up would
// overflow it and fail the whole batch instead of just this spot.
const MAX_KHZ = 1_000_000_000;

/**
 * Parse an upstream frequency into kHz rounded to 3 decimals.
 * Accepts a string or number in the given unit. Throws ValidationError when
 * missing, non-numeric, not positive, or too large for the database column.
 */
export function parseKhz(value: unknown, unit: "khz" | "mhz"): number {
  let n = Number.NaN;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string") {
    n = Number.parseFloat(value);
  }
  if (!Number.isFinite(n) || n <= 0) {
    throw new ValidationError(`invalid frequency: ${JSON.stringify(value)}`, {
      cause: undefined,
      where: "parseKhz: frequency",
    });
  }
  let inKhz = n;
  if (unit === "mhz") {
    inKhz = n * 1000;
  }
  const khz = Math.round(inKhz * 1000) / 1000;
  if (khz >= MAX_KHZ) {
    throw new ValidationError(`frequency out of range: ${JSON.stringify(value)} ${unit}`, {
      cause: undefined,
      where: "parseKhz: frequency",
    });
  }
  return khz;
}

/**
 * Parse an ISO 8601 timestamp to a Date. A value with no offset (POTA sends
 * "2026-10-05T13:37:03") is UTC, so "Z" is appended before parsing.
 * Throws ValidationError when missing or unparseable.
 */
export function parseUtc(value: unknown): Date {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`invalid timestamp: ${JSON.stringify(value)}`, {
      cause: undefined,
      where: "parseUtc: timestamp",
    });
  }
  const text = value.trim();
  let withOffset = `${text}Z`;
  if (HAS_UTC_OFFSET.test(text)) {
    withOffset = text;
  }
  const date = new Date(withOffset);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError(`invalid timestamp: ${JSON.stringify(value)}`, {
      cause: undefined,
      where: "parseUtc: timestamp",
    });
  }
  return date;
}

export function isTooOld(spotTime: Date, now: Date, maxAgeMs: number): boolean {
  return now.getTime() - spotTime.getTime() > maxAgeMs;
}

// Bounds on what one spot may carry, so a bad item becomes one ingest_failures
// row instead of failing its whole batch. A btree index entry over about 2.7 KB
// fails the insert (raw_spots indexes callsign and source_spot_id, rbn_spots
// and aprs_packets index the station, the rollups key on spotter and
// reference), and Postgres refuses years past 294276 or before 4713 BC. Real
// callsigns are under 20 characters; the RBN and DX Cluster ids join an ISO
// time, two calls and a frequency.
export const MAX_CALLSIGN_LENGTH = 64;
export const MAX_SPOT_ID_LENGTH = 256;
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;
const MIN_TIME_MS = Date.UTC(2000, 0, 1);

/** Throws ValidationError when the text is longer than max characters. */
export function assertMaxLength(value: string, max: number, field: string): void {
  if (value.length > max) {
    throw new ValidationError(
      `${field} is ${String(value.length)} characters; the limit is ${String(max)}`,
      { cause: undefined, where: `assertMaxLength: ${field}` },
    );
  }
}

/**
 * Throws ValidationError for a time more than a day after now or before 2000 (a milliseconds
 * value read as seconds, a bad clock): such a time would fail the batch in
 * Postgres or, being in the future, never age out of the feed.
 */
export function assertPlausibleTime(time: Date, now: Date, field: string): void {
  const ms = time.getTime();
  if (!(ms >= MIN_TIME_MS && ms - now.getTime() <= MAX_FUTURE_MS)) {
    let shown = "invalid";
    if (!Number.isNaN(ms)) {
      shown = time.toISOString();
    }
    throw new ValidationError(`${field} out of range: ${shown}`, {
      cause: undefined,
      where: `assertPlausibleTime: ${field}`,
    });
  }
}

/** Throws when a normalized spot would fail its ingest_spots batch. The orchestrator runs it on every spot. */
export function assertStorableSpot(spot: NormalizedSpot, now: Date): void {
  assertPlausibleTime(new Date(spot.spot_time), now, "spot time");
  assertMaxLength(spot.source_spot_id, MAX_SPOT_ID_LENGTH, "source_spot_id");
  assertMaxLength(spot.callsign, MAX_CALLSIGN_LENGTH, "callsign");
  const bounded: [string, string | null][] = [
    ["spotter", spot.spotter],
    ["pota_reference", spot.pota_reference],
    ["sota_summit_ref", spot.sota_summit_ref],
    ["wwff_reference", spot.wwff_reference],
  ];
  for (const pair of bounded) {
    const value = pair[1];
    if (value !== null) {
      assertMaxLength(value, MAX_CALLSIGN_LENGTH, pair[0]);
    }
  }
}

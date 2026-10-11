// Pure normalization helpers shared by the source adapters. No I/O.

const TEST_COMMENT = /\btest(ing)?\b/i;
const RBNHOLE_SPOTTER = /\[RBNHole\]\s+at\s+(\S+)/i;
const HAS_UTC_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

/** Uppercase with every whitespace character removed. */
export function cleanCallsign(value: string): string {
  return value.toUpperCase().replace(/\s/g, "");
}

/** POTA spotter: uppercase, trimmed, trailing "-#" skimmer marker removed. Null when blank. */
export function cleanPotaSpotter(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value.trim().toUpperCase().replace(/-#$/, "");
  return cleaned === "" ? null : cleaned;
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
  if (!value) return null;
  const cleaned = value.trim().toUpperCase();
  if (cleaned === "") return null;
  if (cleaned === "RBNHOLE") {
    const match = RBNHOLE_SPOTTER.exec(comment);
    return match?.[1] ? match[1].toUpperCase() : null;
  }
  return cleaned;
}

/** Trimmed; null becomes "". */
export function cleanPotaComment(value: string | null | undefined): string {
  return (value ?? "").trim();
}

/** Leading ". " or "*" removed, trimmed; null and the literal "(null)" become "". */
export function cleanSotaComment(value: string | null | undefined): string {
  if (!value) return "";
  const cleaned = value.replace(/^(\. |\*)/, "").trim();
  return cleaned === "(null)" ? "" : cleaned;
}

export function isTestComment(comment: string): boolean {
  return TEST_COMMENT.test(comment);
}

// raw_spots.frequency_khz is numeric(12,3); anything from 1e9 kHz up would
// overflow it and fail the whole batch instead of just this spot.
const MAX_KHZ = 1_000_000_000;

/**
 * Parse an upstream frequency into kHz rounded to 3 decimals.
 * Accepts a string or number in the given unit. Throws when missing,
 * non-numeric, not positive, or too large for the database column.
 */
export function parseKhz(value: unknown, unit: "khz" | "mhz"): number {
  const n = typeof value === "number"
    ? value
    : typeof value === "string"
    ? Number.parseFloat(value)
    : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`invalid frequency: ${JSON.stringify(value)}`);
  }
  const khz = Math.round((unit === "mhz" ? n * 1000 : n) * 1000) / 1000;
  if (khz >= MAX_KHZ) {
    throw new Error(`frequency out of range: ${JSON.stringify(value)} ${unit}`);
  }
  return khz;
}

/**
 * Parse an ISO 8601 timestamp to a Date. A value with no offset (POTA sends
 * "2026-10-05T13:37:03") is UTC, so "Z" is appended before parsing.
 * Throws when missing or unparseable.
 */
export function parseUtc(value: unknown): Date {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`invalid timestamp: ${JSON.stringify(value)}`);
  }
  const text = value.trim();
  const date = new Date(HAS_UTC_OFFSET.test(text) ? text : `${text}Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid timestamp: ${JSON.stringify(value)}`);
  }
  return date;
}

export function isTooOld(spotTime: Date, now: Date, maxAgeMs: number): boolean {
  return now.getTime() - spotTime.getTime() > maxAgeMs;
}

import type { RecentSpot } from "../lib/api";

export function spotReference(s: RecentSpot): string {
  return s.pota_reference ?? s.sota_summit_ref ?? s.wwff_reference ?? s.wwbota_references?.[0] ?? s.iota_reference ?? "";
}

/** The spot's frequency to one decimal of a kHz; null for a spot without one (APRS-IS). */
export function spotKhz(s: Pick<RecentSpot, "frequency_khz">): string | null {
  return s.frequency_khz === null ? null : Number(s.frequency_khz).toFixed(1);
}

/** "14062.0 kHz CW", or only what the spot has: an APRS-IS spot has neither, so it is blank. */
export function spotTuning(s: Pick<RecentSpot, "frequency_khz" | "mode">): string {
  const khz = spotKhz(s);
  return [khz === null ? "" : `${khz} kHz`, (s.mode ?? "").toUpperCase()].filter(Boolean).join(" ");
}

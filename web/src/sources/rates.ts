// Rates for the Sources pages, from the stats snapshot's 168 hourly buckets
// (see useStats). Pure, so the maths is tested without a page.
import type { StatsPayload } from "../stats/types";
import type { StatsKey } from "./sources";

export type Hour = StatsPayload["hourly"][number];

export interface Rates {
  /** Spots per UTC hour, as the snapshot counts them. */
  series: number[];
  hours: string[];
  average: number;
  peak: number;
  peakHour: string;
  minimum: number;
  perDay: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Null when the snapshot predates the source's key (DX Cluster before
 * 20261014000200, WWFF before 20261015001000) or has no hours, so the page shows "no rates yet" rather than zeros.
 */
export function sourceRates(hourly: readonly Hour[], key: StatsKey): Rates | null {
  const first = hourly[0];
  if (first === undefined || typeof first[key] !== "number") return null;
  const points = hourly.map((h) => ({ hour: h.hour, count: Number(h[key] ?? 0) }));
  const series = points.map((p) => p.count);
  // Strictly greater, so the earliest hour wins a tie.
  const top = points.reduce((best, p) => (p.count > best.count ? p : best));
  const total = points.reduce((sum, p) => sum + p.count, 0);
  return {
    series,
    hours: points.map((p) => p.hour),
    average: total / series.length,
    peak: top.count,
    peakHour: top.hour,
    minimum: Math.min(...series),
    perDay: total / 7,
  };
}

export function formatRate(n: number): string {
  const r = Math.round(n * 10) / 10;
  return r < 10 ? r.toFixed(1) : Math.round(r).toLocaleString("en-US");
}

/** Every source is per hour, the snapshot's bucket size, high volume or not. */
export const RATE_UNIT = "spots/hour";
export const RATE_UNIT_SHORT = "/ hour";

/** "Oct 12, 14:00 UTC": snapshot buckets are UTC hours, so the label is always UTC. */
export function formatHour(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${String(d.getUTCHours()).padStart(2, "0")}:00 UTC`;
}

/** Two significant figures below a million ("4,600"), then "1.5 million". */
export function formatPerDay(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} million`;
  return Number(n.toPrecision(2)).toLocaleString("en-US");
}

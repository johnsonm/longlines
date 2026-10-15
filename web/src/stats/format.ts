// Pure presentation helpers for the Stats page. Everything here is testable
// in node: no React, no supabase-js.

import type { AprsPacketType, CountrySpots, LatestStats } from "./types";

export const fmt = (n: number): string => n.toLocaleString("en-US");

/** Axis labels for counts that span thousands to millions: 950, 12k, 1.5M. */
export function compact(n: number): string {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
  return String(n);
}

export const hourLabel = (hour: number): string => `${String(hour).padStart(2, "0")}:00`;

const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });
const TIME = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });
const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** "Tue" for a YYYY-MM-DD UTC day. */
export function weekday(day: string): string {
  return WEEKDAY.format(new Date(`${day}T00:00:00Z`));
}

/** "Tue 9/29" for a YYYY-MM-DD UTC day. */
export function dayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return `${weekday(day)} ${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/** "Tue 10/6 14:00" for an hour of the hourly series, an ISO UTC instant. */
export function slotLabel(hour: Date | string): string {
  const d = typeof hour === "string" ? new Date(hour) : hour;
  return `${dayLabel(d.toISOString().slice(0, 10))} ${hourLabel(d.getUTCHours())}`;
}

/**
 * The UTC midnights of the hourly series, for the day ticks. The series ends
 * at the last complete hour, so it rarely starts at midnight. On phones every
 * other one, counting back from the newest so the latest day stays labelled.
 */
export function midnightTicks(hours: Date[], everyOther: boolean): Date[] {
  const midnights = hours.filter((d) => d.getUTCHours() === 0);
  return everyOther ? midnights.filter((_, i) => (midnights.length - 1 - i) % 2 === 0) : midnights;
}

/** The caption under the page title; copy from docs/ui-mock.html. */
export function updatedCaption(generatedAt: string): string {
  const d = new Date(generatedAt);
  return `All times UTC. Updated hourly, last at ${TIME.format(d)} UTC ${DATE.format(d)}.`;
}

/** The empty state shows when there is no snapshot or it counted no spots. */
export function hasData(stats: LatestStats | null): stats is LatestStats {
  return stats !== null && stats.payload.totals.spots > 0;
}

/** Busiest states: spots desc, ties by code so the list is stable. potaByState is zero-filled, so idle states are dropped. */
export function topStates(byState: Record<string, number>, limit = 10): { code: string; spots: number }[] {
  return Object.entries(byState)
    .map(([code, spots]) => ({ code, spots }))
    .filter((s) => s.spots > 0)
    .sort((a, b) => b.spots - a.spots || a.code.localeCompare(b.code))
    .slice(0, limit);
}

/**
 * Choropleth alpha: 0.12 for the lightest active state up to 1 for the busiest.
 * 0 means "use the neutral hover color"; it also covers a week with no US POTA
 * activity (max 0) so the map never divides by zero.
 */
export function fillOpacity(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return 0.12 + 0.88 * (value / max);
}

/**
 * fillOpacity on a log scale, for the world map: a week's country totals run
 * from one spot to millions (RBN hears the US most of all), so a linear scale
 * would leave every country but a handful at the palest shade.
 */
export function logFillOpacity(value: number, max: number): number {
  return fillOpacity(Math.log1p(Math.max(0, value)), Math.log1p(Math.max(0, max)));
}

/** A country's spots from every source. A snapshot written before 20261015001000 has no wwff. */
export const countryTotal = (c: CountrySpots): number => c.pota + c.sota + (c.wwff ?? 0) + c.dx + c.rbn;

/** Per-source detail for a country, in the order of the Spots processed figure. */
export function countryDetail(c: CountrySpots): string {
  return `${fmt(c.rbn)} RBN, ${fmt(c.dx)} DX Cluster, ${fmt(c.pota)} POTA, ${fmt(c.sota)} SOTA, ${fmt(c.wwff ?? 0)} WWFF`;
}

const APRS_TYPE_LABELS: Record<AprsPacketType, string> = {
  position: "Position", mic_e: "Mic-E", object: "Object", item: "Item", message: "Message",
  status: "Status", weather: "Weather", telemetry: "Telemetry", nmea: "NMEA", third_party: "Third party",
  capabilities: "Capabilities", query: "Query", user_defined: "User defined", other: "Other",
};

/** Packet type as the Stats page names it; a type added in SQL first shows as sent. */
export const aprsTypeLabel = (type: AprsPacketType): string => APRS_TYPE_LABELS[type] ?? type;

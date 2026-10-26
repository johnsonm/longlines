// Words for the group statistics pages (canvas page 10). Copy comes from the
// Copy section of docs/superpowers/specs/2026-10-19-group-statistics-design.md.
// SQL decides every number; nothing here counts, ranks or filters callsigns.

import { plural } from "../../profile/format";
import type { GroupPeriod, GroupStatistics, ModeBucket } from "./types";

export const PERIODS: { value: GroupPeriod; label: string }[] = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];

/** ?period=7d picks the shorter period; anything else is 30 days. */
export function parsePeriod(value: string | null): GroupPeriod {
  return value === "7d" ? "7d" : "30d";
}

export function periodDays(period: GroupPeriod): number {
  return period === "7d" ? 7 : 30;
}

/** The Spots heard card's line: "12% more than the previous 30 days". */
export function comparisonLine(spots: number, previous: number, period: GroupPeriod): string {
  const span = `the previous ${periodDays(period)} days`;
  if (previous === 0) return `None in ${span}`;
  const change = Math.round(((spots - previous) / previous) * 100);
  if (change > 0) return `${change}% more than ${span}`;
  if (change < 0) return `${-change}% fewer than ${span}`;
  return `Same as ${span}`;
}

/** "26 POTA, 5 SOTA", plus ", 2 WWFF" and ", 1 WWBOTA" when there are any. */
export function activationsLine(a: GroupStatistics["kpis"]["activations"]): string {
  const wwbota = a.wwbota ?? 0;
  return `${a.pota} POTA, ${a.sota} SOTA${a.wwff > 0 ? `, ${a.wwff} WWFF` : ""}${wwbota > 0 ? `, ${wwbota} WWBOTA` : ""}`;
}

export function totalActivations(a: GroupStatistics["kpis"]["activations"]): number {
  return a.pota + a.sota + a.wwff + (a.wwbota ?? 0);
}

/** "19 parks, 3 summits", plus ", 2 bunkers" when there are any. */
export function placesLine(p: GroupStatistics["kpis"]["places"]): string {
  const bunkers = p.bunkers ?? 0;
  return `${plural(p.parks, "park", "parks")}, ${plural(p.summits, "summit", "summits")}${
    bunkers > 0 ? `, ${plural(bunkers, "bunker", "bunkers")}` : ""
  }`;
}

export function totalPlaces(p: GroupStatistics["kpis"]["places"]): number {
  return p.parks + p.summits + (p.bunkers ?? 0);
}

/** The members table's last heard: "2 min ago", "3 hours ago", "9 days ago". */
export function heardAgo(iso: string | null, now: Date): string {
  if (iso === null) return "Not heard yet";
  const minutes = Math.floor((now.getTime() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${plural(Math.floor(minutes / 60), "hour", "hours")} ago`;
  return `${plural(Math.floor(minutes / 1440), "day", "days")} ago`;
}

/** "12 minutes ago", for "Updated 12 minutes ago." */
export function updatedAgo(iso: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${plural(minutes, "minute", "minutes")} ago`;
  return `${plural(Math.floor(minutes / 60), "hour", "hours")} ago`;
}

/** The club heat map's levels: none, 1 to 99, 100 to 199, 200 to 399, 400 or more. */
export const GROUP_HEAT_LEVELS = 4;
export function groupHeatLevel(spots: number): number {
  if (spots <= 0) return 0;
  if (spots < 100) return 1;
  if (spots < 200) return 2;
  if (spots < 400) return 3;
  return 4;
}

const MODE_LABELS: Record<ModeBucket, string> = { CW: "CW", SSB: "SSB", "FT8/FT4": "FT8 and FT4", FM: "FM", Other: "Other" };

export function modeLabel(bucket: ModeBucket | null): string {
  return bucket === null ? "—" : MODE_LABELS[bucket];
}

/** A card's on-air line: "3 on the air now: W4ABC, KK4PWJ, N4GHI", newest first. */
export function onAirLine(calls: string[]): string {
  if (calls.length === 0) return "Nobody on the air right now";
  const shown = calls.slice(0, 3).join(", ");
  const more = calls.length > 3 ? ` and ${calls.length - 3} more` : "";
  return `${calls.length} on the air now: ${shown}${more}`;
}

/** "24 members · used by 2 connections", "8 members · not used by any connection". */
export function groupMeta(members: number, subscriptions: number): string {
  const used = subscriptions === 0
    ? "not used by any connection"
    : `used by ${plural(subscriptions, "connection", "connections")}`;
  return `${plural(members, "member", "members")} · ${used}`;
}

/** The public link as a full URL, from the page's own origin. */
export function publicUrl(origin: string, slug: string): string {
  return `${origin}/g/${slug}`;
}

/** The link as shown on the Settings tab: "longlines.io/g/7f3kq9xm2a". */
export function linkLabel(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

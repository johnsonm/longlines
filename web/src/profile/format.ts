// Pure presentation helpers for the lookup and profile pages. Everything here
// is testable in node: no React, no supabase-js. Copy comes from the "Copy"
// section of docs/superpowers/specs/2026-10-12-callsign-lookup-design.md.

import type { RecentSpot } from "../lib/api";
import { normalizeCallsign } from "../lib/callsign";
import { formatDate } from "../lib/time";
import { sourceName } from "../sources/sources";
import { fmt } from "../stats/format";
import { stateName } from "../stats/stateShapes";
import type { CallsignProfile, HeardProfile, ProfileSpot } from "./types";

const TIME = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });
const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const MONTH_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const MONTH = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

/** "1 park", "3 parks". */
export function plural(n: number, one: string, many: string): string {
  return `${fmt(n)} ${n === 1 ? one : many}`;
}

/**
 * The profile path for a callsign as typed, uppercased: "/call/KK4PWJ/P".
 * The profile page swaps it for the base call SQL returns; TypeScript never
 * works out the base call itself. Null for blank input, and for a `.` or `..`
 * segment, which the router would resolve to another page ("../STATS").
 */
export function lookupPath(input: string): string | null {
  const call = normalizeCallsign(input);
  if (!call) return null;
  const segments = call.split("/");
  if (segments.some((s) => s === "." || s === "..")) return null;
  return `/call/${segments.map(encodeURIComponent).join("/")}`;
}

/** What the search boxes say when lookupPath refuses non-blank input; the callsign-profile function's 400 message. */
export const INVALID_CALLSIGN = "Enter a callsign, like KK4PWJ.";

/** The canonical, shareable link of a profile. */
export function profileUrl(origin: string, callsign: string): string {
  return `${origin}/call/${callsign}`;
}

/** "Oct 5, 2026" for a YYYY-MM-DD day; the account page's format. */
export function dateLabel(day: string): string {
  return formatDate(`${day}T00:00:00Z`);
}

/** "Oct 2026" for a YYYY-MM month. */
export function monthLabel(month: string): string {
  return MONTH.format(new Date(`${month}-01T00:00:00Z`));
}

/** "10/5" for a YYYY-MM-DD day: the 30-day chart's axis. */
export function shortDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/** A spot this recent puts the "On the air now" chip in the header; the same window as Groups. */
const ON_AIR_MS = 30 * 60 * 1000;

export function onAirNow(time: string, now: Date): boolean {
  return now.getTime() - new Date(time).getTime() <= ON_AIR_MS;
}

/** "14062.0 kHz". */
export function frequencyLabel(khz: number): string {
  return `${khz.toFixed(1)} kHz`;
}

/** "2 min ago (14:30 UTC)", "3 h ago (11:30 UTC)"; the date instead past a day: "Oct 5 (09:05 UTC)". */
export function lastHeardWhen(time: string, now: Date): string {
  const at = new Date(time);
  const minutes = Math.max(0, Math.floor((now.getTime() - at.getTime()) / 60000));
  const ago = minutes < 1
    ? "just now"
    : minutes < 60
    ? `${minutes} min ago`
    : minutes < 1440
    ? `${Math.floor(minutes / 60)} h ago`
    : at.getUTCFullYear() === now.getUTCFullYear()
    ? MONTH_DAY.format(at)
    : DATE.format(at);
  return `${ago} (${TIME.format(at)} UTC)`;
}

/**
 * The recent spot behind lastHeard, for its band, source, reference and
 * spotter. Null when lastHeard is older than the recent spots (7 days).
 */
export function lastHeardSpot(heard: HeardProfile): ProfileSpot | null {
  const last = heard.lastHeard;
  if (!last) return null;
  return heard.recentSpots.find((s) => s.time === last.time && s.frequencyKhz === last.frequencyKhz) ?? null;
}

/** "Activating US-2763, Falls Lake SRA. Spotted by K3XYZ."; either sentence alone, or "". */
export function lastHeardDetail(spot: ProfileSpot, heard: HeardProfile): string {
  const parts: string[] = [];
  if (spot.reference) {
    const name = heard.references.find((r) => r.reference === spot.reference)?.name;
    parts.push(`Activating ${spot.reference}${name ? `, ${name}` : ""}.`);
  }
  if (spot.spotter) parts.push(`Spotted by ${spot.spotter}.`);
  return parts.join(" ");
}

/** QRZ's page for a call. QRZ may not have one; the link goes there anyway. */
export function qrzUrl(callsign: string): string {
  return `https://www.qrz.com/db/${encodeURIComponent(callsign)}`;
}

/** The header's place chip: the licensed state, else the country of the prefix. */
export function placeLabel(profile: Pick<CallsignProfile, "license" | "country">): string | null {
  if (profile.license?.state) return stateName(profile.license.state);
  return profile.country?.name ?? null;
}

/** The License card's text when there is no record; "outside the United States" only for a non-US prefix. */
export function noLicenseMessage(usPrefix: boolean): string {
  return usPrefix
    ? "No FCC record found for this callsign."
    : "No FCC record. This looks like a callsign issued outside the United States.";
}

const PROGRAM_NOUNS: Record<string, [string, string]> = {
  POTA: ["park", "parks"],
  SOTA: ["summit", "summits"],
  WWBOTA: ["bunker", "bunkers"],
};

/**
 * The "Park/summit/WWFF visits" KPI's detail: "3 parks, 2 summits, 1 WWFF reference", then "2 bunkers"
 * only when there are any. Programs without a noun read "N <program> references".
 */
export function activationsDetail(activations: HeardProfile["activations"]): string {
  const counts = new Map<string, number>([["POTA", 0], ["SOTA", 0], ["WWFF", 0]]);
  for (const a of activations) counts.set(a.program, a.references);
  return [...counts]
    .map(([program, n]) => {
      const [one, many] = PROGRAM_NOUNS[program] ?? [`${program} reference`, `${program} references`];
      return plural(n, one, many);
    })
    .join(", ");
}

export function totalActivations(activations: HeardProfile["activations"]): number {
  return activations.reduce((sum, a) => sum + a.activations, 0);
}

/** activationsByLocation keeps only US states, keyed the way UsStateMap expects ("US-NC" -> "NC"). */
export function usStates(byLocation: Record<string, number>): Record<string, number> {
  const states: Record<string, number> = {};
  for (const [location, n] of Object.entries(byLocation)) {
    const match = /^US-([A-Z]{2})$/.exec(location);
    if (match) states[match[1]!] = n;
  }
  return states;
}

/** "120 POTA, 4 SOTA". */
export function sourcesDetail(sources: { source: string; spots: number }[]): string {
  return sources.map((s) => `${fmt(s.spots)} ${sourceName(s.source)}`).join(", ");
}

/** One stacked series per source, in the order given, from rows that split their spots by source. */
export function sourceSeries(
  rows: { sources: Record<string, number> }[],
  sources: string[],
): { source: string; data: number[] }[] {
  return sources.map((source) => ({ source, data: rows.map((r) => r.sources[source] ?? 0) }));
}

/** "Also heard as": the spotted forms other than the base call itself. */
export function otherForms(heard: HeardProfile, callsign: string, limit = 5): string[] {
  return heard.variants.map((v) => v.callsign).filter((c) => c !== callsign).slice(0, limit);
}

/**
 * Profile spots in the row shape of the Sources page's SpotsTable, so the
 * profile reuses that table. Profiles carry one reference column whichever
 * program it belongs to; the table only displays it, so it rides in
 * pota_reference.
 */
export function spotRows(spots: ProfileSpot[]): RecentSpot[] {
  return spots.map((s) => ({
    id: null,
    spot_time: s.time,
    callsign: s.callsign,
    frequency_khz: s.frequencyKhz,
    band: s.band,
    mode: s.mode,
    mode_family: null,
    pota_reference: s.reference,
    pota_park_name: null,
    pota_location: null,
    sota_summit_ref: null,
    wwff_reference: null,
    wwff_reference_name: null,
    wwbota_references: null,
    wwbota_reference_name: null,
    source: s.source,
    spotter: s.spotter,
    comment: null,
  }));
}

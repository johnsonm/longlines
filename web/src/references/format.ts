// Pure presentation helpers for the reference page: testable in node, no React,
// no supabase-js. Copy comes from the "Copy" section of
// docs/superpowers/specs/2026-10-26-reference-profiles-design.md. SQL decides
// every figure, list and ranking; this only words them.

import { sourceInfo } from "../bandmap/model";
import { dateLabel, frequencyLabel, plural } from "../profile/format";
import { fmt } from "../stats/format";
import { referenceProgram } from "./paths";
import type { ReferenceActivation, ReferenceCalendarPeriod, ReferenceCatalog, ReferenceProfile, ReferenceProgram, ReferenceSpot } from "./types";

export interface ProgramInfo {
  /** {PROGRAM}: "POTA". */
  short: string;
  /** The About card's Program row. */
  name: string;
  /** {kind}: the place word. */
  kind: string;
  /** Where the details come from: "the POTA park list". */
  list: string;
  /** The program chip, in the band map's colors (WWFF, which the band map leaves out, is the spec's success). */
  color: "primary" | "secondary" | "success";
}

export const PROGRAMS: Record<ReferenceProgram, ProgramInfo> = {
  pota: { short: "POTA", name: "Parks on the Air", kind: "park", list: "the POTA park list", color: sourceInfo("pota").color },
  sota: { short: "SOTA", name: "Summits on the Air", kind: "summit", list: "the SOTA summit list", color: sourceInfo("sotawatch").color },
  wwff: { short: "WWFF", name: "World Wide Flora and Fauna", kind: "reference", list: "the WWFF directory", color: "success" },
};

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const LIST = new Intl.ListFormat("en-US", { style: "long", type: "conjunction" });
const MONTH_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const TIME = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });

/** A catalog row the program no longer lists as active. */
export function isRetired(catalog: ReferenceCatalog | null): boolean {
  return catalog !== null && !catalog.active;
}

/** "W4C · NC-Central Mountains", or whichever half there is. */
function associationRegion(catalog: ReferenceCatalog): string | null {
  const parts = [catalog.association, catalog.region].filter((p): p is string => !!p);
  return parts.length ? parts.join(" · ") : null;
}

/** "US-NC, US-VA" for a park in two states. */
function locations(location: string): string {
  return location.split(",").map((l) => l.trim()).filter(Boolean).join(", ");
}

/** "2,037 m". */
const altitude = (m: number) => `${fmt(m)} m`;

export interface HeaderChip {
  label: string;
  outlined: boolean;
}

/**
 * The header's chips, in the Copy's order. POTA: location, grid, Active. SOTA: association and region,
 * altitude, points, grid. WWFF: country, region, grid. A retired reference starts with an outlined
 * Retired chip and drops Active; one outside the list has only the outlined "Not in the list" chip.
 */
export function headerChips(profile: Pick<ReferenceProfile, "program" | "catalog">): HeaderChip[] {
  const { catalog } = profile;
  if (!catalog) return [{ label: `Not in the ${PROGRAMS[profile.program].short} list`, outlined: true }];
  const retired = !catalog.active;
  const labels: (string | null)[] = profile.program === "pota"
    ? [catalog.location && locations(catalog.location), catalog.grid, retired ? null : "Active"]
    : profile.program === "sota"
    ? [
      associationRegion(catalog),
      catalog.altitudeM === null ? null : altitude(catalog.altitudeM),
      catalog.points === null ? null : plural(catalog.points, "point", "points"),
      catalog.grid,
    ]
    : [catalog.country, catalog.region, catalog.grid];
  const chips = labels.filter((l): l is string => !!l).map((label) => ({ label, outlined: false }));
  return retired ? [{ label: "Retired", outlined: true }, ...chips] : chips;
}

/** "35.7650, -82.2652". */
export function coordinates(latitude: number, longitude: number): string {
  return `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
}

/** The About card's rows, in the Copy's order; rows without a value are left out. */
export function aboutRows(program: ReferenceProgram, catalog: ReferenceCatalog): [string, string][] {
  const retired = !catalog.active;
  const rows: [string, string | null][] = [
    ["Name", catalog.name],
    ["Program", PROGRAMS[program].name],
    ["Location", program === "pota" && catalog.location ? locations(catalog.location) : null],
    ["Region", program === "pota" ? null : catalog.region],
    ["Country", program === "wwff" ? catalog.country : null],
    ["Altitude", program === "sota" && catalog.altitudeM !== null ? altitude(catalog.altitudeM) : null],
    ["Points", program === "sota" && catalog.points !== null ? fmt(catalog.points) : null],
    ["Grid", catalog.grid],
    ["Coordinates", catalog.latitude !== null && catalog.longitude !== null ? coordinates(catalog.latitude, catalog.longitude) : null],
    ["Status", retired ? "Retired" : "Active"],
    ["Valid until", retired && catalog.validTo ? dateLabel(catalog.validTo) : null],
  ];
  return rows.filter((r): r is [string, string] => r[1] !== null && r[1] !== "");
}

/** "About this park". */
export function aboutTitle(program: ReferenceProgram): string {
  return `About this ${PROGRAMS[program].kind}`;
}

/** "From the POTA park list. Refreshed weekly." */
export function aboutSubheader(program: ReferenceProgram): string {
  return `From ${PROGRAMS[program].list}. Refreshed weekly.`;
}

/** The retired alert, with the program's date when it gives one. */
export function retiredMessage(program: ReferenceProgram, catalog: ReferenceCatalog): string {
  const { short, kind } = PROGRAMS[program];
  const first = catalog.validTo
    ? `This ${kind} was retired from the ${short} list on ${dateLabel(catalog.validTo)}.`
    : `This ${kind} is retired in the ${short} list.`;
  return `${first} Activations of it no longer count for ${short}.`;
}

/** The warning for a reference that was spotted but is not in the program's list. */
export function notInListMessage(program: ReferenceProgram, reference: string): string {
  const { kind, list } = PROGRAMS[program];
  return `${reference} isn't in ${list}. Long Lines shows it because activators were spotted here. It may be a new ${kind}, or a typo in the spots.`;
}

/** The Not found warning; a program without pages has no place word. */
export function notFoundMessage(program: string, reference: string): string {
  const p = referenceProgram(program);
  if (!p) return `Long Lines has no reference ${reference}.`;
  const { short, kind } = PROGRAMS[p];
  return `Long Lines has no ${short} ${kind} ${reference}. Check the reference, like US-2763 or W4C/CM-001.`;
}

/** The page's closing note; the last sentence only for a reference in the list. */
export function footerText(profile: Pick<ReferenceProfile, "program" | "reference" | "catalog">): string {
  const { short, kind, list } = PROGRAMS[profile.program];
  const text = `An activation here means an activator was spotted at ${profile.reference} on that UTC day. `
    + `Long Lines sees spots, not logs, so these counts aren't ${short}'s own.`;
  return profile.catalog ? `${text} ${capitalize(kind)} details come from ${list}.` : text;
}

/** "Never activated": the card that stands in for the figures. */
export function neverActivatedMessage(reference: string): string {
  return `Long Lines hasn't heard an activation at ${reference} yet.`;
}

/** Is an ISO time on the same UTC day as now? */
export function isToday(time: string, now: Date): boolean {
  return time.slice(0, 10) === now.toISOString().slice(0, 10);
}

/** "Spotted 18 times today, on 20m and 40m."; "once" for one spot. */
export function todayLine(today: { spots: number; bands: string[] }): string {
  const times = today.spots === 1 ? "once" : `${fmt(today.spots)} times`;
  return today.bands.length ? `Spotted ${times} today, on ${LIST.format(today.bands)}.` : `Spotted ${times} today.`;
}

/** "Oct 26" this year, "Oct 26, 2025" before it: the phone rows' day. */
export function shortDay(day: string, now: Date): string {
  return day.slice(0, 4) === String(now.getUTCFullYear()) ? MONTH_DAY.format(new Date(`${day}T00:00:00Z`)) : dateLabel(day);
}

/** "Oct 26 18:51": the Recent spots table's Time (UTC). */
export function spotTime(time: string): string {
  const at = new Date(time);
  return `${MONTH_DAY.format(at)} ${TIME.format(at)}`;
}

/** "18:51" today, else the day: a phone spot row's right side. */
export function phoneSpotTime(time: string, now: Date): string {
  return isToday(time, now) ? TIME.format(new Date(time)) : shortDay(time.slice(0, 10), now);
}

/** Modes as the tables show them: "CW, SSB". */
export function modesLabel(modes: string[]): string {
  return [...new Set(modes.map((m) => m.toUpperCase()))].join(", ");
}

/** Did the activator spot itself? */
export function selfSpot(spot: Pick<ReferenceSpot, "spotter" | "callsign" | "base">): boolean {
  const spotter = spot.spotter.toUpperCase();
  return spotter === spot.callsign.toUpperCase() || spotter === spot.base;
}

/** A phone spot row's second line: "14062.0 kHz · CW · by KX4FBS", or "… · self-spot". */
export function spotDetail(spot: ReferenceSpot): string {
  const parts = [
    spot.frequencyKhz === null ? null : frequencyLabel(spot.frequencyKhz),
    spot.mode ? spot.mode.toUpperCase() : null,
    selfSpot(spot) ? "self-spot" : `by ${spot.spotter}`,
  ];
  return parts.filter((p): p is string => p !== null).join(" · ");
}

/** A phone activation row's second line: "20m, 40m · CW · 18 spots". */
export function activationDetail(activation: ReferenceActivation): string {
  const parts = [activation.bands.join(", "), modesLabel(activation.modes), plural(activation.spots, "spot", "spots")];
  return parts.filter(Boolean).join(" · ");
}

/** A phone top-activator row's right side: "22 · Oct 26". */
export function topActivatorDetail(activations: number, lastDay: string, now: Date): string {
  return `${fmt(activations)} · ${shortDay(lastDay, now)}`;
}

/** The heat map's Period menu: "Past 365 days", "2026". */
export function periodLabel(period: Pick<ReferenceCalendarPeriod, "period">): string {
  return period.period === "past" ? "Past 365 days" : period.period;
}

/** "Activations in the past year", "Activations in 2025". */
export function periodTitle(period: Pick<ReferenceCalendarPeriod, "period">): string {
  return period.period === "past" ? "Activations in the past year" : `Activations in ${period.period}`;
}

/** The heat map grid's accessible name. */
export function gridLabel(period: Pick<ReferenceCalendarPeriod, "period">): string {
  const span = period.period === "past" ? "for the past 365 days" : `in ${period.period}`;
  return `Heat map of activations per day ${span}. A table view has the same numbers.`;
}

/** A heat map day's first line: "3 activators", "No activations". */
export function cellActivators(n: number): string {
  return n === 0 ? "No activations" : plural(n, "activator", "activators");
}

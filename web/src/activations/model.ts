// Pure wording for the Spotted activations tab and the activation page. Every figure comes from
// SQL (callsign_spotted_activations, spotted_activation); these functions only put words around
// them. Times and days are UTC, as the payload gives them, and are read from the ISO strings
// directly, so the reader's time zone never moves a day.

import { fmt } from "../stats/format";
import type {
  ActivationCard, ActivationFarthest, ActivationPlace, ActivationProgram, ActivationReferenceCounts, ActivationSources, ActivationSpot,
  MostActivated, SpottedActivation,
} from "./types";

/**
 * activation_gap() in SQL, in minutes: the longest quiet inside an activation. The estimate note
 * names it; change the two together.
 */
export const ACTIVATION_GAP_MINUTES = 45;

/** How many activations the Recent card shows before "Show all N". */
export const RECENT_SHOWN = 10;
/** How many spots the Spots card shows before "Show all N spots". */
export const SPOTS_SHOWN = 6;

export const ESTIMATE_ALERT =
  "Estimated from spots, not logs. Long Lines doesn't see contacts, so it can't tell whether an activation met the program's minimum.";
export const SINGLE_SPOT_NOTE = "Only spotted once. It may have ended early or just not been re-spotted.";
export const CONTACTS_UNKNOWN = "Not known. Long Lines only sees spots.";
export const LOCATION_UNKNOWN = "Location not known for this reference.";
export const NOT_FOUND = "Spotted activation not found.";
export const EMPTY = "–";

/** A program as the page names it: "POTA". */
export const PROGRAM_LABELS: Record<ActivationProgram, string> = {
  pota: "POTA", sota: "SOTA", wwff: "WWFF", wwbota: "WWBOTA", iota: "IOTA",
};

// What one reference of each program is called, singular and plural: the References card's caption.
const REFERENCE_WORDS: Record<ActivationProgram, [string, string]> = {
  pota: ["park", "parks"],
  sota: ["summit", "summits"],
  wwff: ["WWFF reference", "WWFF references"],
  wwbota: ["bunker", "bunkers"],
  iota: ["island", "islands"],
};

// The day note's word ("3 parks in one day"); WWFF says only "references" there.
const DAY_WORDS: Record<ActivationProgram, string> = {
  pota: "parks", sota: "summits", wwff: "references", wwbota: "bunkers", iota: "islands",
};

/** Sources in the order the page lists them: the reference sources, then RBN and DX cluster. */
export const SOURCE_ORDER = ["pota", "sotawatch", "wwff", "wwbota", "rbn", "dxcluster"] as const;

const SOURCE_LABELS: Record<string, string> = {
  pota: "POTA", sotawatch: "SOTAwatch", wwff: "WWFF", wwbota: "WWBOTA", rbn: "RBN", dxcluster: "DX cluster",
};

/** A spot source as the page names it ("DX cluster"); an unknown id as given. */
export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayParts(day: string): { weekday: string; date: number; month: string; year: number } {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
  return { weekday: WEEKDAYS[weekday] ?? "", date, month: MONTHS[month - 1] ?? "", year };
}

/** "Thu 29 Oct 2026" for a YYYY-MM-DD day. */
export function dayHeading(day: string): string {
  const p = dayParts(day);
  return `${p.weekday} ${p.date} ${p.month} ${p.year}`;
}

/** "Mon 13 Oct" for a YYYY-MM-DD day. */
export function shortDay(day: string): string {
  const p = dayParts(day);
  return `${p.weekday} ${p.date} ${p.month}`;
}

/** The UTC day before a YYYY-MM-DD day, as YYYY-MM-DD. */
export function previousDay(day: string): string {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date - 1)).toISOString().slice(0, 10);
}

/** "18:12" from an ISO UTC time. */
export function utcTime(iso: string): string {
  return iso.slice(11, 16);
}

/** "18:12–19:40", or one time ("16:20") when the first and last spot share a minute. */
export function timeWindow(a: { startedAt: string; lastSpotAt: string }): string {
  const from = utcTime(a.startedAt);
  const to = utcTime(a.lastSpotAt);
  return from === to ? from : `${from}–${to}`;
}

/** "1 h 28 min", "2 h" or "47 min"; null for no time at all (a single spot). */
export function duration(seconds: number): string | null {
  if (seconds <= 0) return null;
  const minutes = Math.max(1, Math.round(seconds / 60));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** The Time on air card's figure: whole hours ("31 h"), or minutes under an hour ("47 min"). */
export function onAirLabel(seconds: number): string {
  if (seconds > 0 && seconds < 3600) return duration(seconds) ?? "0 h";
  return `${fmt(Math.round(seconds / 3600))} h`;
}

/** "US-2730 · US-4560". */
export function referencesLabel(references: string[]): string {
  return references.join(" · ");
}

/** The names the feed or the list gave, in reference order: "Eno River State Park · Mountains-to-Sea State Trail". */
export function namesLabel(names: (string | null)[]): string {
  return names.filter((n): n is string => !!n).join(" · ");
}

/** A Recent row's names line; programs other than POTA say which they are ("Mount Mitchell · SOTA"). */
export function cardNames(card: Pick<ActivationCard, "program" | "referenceNames">): string {
  const names = namesLabel(card.referenceNames);
  if (card.program === "pota") return names;
  return names ? `${names} · ${PROGRAM_LABELS[card.program]}` : PROGRAM_LABELS[card.program];
}

/** "20m · 40m". */
export function bandsLabel(bands: string[]): string {
  return bands.join(" · ");
}

/** A mode as shown: upper case, USB and LSB as SSB. */
export function modeLabel(mode: string): string {
  const upper = mode.toUpperCase();
  return upper === "USB" || upper === "LSB" ? "SSB" : upper;
}

/** "SSB · CW": each mode once, in SQL's order (most spots first). */
export function modesLabel(modes: string[]): string {
  return [...new Set(modes.map(modeLabel))].join(" · ");
}

/** "Bands · modes" on a phone: "20m · 40m · SSB · CW". */
export function bandsModesLabel(bands: string[], modes: string[]): string {
  return [bandsLabel(bands), modesLabel(modes)].filter((s) => s).join(" · ");
}

/** "14 states · 2 countries" (a phone row joins with ", "); null when heard nowhere known. */
export function heardIn(states: number, countries: number, separator = " · "): string | null {
  const parts: string[] = [];
  if (states > 0) parts.push(`${fmt(states)} ${states === 1 ? "state" : "states"}`);
  if (countries > 0) parts.push(`${fmt(countries)} ${countries === 1 ? "country" : "countries"}`);
  return parts.length ? parts.join(separator) : null;
}

/** "Canada and Germany", "Canada, Germany and Japan". */
function andList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`;
}

// The map caption names this many countries, then counts the rest.
const COUNTRIES_NAMED = 3;

/** The map's caption: "Heard in 14 states, plus Canada and Germany." */
export function heardSentence(heard: ActivationPlace[]): string {
  const states = heard.filter((p) => p.kind === "state").length;
  const countries = heard.filter((p) => p.kind === "country").map((p) => p.name ?? p.code);
  const named = countries.length > COUNTRIES_NAMED
    ? [...countries.slice(0, COUNTRIES_NAMED), `${fmt(countries.length - COUNTRIES_NAMED)} more ${countries.length - COUNTRIES_NAMED === 1 ? "country" : "countries"}`]
    : countries;
  const stateText = `${fmt(states)} ${states === 1 ? "state" : "states"}`;
  if (states > 0 && countries.length > 0) return `Heard in ${stateText}, plus ${andList(named)}.`;
  if (states > 0) return `Heard in ${stateText}.`;
  if (countries.length > 0) return `Heard in ${andList(named)}.`;
  return "No spotter's place is known yet.";
}

/** "about 7,000 km": two significant figures. */
export function aboutKm(km: number): string {
  const rounded = km >= 10 ? Number(km.toPrecision(2)) : Math.round(km);
  return `about ${fmt(rounded)} km`;
}

/** "Germany · about 7,000 km". */
export function farthestLabel(f: ActivationFarthest): string {
  return `${f.name ?? f.code} · ${aboutKm(f.km)}`;
}

/** The chips beside a row's references or the page's heading. */
export function chips(a: { references: string[]; spotCount: number; continuedFrom: string | null; continuedBy: string | null }): string[] {
  const out: string[] = [];
  if (a.references.length > 1) out.push("Two-fer");
  if (a.spotCount === 1) out.push("1 spot");
  if (a.continuedFrom !== null || a.continuedBy !== null) out.push("Split at 00:00 UTC");
  return out;
}

/** "Continued from Mon 13 Oct.": a POTA split's later half; the earlier half is always the UTC day before. */
export function continuedFrom(day: string): string {
  return `Continued from ${shortDay(previousDay(day))}.`;
}

/** The UTC day after a YYYY-MM-DD day, as YYYY-MM-DD. */
export function nextDay(day: string): string {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);
}

/** "Continued on Tue 14 Oct.": a POTA split's earlier half links the later, always the UTC day after. */
export function continuedOn(day: string): string {
  return `Continued on ${shortDay(nextDay(day))}.`;
}

/** The desktop row's note for a split's later half. */
export function continuedNote(day: string): string {
  return `${continuedFrom(day)} POTA counts each UTC day as its own activation.`;
}

/** The note under a row's names: one spot, or the later half of a split; null for neither. */
export function cardNote(card: ActivationCard): string | null {
  if (card.spotCount === 1) return SINGLE_SPOT_NOTE;
  if (card.continuedFrom !== null) return continuedNote(card.day);
  return null;
}

/** A day of activations, the rows in the order they happened. */
export interface ActivationDay {
  day: string;
  cards: ActivationCard[];
}

/** Groups SQL's newest-first list by UTC day: days newest first, each day's rows oldest first. */
export function groupByDay(cards: ActivationCard[]): ActivationDay[] {
  const days: ActivationDay[] = [];
  for (const card of cards) {
    const last = days[days.length - 1];
    if (last && last.day === card.day) last.cards.push(card);
    else days.push({ day: card.day, cards: [card] });
  }
  for (const d of days) d.cards.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return days;
}

/** The day heading's note, "3 parks in one day"; null for a day of one activation. */
export function dayNote(cards: Pick<ActivationCard, "program">[]): string | null {
  if (cards.length < 2) return null;
  const programs = new Set(cards.map((c) => c.program));
  const [only] = programs;
  const word = programs.size === 1 && only ? DAY_WORDS[only] : "activations";
  return `${fmt(cards.length)} ${word} in one day`;
}

/** A phone row's time line: "18:12–19:40 · 1 h 28 min", or "16:20" for one spot. */
export function phoneWindow(card: ActivationCard): string {
  const d = duration(card.durationSeconds);
  return d ? `${timeWindow(card)} · ${d}` : timeWindow(card);
}

/** A phone row's detail line: "20m · 40m · SSB · CW · 31 spots · 14 states, 2 countries". */
export function phoneDetail(card: ActivationCard): string {
  const lead = bandsModesLabel(card.bands, card.modes);
  if (card.spotCount === 1) return [lead, SINGLE_SPOT_NOTE].filter((s) => s).join(" · ");
  const parts = [lead, `${fmt(card.spotCount)} spots`, heardIn(card.states, card.countries, ", ")].filter((s): s is string => !!s);
  const line = parts.join(" · ");
  return card.continuedFrom !== null ? `${line}. ${continuedFrom(card.day)}` : line;
}

/** The References card's caption: "14 parks · 4 summits". */
export function referencesCaption(counts: ActivationReferenceCounts): string {
  const programs: ActivationProgram[] = ["pota", "sota", "wwff", "wwbota", "iota"];
  return programs
    .filter((p) => counts[p] > 0)
    .map((p) => {
      const [one, many] = REFERENCE_WORDS[p];
      return `${fmt(counts[p])} ${counts[p] === 1 ? one : many}`;
    })
    .join(" · ");
}

/** The Most activated card's caption: "Eno River State Park · 9 times" ("9 times" on a phone). */
export function mostActivatedDetail(m: MostActivated, mobile: boolean): string {
  const times = `${fmt(m.times)} ${m.times === 1 ? "time" : "times"}`;
  return m.name && !mobile ? `${m.name} · ${times}` : times;
}

/** "Spotted activation · POTA". */
export function overline(program: ActivationProgram): string {
  return `Spotted activation · ${PROGRAM_LABELS[program]}`;
}

/** The page's heading: "KK4PWJ at US-2730 · US-4560". */
export function pageHeading(a: Pick<SpottedActivation, "callsign" | "references">): string {
  return `${a.callsign} at ${referencesLabel(a.references)}`;
}

/** The browser tab's title. */
export function documentTitle(a: Pick<SpottedActivation, "callsign" | "references">): string {
  return `${pageHeading(a)} · Spotted activation`;
}

/** "Thu 29 Oct 2026 · 18:12–19:40 UTC · 1 h 28 min". */
export function dateLine(a: SpottedActivation): string {
  const d = duration(a.durationSeconds);
  return [dayHeading(a.day), `${timeWindow(a)} UTC`, d].filter((s): s is string => !!s).join(" · ");
}

/** The Time on air row: "1 h 28 min · 18:12–19:40 UTC". */
export function timeOnAirRow(a: SpottedActivation): string {
  const d = duration(a.durationSeconds);
  return d ? `${d} · ${timeWindow(a)} UTC` : `${timeWindow(a)} UTC`;
}

/** The Spots row: "31 · POTA 8 · RBN 19 · DX cluster 4". */
export function spotsLine(spotCount: number, sources: ActivationSources): string {
  const parts = SOURCE_ORDER.flatMap((s) => {
    const n = sources[s];
    return n ? [`${sourceLabel(s)} ${fmt(n)}`] : [];
  });
  return [fmt(spotCount), ...parts].join(" · ");
}

/** The sources an activation's spots came from, in the page's order. */
export function sourcesPresent(spots: Pick<ActivationSpot, "source">[]): string[] {
  const present = new Set(spots.map((s) => s.source));
  const known: string[] = SOURCE_ORDER.filter((s) => present.has(s));
  return [...known, ...[...present].filter((s) => !known.includes(s)).sort()];
}

/** "14,285" kHz, or "14,239.1". */
export function khzLabel(khz: number): string {
  return khz.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

/** A spot's place in the Heard by column, "self-spot" for the activator's own. */
export function spotPlace(spot: Pick<ActivationSpot, "selfSpot" | "place">): string | null {
  return spot.selfSpot ? "self-spot" : spot.place;
}

/** A phone spot row's second line: "North Carolina · 14,285 kHz · SSB · US-2730". */
export function spotPhoneDetail(spot: ActivationSpot): string {
  return [
    spot.selfSpot ? null : spot.place,
    spot.frequencyKhz === null ? null : `${khzLabel(spot.frequencyKhz)} kHz`,
    spot.mode ? modeLabel(spot.mode) : null,
    spot.references ? referencesLabel(spot.references) : null,
  ].filter((s): s is string => !!s).join(" · ");
}

/** The "How this was estimated" note. */
export function estimateNote(a: Pick<SpottedActivation, "callsign" | "program" | "references">): string {
  const at = a.references.length > 1 ? "these references" : "this reference";
  return `Long Lines grouped ${a.callsign}'s spots at ${at} with no gap longer than ${ACTIVATION_GAP_MINUTES} minutes, `
    + "then added RBN and DX cluster spots from the same window. "
    + `Contacts aren't counted, so this can't confirm the activation met ${PROGRAM_LABELS[a.program]}'s minimum.`;
}

/** The tab's empty state. */
export function emptyMessage(callsign: string): string {
  return `Long Lines hasn't spotted an activation by ${callsign} yet.`;
}

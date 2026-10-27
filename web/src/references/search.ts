// Pure presentation helpers for the Reference lookup page (/ref): testable in
// node, no React, no supabase-js. Copy comes from the "Reference lookup (`/ref`)"
// part of the Copy section of docs/superpowers/specs/2026-10-26-reference-profiles-design.md.
// SQL decides what matches and the order (search_references); this only words it.

import { plural } from "../profile/format";
import { fmt } from "../stats/format";
import { shortDay } from "./format";
import type { ReferenceProgram, ReferenceSearchResult } from "./types";

/** The search_references bounds, which the reference-search function checks first. */
export const MIN_QUERY = 2;
export const MAX_QUERY = 64;
export const MAX_WORDS = 6;

/** What the field says when a search is outside those bounds, so it is never sent: the reference-search function's 400 message. */
export const INVALID_SEARCH = "A search is 2 to 64 characters, at most 6 words.";

/** The words SQL looks for: the trimmed query split on whitespace. */
export function searchWords(query: string): string[] {
  return query.trim().split(/\s+/).filter(Boolean);
}

/** Can this query be sent? 2 to 64 characters (code points, as SQL counts them) after trimming, at most 6 words. */
export function validSearch(query: string): boolean {
  const length = Array.from(query.trim()).length;
  return length >= MIN_QUERY && length <= MAX_QUERY && searchWords(query).length <= MAX_WORDS;
}

/** The program chips, in the Copy's order; `null` is All programs. */
export const PROGRAM_CHIPS: { program: ReferenceProgram | null; label: string; short: string }[] = [
  { program: null, label: "All programs", short: "All" },
  { program: "pota", label: "POTA parks", short: "POTA" },
  { program: "sota", label: "SOTA summits", short: "SOTA" },
  { program: "wwff", label: "WWFF references", short: "WWFF" },
];

/** The results card's title: `7 matches for "mitchell"`, `1 match for "us-2763"`. */
export function matchesTitle(count: number, query: string): string {
  return `${plural(count, "match", "matches")} for "${query}"`;
}

/** The no-results line. */
export function noMatches(query: string): string {
  return `No parks, summits or WWFF references match "${query}".`;
}

export interface NamePart {
  text: string;
  match: boolean;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A name cut into runs, the query's words marked, so the page can set them in medium weight.
 * Case-insensitive as SQL's upper() comparison is; the longest word wins where two overlap.
 */
export function nameParts(name: string, words: string[]): NamePart[] {
  const sorted = [...new Set(words)].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!sorted.length || !name) return name ? [{ text: name, match: false }] : [];
  const pattern = new RegExp(sorted.map(escape).join("|"), "giu");
  const parts: NamePart[] = [];
  let at = 0;
  for (const m of name.matchAll(pattern)) {
    if (m.index > at) parts.push({ text: name.slice(at, m.index), match: false });
    parts.push({ text: m[0], match: true });
    at = m.index + m[0].length;
  }
  if (at < name.length) parts.push({ text: name.slice(at), match: false });
  return parts;
}

/** "US-NC, US-VA" for a park in two states, as the reference page shows it. */
function locations(location: string): string {
  return location.split(",").map((l) => l.trim()).filter(Boolean).join(", ");
}

/**
 * A result's detail line. POTA `US-NC · EM85`; SOTA `W4C · NC-Central Mountains · 2,037 m · 10 points`;
 * WWFF `{country} · {region}`. A part without a value is left out, separator and all.
 */
export function detailLine(result: ReferenceSearchResult): string {
  const parts: (string | null)[] = result.program === "pota"
    ? [result.location && locations(result.location), result.grid]
    : result.program === "sota"
    ? [
      result.association,
      result.region,
      result.altitudeM === null ? null : `${fmt(result.altitudeM)} m`,
      result.points === null ? null : plural(result.points, "point", "points"),
    ]
    : [result.country, result.region];
  return parts.filter((p): p is string => !!p).join(" · ");
}

/** The right side of a result: `148 activations · last Oct 26`, or `No activations yet`. */
export function activationsLine(result: Pick<ReferenceSearchResult, "activations" | "lastDay">, now: Date): string {
  if (result.activations === 0) return "No activations yet";
  const count = plural(result.activations, "activation", "activations");
  return result.lastDay ? `${count} · last ${shortDay(result.lastDay, now)}` : count;
}

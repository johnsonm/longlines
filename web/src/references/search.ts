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
 * Case-insensitive as SQL's upper() comparison is. Every occurrence of every word is marked, so
 * words that overlap (`mitch hell` in "Mitchell") are all set, as SQL found each one on its own.
 */
export function nameParts(name: string, words: string[]): NamePart[] {
  if (!name) return [];
  const marked: boolean[] = new Array<boolean>(name.length).fill(false);
  for (const word of new Set(words)) {
    if (!word) continue;
    const pattern = new RegExp(escape(word), "giu");
    for (let m = pattern.exec(name); m !== null; m = pattern.exec(name)) {
      marked.fill(true, m.index, m.index + m[0].length);
      // Step one code point, not past the match, so an occurrence overlapping this one is found too.
      pattern.lastIndex = m.index + ((name.codePointAt(m.index) ?? 0) > 0xffff ? 2 : 1);
    }
  }
  const parts: NamePart[] = [];
  let at = 0;
  for (let i = 1; i <= name.length; i++) {
    if (i === name.length || marked[i] !== marked[at]) {
      parts.push({ text: name.slice(at, i), match: marked[at] ?? false });
      at = i;
    }
  }
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

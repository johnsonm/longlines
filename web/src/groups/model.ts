// Presentation helpers for the Groups page and the group dialog. Copy comes
// from the "Copy" section of docs/superpowers/specs/2026-10-13-callsign-groups-design.md.
// Base calls and the on-air figures come from SQL; nothing here works them out.

import { relativeAge } from "../lib/time";
import { plural } from "../profile/format";
import { sourceName } from "../sources/sources";
import type { GroupSpot } from "./types";

/** save_callsign_group refuses more; the dialog refuses an add that would pass it. */
export const MAX_CALLSIGNS = 1000;
/** Member chips on a card before "+N more". */
export const CARD_CHIPS = 10;
const REJECTED_SHOWN = 20;

/** "12 callsigns · used by 1 subscription". */
export function groupMeta(members: number, subscriptions: number): string {
  return `${plural(members, "callsign", "callsigns")} · used by ${plural(subscriptions, "subscription", "subscriptions")}`;
}

/** The latest on-air spot on two lines: "KK4PWJ 14062.0 kHz CW" and "20m · POTA · US-2763 · 2m ago". */
export function spotLines(spot: GroupSpot, now: Date): [string, string] {
  const freq = spot.frequency_khz === null ? null : `${Number(spot.frequency_khz).toFixed(1)} kHz`;
  const first = [spot.callsign, freq, spot.mode?.toUpperCase()].filter(Boolean).join(" ");
  const age = relativeAge((now.getTime() - new Date(spot.spot_time).getTime()) / 1000);
  const second = [spot.band, sourceName(spot.source), spot.reference, age].filter(Boolean).join(" · ");
  return [first, second];
}

/** The list after an add: no repeats, alphabetical. Both sides are already base calls. */
export function mergeCallsigns(current: string[], added: string[]): string[] {
  return [...new Set([...current, ...added])].sort();
}

export function wouldExceed(count: number): boolean {
  return count > MAX_CALLSIGNS;
}

export function limitText(count: number): string {
  return `That would make ${plural(count, "callsign", "callsigns")}. A group can hold up to 1,000.`;
}

/** "Not callsigns, so not added: N0PE, 12345", up to 20 values then "and N more"; null for none. */
export function rejectedText(rejected: string[]): string | null {
  if (rejected.length === 0) return null;
  const shown = rejected.slice(0, REJECTED_SHOWN).join(", ");
  const more = rejected.length > REJECTED_SHOWN ? ` and ${rejected.length - REJECTED_SHOWN} more` : "";
  return `Not callsigns, so not added: ${shown}${more}`;
}

/** "roster.csv: using the Callsign column. Found 42 callsigns, skipped 3." */
export function csvSummary(file: string, header: string | null, found: number, skipped: number): string {
  const column = header === null ? "the first column" : `the ${header} column`;
  return `${file}: using ${column}. Found ${plural(found, "callsign", "callsigns")}, skipped ${skipped}.`;
}

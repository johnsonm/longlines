// Presentation helpers for the member editor. Copy comes
// from the "Copy" section of docs/superpowers/specs/2026-10-13-callsign-groups-design.md.
// Base calls and the on-air figures come from SQL; nothing here works them out.

import { plural } from "../profile/format";

/** save_callsign_group refuses more; the dialog refuses an add that would pass it. */
export const MAX_CALLSIGNS = 1000;
const REJECTED_SHOWN = 20;

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

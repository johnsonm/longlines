// The goal editor's form: the draft it edits, the save_goal payload it sends, and the
// warnings it shows before a save. Pure, so it is tested in node. SQL validates and stores the
// list (save_goal) and rechecks every contact mark afterwards (goal_recheck); what a save
// with a new window or marking would undo is SQL's too (preview_goal_window), and the
// warnings here only word its answer. Copy comes from the Copy
// section of docs/superpowers/specs/2026-10-29-goals-design.md.

import { plural } from "../profile/format";
import { BANDS } from "../sources/sources";
import { chipLabel, joinNames, utcDay } from "./model";
import type {
  CompleteWhen, GoalKind, GoalInput, GoalProgress, GoalMarking, GoalRelay, GoalRequirementInput, GoalWindowLoss,
} from "./types";

/** us_states() in its order (by name, no DC); editModel.test.ts compares the two. */
export const US_STATES: readonly string[] = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
];

/** A POTA reference as save_goal takes one: it need not be in the reference catalog. */
export const POTA_REFERENCE = /^[A-Z]{1,4}-[0-9]{3,6}$/;

/** save_goal's caps. */
export const MAX_REQUIREMENTS = 10;

export const ALL_STATES_LABEL = "All 50 states";

/** Phones show this many park chips (the names are long), then "+ N more". */
export const PHONE_PARK_CHIPS = 3;

export const KINDS: readonly { kind: GoalKind; label: string }[] = [
  { kind: "state", label: "US states" },
  { kind: "park", label: "Parks" },
  { kind: "band", label: "Bands" },
];

export const COMPLETE_WHEN: readonly { value: CompleteWhen; label: string }[] = [
  { value: "all", label: "All of these" },
  { value: "at_least", label: "At least" },
];

export type WindowKind = "dates" | "open";

export const WINDOWS: readonly { value: WindowKind; label: string; caption: string }[] = [
  { value: "dates", label: "Between dates", caption: "For a contest or a calendar-year award" },
  { value: "open", label: "No end date", caption: "For a lifetime award like POTA hunter" },
];

export const MARKINGS: readonly { value: GoalMarking; label: string; caption: string | null }[] = [
  { value: "relay", label: "From my log, using the relay", caption: "You can still mark by hand" },
  { value: "hand", label: "By hand only", caption: null },
];

export const WINDOW_HELP =
  'Choose "No end date" for something open-ended, like a POTA award. Long Lines counts contacts logged after you connected the relay. Mark earlier ones by hand.';
export const REQUIREMENTS_HELP = "A spot alerts you while it matches anything you still need. Add as many requirements as you like.";

/** The phone's buttons that open a requirement's add field. */
export const ADD_BUTTON: Record<GoalKind, string> = { state: "Add states", park: "Add parks", band: "Add bands" };
/** The add field's label and placeholder. */
export const ADD_FIELD: Record<GoalKind, { label: string; placeholder: string | undefined }> = {
  state: { label: "Add a state", placeholder: "Type a state or abbreviation" },
  park: { label: "Add a park", placeholder: "Search by name or reference" },
  band: { label: "Add a band", placeholder: undefined },
};

/** The park search's lines that can't be chosen. */
export const PARK_NOT_LISTED = "Not in the POTA list. Press Enter to add it anyway.";
export const PARK_NO_MATCH = "No parks match.";

/** The messages save_goal raises about the name, shown on the field rather than as a toast. */
export const NAME_ERRORS: readonly string[] = ["Give the goal a name.", "You already have a goal with that name."];

// ---- The draft --------------------------------------------------------------

export interface RequirementDraft {
  /** React's key: the requirement's id, or a new one's made-up key. */
  key: string;
  /** Null for a requirement not saved yet, or one whose kind changed (SQL makes it anew). */
  id: string | null;
  kind: GoalKind;
  completeWhen: CompleteWhen;
  /** "How many", as typed; SQL checks it. */
  atLeast: string;
  entries: string[];
}

export interface GoalDraft {
  id: string | null;
  name: string;
  window: WindowKind;
  /** YYYY-MM-DD UTC days, as a date field holds them; empty until picked. */
  startsOn: string;
  endsOn: string;
  marking: GoalMarking;
  requirements: RequirementDraft[];
}

/** The six bands the canvas starts a band requirement with. */
const DEFAULT_BANDS = ["80m", "40m", "20m", "15m", "10m", "6m"];

/** A new requirement's entries: all 50 states, the six bands, no parks yet. */
export function defaultEntries(kind: GoalKind): string[] {
  if (kind === "state") return [...US_STATES];
  if (kind === "band") return [...DEFAULT_BANDS];
  return [];
}

export function newRequirement(kind: GoalKind, key: string): RequirementDraft {
  return { key, id: null, kind, completeWhen: "all", atLeast: "", entries: defaultEntries(kind) };
}

/** This UTC year, Jan 1 to Dec 31: a new list's window, and the dates "Between dates" starts from. */
export function yearWindow(now: Date): { startsOn: string; endsOn: string } {
  const y = utcDay(now).slice(0, 4);
  return { startsOn: `${y}-01-01`, endsOn: `${y}-12-31` };
}

/** The form for a list as loaded, or a new list's: this year, from the relay, all 50 states. */
export function draftOf(progress: GoalProgress | null, now: Date): GoalDraft {
  if (!progress) {
    return { id: null, name: "", window: "dates", ...yearWindow(now), marking: "relay", requirements: [newRequirement("state", "new-0")] };
  }
  const l = progress.list;
  const dates = l.starts_on && l.ends_on ? { startsOn: l.starts_on, endsOn: l.ends_on } : yearWindow(now);
  return {
    id: l.id,
    name: l.name,
    window: l.starts_on && l.ends_on ? "dates" : "open",
    ...dates,
    marking: l.marking,
    requirements: [...progress.requirements]
      .sort((a, b) => a.position - b.position)
      .map((r) => ({
        key: r.id,
        id: r.id,
        kind: r.kind,
        completeWhen: r.complete_when,
        atLeast: r.at_least === null ? "" : String(r.at_least),
        entries: [...r.entries].sort((a, b) => a.position - b.position).map((e) => e.value),
      })),
  };
}

/** The parks' names the loaded list knows, for chips. */
export function parkNames(progress: GoalProgress | null): Record<string, string> {
  const names: Record<string, string> = {};
  for (const r of progress?.requirements ?? []) {
    if (r.kind !== "park") continue;
    for (const e of r.entries) if (e.label) names[e.value] = e.label;
  }
  return names;
}

/** A whole number as typed, else null (SQL then says what it needs). */
function whole(text: string): number | null {
  return /^\d{1,6}$/.test(text.trim()) ? Number(text.trim()) : null;
}

/** save_goal's payload. An empty date goes as null, so SQL asks for both. */
export function inputOf(draft: GoalDraft): GoalInput {
  const dates = draft.window === "dates";
  const requirements = draft.requirements.map((r): GoalRequirementInput => ({
    ...(r.id ? { id: r.id } : {}),
    kind: r.kind,
    complete_when: r.completeWhen,
    at_least: r.completeWhen === "at_least" ? whole(r.atLeast) : null,
    entries: r.entries,
  }));
  return {
    ...(draft.id ? { id: draft.id } : {}),
    name: draft.name.trim(),
    starts_on: dates && draft.startsOn ? draft.startsOn : null,
    ends_on: dates && draft.endsOn ? draft.endsOn : null,
    marking: draft.marking,
    requirements,
  };
}

/** Add requirement's kind on a desktop: the first kind the list doesn't have yet, else US states. */
export function nextKind(requirements: Pick<RequirementDraft, "kind">[]): GoalKind {
  return KINDS.find((k) => !requirements.some((r) => r.kind === k.kind))?.kind ?? "state";
}

/** A requirement turned into another kind: a new requirement of that kind, in the same place. */
export function withKind(req: RequirementDraft, kind: GoalKind): RequirementDraft {
  return kind === req.kind ? req : { ...newRequirement(kind, req.key), key: req.key };
}

/** "At least" starts at one less than the entries, so the requirement can still be finished early. */
export function withCompleteWhen(req: RequirementDraft, completeWhen: CompleteWhen): RequirementDraft {
  const atLeast = completeWhen === "at_least" && req.atLeast === "" ? String(Math.max(1, req.entries.length - 1)) : req.atLeast;
  return { ...req, completeWhen, atLeast };
}

/** Entries with more added, once each: states and bands in their lists' order, parks as added. */
export function addEntries(kind: GoalKind, entries: string[], values: string[]): string[] {
  const all = new Set([...entries, ...values]);
  if (kind === "state") return US_STATES.filter((s) => all.has(s));
  if (kind === "band") return [...BANDS.filter((b) => all.has(b)), ...entries.filter((e) => !BANDS.includes(e))];
  return [...all];
}

export const removeEntry = (entries: string[], value: string): string[] => entries.filter((e) => e !== value);

/** Whether a state requirement holds every state, shown as one "All 50 states" chip. */
export const allStates = (entries: string[]): boolean => US_STATES.every((s) => entries.includes(s));

/** A typed park as save_goal stores it, or null when it isn't a POTA reference. */
export function parkReference(text: string): string | null {
  const ref = text.trim().toUpperCase();
  return POTA_REFERENCE.test(ref) ? ref : null;
}

/** "Once you've worked 4 of these, the rest stop alerting." while "How many" is a number. */
export function atLeastHint(req: Pick<RequirementDraft, "completeWhen" | "atLeast">): string | null {
  const n = whole(req.atLeast);
  return req.completeWhen === "at_least" && n !== null ? `Once you've worked ${n} of these, the rest stop alerting.` : null;
}

/** The line under "Mark entries worked". */
export function markingHelp(marking: GoalMarking, relay: Pick<GoalRelay, "status"> | null): string {
  if (marking === "hand") return "Spots never mark an entry on their own.";
  const connected = relay?.status === "recent" ? "The relay is connected. " : "";
  return `${connected}Choose "By hand only" if you don't log with N1MM or WSJT-X. Spots never mark an entry on their own.`;
}

// ---- Warnings before a save -------------------------------------------------

export interface Notice {
  title: string;
  text: string;
}

const MONTH = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" });
const MONTH_YEAR = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** Names a warning lists before "and N more". */
const NAMED = 5;

/**
 * The window and marking a save would send, while they differ from the loaded list's and SQL would
 * take them; else null, with nothing to ask preview_goal_window. Never for a new list.
 */
export interface WindowChange {
  startsOn: string | null;
  endsOn: string | null;
  marking: GoalMarking;
}

export function windowChange(progress: GoalProgress | null, draft: GoalDraft): WindowChange | null {
  if (!progress) return null;
  const dates = draft.window === "dates";
  const startsOn = dates && draft.startsOn ? draft.startsOn : null;
  const endsOn = dates && draft.endsOn ? draft.endsOn : null;
  // A window save_goal refuses: it says why on Save.
  if ((startsOn === null) !== (endsOn === null) || (startsOn !== null && endsOn !== null && endsOn < startsOn)) return null;
  const l = progress.list;
  if (startsOn === l.starts_on && endsOn === l.ends_on && draft.marking === l.marking) return null;
  return { startsOn, endsOn, marking: draft.marking };
}

/** How long the editor waits after the last change to the window or marking before asking SQL. */
export const WINDOW_PREVIEW_DELAY_MS = 400;

interface LostMark {
  name: string;
  at: Date;
  reason: GoalWindowLoss["reason"];
}

/**
 * SQL's losses with these reasons that the draft keeps: same requirement (id and kind) and value.
 * An entry the draft removes goes anyway, and a requirement whose kind changed is made anew. In
 * SQL's order (requirement, then entry). Hand marks are never among them.
 */
function lostMarks(
  progress: GoalProgress, draft: GoalDraft, losses: readonly GoalWindowLoss[], reasons: readonly GoalWindowLoss["reason"][],
): LostMark[] {
  const marks: LostMark[] = [];
  for (const loss of losses) {
    if (!reasons.includes(loss.reason)) continue;
    const kept = draft.requirements.find((r) => r.id === loss.requirement_id && r.kind === loss.kind);
    if (!kept?.entries.includes(loss.value)) continue;
    const loaded = progress.requirements.find((r) => r.id === loss.requirement_id)?.entries.find((e) => e.value === loss.value);
    marks.push({ name: chipLabel(loss.kind, loaded ?? { value: loss.value, label: null }), at: new Date(loss.worked_at), reason: loss.reason });
  }
  return marks;
}

/** "GA, SC and Cape Lookout National Seashore", or the first five "and 3 more". */
function names(marks: LostMark[]): string {
  const all = marks.map((m) => m.name);
  return all.length <= NAMED ? joinNames(all) : `${all.slice(0, NAMED).join(", ")} and ${all.length - NAMED} more`;
}

/** "January and February", with years when the contacts span more than one. */
function months(marks: LostMark[]): string {
  const sorted = [...marks].sort((a, b) => a.at.getTime() - b.at.getTime());
  const years = new Set(sorted.map((m) => m.at.getUTCFullYear()));
  const format = years.size > 1 ? MONTH_YEAR : MONTH;
  return joinNames([...new Set(sorted.map((m) => format.format(m.at)))]);
}

const goBack = (n: number): string =>
  n === 1
    ? "When you save, it goes back to needed and your connections start alerting for it again."
    : "When you save, they go back to needed and your connections start alerting for them again.";

/**
 * The warning under the dates, from preview_goal_window's answer for the draft's window:
 * the entries a contact marks now that the save would send back to needed. SQL decides which
 * (it rechecks every contact as the save would); this only words them.
 */
export function dateWarning(progress: GoalProgress | null, draft: GoalDraft, losses: readonly GoalWindowLoss[]): Notice | null {
  if (!progress || draft.marking !== "relay") return null;
  const out = lostMarks(progress, draft, losses, ["before_start", "after_end"]);
  if (out.length === 0) return null;
  const before = out.every((m) => m.reason === "before_start");
  const after = out.every((m) => m.reason === "after_end");
  const where = before ? "before the new start date" : after ? "after the new end date" : "outside the new dates";
  const n = out.length;
  return {
    title: `${plural(n, "worked entry", "worked entries")} ${n === 1 ? "falls" : "fall"} ${where}`,
    text: `${names(out)} ${n === 1 ? "was" : "were"} worked in ${months(out)}. ${goBack(n)}`,
  };
}

/**
 * The warning under "Mark entries worked" when a relay list turns to "By hand only", from
 * preview_goal_window's answer: the contact marks the save would send back to needed.
 */
export function markingWarning(progress: GoalProgress | null, draft: GoalDraft, losses: readonly GoalWindowLoss[]): Notice | null {
  if (!progress || progress.list.marking !== "relay" || draft.marking !== "hand") return null;
  const marks = lostMarks(progress, draft, losses, ["by_hand"]);
  if (marks.length === 0) return null;
  const n = marks.length;
  return {
    title: `${plural(n, "worked entry", "worked entries")} came from your log`,
    text: `${names(marks)} ${n === 1 ? "was" : "were"} marked from contacts you logged. ${goBack(n)} Mark ${n === 1 ? "it" : "them"} worked by hand from the progress page.`,
  };
}

/**
 * "Long Lines only knows contacts since Oct 16, 2026": shown while a relay list's window reaches
 * back before the account's first logged contact (or has no end date).
 */
export function knownSince(progress: GoalProgress | null, draft: GoalDraft): Notice | null {
  const first = progress?.first_contact_at;
  if (!first || draft.marking !== "relay") return null;
  const day = utcDay(new Date(first));
  if (draft.window === "dates" && (!draft.startsOn || draft.startsOn >= day)) return null;
  return {
    title: `Long Lines only knows contacts since ${DATE.format(new Date(`${day}T00:00:00Z`))}`,
    text: "That's when you connected the relay. Anything you worked before then isn't counted. Mark those entries worked by hand from the progress page.",
  };
}

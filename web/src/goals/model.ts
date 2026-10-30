// Wording for the goal pages. Pure, so it is tested in node. Every count, status and mark
// comes from SQL (get_goal, list_goals); this only puts words around them. Copy comes
// from the Copy section of docs/superpowers/specs/2026-10-29-goals-design.md.

import { plural } from "../profile/format";
import { SOURCES, sourceName } from "../sources/sources";
import { stateName } from "../stats/stateShapes";
import type {
  GoalEntry, GoalEvidence, GoalKind, GoalCard, GoalRelay, GoalRequirement, GoalReview, GoalStatus, GoalUsedBy,
} from "./types";

const DAY_MS = 86_400_000;
const TIME = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });
const MONTH_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export const KIND_LABEL: Record<GoalKind, string> = { state: "States", park: "Parks", band: "Bands" };
const KIND_NOUN: Record<GoalKind, string> = { state: "states", park: "parks", band: "bands" };

/** Phones show this many still-needed chips, then "Show all N needed". */
export const PHONE_CHIPS = 12;
/** Park names are long: phones show this many park chips first, as the canvas's phone frame does. */
export const PHONE_PARK_CHIPS = 4;

/** The relay banner's "Dismiss for 7 days". */
export const DISMISS_MS = 7 * DAY_MS;

// ---- Days -------------------------------------------------------------------

const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);
/** Today's UTC day as YYYY-MM-DD: list windows are UTC days. */
export const utcDay = (now: Date): string => now.toISOString().slice(0, 10);
const daysBetween = (from: string, to: string): number => Math.round((dayMs(to) - dayMs(from)) / DAY_MS);
const year = (day: string): string => day.slice(0, 4);

/** "Jan 1 – Dec 31, 2026", "Jan 24 – 25, 2026", "Dec 1, 2025 – Jan 31, 2026", or "No end date". */
export function windowLabel(starts: string | null, ends: string | null): string {
  if (!starts || !ends) return "No end date";
  const a = new Date(dayMs(starts));
  const b = new Date(dayMs(ends));
  if (starts === ends) return DATE.format(a);
  if (year(starts) !== year(ends)) return `${DATE.format(a)} – ${DATE.format(b)}`;
  if (starts.slice(0, 7) === ends.slice(0, 7)) return `${MONTH_DAY.format(a)} – ${b.getUTCDate()}, ${year(ends)}`;
  return `${MONTH_DAY.format(a)} – ${MONTH_DAY.format(b)}, ${year(ends)}`;
}

/** "Oct 3", with the year when it isn't this year's. */
function shortDate(iso: string, now: Date): string {
  const d = new Date(iso);
  return d.getUTCFullYear() === now.getUTCFullYear() ? MONTH_DAY.format(d) : DATE.format(d);
}

/** "Oct 3, 21:14 UTC". */
export function contactTime(iso: string, now: Date): string {
  return `${shortDate(iso, now)}, ${TIME.format(new Date(iso))} UTC`;
}

/**
 * The line under the title: "Counts contacts from Jan 1 – Dec 31, 2026 · 64 days left" (the end day
 * counts), "· Finished Nov 18, 43 days early" once complete, "Counted contacts from … · Ended 3 days
 * ago" once ended. Phones drop the "Counts contacts from".
 */
export function datesLine(list: GoalCard, now: Date, phone: boolean): string {
  const { starts_on: starts, ends_on: ends } = list;
  const today = utcDay(now);
  const window = windowLabel(starts, ends);
  if (!starts || !ends) {
    return list.status === "complete" && list.completed_at ? `${window} · Finished ${shortDate(list.completed_at, now)}` : window;
  }
  const lead = phone ? window : `${list.status === "ended" ? "Counted" : "Counts"} contacts from ${window}`;
  if (list.status === "complete" && list.completed_at) {
    const early = daysBetween(list.completed_at.slice(0, 10), ends);
    return `${lead} · Finished ${shortDate(list.completed_at, now)}${early > 0 ? `, ${plural(early, "day", "days")} early` : ""}`;
  }
  if (list.status === "ended") return `${lead} · Ended ${plural(Math.max(1, daysBetween(ends, today)), "day", "days")} ago`;
  return `${lead} · ${plural(Math.max(1, daysBetween(today, ends) + 1), "day", "days")} left`;
}

// ---- Index cards ------------------------------------------------------------

export const isFinished = (status: GoalStatus): boolean => status !== "active";

/** "3 requirements · Jan 1 – Dec 31, 2026". */
export function cardMeta(list: GoalCard): string {
  return `${plural(list.requirement_count, "requirement", "requirements")} · ${windowLabel(list.starts_on, list.ends_on)}`;
}

/** "Used by 2 connections"; a finished goal's rule is off, so "Rule off on 1 connection". */
export function usageLine(list: GoalCard): string {
  if (list.connection_count === 0) return "Not used by any connection";
  const n = plural(list.connection_count, "connection", "connections");
  return isFinished(list.status) ? `Rule off on ${n}` : `Used by ${n}`;
}

/** "18 of 64 worked". */
export const workedLine = (worked: number, total: number): string => `${worked} of ${total} worked`;

/** The determinate bar's value, a whole number from 0 to 100. */
export const percent = (worked: number, total: number): number => (total > 0 ? Math.min(100, Math.round((worked / total) * 100)) : 0);

// ---- Entries ----------------------------------------------------------------

/** "80 m", "70 cm", "1.25 m"; QO-100's band by its name. */
export function bandLabel(band: string): string {
  if (band === "3cm_qo100") return "QO-100";
  const m = /^([\d.]+)(c?m)$/.exec(band);
  return m ? `${m[1]} ${m[2]}` : band;
}

/** A chip's label: a state's code, a park's name (else its reference), a band. */
export function chipLabel(kind: GoalKind, entry: Pick<GoalEntry, "value" | "label">): string {
  if (kind === "band") return bandLabel(entry.value);
  if (kind === "park") return entry.label ?? entry.value;
  return entry.value;
}

/** A worked row's label: a state's name, a park's name (else its reference), a band. */
export function entryName(kind: GoalKind, entry: Pick<GoalEntry, "value" | "label">): string {
  return kind === "state" ? stateName(entry.value) : chipLabel(kind, entry);
}

/** "Work all 50", "Work at least 4 of 6"; phones say "At least 4 of 6". */
export function ruleLabel(req: Pick<GoalRequirement, "complete_when" | "at_least" | "entries">, phone: boolean): string {
  const n = req.entries.length;
  if (req.complete_when === "at_least" && req.at_least !== null) return `${phone ? "At least" : "Work at least"} ${req.at_least} of ${n}`;
  return `Work all ${n}`;
}

/** "Once you've worked 4, the other bands stop alerting too." */
export function atLeastNote(req: Pick<GoalRequirement, "kind" | "at_least">): string {
  return `Once you've worked ${req.at_least ?? 0}, the other ${KIND_NOUN[req.kind]} stop alerting too.`;
}

/**
 * How a worked entry got marked: "Worked K4ABC · Oct 3, 21:14 UTC · Logged in N1MM, matched to a
 * POTA spot at 21:09", or "Marked by hand · Oct 20". Phones drop "Worked" and the logger.
 */
export function evidenceLine(entry: Pick<GoalEntry, "worked_at" | "worked_how" | "evidence">, now: Date, phone: boolean): string {
  const e: GoalEvidence | null = entry.evidence;
  if (entry.worked_how === "contact" && e) {
    const head = `${phone ? "" : "Worked "}${e.worked_call} · ${contactTime(e.contact_time, now)}`;
    const at = e.matched_spot_time ? TIME.format(new Date(e.matched_spot_time)) : null;
    const logger = phone ? null : e.logger_app;
    const tail = logger && at
      ? `Logged in ${logger}, matched to a POTA spot at ${at}`
      : logger
      ? `Logged in ${logger}`
      : at
      ? `Matched to a POTA spot at ${at}`
      : null;
    return tail ? `${head} · ${tail}` : head;
  }
  return entry.worked_at ? `Marked by hand · ${shortDate(entry.worked_at, now)}` : "Marked by hand";
}

// ---- Needs a look -----------------------------------------------------------

/** "AA1ZZ · 20 m CW". */
export function reviewTitle(review: Pick<GoalReview, "worked_call" | "band" | "mode">): string {
  const what = [review.band ? bandLabel(review.band) : null, review.mode ? review.mode.toUpperCase() : null].filter(Boolean).join(" ");
  return what ? `${review.worked_call} · ${what}` : review.worked_call;
}

const COUNT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/** "A, B and C". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] ?? ""}`;
}

/** Why it needs a look: no spot near the contact, or spots at several parks. */
export function reviewDetail(review: Pick<GoalReview, "contact_time" | "candidates">, now: Date): string {
  const when = contactTime(review.contact_time, now);
  if (review.candidates.length === 0) return `${when} · No POTA spot for this station within 30 minutes of when you logged it.`;
  const names = review.candidates.map((c) => c.name ?? c.reference);
  const n = COUNT_WORDS[names.length] ?? String(names.length);
  return `${when} · Spotted at ${n} different parks around then: ${joinNames(names)}.`;
}

/** "2 logged contacts need a look before they can count toward Parks." */
export function reviewBanner(count: number): string {
  return count === 1
    ? "1 logged contact needs a look before it can count toward Parks."
    : `${count} logged contacts need a look before they can count toward Parks.`;
}

// ---- The relay --------------------------------------------------------------

export const relayConnected = (relay: Pick<GoalRelay, "status">): boolean => relay.status === "recent";

/** "N1MM · Last contact 12 minutes ago"; "Last contact Oct 20, 9 days ago" once stale; phones drop the logger. */
export function relayLine(relay: GoalRelay, now: Date, phone: boolean): string {
  if (!relay.last_contact_at) return "No contacts yet";
  const at = new Date(relay.last_contact_at);
  if (relayConnected(relay)) {
    const minutes = Math.max(1, Math.floor((now.getTime() - at.getTime()) / 60_000));
    const ago = minutes < 60
      ? plural(minutes, "minute", "minutes")
      : minutes < 1440
      ? plural(Math.floor(minutes / 60), "hour", "hours")
      : plural(Math.floor(minutes / 1440), "day", "days");
    const line = `Last contact ${ago} ago`;
    return !phone && relay.logger_app ? `${relay.logger_app} · ${line}` : line;
  }
  const days = Math.max(1, Math.floor((now.getTime() - at.getTime()) / DAY_MS));
  return `Last contact ${shortDate(relay.last_contact_at, now)}, ${plural(days, "day", "days")} ago`;
}

/** The warning banner's text: how long the relay has been quiet, and what that means. */
export function relayBannerText(relay: GoalRelay, now: Date): string {
  const quiet = relay.last_contact_at
    ? `The relay hasn't sent a contact in ${plural(Math.max(1, Math.floor((now.getTime() - Date.parse(relay.last_contact_at)) / DAY_MS)), "day", "days")}.`
    : "The relay hasn't sent a contact yet.";
  return `${quiet} Contacts you log while it's off won't mark anything worked, and your connections will keep alerting for them. Open the relay on your logging computer, or mark entries by hand.`;
}

/** The relay banner shows on an active relay-marked list while no contact came in the last 7 days. */
export function showRelayBanner(list: Pick<GoalCard, "status" | "marking">, relay: Pick<GoalRelay, "status">): boolean {
  return list.status === "active" && list.marking === "relay" && !relayConnected(relay);
}

export const dismissKey = (id: string): string => `longlines.goalRelayDismissed.${id}`;

type DismissStore = Pick<Storage, "getItem" | "setItem">;

/** window.localStorage, or null where reading it throws (private windows, blocked site data). */
export function browserStorage(): DismissStore | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Whether the relay banner for this goal was dismissed in the last 7 days. Any storage failure reads as not dismissed. */
export function relayDismissed(store: DismissStore | null, id: string, now: Date): boolean {
  try {
    const until = Number(store?.getItem(dismissKey(id)) ?? "");
    return Number.isFinite(until) && until > now.getTime();
  } catch {
    return false;
  }
}

/** Remembers "Dismiss for 7 days"; a store that throws only loses the reminder. */
export function dismissRelay(store: DismissStore | null, id: string, now: Date): void {
  try {
    store?.setItem(dismissKey(id), String(now.getTime() + DISMISS_MS));
  } catch {
    // A per-viewer convenience: the banner just comes back next visit.
  }
}

// ---- Connections ------------------------------------------------------------

/** "Parks on the Air · 1 destination". */
export function connectionDetail(c: Pick<GoalUsedBy, "sources" | "destination_count">): string {
  const one = c.sources.length === 1 ? SOURCES.find((s) => s.id === c.sources[0]) : undefined;
  const source = one ? one.title : c.sources.length === 0 ? "All sources" : c.sources.map(sourceName).join(", ");
  return `${source} · ${plural(c.destination_count, "destination", "destinations")}`;
}

/** The Used by card's note, by status. */
export function usedByNote(status: GoalStatus, count: number): string {
  if (status === "active") return "Every connection using this goal stops alerting for entries you've worked.";
  const which = count === 1 ? "this connection" : count === 2 ? "both connections" : `all ${count} connections`;
  return status === "ended" ? `The goal rule is off on ${which} while this goal is ended.` : `The goal rule is off on ${which}.`;
}

/** The Complete banner about the connections whose rule is now off; null when none uses the list. */
export function completeRuleBanner(used: Pick<GoalUsedBy, "name">[]): { title: string; text: string } | null {
  if (used.length === 0) return null;
  const names = joinNames(used.map((c) => c.name));
  if (used.length === 1) {
    return {
      title: "The goal rule is now off on 1 connection",
      text: `${names} no longer filters by this goal, so it alerts for everything its other rules allow. Add a different goal to it, or delete this one once no connection uses it.`,
    };
  }
  return {
    title: `The goal rule is now off on ${used.length} connections`,
    text: `${names} no longer filter by this goal, so they alert for everything their other rules allow. Add a different goal to them, or delete this one once no connection uses it.`,
  };
}

/** The Ended banner: "This goal ended Dec 31, 2026" and what that means for its connections. */
export function endedBanner(list: Pick<GoalCard, "ends_on" | "worked" | "total">, connections: number): { title: string; text: string } {
  const left = list.total - list.worked;
  const needed = left === 1 ? "1 entry was still needed." : `${left} entries were still needed.`;
  const rule = connections === 0
    ? "It no longer counts new contacts."
    : connections === 1
    ? "It no longer counts new contacts, and the goal rule is now off on the 1 connection using it, so it alerts for everything its other rules allow."
    : `It no longer counts new contacts, and the goal rule is now off on the ${connections} connections using it, so they alert for everything their other rules allow.`;
  return {
    title: `This goal ended ${list.ends_on ? DATE.format(new Date(dayMs(list.ends_on))) : ""}`.trim(),
    text: `${needed} ${rule} Change the dates to turn it back on.`,
  };
}

/** "Copy for 2027": the year the copy's dates move to. */
export function copyYear(list: Pick<GoalCard, "ends_on">, now: Date): number {
  return (list.ends_on ? Number(year(list.ends_on)) : now.getUTCFullYear()) + 1;
}

/** The blocked delete dialog's text. */
export function blockedDeleteText(count: number): string {
  return count === 1
    ? "1 connection uses this goal. Remove the goal rule from it, then you can delete it."
    : `${count} connections use this goal. Remove the goal rule from each one, then you can delete it.`;
}

/** "Final: 0 of 3 requirements complete" once ended. */
export function requirementsLine(complete: number, total: number, status: GoalStatus): string {
  return `${status === "ended" ? "Final: " : ""}${complete} of ${total} requirements complete`;
}

/** The Complete banner's line: "All 3 requirements are complete. Nice work." */
export function completeText(requirements: number): string {
  return requirements === 1 ? "The requirement is complete. Nice work." : `All ${requirements} requirements are complete. Nice work.`;
}

/** The parks a list still needs, for "Pick park" when no spot was near a contact. */
export function neededParks(requirements: GoalRequirement[]): { reference: string; name: string | null }[] {
  const seen = new Map<string, string | null>();
  for (const r of requirements) {
    if (r.kind !== "park" || r.complete) continue;
    for (const e of r.entries) if (e.worked_at === null && !seen.has(e.value)) seen.set(e.value, e.label);
  }
  return [...seen].map(([reference, name]) => ({ reference, name }));
}

// ---- The rule in the connection editor --------------------------------------

/**
 * Whether a connection's sources can carry a park: goal_matches reads only a spot's
 * pota_reference, which only POTA spots have ("any source" includes POTA). States and bands match
 * on every source, so parks are the one kind that can never match.
 */
export function parksCanMatch(sources: string[]): boolean {
  return sources.length === 0 || sources.includes("pota");
}

/** How many of a list's still-needed entries the connection's sources can never alert for. */
export function unmatchableEntries(list: Pick<GoalCard, "status" | "needed_by_kind">, sources: string[]): number {
  return list.status === "active" && !parksCanMatch(sources) ? list.needed_by_kind.park : 0;
}

/**
 * The helper under a goal rule: "46 entries still needed across 3 requirements. This rule
 * updates itself as you work them.", or "7 can't match on this source." in place of the second
 * sentence. A finished list's rule is off, and the helper says so.
 */
export function ruleHelperText(list: Pick<GoalCard, "status" | "worked" | "total" | "requirement_count" | "needed_by_kind">, sources: string[]): string {
  if (list.status === "complete") return "You worked everything on this goal, so this rule is off.";
  if (list.status === "ended") return "This goal ended, so this rule is off. Change its dates to turn it back on.";
  const needed = `${plural(Math.max(0, list.total - list.worked), "entry", "entries")} still needed across ${plural(list.requirement_count, "requirement", "requirements")}.`;
  const unmatched = unmatchableEntries(list, sources);
  return unmatched > 0 ? `${needed} ${unmatched} can't match on this source.` : `${needed} This rule updates itself as you work them.`;
}

/** "SOTAwatch spots", "Logged contacts": what the sources send, as the source warning names it. */
function spotsNoun(sources: string[]): string {
  if (sources.length === 1 && sources[0] === "logged") return "Logged contacts";
  return `${joinNames(sources.map(sourceName))} spots`;
}

/**
 * Sources whose spots are park-like activations with their own references (WWFF's flora and fauna
 * parks, WWBOTA's bunkers): saying they "don't include parks" would be false, so their warning
 * says POTA parks.
 */
const OWN_PARKS = ["wwff", "wwbota"];

/** The warning under a goal rule whose parks can never match the connection's sources; null when they can. */
export function sourceWarning(list: Pick<GoalCard, "status" | "needed_by_kind">, sources: string[]): { title: string; text: string } | null {
  const parks = unmatchableEntries(list, sources);
  if (parks === 0) return null;
  const what = sources.some((s) => OWN_PARKS.includes(s)) ? "POTA parks" : "parks";
  return {
    title: "Parks in this goal can't match here",
    text: `The Parks requirement has ${plural(parks, "park", "parks")} still needed. ${spotsNoun(sources)} don't include ${what}, so those entries will never alert on this connection.`,
  };
}

/** The preview's line under the bar, from preview_subscription's skipped_worked; null when there is nothing to say. */
export function skippedWorkedText(skipped: number | null): string | null {
  if (skipped === null || skipped <= 0) return null;
  return skipped === 1
    ? "1 more matched your other rules but was skipped. You've already worked it."
    : `${skipped} more matched your other rules but were skipped. You've already worked those.`;
}

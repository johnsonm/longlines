import type { Destination, SubscriptionInput, SubscriptionWithLinks } from "../lib/api";
import { splitCallsigns } from "../groups/parse";
import type { CallsignGroup } from "../groups/types";
import { sourceProgram } from "../references/paths";
import { searchWords, validSearch } from "../references/search";
import type { ReferenceProgram, ReferenceSearchResult } from "../references/types";
import { LIVE_SOURCES, modeLabel, SOURCES, type SourceInfo } from "../sources/sources";

export type RuleField = "callsign" | "group" | "band" | "mode" | "reference" | "frequency" | "island";
export type RuleOp = "is" | "is_not" | "contains" | "not_contains" | "gt" | "lt";
export type Join = "and" | "or";

/** One stored rule, as normalize_subscription_rules writes it. Frequency values are numbers (kHz). */
// A type, not an interface, so it is assignable to supabase-js's Json.
export type Rule = {
  field: RuleField;
  op: RuleOp;
  values: (string | number)[];
};

/** subscriptions.rules: AND groups, ORed. [] passes every spot. */
export type Rules = Rule[][];

/**
 * A row of the builder. Rows read as one list where each row after the first is joined to the one
 * before by And or Or, And binding tighter: "A and B or C" is stored as [[A, B], [C]]. A row keeps
 * its values as typed until it is saved.
 */
export interface RuleRow {
  key: number;
  join: Join;
  field: RuleField;
  op: RuleOp;
  values: string[];
}

export interface FieldInfo {
  id: RuleField;
  label: string;
  ops: readonly RuleOp[];
}

export const FIELDS: readonly FieldInfo[] = [
  { id: "callsign", label: "Callsign", ops: ["is", "is_not"] },
  { id: "group", label: "Callsign group", ops: ["is", "is_not"] },
  { id: "band", label: "Band", ops: ["is", "is_not"] },
  { id: "mode", label: "Mode", ops: ["is", "is_not"] },
  // `is` first, so a new reference row matches one reference exactly; `contains` keeps partial text such as US-NC.
  { id: "reference", label: "Park, summit, or location", ops: ["is", "is_not", "contains", "not_contains"] },
  { id: "frequency", label: "Frequency (kHz)", ops: ["is", "is_not", "gt", "lt"] },
  { id: "island", label: "IOTA island", ops: ["is", "is_not"] },
];

/** The IOTA continents, as an island rule's values name them. */
export const CONTINENTS: readonly { code: string; name: string }[] = [
  { code: "AF", name: "Africa" },
  { code: "AN", name: "Antarctica" },
  { code: "AS", name: "Asia" },
  { code: "EU", name: "Europe" },
  { code: "NA", name: "North America" },
  { code: "OC", name: "Oceania" },
  { code: "SA", name: "South America" },
];

/** The island picker's choice that stands for every continent. */
export const ANY_ISLAND = "Any island";

/** A value normalize_subscription_rules takes for an island rule: a reference (EU-005) or a continent (EU). */
const ISLAND_VALUE = /^(AF|AN|AS|EU|NA|OC|SA)(-\d{3})?$/;

/**
 * The island picker's values: trimmed and upper-cased, each once. Any island replaces them with the seven
 * continents, which cover every reference.
 */
export function islandValues(values: string[]): string[] {
  if (values.includes(ANY_ISLAND)) return CONTINENTS.map((c) => c.code);
  return [...new Set(values.map((v) => v.trim().toUpperCase()).filter(Boolean))];
}

export function fieldInfo(id: RuleField): FieldInfo {
  return FIELDS.find((f) => f.id === id) ?? FIELDS[0]!;
}

/** "is", "is not in", "is greater than": the condition as the builder and the cards show it. */
export function opLabel(field: RuleField, op: RuleOp): string {
  const group = field === "group";
  switch (op) {
    case "is": return group ? "is in" : "is";
    case "is_not": return group ? "is not in" : "is not";
    case "contains": return "contains";
    case "not_contains": return "does not contain";
    case "gt": return "is greater than";
    case "lt": return "is less than";
  }
}

/**
 * References exist only on POTA, SOTAwatch, WWFF and WWBOTA spots and on DX Cluster spots that name an
 * IOTA island; the island rule only on DX Cluster, which "any source" leaves out.
 */
export function fieldsFor(sources: string[]): RuleField[] {
  const refs = sources.length === 0
    || sources.some((s) => s === "pota" || s === "sotawatch" || s === "wwff" || s === "wwbota" || s === "dxcluster");
  const islands = sources.includes("dxcluster");
  return FIELDS.map((f) => f.id).filter((f) => (f !== "reference" || refs) && (f !== "island" || islands));
}

/** normalize_subscription_rules refuses more. */
export const MAX_RULES = 50;

let nextKey = 1;

/** A new row: the first field not used yet (or the first field), its first condition, no values. */
export function newRow(available: RuleField[], rows: RuleRow[], join: Join = "and"): RuleRow {
  const field = available.find((f) => !rows.some((r) => r.field === f)) ?? available[0] ?? "callsign";
  return { key: nextKey++, join, field, op: fieldInfo(field).ops[0]!, values: [] };
}

/** The row with another field: its first condition and no values, since values don't carry over. */
export function withField(row: RuleRow, field: RuleField): RuleRow {
  return { ...row, field, op: fieldInfo(field).ops[0]!, values: [] };
}

/** A frequency as typed, in kHz, or null when it isn't a positive number. */
export function parseKhz(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,7}(\.\d{1,3})?$/.test(t)) return null;
  const n = Number(t);
  return n > 0 ? n : null;
}

/**
 * Exact references as normalize_subscription_rules stores them, upper-cased. A reference never holds
 * a comma or a space, so a typed or pasted list ("us-1000, us-1001") becomes one chip each.
 */
export function referenceValues(values: string[]): string[] {
  return [...new Set(values.flatMap((v) => splitCallsigns(v.toUpperCase())))];
}

/**
 * The list the reference picker searches: the one program among the connection's sources (SOTAwatch's
 * is SOTA), or null for all of them when the sources name none or several.
 */
export function searchProgram(sources: string[]): ReferenceProgram | null {
  const programs = [...new Set(sources.map(sourceProgram).filter((p) => p !== null))];
  return programs.length === 1 ? programs[0]! : null;
}

/**
 * The picker's search for what is typed, its words joined by single spaces; null when the
 * reference-search function would refuse it (validSearch), so it is never sent.
 */
export function searchQuery(input: string): string | null {
  const query = searchWords(input).join(" ");
  return validSearch(query) ? query : null;
}

/** Searches already answered, kept for as long as the editor is open; shared by its reference rows. */
export interface ReferenceSearchCache {
  /** By searchKey: the results of a finished search. */
  results: Map<string, ReferenceSearchResult[]>;
  /**
   * By searchKey: searches sent and not answered yet, so the same search is never sent twice at once.
   * Every field showing that search waits on the one promise, so each learns when it answers or fails.
   */
  pending: Map<string, Promise<ReferenceSearchResult[]>>;
}

export function newReferenceSearchCache(): ReferenceSearchCache {
  return { results: new Map(), pending: new Map() };
}

/** An exact reference's shape, as normalize_subscription_rules and reference_profile take it. */
const REFERENCE_VALUE = /^[A-Z0-9/-]{1,64}$/;

const exactReference = (row: RuleRow) => row.field === "reference" && (row.op === "is" || row.op === "is_not");

/** A row's values ready to store, or null when it has none yet (or no valid frequency). */
function storedValues(row: RuleRow): (string | number)[] | null {
  if (row.field === "frequency") {
    const khz = parseKhz(row.values[0] ?? "");
    return khz === null ? null : [khz];
  }
  if (row.field === "island") {
    const islands = islandValues(row.values);
    return islands.length ? islands : null;
  }
  if (exactReference(row)) {
    const references = referenceValues(row.values);
    return references.length ? references : null;
  }
  const values = row.values.map((v) => v.trim()).filter(Boolean);
  return values.length ? values : null;
}

/**
 * A frequency row with text that isn't a number, an island row with a value that is neither a
 * reference nor a continent, or an exact reference row with a value outside the reference shape:
 * shown as an error, and the page won't save.
 */
export function rowInvalid(row: RuleRow): boolean {
  if (row.field === "island") return islandValues(row.values).some((v) => !ISLAND_VALUE.test(v));
  if (exactReference(row)) return referenceValues(row.values).some((v) => !REFERENCE_VALUE.test(v));
  return row.field === "frequency" && (row.values[0] ?? "").trim() !== "" && storedValues(row) === null;
}

/** The rows of stored rules, each group's first row joined by Or. */
export function rowsOf(rules: Rules): RuleRow[] {
  return rules.flatMap((group, g) =>
    group.map((r, i) => ({
      key: nextKey++, join: (g > 0 && i === 0 ? "or" : "and") as Join, field: r.field, op: r.op, values: r.values.map(String),
    })),
  );
}

/**
 * The rules to store from the rows. Rows without values yet don't count, and neither does a group
 * of only such rows, so an unfinished row never widens the filter.
 */
export function rulesOf(rows: RuleRow[]): Rules {
  const groups: Rule[][] = [];
  let current: Rule[] = [];
  rows.forEach((row, i) => {
    if (i > 0 && row.join === "or") {
      groups.push(current);
      current = [];
    }
    const values = storedValues(row);
    if (values) current.push({ field: row.field, op: row.op, values });
  });
  groups.push(current);
  return groups.filter((g) => g.length > 0);
}

/** Does any rule test the IOTA island? The IOTA catalog page lists such DX Cluster connections as its own. */
export function usesIslandRule(rules: Rules): boolean {
  return rules.some((g) => g.some((r) => r.field === "island"));
}

/** Does every group name stations, with a callsign or group rule that is "is"? False for no rules. */
export function namesStations(rules: Rules): boolean {
  return rules.length > 0 && rules.every((g) => g.some((r) => (r.field === "callsign" || r.field === "group") && r.op === "is"));
}

/** Are there callsign or group rules that pick stations? The preview's station count is shown then. */
export function picksStations(rules: Rules): boolean {
  return rules.some((g) => g.some((r) => (r.field === "callsign" || r.field === "group") && r.op === "is"));
}

/** Does a rule pass spots of this value outright, as a one-rule "callsign is" or "group is in" subscription would? */
export function hasPositiveRule(rules: Rules, field: "callsign" | "group", value: string): boolean {
  return rules.some((g) => g.some((r) => r.field === field && r.op === "is" && r.values.includes(value)));
}

export interface RuleSummary {
  /** How the rule joins the one before it; null for the first. */
  join: Join | null;
  label: string;
  values: string[];
}

/** "Band is 20m", "or Callsign group is in Friends": the card's filter lines. Group names need the group list. */
export function ruleSummaries(rules: Rules, groups: Pick<CallsignGroup, "id" | "name">[] | null): RuleSummary[] {
  const out: RuleSummary[] = [];
  rules.forEach((group, g) => {
    group.forEach((r, i) => {
      let values = r.values.map(String);
      if (r.field === "group") {
        // Ids aren't shown: until the names load the group's values are left out.
        values = (groups ?? []).filter((x) => values.includes(x.id)).map((x) => x.name);
      }
      if (r.field === "mode") values = values.map(modeLabel);
      out.push({ join: out.length === 0 ? null : g > 0 && i === 0 ? "or" : "and", label: `${fieldInfo(r.field).label} ${opLabel(r.field, r.op)}`, values });
    });
  });
  return out;
}

export const QUIET_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: "Every spot" },
  { value: 5, label: "At most once per 5 minutes" },
  { value: 10, label: "At most once per 10 minutes" },
  { value: 30, label: "At most once per 30 minutes" },
  { value: 60, label: "At most once per hour" },
];

/** The card's short form: "Every spot", "Once per 30 min". */
export function quietLabel(minutes: number): string {
  return minutes ? `Once per ${minutes} min` : "Every spot";
}

/** The one source a subscription uses, or null for an older one with several or "any source". */
export function singleSource(sources: string[]): SourceInfo | null {
  return sources.length === 1 ? (SOURCES.find((s) => s.id === sources[0]) ?? null) : null;
}

/** A source a new subscription can be made from: live and alerting, or carried by one (IOTA). */
export function pickableSource(id: string | null): SourceInfo | null {
  return LIVE_SOURCES.find((s) => s.id === id) ?? null;
}

/**
 * RBN spots only pass a group of rules that names stations, and the database refuses an RBN-only
 * subscription unless every group does (subscriptions_rbn_needs_callsign). The page says so before saving.
 */
export function needsCallsign(sources: string[], rules: Rules): boolean {
  return sources.length === 1 && sources[0] === "rbn" && !namesStations(rules);
}

/**
 * A new subscription on one source, filtered to a callsign (a profile's Get alerts), else a group id (a group's),
 * else one reference exactly (a reference page's).
 */
/**
 * A new subscription on one source. IOTA starts on DX Cluster, its carrier, with an island rule for
 * every continent (Any island) beside any callsign, group or reference it starts with.
 */
export function blankSub(source: string, callsign?: string | null, group?: string | null, reference?: string | null): SubscriptionInput {
  const iota = source === "iota";
  const start: Rule[] = callsign ? [{ field: "callsign", op: "is", values: [callsign] }]
    : group ? [{ field: "group", op: "is", values: [group] }]
    : reference ? [{ field: "reference", op: "is", values: [reference] }] : [];
  const rules: Rule[] = iota ? [...start, { field: "island", op: "is", values: islandValues([ANY_ISLAND]) }] : start;
  return {
    name: callsign ? `${callsign} on the air` : reference && !group ? `Activators at ${reference}` : "", enabled: true,
    sources: [iota ? "dxcluster" : source], rules: rules.length ? [rules] : [], quiet_minutes: 10, destinations: [],
  };
}

export function toInput(s: SubscriptionWithLinks): SubscriptionInput {
  return {
    id: s.id, name: s.name, enabled: s.enabled, sources: s.sources,
    // jsonb in the generated types; written only by normalize_subscription_rules, so it has this shape.
    rules: s.rules as unknown as Rules,
    quiet_minutes: s.quiet_minutes, destinations: s.destinations,
  };
}

/** A subscription's destinations in the order it lists them; ids that no longer resolve are dropped. */
export function linkedDestinations(ids: string[], dests: Destination[]): Destination[] {
  return ids.map((id) => dests.find((d) => d.id === id)).filter((d): d is Destination => d !== undefined);
}

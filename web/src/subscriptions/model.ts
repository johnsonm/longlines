import type { Destination, SubscriptionInput, SubscriptionWithLinks } from "../lib/api";
import type { CallsignGroup } from "../groups/types";
import { LIVE_SOURCES, modeLabel, SOURCES, type SourceInfo } from "../sources/sources";

/**
 * The filter's rule rows. Each maps onto one column of the subscription, so a field appears at
 * most once and rules always combine with "all": spot_matches ANDs the columns and ORs the values
 * inside one.
 */
export type RuleField = "callsign" | "group" | "band" | "mode" | "reference";

export interface FieldInfo {
  id: RuleField;
  label: string;
  condition: string;
}

export const FIELDS: readonly FieldInfo[] = [
  { id: "callsign", label: "Callsign", condition: "is" },
  { id: "group", label: "Callsign group", condition: "is in" },
  { id: "band", label: "Band", condition: "is" },
  { id: "mode", label: "Mode", condition: "is" },
  { id: "reference", label: "Park, summit, or location", condition: "contains" },
];

export function fieldInfo(id: RuleField): FieldInfo {
  return FIELDS.find((f) => f.id === id) ?? FIELDS[0]!;
}

/** Park and summit references exist only on POTA and SOTAwatch spots. */
export function fieldsFor(sources: string[]): RuleField[] {
  const refs = sources.length === 0 || sources.some((s) => s === "pota" || s === "sotawatch");
  return FIELDS.map((f) => f.id).filter((f) => f !== "reference" || refs);
}

export function hasValues(sub: SubscriptionInput, field: RuleField): boolean {
  switch (field) {
    case "callsign": return sub.callsigns.length > 0;
    case "group": return sub.group_ids.length > 0;
    case "band": return sub.bands.length > 0;
    case "mode": return sub.modes.length > 0;
    case "reference": return sub.reference.trim() !== "";
  }
}

/** Fields that hold values, in display order: the rule rows an existing subscription starts with. */
export function rulesOf(sub: SubscriptionInput): RuleField[] {
  return FIELDS.map((f) => f.id).filter((f) => hasValues(sub, f));
}

/** The subscription with one rule's values removed, for deleting a row or changing its field. */
export function clearField(sub: SubscriptionInput, field: RuleField): SubscriptionInput {
  switch (field) {
    case "callsign": return { ...sub, callsigns: [] };
    case "group": return { ...sub, group_ids: [] };
    case "band": return { ...sub, bands: [] };
    case "mode": return { ...sub, modes: [] };
    case "reference": return { ...sub, reference: "" };
  }
}

export interface RuleSummary {
  label: string;
  values: string[];
}

/** "Band is 20m", "Callsign group is in Friends": the card's filter lines. Group names need the group list. */
export function ruleSummaries(sub: SubscriptionInput, groups: Pick<CallsignGroup, "id" | "name">[] | null): RuleSummary[] {
  const out: RuleSummary[] = [];
  for (const field of rulesOf(sub)) {
    const f = fieldInfo(field);
    const label = `${f.label} ${f.condition}`;
    switch (field) {
      case "callsign": out.push({ label, values: sub.callsigns }); break;
      case "group": {
        const names = (groups ?? []).filter((g) => sub.group_ids.includes(g.id)).map((g) => g.name);
        // Left out until the names load, rather than showing ids.
        if (names.length) out.push({ label, values: names });
        break;
      }
      case "band": out.push({ label, values: sub.bands }); break;
      case "mode": out.push({ label, values: sub.modes.map(modeLabel) }); break;
      case "reference": out.push({ label, values: [sub.reference.trim()] }); break;
    }
  }
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

/** A source a new subscription can be made from: live and alerting. */
export function pickableSource(id: string | null): SourceInfo | null {
  return LIVE_SOURCES.find((s) => s.id === id) ?? null;
}

/**
 * RBN spots only match subscriptions that name callsigns, and the database refuses an RBN-only
 * subscription without them (subscriptions_rbn_needs_callsign). The page says so before saving.
 */
export function needsCallsign(sub: SubscriptionInput): boolean {
  return sub.sources.length === 1 && sub.sources[0] === "rbn" && sub.callsigns.length === 0 && sub.group_ids.length === 0;
}

export const blankSub = (source: string): SubscriptionInput => ({
  name: "", enabled: true, sources: [source], bands: [], modes: [], callsigns: [], reference: "", quiet_minutes: 10, destinations: [],
  group_ids: [],
});

export function toInput(s: SubscriptionWithLinks): SubscriptionInput {
  return {
    id: s.id, name: s.name, enabled: s.enabled, sources: s.sources, bands: s.bands, modes: s.modes, callsigns: s.callsigns,
    reference: s.reference, quiet_minutes: s.quiet_minutes, destinations: s.destinations, group_ids: s.group_ids,
  };
}

/** A subscription's destinations in the order it lists them; ids that no longer resolve are dropped. */
export function linkedDestinations(ids: string[], dests: Destination[]): Destination[] {
  return ids.map((id) => dests.find((d) => d.id === id)).filter((d): d is Destination => d !== undefined);
}

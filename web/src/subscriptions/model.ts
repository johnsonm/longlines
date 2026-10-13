import type { SubscriptionInput, SubscriptionWithLinks } from "../lib/api";
import type { CallsignGroup } from "../groups/types";
import { modeLabel, sourceName } from "../sources/sources";

export const PREVIEW_WINDOW = 200;

export const blankSub = (): SubscriptionInput => ({
  name: "", enabled: true, sources: [], bands: [], modes: [], callsigns: [], reference: "", quiet_minutes: 10, destinations: [],
  group_ids: [],
});

export function toInput(s: SubscriptionWithLinks): SubscriptionInput {
  return {
    id: s.id, name: s.name, enabled: s.enabled, sources: s.sources, bands: s.bands, modes: s.modes, callsigns: s.callsigns,
    reference: s.reference, quiet_minutes: s.quiet_minutes, destinations: s.destinations, group_ids: s.group_ids,
  };
}

/** Group names come from list_callsign_groups; null when it didn't load, which leaves the group chips out. */
export function filterChips(sub: SubscriptionInput, groups: Pick<CallsignGroup, "id" | "name">[] | null): string[] {
  const chips: string[] = [];
  chips.push(sub.sources.length ? sub.sources.map(sourceName).join(", ") : "All sources");
  if (sub.bands.length) chips.push(sub.bands.join(", "));
  if (sub.modes.length) chips.push(sub.modes.map(modeLabel).join(", "));
  if (sub.callsigns.length) chips.push(sub.callsigns.join(", "));
  for (const g of groups ?? []) if (sub.group_ids.includes(g.id)) chips.push(`Group: ${g.name}`);
  if (sub.reference) chips.push(`Ref contains ${sub.reference}`);
  if (sub.quiet_minutes) chips.push(`Once per ${sub.quiet_minutes} min`);
  return chips;
}

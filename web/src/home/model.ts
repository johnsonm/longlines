// What the Home page's flow diagram shows: the caller's configuration (every
// connection, the sources it takes spots from, the destinations it sends to and
// destinations nothing sends to yet), labelled and weighted by the last 24 hours.
// Nothing leaves the diagram for being quiet. Counts and each connection's sources
// come from home_flow(); names, types and destination links from the lists every
// signed-in page already has. Geometry is layout.ts's.

import type { Destination, SubscriptionWithLinks } from "../lib/api";
import { SOURCES } from "../sources/sources";
import type { LinkInput } from "./layout";
import type { HomeFlow } from "./types";

/** How many connections the diagram shows; the rest fold into one "N more connections" node. */
export const TOP_CONNECTIONS = 6;

/** A missing number. */
export const DASH = "–";

export interface SourceNode {
  id: string;
  matched: number;
}

export interface ConnectionNode {
  id: string;
  name: string;
  /** Its first source (the one it matched most from, else the first in the catalog), which colours it; null for none. */
  source: string | null;
  /**
   * Null when there is no record to count: the counts didn't load, or the connection is off or has
   * no enabled destination (the matcher skips it) and made no deliveries in the window.
   */
  matched: number | null;
  destinations: number;
}

export interface DestinationNode {
  id: string;
  name: string;
  type: string;
  /** Null when the counts didn't load. */
  delivered: number | null;
}

/** A link and the source whose colour it takes (null: none, drawn grey). */
export interface FlowLink extends LinkInput {
  source: string | null;
}

export interface Flow {
  sources: SourceNode[];
  connections: ConnectionNode[];
  destinations: DestinationNode[];
  /** Sources and destinations only hidden connections use, counted in a "+N more" node. */
  moreSources: number;
  moreDestinations: number;
  /** The connections past TOP_CONNECTIONS; null when none are hidden. */
  moreConnections: { count: number; matched: number } | null;
  sourceLinks: FlowLink[];
  destinationLinks: FlowLink[];
}

/** Every destination with what it was sent in the window, busiest first (the phone's list). */
export function destinationTotals(dests: Destination[], flow: HomeFlow | null): DestinationNode[] {
  const sent = new Map<string, number>();
  for (const l of flow?.links ?? []) sent.set(l.destination_id, (sent.get(l.destination_id) ?? 0) + l.delivered);
  return dests
    .map((d) => ({ id: d.id, name: d.name, type: d.type, delivered: flow ? (sent.get(d.id) ?? 0) : null }))
    .sort((a, b) => (b.delivered ?? 0) - (a.delivered ?? 0) || a.name.localeCompare(b.name));
}

const catalogOrder = (id: string) => {
  const i = SOURCES.findIndex((s) => s.id === id);
  return i < 0 ? SOURCES.length : i;
};

export function buildFlow(subs: SubscriptionWithLinks[], dests: Destination[], flow: HomeFlow | null): Flow {
  const destById = new Map(dests.map((d) => [d.id, d]));

  const matchedBySub = new Map<string, Map<string, number>>();
  for (const r of flow?.subscriptions ?? []) {
    const matched = matchedBySub.get(r.subscription_id) ?? new Map<string, number>();
    matched.set(r.source, r.matched);
    matchedBySub.set(r.subscription_id, matched);
  }
  const sentBySub = new Map<string, Map<string, number>>();
  for (const l of flow?.links ?? []) {
    const sent = sentBySub.get(l.subscription_id) ?? new Map<string, number>();
    sent.set(l.destination_id, l.delivered);
    sentBySub.set(l.subscription_id, sent);
  }
  const configured = new Map<string, string[]>();
  for (const r of flow?.subscription_sources ?? []) configured.set(r.subscription_id, [...(configured.get(r.subscription_id) ?? []), r.source]);

  // A connection's sources as SQL expands them (its own list when the counts didn't load), plus any it
  // matched from in the window since; busiest first, then in catalog order.
  const sourcesOf = (s: SubscriptionWithLinks): { source: string; matched: number }[] => {
    const matched = matchedBySub.get(s.id) ?? new Map<string, number>();
    const ids = new Set([...(flow ? (configured.get(s.id) ?? []) : s.sources), ...matched.keys()]);
    return [...ids]
      .map((source) => ({ source, matched: matched.get(source) ?? 0 }))
      .sort((a, b) => b.matched - a.matched || catalogOrder(a.source) - catalogOrder(b.source));
  };
  const subSources = new Map(subs.map((s) => [s.id, sourcesOf(s)]));

  // The matcher's test for a connection it would deliver for.
  const live = (s: SubscriptionWithLinks) => s.enabled && s.destinations.some((id) => destById.get(id)?.enabled === true);
  const nodes: ConnectionNode[] = subs.map((s) => {
    const matched = matchedBySub.get(s.id);
    const recorded = matched ? [...matched.values()].reduce((n, m) => n + m, 0) : live(s) ? 0 : null;
    return {
      id: s.id, name: s.name, source: subSources.get(s.id)?.[0]?.source ?? null, matched: flow ? recorded : null,
      destinations: s.destinations.length,
    };
  });

  const ranked = [...nodes].sort((a, b) => (b.matched ?? 0) - (a.matched ?? 0) || a.name.localeCompare(b.name));
  const shown = ranked.slice(0, TOP_CONNECTIONS);
  const hidden = ranked.slice(TOP_CONNECTIONS);

  // Grouped under their first source to keep links from crossing: groups in the order their busiest
  // connection ranks, connections without a source last.
  const groups: (string | null)[] = [];
  for (const c of shown) if (c.source !== null && !groups.includes(c.source)) groups.push(c.source);
  groups.push(null);
  const connections = groups.flatMap((g) => shown.filter((c) => c.source === g));

  // Sources in the order the connections first use them.
  const sourceTotals = new Map((flow?.sources ?? []).map((s) => [s.source, s.matched]));
  const sourceIds: string[] = [];
  for (const c of connections) for (const r of subSources.get(c.id) ?? []) if (!sourceIds.includes(r.source)) sourceIds.push(r.source);
  const sources = sourceIds.map((id) => ({ id, matched: sourceTotals.get(id) ?? 0 }));
  const hiddenSources = new Set(hidden.flatMap((c) => (subSources.get(c.id) ?? []).map((r) => r.source)));
  const moreSources = [...hiddenSources].filter((id) => !sourceIds.includes(id)).length;

  // A connection's destinations: the ones it links to, and any it sent to in the window since unlinked.
  const subById = new Map(subs.map((s) => [s.id, s]));
  const linked = (id: string): string[] => {
    const ids = new Set(subById.get(id)?.destinations ?? []);
    for (const d of sentBySub.get(id)?.keys() ?? []) ids.add(d);
    return [...ids].filter((d) => destById.has(d));
  };

  // Destinations the shown connections reach, by the mean row of those connections, then the ones no
  // connection reaches yet.
  const rowsOf = new Map<string, number[]>();
  connections.forEach((c, i) => {
    for (const d of linked(c.id)) rowsOf.set(d, [...(rowsOf.get(d) ?? []), i]);
  });
  const mean = (id: string) => {
    const rows = rowsOf.get(id) ?? [];
    return rows.reduce((a, b) => a + b, 0) / Math.max(rows.length, 1);
  };
  const totals = destinationTotals(dests, flow);
  const reachedByHidden = new Set(hidden.flatMap((c) => linked(c.id)));
  const destinations = [
    ...totals
      .filter((d) => rowsOf.has(d.id))
      .sort((a, b) => mean(a.id) - mean(b.id) || (b.delivered ?? 0) - (a.delivered ?? 0) || a.name.localeCompare(b.name)),
    ...totals.filter((d) => !rowsOf.has(d.id) && !reachedByHidden.has(d.id)).sort((a, b) => a.name.localeCompare(b.name)),
  ];
  const moreDestinations = [...reachedByHidden].filter((id) => !rowsOf.has(id)).length;

  const sourceRow = new Map(sources.map((s, i) => [s.id, i]));
  const destinationRow = new Map(destinations.map((d, i) => [d.id, i]));
  const sourceLinks = connections.flatMap((c, i) =>
    (subSources.get(c.id) ?? []).map((r) => ({ from: sourceRow.get(r.source) ?? 0, to: i, value: r.matched, source: r.source }))
  );
  const destinationLinks = connections.flatMap((c, i) =>
    linked(c.id).map((d) => ({ from: i, to: destinationRow.get(d) ?? 0, value: sentBySub.get(c.id)?.get(d) ?? 0, source: c.source }))
  );

  return {
    sources,
    connections,
    destinations,
    moreSources,
    moreDestinations,
    moreConnections: hidden.length > 0 ? { count: hidden.length, matched: hidden.reduce((n, c) => n + (c.matched ?? 0), 0) } : null,
    sourceLinks,
    destinationLinks,
  };
}

/** An exact count, or an en dash when there is none. */
export function count(n: number | null): string {
  return n === null ? DASH : n.toLocaleString("en-US");
}

const plural = (n: number, word: string) => `${count(n)} ${word}${n === 1 ? "" : "s"}`;

/** "86 matched · 2 destinations", "– matched · No destination". */
export function connectionDetail(c: ConnectionNode): string {
  return `${count(c.matched)} matched · ${c.destinations === 0 ? "No destination" : plural(c.destinations, "destination")}`;
}

const TYPE_LABELS: Record<string, string> = { discord: "Discord", webhook: "Webhook", push: "Push" };

/** "Discord · 131 delivered". */
export function destinationDetail(d: DestinationNode): string {
  return `${TYPE_LABELS[d.type] ?? d.type} · ${count(d.delivered)} delivered`;
}

/** "9 more connections", "1 more connection". */
export function moreConnectionsName(n: number): string {
  return `${count(n)} more connection${n === 1 ? "" : "s"}`;
}

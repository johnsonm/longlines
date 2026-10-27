// What the Home page's flow diagram shows: which sources, connections and
// destinations get a node, in what order, and the links between them. Counts come
// from home_flow(); names, types and links from the lists every signed-in page
// already has. Geometry is layout.ts's.

import type { Destination, SubscriptionWithLinks } from "../lib/api";
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
  /** The spot source it matched most from, which colours it; null when it matched nothing. */
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
  /** Sources and destinations only hidden connections touch, counted in a "+N more" node. */
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

export function buildFlow(subs: SubscriptionWithLinks[], dests: Destination[], flow: HomeFlow | null): Flow {
  const destById = new Map(dests.map((d) => [d.id, d]));

  // Each connection's matched rows by spot source, busiest first.
  const bySub = new Map<string, { source: string; matched: number }[]>();
  for (const r of flow?.subscriptions ?? []) {
    bySub.set(r.subscription_id, [...(bySub.get(r.subscription_id) ?? []), { source: r.source, matched: r.matched }]);
  }
  for (const rows of bySub.values()) rows.sort((a, b) => b.matched - a.matched || a.source.localeCompare(b.source));
  const sentBySub = new Map<string, Map<string, number>>();
  for (const l of flow?.links ?? []) {
    const sent = sentBySub.get(l.subscription_id) ?? new Map<string, number>();
    sent.set(l.destination_id, l.delivered);
    sentBySub.set(l.subscription_id, sent);
  }

  // The matcher's test for a connection it would deliver for.
  const live = (s: SubscriptionWithLinks) => s.enabled && s.destinations.some((id) => destById.get(id)?.enabled === true);
  const nodes: ConnectionNode[] = subs.map((s) => {
    const rows = bySub.get(s.id) ?? [];
    const recorded = rows.length > 0 ? rows.reduce((n, r) => n + r.matched, 0) : live(s) ? 0 : null;
    return { id: s.id, name: s.name, source: rows[0]?.source ?? null, matched: flow ? recorded : null, destinations: s.destinations.length };
  });

  const ranked = [...nodes].sort((a, b) => (b.matched ?? 0) - (a.matched ?? 0) || a.name.localeCompare(b.name));
  const shown = ranked.slice(0, TOP_CONNECTIONS);
  const hidden = ranked.slice(TOP_CONNECTIONS);

  // Grouped under their top source to keep links from crossing: groups in the order their busiest
  // connection ranks, connections that matched nothing last.
  const groups: (string | null)[] = [];
  for (const c of shown) if (c.source !== null && !groups.includes(c.source)) groups.push(c.source);
  groups.push(null);
  const connections = groups.flatMap((g) => shown.filter((c) => c.source === g));

  // Sources in the order the connections first use them.
  const sourceTotals = new Map((flow?.sources ?? []).map((s) => [s.source, s.matched]));
  const sourceIds: string[] = [];
  for (const c of connections) for (const r of bySub.get(c.id) ?? []) if (!sourceIds.includes(r.source)) sourceIds.push(r.source);
  const sources = sourceIds.map((id) => ({ id, matched: sourceTotals.get(id) ?? 0 }));
  const hiddenSources = new Set(hidden.flatMap((c) => (bySub.get(c.id) ?? []).map((r) => r.source)));
  const moreSources = [...hiddenSources].filter((id) => !sourceIds.includes(id)).length;

  // A connection's destinations: the ones it links to, and any it sent to in the window since unlinked.
  const subById = new Map(subs.map((s) => [s.id, s]));
  const linked = (id: string): string[] => {
    const ids = new Set(subById.get(id)?.destinations ?? []);
    for (const d of sentBySub.get(id)?.keys() ?? []) ids.add(d);
    return [...ids].filter((d) => destById.has(d));
  };

  // Destinations ordered by the mean row of the connections that reach them.
  const rowsOf = new Map<string, number[]>();
  connections.forEach((c, i) => {
    for (const d of linked(c.id)) rowsOf.set(d, [...(rowsOf.get(d) ?? []), i]);
  });
  const mean = (id: string) => {
    const rows = rowsOf.get(id) ?? [];
    return rows.reduce((a, b) => a + b, 0) / Math.max(rows.length, 1);
  };
  const destinations = destinationTotals(dests, flow)
    .filter((d) => rowsOf.has(d.id))
    .sort((a, b) => mean(a.id) - mean(b.id) || (b.delivered ?? 0) - (a.delivered ?? 0) || a.name.localeCompare(b.name));
  const hiddenDestinations = new Set(hidden.flatMap((c) => linked(c.id)));
  const moreDestinations = [...hiddenDestinations].filter((id) => !rowsOf.has(id)).length;

  const sourceRow = new Map(sources.map((s, i) => [s.id, i]));
  const destinationRow = new Map(destinations.map((d, i) => [d.id, i]));
  const sourceLinks = connections.flatMap((c, i) =>
    (bySub.get(c.id) ?? []).map((r) => ({ from: sourceRow.get(r.source) ?? 0, to: i, value: r.matched, source: r.source }))
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

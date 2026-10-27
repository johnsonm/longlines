import { describe, expect, it } from "vitest";
import type { Destination, SubscriptionWithLinks } from "../lib/api";
import {
  buildFlow, connectionDetail, count, destinationDetail, destinationTotals, moreConnectionsName, TOP_CONNECTIONS,
} from "./model";
import type { HomeFlow } from "./types";

const dest = (id: string, type = "discord", enabled = true) => ({ id, name: `Dest ${id}`, type, enabled }) as Destination;
const sub = (id: string, destinations: string[], enabled = true, sources: string[] = []) =>
  ({ id, name: `Conn ${id}`, enabled, destinations, sources }) as SubscriptionWithLinks;

function flow(
  subscriptions: [string, string, number][],
  links: [string, string, number][] = [],
  sources: [string, number][] = [],
  configured: [string, string][] = [],
): HomeFlow {
  return {
    matched: 0,
    delivered: 0,
    sources: sources.map(([source, matched]) => ({ source, matched })),
    subscriptions: subscriptions.map(([subscription_id, source, matched]) => ({ subscription_id, source, matched })),
    links: links.map(([subscription_id, destination_id, delivered]) => ({ subscription_id, destination_id, delivered })),
    subscription_sources: configured.map(([subscription_id, source]) => ({ subscription_id, source })),
  };
}

describe("buildFlow: connections", () => {
  const dests = [dest("d1"), dest("off", "webhook", false)];

  it("sums a connection's matched spots over its sources and colours it by the busiest", () => {
    const f = buildFlow([sub("a", ["d1"])], dests, flow([["a", "pota", 3], ["a", "rbn", 9]]));
    expect(f.connections).toEqual([{ id: "a", name: "Conn a", source: "rbn", matched: 12, destinations: 1 }]);
  });

  it("counts zero for a live connection with no deliveries and nothing for one the matcher skips", () => {
    const subs = [sub("live", ["d1"]), sub("off", ["d1"], false), sub("nowhere", []), sub("disabled-dest", ["off"])];
    const f = buildFlow(subs, dests, flow([]));
    expect(Object.fromEntries(f.connections.map((c) => [c.id, c.matched]))).toEqual({
      live: 0, off: null, nowhere: null, "disabled-dest": null,
    });
    expect(f.connections.every((c) => c.source === null)).toBe(true);
  });

  it("keeps a number a connection recorded before it stopped being live", () => {
    const f = buildFlow([sub("off", ["d1"], false)], dests, flow([["off", "pota", 4]]));
    expect(f.connections[0]?.matched).toBe(4);
  });

  it("has no numbers when the counts didn't load", () => {
    const f = buildFlow([sub("a", ["d1"])], dests, null);
    expect(f.connections[0]?.matched).toBeNull();
    expect(f.destinations[0]?.delivered).toBeNull();
  });

  it(`shows the top ${TOP_CONNECTIONS} by matched and folds the rest into one node`, () => {
    const subs = Array.from({ length: 9 }, (_, i) => sub(`c${i}`, ["d1"]));
    const f = buildFlow(subs, dests, flow(subs.map((s, i) => [s.id, "pota", 100 - i])));
    expect(f.connections.map((c) => c.id)).toEqual(["c0", "c1", "c2", "c3", "c4", "c5"]);
    expect(f.moreConnections).toEqual({ count: 3, matched: 94 + 93 + 92 });
  });

  it("has no more node when everything fits", () => {
    expect(buildFlow([sub("a", ["d1"])], dests, flow([])).moreConnections).toBeNull();
  });

  it("groups connections under their source in the order each group's busiest ranks, idle ones last", () => {
    const subs = [sub("p50", ["d1"]), sub("dx40", ["d1"]), sub("p30", ["d1"]), sub("idle", ["d1"])];
    const f = buildFlow(subs, dests, flow([["p50", "pota", 50], ["dx40", "dxcluster", 40], ["p30", "pota", 30]]));
    expect(f.connections.map((c) => c.id)).toEqual(["p50", "p30", "dx40", "idle"]);
  });

  it("breaks ties by name", () => {
    const f = buildFlow([sub("b", ["d1"]), sub("a", ["d1"])], dests, flow([]));
    expect(f.connections.map((c) => c.id)).toEqual(["a", "b"]);
  });
});

describe("buildFlow: sources", () => {
  it("lists the sources visible connections matched from, in the order they are first used, with true totals", () => {
    const subs = [sub("a", ["d1"]), sub("b", ["d1"])];
    const f = buildFlow(subs, [dest("d1")], flow([["a", "pota", 9], ["b", "rbn", 5], ["a", "sotawatch", 1]], [], [["pota", 12], ["rbn", 5], ["sotawatch", 1]]));
    expect(f.sources).toEqual([{ id: "pota", matched: 12 }, { id: "sotawatch", matched: 1 }, { id: "rbn", matched: 5 }]);
    expect(f.sourceLinks).toEqual([
      { from: 0, to: 0, value: 9, source: "pota" },
      { from: 1, to: 0, value: 1, source: "sotawatch" },
      { from: 2, to: 1, value: 5, source: "rbn" },
    ]);
  });

  it("counts sources only hidden connections touch", () => {
    const subs = Array.from({ length: 8 }, (_, i) => sub(`c${i}`, []));
    const rows: [string, string, number][] = subs.map((s, i) => [s.id, "pota", 100 - i]);
    rows.push(["c6", "rbn", 1], ["c7", "wwff", 1]);
    const f = buildFlow(subs, [], flow(rows));
    expect(f.sources.map((s) => s.id)).toEqual(["pota"]);
    expect(f.moreSources).toBe(2);
  });
});

describe("buildFlow: destinations", () => {
  it("shows destinations visible connections link to, ordered by where those connections sit, with true totals", () => {
    const dests = [dest("top"), dest("bottom"), dest("shared")];
    const subs = [sub("a", ["bottom", "shared"]), sub("b", ["top", "shared"])];
    const f = buildFlow(subs, dests, flow([["a", "pota", 9], ["b", "pota", 3]], [["a", "bottom", 4], ["b", "shared", 2]]));
    // a is row 0 and b row 1: bottom (mean 0), shared (mean 0.5), top (mean 1).
    expect(f.destinations.map((d) => [d.id, d.delivered])).toEqual([["bottom", 4], ["shared", 2], ["top", 0]]);
    expect(f.destinationLinks).toEqual([
      { from: 0, to: 0, value: 4, source: "pota" },
      { from: 0, to: 1, value: 0, source: "pota" },
      { from: 1, to: 2, value: 0, source: "pota" },
      { from: 1, to: 1, value: 2, source: "pota" },
    ]);
  });

  it("draws a link a connection sent through in the window though it is unlinked now", () => {
    const f = buildFlow([sub("a", [])], [dest("d1")], flow([["a", "pota", 2]], [["a", "d1", 2]]));
    expect(f.destinations.map((d) => d.id)).toEqual(["d1"]);
    expect(f.destinationLinks).toEqual([{ from: 0, to: 0, value: 2, source: "pota" }]);
  });

  it("ignores links to destinations it doesn't know", () => {
    const f = buildFlow([sub("a", ["gone"])], [], flow([], [["a", "gone", 1]]));
    expect(f.destinations).toEqual([]);
    expect(f.destinationLinks).toEqual([]);
  });

  it("counts destinations only hidden connections reach, and totals include hidden connections", () => {
    const dests = [dest("seen"), dest("hidden")];
    const subs = Array.from({ length: 7 }, (_, i) => sub(`c${i}`, i === 6 ? ["hidden", "seen"] : ["seen"]));
    const f = buildFlow(subs, dests, flow(subs.map((s, i) => [s.id, "pota", 100 - i]), [["c0", "seen", 1], ["c6", "seen", 5]]));
    expect(f.destinations.map((d) => [d.id, d.delivered])).toEqual([["seen", 6]]);
    expect(f.moreDestinations).toBe(1);
  });
});

describe("buildFlow: configuration, traffic or not", () => {
  it("links a quiet connection to every source it takes spots from, at the thinnest width", () => {
    const f = buildFlow([sub("a", ["d1"])], [dest("d1")], flow([], [], [], [["a", "sotawatch"], ["a", "pota"]]));
    expect(f.sources).toEqual([{ id: "pota", matched: 0 }, { id: "sotawatch", matched: 0 }]);
    expect(f.sourceLinks).toEqual([
      { from: 0, to: 0, value: 0, source: "pota" },
      { from: 1, to: 0, value: 0, source: "sotawatch" },
    ]);
    // Coloured by its first source in catalog order while nothing has matched.
    expect(f.connections[0]?.source).toBe("pota");
    expect(f.destinationLinks).toEqual([{ from: 0, to: 0, value: 0, source: "pota" }]);
  });

  it("takes a connection's sources from SQL, not its own list, so any source reads as SQL expands it", () => {
    const f = buildFlow([sub("any", ["d1"], true, [])], [dest("d1")], flow([], [], [], [["any", "pota"], ["any", "sotawatch"], ["any", "rbn"]]));
    expect(f.sources.map((s) => s.id)).toEqual(["pota", "sotawatch", "rbn"]);
  });

  it("falls back to the connection's own list when the counts didn't load", () => {
    const f = buildFlow([sub("a", ["d1"], true, ["dxcluster"]), sub("any", ["d1"], true, [])], [dest("d1")], null);
    expect(f.sources.map((s) => s.id)).toEqual(["dxcluster"]);
    expect(f.connections.find((c) => c.id === "any")?.source).toBeNull();
  });

  it("puts the busiest source first and keeps one it matched from that is no longer configured", () => {
    const f = buildFlow([sub("a", ["d1"])], [dest("d1")], flow([["a", "rbn", 3], ["a", "wwff", 7]], [], [], [["a", "pota"], ["a", "rbn"]]));
    expect(f.sourceLinks.map((l) => [l.source, l.value])).toEqual([["wwff", 7], ["rbn", 3], ["pota", 0]]);
    expect(f.connections[0]?.source).toBe("wwff");
  });

  it("shows destinations no connection reaches yet after the linked ones, with no links", () => {
    const dests = [dest("spare-b"), dest("linked"), dest("spare-a")];
    const f = buildFlow([sub("a", ["linked"])], dests, flow([], [], [], [["a", "pota"]]));
    expect(f.destinations.map((d) => d.id)).toEqual(["linked", "spare-a", "spare-b"]);
    expect(f.destinationLinks.map((l) => l.to)).toEqual([0]);
    expect(f.moreDestinations).toBe(0);
  });
});

describe("destinationTotals", () => {
  it("lists every destination, busiest first, then by name", () => {
    const totals = destinationTotals([dest("b"), dest("a"), dest("c")], flow([], [["x", "c", 3], ["y", "c", 1], ["x", "b", 0]]));
    expect(totals.map((d) => [d.id, d.delivered])).toEqual([["c", 4], ["a", 0], ["b", 0]]);
  });
});

describe("copy", () => {
  it("writes exact counts, and an en dash for a missing one", () => {
    expect(count(1234)).toBe("1,234");
    expect(count(0)).toBe("0");
    expect(count(null)).toBe("–");
  });

  it("words a connection's caption", () => {
    const c = { id: "a", name: "A", source: null, matched: 86, destinations: 2 };
    expect(connectionDetail(c)).toBe("86 matched · 2 destinations");
    expect(connectionDetail({ ...c, destinations: 1 })).toBe("86 matched · 1 destination");
    expect(connectionDetail({ ...c, matched: null, destinations: 0 })).toBe("– matched · No destination");
  });

  it("words a destination's caption by type", () => {
    expect(destinationDetail({ id: "d", name: "D", type: "discord", delivered: 131 })).toBe("Discord · 131 delivered");
    expect(destinationDetail({ id: "d", name: "D", type: "push", delivered: null })).toBe("Push · – delivered");
    expect(destinationDetail({ id: "d", name: "D", type: "webhook", delivered: 49 })).toBe("Webhook · 49 delivered");
    expect(destinationDetail({ id: "d", name: "D", type: "pager", delivered: 1 })).toBe("pager · 1 delivered");
  });

  it("names the more node", () => {
    expect(moreConnectionsName(9)).toBe("9 more connections");
    expect(moreConnectionsName(1)).toBe("1 more connection");
  });
});

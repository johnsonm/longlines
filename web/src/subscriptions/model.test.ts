import { describe, expect, it } from "vitest";
import type { Destination, SubscriptionWithLinks } from "../lib/api";
import {
  blankSub, clearField, fieldInfo, fieldsFor, linkedDestinations, needsCallsign, pickableSource, quietLabel, ruleSummaries, rulesOf,
  singleSource, toInput,
} from "./model";

const GROUPS = [{ id: "g1", name: "Friends" }, { id: "g2", name: "RARS members" }, { id: "g3", name: "Unused" }];

describe("blankSub and toInput", () => {
  it("starts a new subscription on one source with no rules or destinations", () => {
    const sub = blankSub("pota");
    expect(sub.sources).toEqual(["pota"]);
    expect(rulesOf(sub)).toEqual([]);
    expect(sub.destinations).toEqual([]);
  });

  it("carries a subscription's groups into the editor", () => {
    const row = { id: "s1", name: "Club", group_ids: ["g2"], callsigns: [] } as unknown as SubscriptionWithLinks;
    expect(toInput(row).group_ids).toEqual(["g2"]);
  });
});

describe("rules", () => {
  const sub = { ...blankSub("pota"), callsigns: ["W1AW"], bands: ["20m"], modes: ["digital"], reference: " US-NC ", group_ids: ["g2", "g1"] };

  it("lists the fields that hold values, in display order", () => {
    expect(rulesOf(sub)).toEqual(["callsign", "group", "band", "mode", "reference"]);
    expect(rulesOf({ ...blankSub("pota"), reference: "  " })).toEqual([]);
  });

  it("clears one field at a time", () => {
    expect(rulesOf(clearField(sub, "callsign"))).not.toContain("callsign");
    expect(rulesOf(clearField(sub, "group"))).not.toContain("group");
    expect(rulesOf(clearField(sub, "band"))).not.toContain("band");
    expect(rulesOf(clearField(sub, "mode"))).not.toContain("mode");
    expect(rulesOf(clearField(sub, "reference"))).toEqual(["callsign", "group", "band", "mode"]);
  });

  it("offers park and summit references only on POTA and SOTAwatch", () => {
    expect(fieldsFor(["pota"])).toContain("reference");
    expect(fieldsFor(["sotawatch"])).toContain("reference");
    expect(fieldsFor([])).toContain("reference");
    expect(fieldsFor(["rbn"])).toEqual(["callsign", "group", "band", "mode"]);
  });

  it("summarizes each rule with its condition, groups by name in the list's order", () => {
    expect(ruleSummaries(sub, GROUPS)).toEqual([
      { label: "Callsign is", values: ["W1AW"] },
      { label: "Callsign group is in", values: ["Friends", "RARS members"] },
      { label: "Band is", values: ["20m"] },
      { label: "Mode is", values: ["Any digital"] },
      { label: "Park, summit, or location contains", values: ["US-NC"] },
    ]);
    expect(fieldInfo("group").condition).toBe("is in");
  });

  it("leaves the group rule out until the names load", () => {
    expect(ruleSummaries({ ...blankSub("pota"), group_ids: ["g1"] }, null)).toEqual([]);
  });
});

describe("sources", () => {
  it("finds the one source, and none for several or any", () => {
    expect(singleSource(["rbn"])?.title).toBe("Reverse Beacon Network");
    expect(singleSource(["pota", "rbn"])).toBeNull();
    expect(singleSource([])).toBeNull();
  });

  it("lets new subscriptions start only from live alerting sources", () => {
    expect(pickableSource("dxcluster")?.id).toBe("dxcluster");
    expect(pickableSource("aprs")).toBeNull();
    expect(pickableSource("wwff")).toBeNull();
    expect(pickableSource(null)).toBeNull();
  });

  it("needs a callsign or group on an RBN-only subscription", () => {
    expect(needsCallsign(blankSub("rbn"))).toBe(true);
    expect(needsCallsign({ ...blankSub("rbn"), callsigns: ["W1AW"] })).toBe(false);
    expect(needsCallsign({ ...blankSub("rbn"), group_ids: ["g1"] })).toBe(false);
    expect(needsCallsign(blankSub("pota"))).toBe(false);
    expect(needsCallsign({ ...blankSub("rbn"), sources: ["rbn", "pota"] })).toBe(false);
  });
});

describe("labels and links", () => {
  it("shortens the repeat window", () => {
    expect(quietLabel(0)).toBe("Every spot");
    expect(quietLabel(30)).toBe("Once per 30 min");
  });

  it("resolves destinations in the subscription's order and drops missing ones", () => {
    const dests = [{ id: "d1", name: "A" }, { id: "d2", name: "B" }] as Destination[];
    expect(linkedDestinations(["d2", "gone", "d1"], dests).map((d) => d.name)).toEqual(["B", "A"]);
  });
});

import { describe, expect, it } from "vitest";
import type { Destination, SubscriptionWithLinks } from "../lib/api";
import {
  ANY_ISLAND, blankSub, CONTINENTS, fieldInfo, fieldsFor, hasPositiveRule, islandValues, linkedDestinations, namesStations, needsCallsign,
  newRow, opLabel, parseKhz, pickableSource, picksStations, quietLabel, referenceValues, rowInvalid, rowsOf, ruleSummaries, rulesOf, singleSource, toInput,
  usesIslandRule, withField, type Rule, type RuleOp, type RuleRow,
} from "./model";

const GROUPS = [{ id: "g1", name: "Friends" }, { id: "g2", name: "RARS members" }, { id: "g3", name: "Unused" }];

describe("blankSub and toInput", () => {
  it("starts a new subscription on one source with no rules or destinations", () => {
    const sub = blankSub("pota");
    expect(sub.sources).toEqual(["pota"]);
    expect(sub.rules).toEqual([]);
    expect(sub.destinations).toEqual([]);
  });

  it("starts a profile's Get alerts filtered to that callsign", () => {
    const sub = blankSub("rbn", "KK4PWJ");
    expect(sub.name).toBe("KK4PWJ on the air");
    expect(sub.sources).toEqual(["rbn"]);
    expect(sub.rules).toEqual([[{ field: "callsign", op: "is", values: ["KK4PWJ"] }]]);
  });

  it("starts a group's Get alerts filtered to that group, unnamed until the editor knows the group's name", () => {
    const sub = blankSub("pota", null, "g1");
    expect(sub.name).toBe("");
    expect(sub.rules).toEqual([[{ field: "group", op: "is", values: ["g1"] }]]);
  });

  it("starts a reference page's Get alerts filtered to exactly that reference", () => {
    const sub = blankSub("sotawatch", null, null, "W4C/CM-001");
    expect(sub.name).toBe("Activators at W4C/CM-001");
    expect(sub.rules).toEqual([[{ field: "reference", op: "is", values: ["W4C/CM-001"] }]]);
    // A callsign or a group wins over a reference.
    expect(blankSub("pota", null, "g1", "US-2763").rules).toEqual([[{ field: "group", op: "is", values: ["g1"] }]]);
    expect(blankSub("pota", null, "g1", "US-2763").name).toBe("");
  });

  it("reads exact reference values trimmed and upper-cased, each once", () => {
    expect(referenceValues([" us-2763 ", "US-2763", "", "w4c/cm-001"])).toEqual(["US-2763", "W4C/CM-001"]);
    // A list typed or pasted as one value is one chip per reference.
    expect(referenceValues(["us-1000, us-1001", "US-1000;\tw4c/cm-001"])).toEqual(["US-1000", "US-1001", "W4C/CM-001"]);
    const ref = (op: RuleOp, ...values: string[]): RuleRow => ({ key: 1, join: "and", field: "reference", op, values });
    expect(rulesOf([ref("is", "us-1000, us-1001")])).toEqual([[{ field: "reference", op: "is", values: ["US-1000", "US-1001"] }]]);
    expect(rowInvalid(ref("is", "US_1000"))).toBe(true);
    expect(rowInvalid(ref("is_not", "w4c/cm-001"))).toBe(false);
    expect(rowInvalid(ref("is", "A".repeat(65)))).toBe(true);
    // Contains keeps partial text as typed.
    expect(rowInvalid(ref("contains", "US NC"))).toBe(false);
    expect(opLabel("reference", "is")).toBe("is");
    expect(opLabel("reference", "is_not")).toBe("is not");
  });

  it("carries a subscription's rules into the editor", () => {
    const rules = [[{ field: "group", op: "is", values: ["g2"] }]];
    const row = { id: "s1", name: "Club", rules, group_ids: ["g2"] } as unknown as SubscriptionWithLinks;
    expect(toInput(row).rules).toEqual(rules);
  });
});

const rule = (field: Rule["field"], op: Rule["op"], ...values: (string | number)[]): Rule => ({ field, op, values });
const row = (join: "and" | "or", field: Rule["field"], op: Rule["op"], ...values: string[]) =>
  ({ ...withField(newRow([field], []), field), join, op, values });

describe("rows and rules", () => {
  it("binds And tighter than Or", () => {
    const rows = [row("and", "band", "is", "20m"), row("and", "mode", "is", "cw"), row("or", "callsign", "is", "W1AW")];
    expect(rulesOf(rows)).toEqual([
      [rule("band", "is", "20m"), rule("mode", "is", "cw")],
      [rule("callsign", "is", "W1AW")],
    ]);
    // The first row's join means nothing.
    expect(rulesOf([{ ...rows[0]!, join: "or" }])).toEqual([[rule("band", "is", "20m")]]);
  });

  it("round-trips stored rules through rows", () => {
    const rules = [[rule("callsign", "is_not", "W1AW"), rule("frequency", "gt", 14000)], [rule("reference", "contains", "US-NC")]];
    const rows = rowsOf(rules);
    expect(rows.map((r) => r.join)).toEqual(["and", "and", "or"]);
    expect(rows[1]!.values).toEqual(["14000"]);
    expect(rulesOf(rows)).toEqual(rules);
    expect(new Set(rows.map((r) => r.key)).size).toBe(3);
  });

  it("leaves out rows without values, and groups left with none", () => {
    const rows = [row("and", "band", "is", "20m"), row("or", "callsign", "is"), row("and", "reference", "contains", "  ")];
    expect(rulesOf(rows)).toEqual([[rule("band", "is", "20m")]]);
    expect(rulesOf([row("and", "mode", "is")])).toEqual([]);
  });

  it("stores a frequency as a number and flags one that isn't", () => {
    expect(rulesOf([row("and", "frequency", "lt", " 7074.5 ")])).toEqual([[rule("frequency", "lt", 7074.5)]]);
    expect(parseKhz("0")).toBeNull();
    expect(parseKhz("14.074.0")).toBeNull();
    const bad = row("and", "frequency", "is", "14 MHz");
    expect(rowInvalid(bad)).toBe(true);
    expect(rulesOf([bad])).toEqual([]);
    expect(rowInvalid(row("and", "frequency", "is"))).toBe(false);
    expect(rowInvalid(row("and", "band", "is", "abc"))).toBe(false);
  });

  it("resets the condition and values when the field changes", () => {
    const r = withField(row("or", "frequency", "gt", "14000"), "reference");
    expect([r.join, r.op, r.values]).toEqual(["or", "is", []]);
  });

  it("starts a new row on the first field not used yet", () => {
    const rows = [row("and", "callsign", "is", "W1AW")];
    expect(newRow(["callsign", "band"], rows, "or")).toMatchObject({ field: "band", op: "is", join: "or", values: [] });
    expect(newRow(["callsign"], rows).field).toBe("callsign");
  });

  it("offers each field its own conditions", () => {
    expect(fieldInfo("frequency").ops).toEqual(["is", "is_not", "gt", "lt"]);
    expect(fieldInfo("reference").ops).toEqual(["is", "is_not", "contains", "not_contains"]);
    expect(fieldInfo("band").ops).toEqual(["is", "is_not"]);
    expect(opLabel("group", "is_not")).toBe("is not in");
    expect(opLabel("frequency", "gt")).toBe("is greater than");
    expect(opLabel("reference", "not_contains")).toBe("does not contain");
  });

  it("offers references only on POTA, SOTAwatch and WWFF", () => {
    expect(fieldsFor(["pota"])).toContain("reference");
    expect(fieldsFor(["sotawatch"])).toContain("reference");
    expect(fieldsFor(["wwff"])).toContain("reference");
    expect(fieldsFor(["dxcluster", "wwff"])).toContain("reference");
    expect(fieldsFor(["wwbota"])).toContain("reference");
    expect(fieldsFor([])).toContain("reference");
    expect(fieldsFor(["rbn"])).toEqual(["callsign", "group", "band", "mode", "frequency"]);
  });

  it("offers the island rule only on DX Cluster, whose spots carry IOTA references", () => {
    expect(fieldsFor(["dxcluster"])).toEqual(["callsign", "group", "band", "mode", "reference", "frequency", "island"]);
    expect(fieldsFor([])).not.toContain("island");
    expect(fieldsFor(["pota", "wwff"])).not.toContain("island");
    expect(opLabel("island", "is_not")).toBe("is not");
  });

  it("reads island values as references or continents, with Any island as all seven", () => {
    expect(islandValues([" eu-005 ", "na", "EU-005"])).toEqual(["EU-005", "NA"]);
    expect(islandValues(["EU-005", "EU", ANY_ISLAND])).toEqual(["AF", "AN", "AS", "EU", "NA", "OC", "SA"]);
    expect(CONTINENTS.map((c) => c.code)).toEqual(["AF", "AN", "AS", "EU", "NA", "OC", "SA"]);
    const row = (values: string[]): RuleRow => ({ key: 1, join: "and", field: "island", op: "is", values });
    expect(rowInvalid(row(["EU-005", "oc"]))).toBe(false);
    expect(rowInvalid(row([]))).toBe(false);
    expect(rowInvalid(row(["EU5"]))).toBe(true);
    expect(rowInvalid(row(["Europe"]))).toBe(true);
    expect(rulesOf([row(["eu-005", "oc"])])).toEqual([[{ field: "island", op: "is", values: ["EU-005", "OC"] }]]);
    expect(rulesOf([row([" "])])).toEqual([]);
  });

  it("tells whether a connection tests the island", () => {
    expect(usesIslandRule([[{ field: "band", op: "is", values: ["20m"] }], [{ field: "island", op: "is_not", values: ["EU"] }]])).toBe(true);
    expect(usesIslandRule([[{ field: "band", op: "is", values: ["20m"] }]])).toBe(false);
    expect(usesIslandRule([])).toBe(false);
  });
});

describe("rule summaries", () => {
  const rules = [
    [rule("callsign", "is", "W1AW"), rule("group", "is", "g2", "g1"), rule("mode", "is_not", "digital")],
    [rule("reference", "contains", "US-NC"), rule("frequency", "lt", 7100)],
  ];

  it("joins each rule to the one before, groups by name in the list's order", () => {
    expect(ruleSummaries(rules, GROUPS)).toEqual([
      { join: null, label: "Callsign is", values: ["W1AW"] },
      { join: "and", label: "Callsign group is in", values: ["Friends", "RARS members"] },
      { join: "and", label: "Mode is not", values: ["Any digital"] },
      { join: "or", label: "Park, summit, or location contains", values: ["US-NC"] },
      { join: "and", label: "Frequency (kHz) is less than", values: ["7100"] },
    ]);
  });

  it("leaves group names out until they load", () => {
    expect(ruleSummaries([[rule("group", "is", "g1")]], null)).toEqual([{ join: null, label: "Callsign group is in", values: [] }]);
  });

  it("finds rules that pick a call or a group outright", () => {
    expect(hasPositiveRule(rules, "callsign", "W1AW")).toBe(true);
    expect(hasPositiveRule([[rule("callsign", "is_not", "W1AW")]], "callsign", "W1AW")).toBe(false);
    expect(hasPositiveRule(rules, "group", "g1")).toBe(true);
    expect(picksStations(rules)).toBe(true);
    expect(picksStations([[rule("group", "is_not", "g1")]])).toBe(false);
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
    expect(pickableSource("wwff")?.id).toBe("wwff");
    expect(pickableSource("wwbota")?.id).toBe("wwbota");
    // IOTA rides on DX Cluster: a connection picks DX Cluster and an island rule.
    expect(pickableSource("iota")).toBeNull();
    expect(pickableSource(null)).toBeNull();
  });

  it("needs a callsign or group in every Or of an RBN-only subscription", () => {
    const calls = [rule("callsign", "is", "W1AW")];
    expect(needsCallsign(["rbn"], [])).toBe(true);
    expect(needsCallsign(["rbn"], [calls])).toBe(false);
    expect(needsCallsign(["rbn"], [[rule("group", "is", "g1"), rule("band", "is", "20m")]])).toBe(false);
    expect(needsCallsign(["rbn"], [[rule("callsign", "is_not", "W1AW")]])).toBe(true);
    expect(needsCallsign(["rbn"], [calls, [rule("mode", "is", "cw")]])).toBe(true);
    expect(namesStations([calls, calls])).toBe(true);
    expect(needsCallsign(["pota"], [])).toBe(false);
    expect(needsCallsign(["rbn", "pota"], [])).toBe(false);
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

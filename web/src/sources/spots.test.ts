import { describe, expect, it } from "vitest";
import type { RecentSpot } from "../lib/api";
import { spotReference } from "./spots";

const spot = (refs: Partial<RecentSpot>) =>
  ({ pota_reference: null, sota_summit_ref: null, wwff_reference: null, wwbota_references: null, ...refs }) as RecentSpot;

describe("spotReference", () => {
  it("shows the park, summit or WWFF reference, whichever the spot has", () => {
    expect(spotReference(spot({ pota_reference: "US-0817" }))).toBe("US-0817");
    expect(spotReference(spot({ sota_summit_ref: "W4C/CM-001" }))).toBe("W4C/CM-001");
    expect(spotReference(spot({ wwff_reference: "KFF-5268" }))).toBe("KFF-5268");
  });

  it("shows a WWBOTA spot's first bunker", () => {
    expect(spotReference(spot({ wwbota_references: ["B/EA-0103", "B/EA-0104"] }))).toBe("B/EA-0103");
    expect(spotReference(spot({ wwbota_references: [] }))).toBe("");
  });

  it("is blank for a spot with no reference", () => {
    expect(spotReference(spot({}))).toBe("");
  });
});

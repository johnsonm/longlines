import { describe, expect, it } from "vitest";
import type { RecentSpot } from "../lib/api";
import { spotKhz, spotReference, spotTuning } from "./spots";

const spot = (refs: Partial<RecentSpot>) =>
  ({ pota_reference: null, sota_summit_ref: null, wwff_reference: null, wwbota_references: null, iota_reference: null, ...refs }) as RecentSpot;

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

  it("shows a DX Cluster spot's IOTA reference", () => {
    expect(spotReference(spot({ iota_reference: "EU-005" }))).toBe("EU-005");
  });

  it("is blank for a spot with no reference", () => {
    expect(spotReference(spot({}))).toBe("");
  });
});

describe("spotTuning", () => {
  it("shows the frequency and mode", () => {
    expect(spotTuning({ frequency_khz: 14062, mode: "cw" })).toBe("14062.0 kHz CW");
    expect(spotKhz({ frequency_khz: 7138.5 })).toBe("7138.5");
  });

  it("leaves out what the spot lacks, so an APRS-IS spot is blank", () => {
    expect(spotTuning({ frequency_khz: 14062, mode: null })).toBe("14062.0 kHz");
    expect(spotTuning({ frequency_khz: null, mode: null })).toBe("");
    expect(spotKhz({ frequency_khz: null })).toBeNull();
  });
});

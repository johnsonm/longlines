import { describe, expect, it } from "vitest";
import {
  activationsDetail, dateLabel, frequencyLabel, lastHeardDetail, lastHeardSpot, lastHeardWhen, lookupPath, monthLabel,
  noLicenseMessage, onAirNow, otherForms, placeLabel, plural, profileUrl, qrzUrl, shortDay, sourceSeries, sourcesDetail,
  spotRows, totalActivations, usStates,
} from "./format";
import type { HeardProfile } from "./types";

const NOW = new Date("2026-10-12T18:00:00Z");

describe("profile format", () => {
  it("pluralizes counts", () => {
    expect(plural(1, "park", "parks")).toBe("1 park");
    expect(plural(1200, "park", "parks")).toBe("1,200 parks");
    expect(plural(0, "park", "parks")).toBe("0 parks");
  });

  it("builds the lookup path from input as typed, uppercased", () => {
    expect(lookupPath(" kk4pwj ")).toBe("/call/KK4PWJ");
    expect(lookupPath("kk4pwj/p")).toBe("/call/KK4PWJ/P");
    expect(lookupPath("kk4 pwj")).toBe("/call/KK4%20PWJ");
    expect(lookupPath("   ")).toBeNull();
  });

  it("builds the canonical URL", () => {
    expect(profileUrl("https://longlines.app", "KK4PWJ")).toBe("https://longlines.app/call/KK4PWJ");
  });

  it("formats days and months", () => {
    expect(dateLabel("2026-10-05")).toBe("Oct 5, 2026");
    expect(monthLabel("2026-10")).toBe("Oct 2026");
    expect(shortDay("2026-10-05")).toBe("10/5");
  });

  it("says how long ago a station was last heard", () => {
    expect(lastHeardWhen("2026-10-12T17:59:40Z", NOW)).toBe("just now (17:59 UTC)");
    expect(lastHeardWhen("2026-10-12T17:58:00Z", NOW)).toBe("2 min ago (17:58 UTC)");
    expect(lastHeardWhen("2026-10-12T14:32:10Z", NOW)).toBe("3 h ago (14:32 UTC)");
    expect(lastHeardWhen("2026-10-05T09:05:00Z", NOW)).toBe("Oct 5 (09:05 UTC)");
    expect(lastHeardWhen("2025-12-31T00:00:00Z", NOW)).toBe("Dec 31, 2025 (00:00 UTC)");
  });

  it("is on the air now for half an hour after a spot", () => {
    expect(onAirNow("2026-10-12T17:30:00Z", NOW)).toBe(true);
    expect(onAirNow("2026-10-12T17:29:59Z", NOW)).toBe(false);
  });

  it("formats the last frequency in kHz", () => {
    expect(frequencyLabel(14062)).toBe("14062.0 kHz");
    expect(frequencyLabel(7031.25)).toBe("7031.3 kHz");
  });

  it("finds the recent spot behind lastHeard and describes it", () => {
    const spot = { time: "2026-10-12T14:32:00Z", callsign: "KK4PWJ", frequencyKhz: 14062, band: "20m", mode: "cw", reference: "US-0817", source: "pota", spotter: "N4XYZ" };
    const heard = {
      lastHeard: { time: spot.time, frequencyKhz: 14062, mode: "cw" },
      recentSpots: [{ ...spot, frequencyKhz: 7031 }, spot],
      references: [{ reference: "US-0817", name: "Pisgah National Forest" }],
    } as unknown as HeardProfile;
    expect(lastHeardSpot(heard)).toBe(spot);
    expect(lastHeardSpot({ ...heard, recentSpots: [] })).toBeNull();
    expect(lastHeardSpot({ ...heard, lastHeard: null })).toBeNull();
    expect(lastHeardDetail(spot, heard)).toBe("Activating US-0817, Pisgah National Forest. Spotted by N4XYZ.");
    expect(lastHeardDetail({ ...spot, reference: "US-9999" }, heard)).toBe("Activating US-9999. Spotted by N4XYZ.");
    expect(lastHeardDetail({ ...spot, reference: null }, heard)).toBe("Spotted by N4XYZ.");
    expect(lastHeardDetail({ ...spot, reference: null, spotter: null }, heard)).toBe("");
  });

  it("links to the call on QRZ", () => {
    expect(qrzUrl("KK4PWJ")).toBe("https://www.qrz.com/db/KK4PWJ");
  });

  it("names the state from the license, else the country of the prefix", () => {
    const license = { authority: "FCC", name: null, operatorClass: null, status: null, grantedOn: null, expiresOn: null, state: "NC" };
    const country = { name: "England", continent: "EU" };
    expect(placeLabel({ license, country: { name: "United States", continent: "NA" } })).toBe("North Carolina");
    expect(placeLabel({ license: { ...license, state: null }, country })).toBe("England");
    expect(placeLabel({ license: null, country })).toBe("England");
    expect(placeLabel({ license: null, country: null })).toBeNull();
  });

  it("only says outside the United States for a non-US prefix", () => {
    expect(noLicenseMessage(true)).toBe("No FCC record found for this callsign.");
    expect(noLicenseMessage(false)).toBe("No FCC record. This looks like a callsign issued outside the United States.");
  });

  it("sums activations and names them per program", () => {
    const activations = [
      { program: "POTA", references: 3, activations: 7 },
      { program: "SOTA", references: 1, activations: 2 },
      { program: "WWFF", references: 2, activations: 2 },
    ];
    expect(activationsDetail(activations)).toBe("3 parks, 1 summit, 2 WWFF references");
    expect(activationsDetail([])).toBe("0 parks, 0 summits");
    expect(totalActivations(activations)).toBe(11);
    expect(totalActivations([])).toBe(0);
  });

  it("keeps only US states for the map", () => {
    expect(usStates({ "US-NC": 3, "US-VA": 1, "CA-ON": 2, "W4C": 5 })).toEqual({ NC: 3, VA: 1 });
  });

  it("lists sources by name", () => {
    expect(sourcesDetail([{ source: "pota", spots: 1200 }, { source: "sotawatch", spots: 4 }, { source: "newnet", spots: 1 }]))
      .toBe("1,200 POTA, 4 SOTAwatch, 1 newnet");
  });

  it("splits rows into one zero-filled series per source", () => {
    const rows: { sources: Record<string, number> }[] = [{ sources: { pota: 2, rbn: 10 } }, { sources: {} }, { sources: { rbn: 1 } }];
    expect(sourceSeries(rows, ["rbn", "pota"])).toEqual([
      { source: "rbn", data: [10, 0, 1] },
      { source: "pota", data: [2, 0, 0] },
    ]);
  });

  it("lists the other forms a station was spotted as", () => {
    const heard = { variants: [{ callsign: "KK4PWJ", spots: 9 }, { callsign: "KK4PWJ/P", spots: 4 }, { callsign: "W4/KK4PWJ", spots: 1 }] };
    expect(otherForms(heard as HeardProfile, "KK4PWJ")).toEqual(["KK4PWJ/P", "W4/KK4PWJ"]);
    expect(otherForms(heard as HeardProfile, "KK4PWJ", 1)).toEqual(["KK4PWJ/P"]);
  });

  it("maps profile spots onto the Sources table's rows", () => {
    const rows = spotRows([
      { time: "2026-10-12T14:32:00Z", callsign: "KK4PWJ/P", frequencyKhz: 14062, band: "20m", mode: "cw", reference: "US-0817", source: "pota", spotter: "W1AW" },
    ]);
    expect(rows).toEqual([expect.objectContaining({
      id: null, spot_time: "2026-10-12T14:32:00Z", callsign: "KK4PWJ/P", frequency_khz: 14062, band: "20m", mode: "cw",
      pota_reference: "US-0817", sota_summit_ref: null, source: "pota", spotter: "W1AW",
    })]);
  });
});

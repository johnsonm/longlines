import { describe, expect, it } from "vitest";
import {
  activationsDetail, dateLabel, lastHeardLabel, lookupPath, monthLabel, noLicenseMessage, otherForms, placeLabel, plural,
  profileUrl, shortDay, sourceSeries, sourcesDetail, spotRows, totalActivations, usStates,
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

  it("says when and where a station was last heard", () => {
    const last = { time: "2026-10-12T14:32:10Z", frequencyKhz: 14062, mode: "cw" };
    expect(lastHeardLabel(last, NOW)).toBe("Last heard 14:32 UTC today on 14.062 MHz CW");
    expect(lastHeardLabel({ ...last, time: "2026-10-11T23:59:00Z" }, NOW)).toBe("Last heard 23:59 UTC yesterday on 14.062 MHz CW");
    expect(lastHeardLabel({ ...last, time: "2026-10-05T09:05:00Z", mode: null }, NOW)).toBe("Last heard 09:05 UTC Oct 5 on 14.062 MHz");
    expect(lastHeardLabel({ ...last, time: "2025-12-31T00:00:00Z", frequencyKhz: 7031.2 }, NOW))
      .toBe("Last heard 00:00 UTC Dec 31, 2025 on 7.031 MHz CW");
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

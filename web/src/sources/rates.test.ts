import { describe, expect, it } from "vitest";
import { formatHour, formatPerDay, formatRate, RATE_UNIT, RATE_UNIT_SHORT, sourceRates, type Hour } from "./rates";

const START = Date.UTC(2026, 9, 7); // Oct 7 00:00 UTC
function week(value: (i: number) => number, key: "pota" | "wwff" | "wwbota" | "rbn" | "dx" = "pota"): Hour[] {
  return Array.from({ length: 168 }, (_, i) => ({
    hour: new Date(START + i * 3_600_000).toISOString().replace(".000", ""),
    pota: 0, sota: 0, wwff: 0, rbn: 0, aprs: 0, dx: 0, [key]: value(i),
  }));
}

describe("sourceRates", () => {
  it("works per hour for a standard volume source", () => {
    const r = sourceRates(week((i) => (i === 100 ? 88 : i === 5 ? 2 : 36)), "pota")!;
    expect(r.series).toHaveLength(168);
    expect(r.peak).toBe(88);
    expect(r.peakHour).toBe("2026-10-11T04:00:00Z");
    expect(r.minimum).toBe(2);
    expect(r.average).toBeCloseTo((36 * 166 + 88 + 2) / 168);
    expect(r.perDay).toBeCloseTo((36 * 166 + 88 + 2) / 7);
  });

  it("works per hour for a high volume source too", () => {
    const r = sourceRates(week(() => 60_000, "rbn"), "rbn")!;
    expect(r.average).toBe(60_000);
    expect(r.peak).toBe(60_000);
    expect(r.perDay).toBe(60_000 * 24);
  });

  it("takes the earliest hour when the peak ties", () => {
    const r = sourceRates(week((i) => (i === 30 || i === 90 ? 9 : 1)), "pota")!;
    expect(r.peakHour).toBe(week(() => 0)[30]!.hour);
  });

  it("handles an all-zero week", () => {
    const r = sourceRates(week(() => 0), "pota")!;
    expect(r).toMatchObject({ average: 0, peak: 0, minimum: 0, perDay: 0, peakHour: week(() => 0)[0]!.hour });
  });

  it("returns null for a snapshot without the source's key", () => {
    const old = week(() => 1).map(({ dx: _dx, ...rest }) => rest) as unknown as Hour[];
    expect(sourceRates(old, "dx")).toBeNull();
    const beforeWwff = week(() => 1).map(({ wwff: _wwff, ...rest }) => rest) as unknown as Hour[];
    expect(sourceRates(beforeWwff, "wwff")).toBeNull();
    expect(sourceRates(week(() => 12, "wwff"), "wwff")?.average).toBe(12);
    // Snapshots before 20261026001000 have no wwbota key.
    expect(sourceRates(week(() => 1), "wwbota")).toBeNull();
    expect(sourceRates(week(() => 2, "wwbota"), "wwbota")?.average).toBe(2);
  });

  it("returns null for an empty series", () => {
    expect(sourceRates([], "pota")).toBeNull();
  });
});

describe("formatting", () => {
  it("formatRate uses one decimal below 10 and separators from 10", () => {
    expect(formatRate(0)).toBe("0.0");
    expect(formatRate(4.84)).toBe("4.8");
    expect(formatRate(9.96)).toBe("10");
    expect(formatRate(36.4)).toBe("36");
    expect(formatRate(1042.3)).toBe("1,042");
  });

  it("names the units per hour", () => {
    expect(RATE_UNIT).toBe("spots/hour");
    expect(RATE_UNIT_SHORT).toBe("/ hour");
  });

  it("formatHour is always UTC", () => {
    expect(formatHour("2026-10-12T14:00:00Z")).toBe("Oct 12, 14:00 UTC");
    expect(formatHour("2026-10-03T01:00:00Z")).toBe("Oct 3, 01:00 UTC");
  });

  it("formatPerDay rounds to two figures below a million and names millions", () => {
    expect(formatPerDay(0)).toBe("0");
    expect(formatPerDay(864)).toBe("860");
    expect(formatPerDay(4567)).toBe("4,600");
    expect(formatPerDay(999_499)).toBe("1,000,000");
    expect(formatPerDay(1_520_000)).toBe("1.5 million");
  });
});

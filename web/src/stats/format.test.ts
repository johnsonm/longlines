import { describe, expect, it } from "vitest";
import { compact, dayLabel, fillOpacity, fmt, hasData, hourLabel, midnightTicks, slotLabel, topStates, updatedCaption, weekday } from "./format";
import type { LatestStats, StatsPayload } from "./types";

const payload = (spots: number): StatsPayload => ({
  totals: {
    spots, potaSpots: spots, sotaSpots: 0,
    activations: 0, potaActivations: 0, sotaActivations: 0,
    chasers: 0, potaChasers: 0, sotaChasers: 0,
    activators: 0, references: 0,
  },
  peakHour: 0,
  busiestSlot: { day: "2026-09-28", hour: 0 },
  daily: [],
  potaByState: {},
  sotaAssociations: [],
  bands: [],
  modes: [],
  topActivators: [],
  topReferences: [],
  hourly: [],
  rbn: { spots: 0, skimmers: 0, bands: [], topStations: [] },
});

describe("fmt", () => {
  it("uses en-US thousands separators", () => {
    expect(fmt(3120)).toBe("3,120");
    expect(fmt(0)).toBe("0");
  });
});

describe("hourLabel", () => {
  it("zero-pads the hour", () => {
    expect(hourLabel(0)).toBe("00:00");
    expect(hourLabel(14)).toBe("14:00");
  });
});

describe("day labels", () => {
  it("formats a UTC day as weekday and M/D", () => {
    expect(weekday("2026-09-29")).toBe("Tue");
    expect(dayLabel("2026-09-29")).toBe("Tue 9/29");
    expect(dayLabel("2026-10-04")).toBe("Sun 10/4");
  });
});

describe("midnightTicks", () => {
  // 168 hours starting at `startHour` UTC on 2026-10-06, like the payload's hourly series.
  const week = (startHour: number) => Array.from({ length: 168 }, (_, i) => new Date(Date.UTC(2026, 9, 6, startHour + i)));
  const days = (ticks: Date[]) => ticks.map((d) => d.toISOString().slice(0, 10));

  it("ticks every UTC midnight in the series", () => {
    expect(days(midnightTicks(week(0), false))).toEqual(["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12"]);
    expect(days(midnightTicks(week(13), false))).toEqual(["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13"]);
  });

  it("keeps every other midnight on phones, counting back from the newest", () => {
    expect(days(midnightTicks(week(0), true))).toEqual(["2026-10-06", "2026-10-08", "2026-10-10", "2026-10-12"]);
    // A series that does not start at midnight still gets ticks.
    expect(days(midnightTicks(week(13), true))).toEqual(["2026-10-07", "2026-10-09", "2026-10-11", "2026-10-13"]);
  });
});

describe("updatedCaption", () => {
  it("matches the mock caption", () => {
    expect(updatedCaption("2026-10-05T14:00:00Z")).toBe("All times UTC. Updated hourly, last at 14:00 UTC Oct 5.");
  });
  it("uses 00, not 24, just after midnight", () => {
    expect(updatedCaption("2026-10-05T00:05:00+00:00")).toBe("All times UTC. Updated hourly, last at 00:05 UTC Oct 5.");
  });
});

describe("hasData", () => {
  it("is false with no snapshot", () => {
    expect(hasData(null)).toBe(false);
  });
  it("is false when the snapshot has zero spots", () => {
    const stats: LatestStats = { payload: payload(0), generatedAt: "2026-10-05T14:00:00Z" };
    expect(hasData(stats)).toBe(false);
  });
  it("is true when the snapshot has spots", () => {
    const stats: LatestStats = { payload: payload(12), generatedAt: "2026-10-05T14:00:00Z" };
    expect(hasData(stats)).toBe(true);
  });
});

describe("topStates", () => {
  it("sorts by spots desc, then code asc, and limits", () => {
    const result = topStates({ NC: 5, VA: 7, GA: 5, AL: 0 }, 3);
    expect(result).toEqual([
      { code: "VA", spots: 7 },
      { code: "GA", spots: 5 },
      { code: "NC", spots: 5 },
    ]);
  });
  it("drops states with no spots instead of padding the list with them", () => {
    expect(topStates({ AL: 0, NC: 2, AK: 0, VA: 1 })).toEqual([
      { code: "NC", spots: 2 },
      { code: "VA", spots: 1 },
    ]);
    expect(topStates({ AL: 0, AK: 0 })).toEqual([]);
  });
  it("defaults to ten entries", () => {
    const byState = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`S${String(i).padStart(2, "0")}`, i]));
    expect(topStates(byState)).toHaveLength(10);
  });
});

describe("fillOpacity", () => {
  it("ranges from 0.12 at the smallest non-zero value to 1 at the max", () => {
    expect(fillOpacity(1, 1)).toBeCloseTo(1);
    expect(fillOpacity(50, 100)).toBeCloseTo(0.56);
    expect(fillOpacity(1, 1000)).toBeCloseTo(0.12088);
  });
  it("is 0 for zero values and when there is no activity at all", () => {
    expect(fillOpacity(0, 100)).toBe(0);
    expect(fillOpacity(0, 0)).toBe(0);
    expect(fillOpacity(5, 0)).toBe(0);
  });
});

describe("slotLabel", () => {
  it("formats an hour of the hourly series in UTC", () => {
    expect(slotLabel("2026-10-06T14:00:00Z")).toBe("Tue 10/6 14:00");
    expect(slotLabel(new Date("2026-10-06T00:00:00Z"))).toBe("Tue 10/6 00:00");
  });
});

describe("compact", () => {
  it("abbreviates thousands and millions", () => {
    expect(compact(950)).toBe("950");
    expect(compact(12000)).toBe("12k");
    expect(compact(1250)).toBe("1.3k");
    expect(compact(1_500_000)).toBe("1.5M");
  });
});

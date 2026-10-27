import { describe, expect, it } from "vitest";
import {
  activationsLine, comparisonLine, groupHeatLevel, groupMeta, heardAgo, linkLabel, modeLabel, onAirLine, parsePeriod, periodDays,
  placesLine, publicUrl, totalActivations, totalPlaces, updatedAgo,
} from "./model";

const NOW = new Date("2026-10-19T15:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

describe("group statistics model", () => {
  it("reads the period from the query string", () => {
    expect(parsePeriod("7d")).toBe("7d");
    expect(parsePeriod("30d")).toBe("30d");
    expect(parsePeriod(null)).toBe("30d");
    expect(parsePeriod("1y")).toBe("30d");
    expect(periodDays("7d")).toBe(7);
    expect(periodDays("30d")).toBe(30);
  });

  it("compares the period with the one before", () => {
    expect(comparisonLine(10082, 9002, "30d")).toBe("12% more than the previous 30 days");
    expect(comparisonLine(900, 1000, "7d")).toBe("10% fewer than the previous 7 days");
    expect(comparisonLine(1001, 1000, "30d")).toBe("Same as the previous 30 days");
    expect(comparisonLine(50, 0, "30d")).toBe("None in the previous 30 days");
  });

  it("words activations and places", () => {
    expect(activationsLine({ pota: 26, sota: 5, wwff: 0 })).toBe("26 POTA, 5 SOTA");
    expect(activationsLine({ pota: 26, sota: 5, wwff: 2 })).toBe("26 POTA, 5 SOTA, 2 WWFF");
    expect(totalActivations({ pota: 26, sota: 5, wwff: 2 })).toBe(33);
    expect(activationsLine({ pota: 26, sota: 5, wwff: 2, wwbota: 1 })).toBe("26 POTA, 5 SOTA, 2 WWFF, 1 WWBOTA");
    expect(activationsLine({ pota: 0, sota: 0, wwff: 0, wwbota: 0 })).toBe("0 POTA, 0 SOTA");
    expect(totalActivations({ pota: 26, sota: 5, wwff: 2, wwbota: 1 })).toBe(34);
    expect(placesLine({ parks: 19, summits: 3 })).toBe("19 parks, 3 summits");
    expect(placesLine({ parks: 1, summits: 1 })).toBe("1 park, 1 summit");
    expect(placesLine({ parks: 1, summits: 1, bunkers: 1 })).toBe("1 park, 1 summit, 1 bunker");
    expect(placesLine({ parks: 0, summits: 0, bunkers: 0 })).toBe("0 parks, 0 summits");
    expect(totalPlaces({ parks: 19, summits: 3 })).toBe(22);
    expect(totalPlaces({ parks: 19, summits: 3, bunkers: 2 })).toBe(24);
    expect(activationsLine({ pota: 1, sota: 0, wwff: 0, wwbota: 0, iota: 2 })).toBe("1 POTA, 0 SOTA, 2 IOTA");
    expect(totalActivations({ pota: 1, sota: 0, wwff: 0, wwbota: 1, iota: 2 })).toBe(4);
    expect(placesLine({ parks: 1, summits: 0, bunkers: 0, islands: 2 })).toBe("1 park, 0 summits, 2 islands");
    expect(totalPlaces({ parks: 1, summits: 0, bunkers: 1, islands: 2 })).toBe(4);
  });

  it("words last heard", () => {
    expect(heardAgo(null, NOW)).toBe("Not heard yet");
    expect(heardAgo(ago(0.5), NOW)).toBe("Just now");
    expect(heardAgo(ago(2), NOW)).toBe("2 min ago");
    expect(heardAgo(ago(60), NOW)).toBe("1 hour ago");
    expect(heardAgo(ago(180), NOW)).toBe("3 hours ago");
    expect(heardAgo(ago(9 * 1440), NOW)).toBe("9 days ago");
    expect(heardAgo(ago(1440), NOW)).toBe("1 day ago");
  });

  it("words when the statistics were built", () => {
    expect(updatedAgo(ago(0.2), NOW)).toBe("just now");
    expect(updatedAgo(ago(1), NOW)).toBe("1 minute ago");
    expect(updatedAgo(ago(12), NOW)).toBe("12 minutes ago");
    expect(updatedAgo(ago(75), NOW)).toBe("1 hour ago");
  });

  it("places a day's spots on the club levels", () => {
    expect([0, 1, 99, 100, 199, 200, 399, 400, 5000].map(groupHeatLevel)).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it("labels mode buckets", () => {
    expect(modeLabel("FT8/FT4")).toBe("FT8 and FT4");
    expect(modeLabel("CW")).toBe("CW");
    expect(modeLabel(null)).toBe("—");
  });

  it("words who is on the air", () => {
    expect(onAirLine([])).toBe("Nobody on the air right now");
    expect(onAirLine(["N2QT"])).toBe("1 on the air now: N2QT");
    expect(onAirLine(["W4ABC", "KK4PWJ", "N4GHI"])).toBe("3 on the air now: W4ABC, KK4PWJ, N4GHI");
    expect(onAirLine(["A1A", "B1B", "C1C", "D1D", "E1E"])).toBe("5 on the air now: A1A, B1B, C1C and 2 more");
  });

  it("words a group's members and connections", () => {
    expect(groupMeta(24, 2)).toBe("24 members · used by 2 connections");
    expect(groupMeta(1, 1)).toBe("1 member · used by 1 connection");
    expect(groupMeta(12, 0)).toBe("12 members · not used by any connection");
  });

  it("builds and shows the public link", () => {
    const url = publicUrl("https://longlines.io", "7f3kq9xm2a");
    expect(url).toBe("https://longlines.io/g/7f3kq9xm2a");
    expect(linkLabel(url)).toBe("longlines.io/g/7f3kq9xm2a");
    expect(linkLabel("http://localhost:5173/g/x")).toBe("localhost:5173/g/x");
  });
});

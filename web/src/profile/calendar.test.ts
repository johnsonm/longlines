import { describe, expect, it } from "vitest";
import {
  cellCount, cellDate, cellSources, gridLabel, heatGrid, heatScale, periodDays, periodLabel, periodTitle,
} from "./calendar";
import { HEARD } from "./fixtures";
import type { CalendarPeriod } from "./types";

const calendar = HEARD.calendar!;
const [past, thisYear, lastYear] = calendar.periods as [CalendarPeriod, CalendarPeriod, CalendarPeriod];

describe("profile calendar", () => {
  it("levels days by rank within the period, about a quarter each", () => {
    const level = heatScale([0, 0, 2, 4, 6, 8, 10, 12, 14, 16]);
    expect([0, 2, 4, 6, 8, 10, 12, 14, 16].map(level)).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it("shades a quiet call's busy days as dark as a loud call's", () => {
    expect([1, 2, 3].map(heatScale([1, 1, 2, 3]))).toEqual([2, 3, 4]);
    expect([100, 200, 300].map(heatScale([100, 100, 200, 300]))).toEqual([2, 3, 4]);
  });

  it("keeps equal counts on one level and the busiest day darkest", () => {
    expect(heatScale([5, 5, 5])(5)).toBe(4);
    expect([1, 9].map(heatScale([1, 9]))).toEqual([2, 4]);
    expect(heatScale([])(3)).toBe(0);
  });

  it("lays the past year out in week columns, Sunday on top", () => {
    const grid = heatGrid(past, calendar.days);
    expect(grid.cells).toHaveLength(365);
    // 2025-10-13 is a Monday: the first column starts one row down.
    expect(grid.cells[0]).toEqual({ day: "2025-10-13", col: 0, row: 1, spots: 0, sources: {} });
    expect(grid.cells.at(-1)).toEqual({ day: "2026-10-12", col: 52, row: 1, spots: 1, sources: { sotawatch: 1 } });
    expect(grid.weeks).toBe(53);
    expect(grid.cells.find((c) => c.day === "2026-10-11")).toMatchObject({ col: 52, row: 0, spots: 484 });
  });

  it("labels each month over its first full week, dropping a cramped first month", () => {
    const { months } = heatGrid(past, calendar.days);
    // The partial October before it has two columns, too few; Nov 1 2025 is a Saturday, so Nov goes on the next column.
    expect(months[0]).toEqual({ label: "Nov", col: 3 });
    expect(months.map((m) => m.label)).toEqual(["Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct"]);
    expect(months.at(-1)).toEqual({ label: "Oct", col: 51 });
    const cramped = heatGrid({ ...past, from: "2025-10-28", days: 30 }, []);
    expect(cramped.months.map((m) => m.label)).toEqual(["Nov"]);
  });

  it("stops a year's grid at its day count, so future days have no cell", () => {
    const grid = heatGrid(thisYear, calendar.days);
    expect(grid.cells).toHaveLength(285);
    expect(grid.cells[0]).toMatchObject({ day: "2026-01-01", row: 4, col: 0 });
    expect(grid.months[0]).toEqual({ label: "Jan", col: 1 });
    expect(heatGrid({ ...thisYear, days: 0 }, []).weeks).toBe(0);
  });

  it("words a day for its tooltip", () => {
    expect(cellCount(0)).toBe("No spots");
    expect(cellCount(1)).toBe("1 spot");
    expect(cellCount(1234)).toBe("1,234 spots");
    expect(cellDate("2025-10-19")).toBe("Sunday, October 19, 2025");
    expect(cellSources({ pota: 1, rbn: 29 })).toBe("RBN 29 · POTA 1");
    expect(cellSources({ wwff: 2, pota: 2 })).toBe("POTA 2 · WWFF 2");
    expect(cellSources({})).toBe("");
  });

  it("names periods", () => {
    expect(periodLabel(past)).toBe("Past 12 months");
    expect(periodLabel(lastYear)).toBe("2025");
    expect(periodTitle(past)).toBe("Activity over the past year");
    expect(periodTitle(lastYear)).toBe("Activity in 2025");
    expect(gridLabel(past)).toBe("Heat map of spots heard per day for the past 365 days. A table view has the same numbers.");
    expect(gridLabel(lastYear)).toBe("Heat map of spots heard per day in 2025. A table view has the same numbers.");
  });

  it("lists a period's days with spots, newest first", () => {
    expect(periodDays(past, calendar.days).map((d) => d.day)).toEqual(["2026-10-12", "2026-10-11", "2026-10-10", "2025-12-31"]);
    expect(periodDays(lastYear, calendar.days).map((d) => d.day)).toEqual(["2025-12-31"]);
    expect(periodDays({ ...thisYear, days: 283 }, calendar.days).map((d) => d.day)).toEqual(["2026-10-10"]);
  });
});

// The year heat map on a profile (canvas page 9): pure layout and copy, so it
// is testable in node. SQL decides the periods, totals, streaks and busiest
// day; this only places days in a week-column grid and words them.

import { sourceName } from "../sources/sources";
import { fmt } from "../stats/format";
import type { Calendar, CalendarPeriod } from "./types";

/** The shades after "none"; levels run 0 to HEAT_LEVELS. */
export const HEAT_LEVELS = 4;

/**
 * Levels relative to the period's own days on the air, never fixed counts:
 * days are ranked by spots and each level holds about a quarter of them, so a
 * call heard a few times a day shows its busy days as plainly as one heard
 * hundreds of times. A day's level is the quarter its rank ends in, so equal
 * counts share a level and the busiest day is always the darkest.
 */
export function heatScale(spots: readonly number[]): (spots: number) => number {
  const active = spots.filter((n) => n > 0).sort((a, b) => a - b);
  const levels = new Map<number, number>();
  active.forEach((n, i) => {
    // The last index holding n is its rank; a later equal count overwrites.
    levels.set(n, Math.ceil(((i + 1) / active.length) * HEAT_LEVELS));
  });
  // 0 for no spots, else 1 to HEAT_LEVELS.
  return (n) => (n > 0 ? levels.get(n) ?? 0 : 0);
}

export type HeatCell = {
  day: string;
  col: number; // week column, 0 is the week holding `from`
  row: number; // UTC weekday, 0 is Sunday
  spots: number;
  sources: Record<string, number>;
};

export type HeatGrid = { weeks: number; cells: HeatCell[]; months: { label: string; col: number }[] };

const DAY_MS = 86_400_000;
const MONTH = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
const LONG_DATE = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

const toTime = (day: string) => Date.parse(`${day}T00:00:00Z`);
const toDay = (time: number) => new Date(time).toISOString().slice(0, 10);

/**
 * One cell per day of the period through its day count (no future days),
 * Sunday on top, and a month label over the first week that starts in each
 * month. A month starting in the grid's last column has no room and is left
 * unlabelled; so is a partial first month too narrow for its label.
 */
export function heatGrid(period: CalendarPeriod, days: Calendar["days"]): HeatGrid {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const start = toTime(period.from);
  const offset = new Date(start).getUTCDay();
  const cells: HeatCell[] = [];
  for (let i = 0; i < period.days; i++) {
    const day = toDay(start + i * DAY_MS);
    const d = byDay.get(day);
    cells.push({ day, col: Math.floor((offset + i) / 7), row: (offset + i) % 7, spots: d?.spots ?? 0, sources: d?.sources ?? {} });
  }
  const weeks = cells.length === 0 ? 0 : cells[cells.length - 1]!.col + 1;
  const months: HeatGrid["months"] = [];
  for (const c of cells) {
    if (!c.day.endsWith("-01") && c !== cells[0]) continue;
    const col = c.row === 0 ? c.col : c.col + 1;
    if (col < weeks - 1) months.push({ label: MONTH.format(new Date(toTime(c.day))), col });
  }
  // The first month's label needs about three columns before the next one.
  if (months.length > 1 && months[1]!.col - months[0]!.col < 3) months.shift();
  return { weeks, cells, months };
}

/** "52 spots", "1 spot", "No spots": the tooltip's first line. */
export function cellCount(spots: number): string {
  return spots === 0 ? "No spots" : `${fmt(spots)} ${spots === 1 ? "spot" : "spots"}`;
}

/** "Sunday, October 19, 2025". */
export function cellDate(day: string): string {
  return LONG_DATE.format(new Date(toTime(day)));
}

/** "RBN 29 · POTA 1", most spots first; "" without spots. */
export function cellSources(sources: Record<string, number>): string {
  return Object.entries(sources)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([source, n]) => `${sourceName(source)} ${fmt(n)}`)
    .join(" · ");
}

/** The Period menu: "Past 12 months", "2026". */
export function periodLabel(period: CalendarPeriod): string {
  return period.period === "past" ? "Past 12 months" : period.period;
}

/** The card's title: "Activity over the past year", "Activity in 2025". */
export function periodTitle(period: CalendarPeriod): string {
  return period.period === "past" ? "Activity over the past year" : `Activity in ${period.period}`;
}

/** The grid's accessible name. */
export function gridLabel(period: CalendarPeriod): string {
  const span = period.period === "past" ? "for the past 365 days" : `in ${period.period}`;
  return `Heat map of spots heard per day ${span}. A table view has the same numbers.`;
}

/** The period's days with spots, newest first: the table view. */
export function periodDays(period: CalendarPeriod, days: Calendar["days"]): Calendar["days"] {
  const last = toDay(toTime(period.from) + (period.days - 1) * DAY_MS);
  return days.filter((d) => d.day >= period.from && d.day <= last).reverse();
}

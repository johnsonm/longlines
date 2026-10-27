import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import { setMobile } from "../test/media";
import { PARK } from "./fixtures";
import { ReferenceHeatMap } from "./ReferenceHeatMap";

const calendar = PARK.calendar;

/** The day squares: every rect in the grid, not the legend's. */
function cells() {
  return screen.getByRole("img", { name: /^Heat map/ }).querySelectorAll("rect");
}

describe("ReferenceHeatMap", () => {
  it("shows the past year with SQL's figures", () => {
    renderPage(<ReferenceHeatMap reference="US-2763" calendar={calendar} />);
    expect(screen.getByText("Activations in the past year")).toBeInTheDocument();
    expect(screen.getByText("Activators spotted at US-2763 each day. Hover a day to see who.")).toBeInTheDocument();
    expect(screen.getByText("9")).toBeInTheDocument();
    expect(screen.getByText("4 of 365")).toBeInTheDocument();
    expect(screen.getByText("2 days")).toBeInTheDocument();
    expect(screen.getByText("5 activators")).toBeInTheDocument();
    expect(screen.getByText("Jun 14, 2026")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Heat map of activations per day for the past 365 days. A table view has the same numbers." }))
      .toBeInTheDocument();
    expect(cells()).toHaveLength(365);
  });

  it("shades days by activators relative to the period", () => {
    renderPage(<ReferenceHeatMap reference="US-2763" calendar={calendar} />);
    const fills = [...cells()].map((c) => c.getAttribute("fill"));
    const legend = [...document.querySelectorAll("svg[aria-hidden] rect")].map((r) => r.getAttribute("fill"));
    // 2026-10-26 (1 activator) is the lightest shade, 2026-06-14 (5) the darkest; most days have none.
    expect(fills.at(-1)).toBe(legend[2]);
    expect(fills.at(-2)).toBe(legend[3]);
    expect(fills).toContain(legend[4]);
    expect(fills[0]).toBe(legend[0]);
  });

  it("names a day's activators on hover", async () => {
    const { user } = renderPage(<ReferenceHeatMap reference="US-2763" calendar={calendar} />);
    await user.hover(cells()[363]!);
    const tip = await screen.findByRole("tooltip");
    expect(within(tip).getByText("2 activators")).toBeInTheDocument();
    expect(within(tip).getByText("Sunday, October 25, 2026")).toBeInTheDocument();
    expect(within(tip).getByText("KD2RVS, KJ4ABS")).toBeInTheDocument();
    await user.unhover(cells()[363]!);
    await user.hover(cells()[1]!);
    expect(await screen.findByText("No activations")).toBeInTheDocument();
  });

  it("switches to a calendar year from the Period menu", async () => {
    const { user } = renderPage(<ReferenceHeatMap reference="US-2763" calendar={calendar} />);
    await user.click(screen.getByRole("combobox", { name: "Period" }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Past 365 days", "2026", "2025"]);
    await user.click(screen.getByRole("option", { name: "2025" }));
    expect(screen.getByText("Activations in 2025")).toBeInTheDocument();
    expect(screen.getByText("1 of 365")).toBeInTheDocument();
    expect(screen.getByText("1 activator")).toBeInTheDocument();
  });

  it("lists the same days as a table, each activator linked", async () => {
    const { user } = renderPage(<ReferenceHeatMap reference="US-2763" calendar={calendar} />);
    await user.click(screen.getByRole("button", { name: "View as table" }));
    const grid = screen.getByRole("grid");
    expect(within(grid).getByText("Jun 14, 2026")).toBeInTheDocument();
    expect(within(grid).getAllByRole("link", { name: "N4MTS" })[0]).toHaveAttribute("href", "/call/N4MTS");
    expect(within(grid).getByText("Nov 2, 2025")).toBeInTheDocument();
  });

  it("on a phone, shows the past year only and says to tap", () => {
    setMobile(true);
    renderPage(<ReferenceHeatMap reference="US-2763" calendar={calendar} />);
    expect(screen.queryByRole("combobox", { name: "Period" })).not.toBeInTheDocument();
    expect(screen.getByText("Activators spotted at US-2763 each day. Tap a day to see who.")).toBeInTheDocument();
    expect(screen.getByText("Scroll sideways for earlier months.")).toBeInTheDocument();
  });

  it("renders nothing without periods, and None for a period without activations", () => {
    const { unmount } = renderPage(<ReferenceHeatMap reference="US-2763" calendar={{ days: [], periods: [] }} />);
    expect(screen.queryByText(/^Activations in/)).not.toBeInTheDocument();
    unmount();
    renderPage(
      <ReferenceHeatMap
        reference="US-4471"
        calendar={{ days: [], periods: [{ ...calendar.periods[0]!, activations: 0, daysActivated: 0, longestStreak: 0, busiest: null }] }}
      />,
    );
    expect(screen.getByText("None")).toBeInTheDocument();
  });
});

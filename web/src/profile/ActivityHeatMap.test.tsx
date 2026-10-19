import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import { setMobile } from "../test/media";
import { ActivityHeatMap } from "./ActivityHeatMap";
import { HEARD } from "./fixtures";

const calendar = HEARD.calendar!;

/** The day squares: every rect in the grid, not the legend's. */
function cells() {
  return screen.getByRole("img", { name: /^Heat map/ }).querySelectorAll("rect");
}

describe("ActivityHeatMap", () => {
  it("shows the past year with SQL's figures", () => {
    renderPage(<ActivityHeatMap callsign="KK4PWJ" calendar={calendar} />);
    expect(screen.getByText("Activity over the past year")).toBeInTheDocument();
    expect(screen.getByText("Spots heard for KK4PWJ each day. Hover a day to see the count.")).toBeInTheDocument();
    expect(screen.getByText("518")).toBeInTheDocument();
    expect(screen.getByText("4 of 365")).toBeInTheDocument();
    expect(screen.getByText("3 days")).toBeInTheDocument();
    expect(screen.getByText("484 spots")).toBeInTheDocument();
    expect(screen.getByText("Oct 11, 2026")).toBeInTheDocument();
    expect(cells()).toHaveLength(365);
    expect(screen.getByText("Spots per day: none, 1 to 49, 50 to 149, 150 to 299, 300 or more.")).toBeInTheDocument();
  });

  it("shades days by level and leaves empty days neutral", () => {
    renderPage(<ActivityHeatMap callsign="KK4PWJ" calendar={calendar} />);
    const fills = [...cells()].map((c) => c.getAttribute("fill"));
    // None, 1-49 (1 and 30 spots) and 300+ (484).
    expect(new Set(fills).size).toBe(3);
    expect(fills.at(-1)).toBe(fills.at(-3));
    expect(fills.at(-2)).not.toBe(fills.at(-1));
  });

  it("shows a day's count, date and sources on hover", async () => {
    const { user } = renderPage(<ActivityHeatMap callsign="KK4PWJ" calendar={calendar} />);
    await user.hover(cells()[363]!);
    const tip = await screen.findByRole("tooltip");
    expect(within(tip).getByText("484 spots")).toBeInTheDocument();
    expect(within(tip).getByText("Sunday, October 11, 2026")).toBeInTheDocument();
    expect(within(tip).getByText("RBN 470 · POTA 14")).toBeInTheDocument();
    await user.unhover(cells()[363]!);
    await user.hover(cells()[0]!);
    expect(await screen.findByText("No spots")).toBeInTheDocument();
  });

  it("switches to a calendar year", async () => {
    const { user } = renderPage(<ActivityHeatMap callsign="KK4PWJ" calendar={calendar} />);
    await user.click(screen.getByRole("combobox", { name: "Period" }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Past 12 months", "2026", "2025"]);
    await user.click(screen.getByRole("option", { name: "2025" }));
    expect(screen.getByText("Activity in 2025")).toBeInTheDocument();
    expect(screen.getByText("1 of 365")).toBeInTheDocument();
    expect(screen.getByText("1 day")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Heat map of spots heard per day in 2025. A table view has the same numbers." })).toBeInTheDocument();
    expect(cells()).toHaveLength(365);
  });

  it("lists the same numbers as a table", async () => {
    const { user } = renderPage(<ActivityHeatMap callsign="KK4PWJ" calendar={calendar} />);
    await user.click(screen.getByRole("button", { name: "View as table" }));
    const grid = screen.getByRole("grid");
    expect(within(grid).getByText("Oct 11, 2026")).toBeInTheDocument();
    expect(within(grid).getByText("RBN 470 · POTA 14")).toBeInTheDocument();
    expect(within(grid).getByText("Dec 31, 2025")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /^Heat map/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View as heat map" }));
    expect(cells()).toHaveLength(365);
  });

  it("on a phone, shows the past year only and scrolls sideways", () => {
    setMobile(true);
    renderPage(<ActivityHeatMap callsign="KK4PWJ" calendar={calendar} />);
    expect(screen.queryByRole("combobox", { name: "Period" })).not.toBeInTheDocument();
    expect(screen.getByText("Spots per day: none, 1 to 49, 50 to 149, 150 to 299, 300 or more. Scroll sideways for earlier months."))
      .toBeInTheDocument();
  });

  it("renders nothing without periods", () => {
    renderPage(<ActivityHeatMap callsign="KK4PWJ" calendar={{ days: [], periods: [] }} />);
    expect(screen.queryByText(/^Activity/)).not.toBeInTheDocument();
  });
});

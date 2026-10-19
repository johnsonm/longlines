import { beforeEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderPage } from "../test/render";
import { setMobile } from "../test/media";
import { GroupHeatMap } from "./GroupHeatMap";
import { STATS } from "./stats/fixtures";

beforeEach(() => setMobile(false));

const cell = (day: string) => screen.getAllByTestId("heat-cell").find((c) => c.dataset.day === day)!;

describe("GroupHeatMap", () => {
  it("draws the past 365 days on the club's levels", () => {
    renderPage(<GroupHeatMap stats={STATS} />);
    expect(screen.getByText("Club activity over the past year")).toBeInTheDocument();
    expect(screen.getByText("Spots heard each day for all members combined. Hover a day for the count. Ignores the period above."))
      .toBeInTheDocument();
    const cells = screen.getAllByTestId("heat-cell");
    expect(cells).toHaveLength(365);
    expect(cells[0]!.dataset.day).toBe("2025-10-20");
    expect(cells[364]!.dataset.day).toBe("2026-10-19");
    expect(cell("2026-10-19").dataset.level).toBe("4");
    expect(cell("2026-10-18").dataset.level).toBe("3");
    expect(cell("2026-10-12").dataset.level).toBe("2");
    expect(cell("2025-12-23").dataset.level).toBe("1");
    expect(cell("2026-10-17").dataset.level).toBe("0");
    expect(screen.getByText("Club spots per day: none, 1 to 99, 100 to 199, 200 to 399, 400 or more.")).toBeInTheDocument();
  });

  it("tells a day's count, date and members on the air", async () => {
    const { user } = renderPage(<GroupHeatMap stats={STATS} />);
    await user.hover(cell("2026-10-19"));
    expect(await screen.findByText("900 spots")).toBeInTheDocument();
    expect(screen.getByText("Monday, October 19, 2026")).toBeInTheDocument();
    expect(screen.getByText("8 members on the air")).toBeInTheDocument();
  });

  it("lists the days as a table", async () => {
    const { user } = renderPage(<GroupHeatMap stats={STATS} />);
    await user.click(screen.getByRole("button", { name: "View as table" }));
    expect(screen.getByText("Members on the air")).toBeInTheDocument();
    expect(screen.getByText("900")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View as heat map" }));
    expect(screen.getAllByTestId("heat-cell")).toHaveLength(365);
  });

  it("scrolls sideways on phones", () => {
    setMobile(true);
    renderPage(<GroupHeatMap stats={STATS} />);
    expect(screen.getByText(/Scroll sideways for earlier months\./)).toBeInTheDocument();
  });
});

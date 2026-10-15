import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderPage } from "../test/render";
import { COUNTRY_SHAPES } from "./countryShapes";
import { WorldMap } from "./WorldMap";

const DE = { code: "DE", pota: 40, sota: 5, wwff: 0, dx: 300, rbn: 12000 };

describe("WorldMap", () => {
  it("draws every country and labels the scale with the busiest total", () => {
    const { container } = renderPage(<WorldMap countries={[DE, { code: "JP", pota: 1, sota: 0, wwff: 0, dx: 0, rbn: 0 }]} />);
    expect(screen.getByRole("img", { name: "Map of spots by country" })).toBeInTheDocument();
    expect(container.querySelectorAll("path")).toHaveLength(COUNTRY_SHAPES.length);
    expect(screen.getByText("12,345 spots")).toBeInTheDocument();
  });

  it("shades active countries and leaves idle ones neutral", () => {
    const { container } = renderPage(<WorldMap countries={[DE, { code: "JP", pota: 1, sota: 0, wwff: 0, dx: 0, rbn: 0 }]} />);
    const fills = new Set([...container.querySelectorAll("path")].map((p) => p.getAttribute("fill")));
    expect(fills.size).toBe(3);
  });

  it("shows the total and each source on hover", async () => {
    const { container, user } = renderPage(<WorldMap countries={[DE]} />);
    await user.hover(container.querySelectorAll("path")[COUNTRY_SHAPES.findIndex((s) => s.code === "DE")]!);
    expect(await screen.findByText("Germany: 12,345 spots")).toBeInTheDocument();
    expect(screen.getByText("12,000 RBN, 300 DX Cluster, 40 POTA, 5 SOTA, 0 WWFF")).toBeInTheDocument();
  });

  it("shows only the total for a country without spots", async () => {
    const { container, user } = renderPage(<WorldMap countries={[DE]} />);
    await user.hover(container.querySelectorAll("path")[COUNTRY_SHAPES.findIndex((s) => s.code === "FR")]!);
    expect(await screen.findByText("France: 0 spots")).toBeInTheDocument();
    expect(screen.queryByText(/DX Cluster/)).not.toBeInTheDocument();
  });

  it("handles a week with no spots", () => {
    renderPage(<WorldMap countries={[]} />);
    expect(screen.getByText("0 spots")).toBeInTheDocument();
  });
});

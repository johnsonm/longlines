import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderPage } from "../test/render";
import { findLiveSource, SOURCES } from "./sources";
import { SourceTile } from "./SourceTile";
import type { Rates } from "./rates";

const rates = (average: number): Rates => ({ series: [], hours: [], average, peak: 0, peakHour: "", minimum: 0, perDay: 0 });

describe("SourceTile", () => {
  it("links a live source to its page with status, volume and rate", () => {
    renderPage(<SourceTile source={findLiveSource("rbn")!} status="connected" rates={rates(1042.3)} />);
    expect(screen.getByRole("link", { name: /Reverse Beacon Network/ })).toHaveAttribute("href", "/sources/rbn");
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("High volume")).toBeInTheDocument();
    expect(screen.getByText("1,042 spots/min")).toBeInTheDocument();
    expect(screen.getByText("CW and RTTY signals heard by skimmers around the world.")).toBeInTheDocument();
  });

  it("shows a delayed standard source per hour", () => {
    renderPage(<SourceTile source={findLiveSource("pota")!} status="delayed" rates={rates(36)} />);
    expect(screen.getByText("Delayed")).toBeInTheDocument();
    expect(screen.getByText("Standard volume")).toBeInTheDocument();
    expect(screen.getByText("36 spots/hour")).toBeInTheDocument();
  });

  it("hides the rate when there are no rates", () => {
    renderPage(<SourceTile source={findLiveSource("dxcluster")!} status="connected" rates={null} />);
    expect(screen.queryByText(/spots\//)).not.toBeInTheDocument();
  });

  it("does not link a planned source", () => {
    renderPage(<SourceTile source={SOURCES.find((s) => s.id === "wwff")!} status="planned" rates={null} />);
    expect(screen.getByText("WWFF")).toBeInTheDocument();
    expect(screen.getByText("Not yet available")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

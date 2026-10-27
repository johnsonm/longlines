import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import { setMobile } from "../test/media";
import { loadIngestHealth, type IngestHealth } from "../lib/api";
import { useStats } from "../stats/useStats";
import type { LatestStats } from "../stats/types";
import { SourcesPage } from "./SourcesPage";

vi.mock("../lib/api", () => ({ loadIngestHealth: vi.fn() }));
vi.mock("../stats/useStats", () => ({ useStats: vi.fn() }));

const health = (source: string, age: number | null) => ({ source, seconds_since_last_success: age }) as IngestHealth;
const hourly = Array.from({ length: 168 }, (_, i) => ({
  hour: new Date(Date.UTC(2026, 9, 7) + i * 3_600_000).toISOString().replace(".000", ""),
  pota: 36, sota: 5, wwff: 12, wwbota: 2, iota: 3, rbn: 62_520, aprs: 330_000, dx: 56,
}));
const STATS = { payload: { hourly }, generatedAt: "2026-10-14T15:00:00Z" } as unknown as LatestStats;

beforeEach(() => {
  setMobile(false);
  vi.mocked(loadIngestHealth).mockReset().mockResolvedValue([
    health("pota", 20), health("sotawatch", 600), health("rbn", 30), health("dxcluster", 40), health("aprs", 50), health("wwff", 45), health("wwbota", 30),
  ]);
  vi.mocked(useStats).mockReturnValue({ stats: STATS, loading: false, error: null });
});

const tiles = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);

describe("SourcesPage", () => {
  it("shows the catalog copy and every source in order", async () => {
    renderPage(<SourcesPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Sources" })).toBeInTheDocument();
    expect(screen.getByText("Where spots come from. Pick a source to see what it sends and what you can do with it.")).toBeInTheDocument();
    // The high volume alert lives only on RBN's and APRS-IS's detail pages.
    expect(screen.queryByText(/callsign filter/)).not.toBeInTheDocument();
    expect(tiles()).toEqual(["Parks on the Air", "SOTA", "Reverse Beacon Network", "DX Cluster", "APRS-IS", "WWFF", "WWBOTA", "IOTA"]);
    expect(await screen.findByText("Delayed")).toBeInTheDocument(); // SOTA: 600 s > 3 × 30 s
  });

  it("shows each live source's average rate from the snapshot", () => {
    renderPage(<SourcesPage />);
    expect(screen.getByText("36 spots/hour")).toBeInTheDocument();
    expect(screen.getByText("62,520 spots/hour")).toBeInTheDocument();
    expect(screen.getByText("330,000 spots/hour")).toBeInTheDocument();
    expect(screen.getByText("56 spots/hour")).toBeInTheDocument();
    expect(screen.getByText("12 spots/hour")).toBeInTheDocument();
    expect(screen.getByText("2.0 spots/hour")).toBeInTheDocument();
    expect(screen.getByText("3.0 spots/hour")).toBeInTheDocument();
  });

  it("links live tiles to their pages", () => {
    renderPage(<SourcesPage />);
    expect(screen.getByRole("link", { name: /Parks on the Air/ })).toHaveAttribute("href", "/sources/pota");
    expect(screen.getByRole("link", { name: /APRS-IS/ })).toHaveAttribute("href", "/sources/aprs");
    expect(screen.getByRole("link", { name: /WWFF/ })).toHaveAttribute("href", "/sources/wwff");
    expect(screen.getByRole("link", { name: /WWBOTA/ })).toHaveAttribute("href", "/sources/wwbota");
    expect(screen.getByRole("link", { name: /IOTA/ })).toHaveAttribute("href", "/sources/iota");
  });

  it("filters by search, trimming and ignoring case", async () => {
    const { user } = renderPage(<SourcesPage />);
    await user.type(screen.getByLabelText("Search sources"), "  rbn ");
    expect(tiles()).toEqual(["Reverse Beacon Network"]);
    await user.clear(screen.getByLabelText("Search sources"));
    await user.type(screen.getByLabelText("Search sources"), "summits");
    expect(tiles()).toEqual(["SOTA"]);
  });

  it("filters by chip and says when nothing matches", async () => {
    const { user } = renderPage(<SourcesPage />);
    // No source is planned, so there is no "Not yet available" filter.
    expect(screen.queryByRole("button", { name: "Not yet available" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Connected" }));
    expect(tiles()).toHaveLength(8);
    await user.type(screen.getByLabelText("Search sources"), "zzz");
    expect(screen.getByText("No sources match.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "All" }));
    await user.clear(screen.getByLabelText("Search sources"));
    expect(tiles()).toHaveLength(8);
  });

  it("still shows the catalog when ingest health fails", async () => {
    vi.mocked(loadIngestHealth).mockRejectedValue(new Error("Couldn't load source health."));
    renderPage(<SourcesPage />);
    expect(await screen.findByText("Couldn't load source health.")).toBeInTheDocument();
    expect(screen.queryByText("Delayed")).not.toBeInTheDocument();
    expect(screen.getAllByText("Connected").length).toBeGreaterThanOrEqual(8);
  });

  it("hides rates while there is no snapshot", () => {
    vi.mocked(useStats).mockReturnValue({ stats: null, loading: false, error: null });
    renderPage(<SourcesPage />);
    expect(screen.queryByText(/spots\//)).not.toBeInTheDocument();
    expect(tiles()).toHaveLength(8);
  });

  it("stacks tiles on a phone", () => {
    setMobile(true);
    renderPage(<SourcesPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Sources" })).toBeInTheDocument();
    expect(within(screen.getByTestId("source-grid")).getAllByRole("heading", { level: 2 })).toHaveLength(8);
  });
});

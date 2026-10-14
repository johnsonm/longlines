import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import { setMobile } from "../test/media";
import { loadIngestHealth, loadRecentSpots, type IngestHealth, type RecentSpot } from "../lib/api";
import { SourcesPage } from "./SourcesPage";
import { SpotsTable } from "./SpotsTable";

vi.mock("../lib/api", () => ({ loadIngestHealth: vi.fn(), loadRecentSpots: vi.fn() }));

const UTC = { utcTimes: true, timezone: "UTC" };

function spot(id: number, overrides: Partial<RecentSpot> = {}): RecentSpot {
  return {
    id, source: "pota", callsign: `W${id}AW`, frequency_khz: 14062, band: "20m", mode: "cw", pota_reference: "US-0817",
    sota_summit_ref: null, spotter: "K1ABC", spot_time: "2026-10-05T14:00:05Z", ...overrides,
  } as RecentSpot;
}

const health = (source: string, age: number | null, lastHour = 12) =>
  ({ source, seconds_since_last_success: age, spots_last_hour: lastHour }) as IngestHealth;

beforeEach(() => {
  vi.mocked(loadIngestHealth).mockReset().mockResolvedValue([health("pota", 20), health("sotawatch", 600), health("rbn", 30, 3), health("dxcluster", 40, 5), health("aprs", 50, 6123)]);
  vi.mocked(loadRecentSpots).mockReset().mockImplementation(async (source) => ({
    pota: [spot(1)],
    sotawatch: [spot(2, { source: "sotawatch", pota_reference: null, sota_summit_ref: "W4C/CM-001", mode: null })],
    rbn: [spot(3, { id: null, source: "rbn", pota_reference: null, comment: "12 dB 22 WPM CQ" })],
    dxcluster: [spot(4, { source: "dxcluster", pota_reference: null, mode: "ssb", frequency_khz: 14305 })],
  })[source] ?? []);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SourcesPage", () => {
  it("shows live source health and planned sources", async () => {
    renderPage(<SourcesPage prefs={UTC} />);
    expect(await screen.findAllByText("Connected")).toHaveLength(4);
    expect(screen.getByText("Delayed")).toBeInTheDocument();
    expect(screen.getAllByText("Not yet available")).toHaveLength(2);
    expect(screen.getByText("20s ago")).toBeInTheDocument();
    expect(screen.getAllByText("12")).toHaveLength(2);
  });

  it("marks a live source with no health row as delayed", async () => {
    vi.mocked(loadIngestHealth).mockResolvedValue([]);
    renderPage(<SourcesPage prefs={UTC} />);
    expect(await screen.findAllByText("Delayed")).toHaveLength(5);
    expect(screen.getAllByText("–").length).toBeGreaterThan(0);
  });

  it("shows APRS-IS health with its packet count", async () => {
    renderPage(<SourcesPage prefs={UTC} />);
    expect(await screen.findByText("APRS-IS")).toBeInTheDocument();
    expect(screen.getByText("Automatic Packet Reporting System. Every packet on the worldwide APRS-IS feed.")).toBeInTheDocument();
    expect(screen.getByText("6123")).toBeInTheDocument();
  });

  it("opens on POTA's newest spots, with one tab per live source", async () => {
    renderPage(<SourcesPage prefs={UTC} />);
    expect(await screen.findByText("W1AW")).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["POTA", "SOTAwatch", "RBN", "DX Cluster"]);
    expect(screen.queryByRole("tab", { name: "APRS-IS" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "POTA" })).toHaveAttribute("aria-selected", "true");
    expect(loadRecentSpots).toHaveBeenCalledWith("pota");
    expect(screen.queryByText("W2AW")).not.toBeInTheDocument();
  });

  it("loads a source's spots when its tab is chosen", async () => {
    const { user } = renderPage(<SourcesPage prefs={UTC} />);
    await screen.findByText("W1AW");
    await user.click(screen.getByRole("tab", { name: "SOTAwatch" }));
    expect(await screen.findByText("W4C/CM-001")).toBeInTheDocument();
    expect(screen.queryByText("W1AW")).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "RBN" }));
    expect(await screen.findByText("W3AW")).toBeInTheDocument();
    expect(loadRecentSpots).toHaveBeenLastCalledWith("rbn");
    await user.click(screen.getByRole("tab", { name: "DX Cluster" }));
    expect(await screen.findByText("W4AW")).toBeInTheDocument();
    expect(loadRecentSpots).toHaveBeenLastCalledWith("dxcluster");
  });

  it("ignores a slow response for a tab that is no longer shown", async () => {
    let resolvePota: (spots: RecentSpot[]) => void = () => {};
    vi.mocked(loadRecentSpots).mockImplementationOnce(() => new Promise((resolve) => { resolvePota = resolve; }));
    const { user } = renderPage(<SourcesPage prefs={UTC} />);
    await user.click(screen.getByRole("tab", { name: "SOTAwatch" }));
    expect(await screen.findByText("W4C/CM-001")).toBeInTheDocument();
    await act(async () => resolvePota([spot(1)]));
    expect(screen.queryByText("W1AW")).not.toBeInTheDocument();
    expect(screen.getByText("W4C/CM-001")).toBeInTheDocument();
  });

  it("shows load errors", async () => {
    vi.mocked(loadRecentSpots).mockRejectedValue(new Error("Couldn't load recent spots."));
    renderPage(<SourcesPage prefs={UTC} />);
    expect(await screen.findByText("Couldn't load recent spots.")).toBeInTheDocument();
  });

  it("refreshes every 30 seconds while visible and on returning to the tab", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { unmount } = renderPage(<SourcesPage prefs={UTC} />);
    await waitFor(() => expect(loadRecentSpots).toHaveBeenCalledTimes(1));
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(loadRecentSpots).toHaveBeenCalledTimes(2);

    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(loadRecentSpots).toHaveBeenCalledTimes(2);

    visibility.mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(loadRecentSpots).toHaveBeenCalledTimes(3);
    unmount();
  });
});

describe("SpotsTable", () => {
  it("renders a table with local-time header on desktop", () => {
    renderPage(<SpotsTable spots={[spot(1)]} prefs={{ utcTimes: false, timezone: "America/New_York" }} />);
    expect(screen.getByRole("columnheader", { name: "Time (local)" })).toBeInTheDocument();
    const row = screen.getAllByRole("row")[1]!;
    expect(within(row).getByText("10:00:05")).toBeInTheDocument();
    expect(within(row).getByText("14062.0")).toBeInTheDocument();
    expect(within(row).getByText("K1ABC")).toBeInTheDocument();
  });

  it("renders a compact list on phones", () => {
    setMobile(true);
    renderPage(<SpotsTable spots={[spot(1), spot(2, { id: null, spot_time: null, source: null, mode: null })]} prefs={UTC} />);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText("14062.0 kHz CW")).toBeInTheDocument();
    expect(screen.getByText("14:00:05")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("says when nothing matches", () => {
    renderPage(<SpotsTable spots={[]} prefs={UTC} />);
    expect(screen.getByText("No spots match these filters yet.")).toBeInTheDocument();
  });
});

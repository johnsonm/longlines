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
  vi.mocked(loadIngestHealth).mockReset().mockResolvedValue([health("pota", 20), health("sotawatch", 600), health("rbn", 30, 3)]);
  vi.mocked(loadRecentSpots).mockReset().mockResolvedValue([
    spot(1),
    spot(2, { source: "sotawatch", pota_reference: null, sota_summit_ref: "W4C/CM-001", mode: null }),
  ]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SourcesPage", () => {
  it("shows live source health and planned sources", async () => {
    renderPage(<SourcesPage prefs={UTC} />);
    expect(await screen.findAllByText("Connected")).toHaveLength(2);
    expect(screen.getByText("Delayed")).toBeInTheDocument();
    expect(screen.getAllByText("Not yet available")).toHaveLength(3);
    expect(screen.getByText("20s ago")).toBeInTheDocument();
    expect(screen.getAllByText("12")).toHaveLength(2);
  });

  it("marks a live source with no health row as delayed", async () => {
    vi.mocked(loadIngestHealth).mockResolvedValue([]);
    renderPage(<SourcesPage prefs={UTC} />);
    expect(await screen.findAllByText("Delayed")).toHaveLength(3);
    expect(screen.getAllByText("–").length).toBeGreaterThan(0);
  });

  it("filters recent spots by source tab", async () => {
    const { user } = renderPage(<SourcesPage prefs={UTC} />);
    expect(await screen.findByText("W1AW")).toBeInTheDocument();
    expect(screen.getByText("W2AW")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "SOTAwatch" }));
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

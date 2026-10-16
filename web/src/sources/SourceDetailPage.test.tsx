import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { appValue, wrap } from "../test/render";
import { LocationProbe } from "../test/LocationProbe";
import { setMobile } from "../test/media";
import { loadIngestHealth, loadRecentSpots, type IngestHealth, type RecentSpot, type SubscriptionWithLinks } from "../lib/api";
import { useStats } from "../stats/useStats";
import type { LatestStats } from "../stats/types";
import { SourceDetailPage } from "./SourceDetailPage";

vi.mock("../lib/api", () => ({ loadIngestHealth: vi.fn(), loadRecentSpots: vi.fn() }));
vi.mock("../stats/useStats", () => ({ useStats: vi.fn() }));

const UTC = { utcTimes: true, timezone: "UTC" };
const hourly = (withDx = true) => Array.from({ length: 168 }, (_, i) => {
  const h: Record<string, unknown> = {
    hour: new Date(Date.UTC(2026, 9, 7) + i * 3_600_000).toISOString().replace(".000", ""),
    pota: i === 125 ? 88 : 36, sota: 5, rbn: i === 125 ? 708 : 192, aprs: 330_000,
  };
  if (withDx) h.dx = 56;
  return h;
});
const stats = (withDx = true) => ({ payload: { hourly: hourly(withDx) }, generatedAt: "2026-10-14T15:00:00Z" }) as unknown as LatestStats;
const spot = {
  id: 1, source: "pota", callsign: "W1AW", frequency_khz: 14062, band: "20m", mode: "cw", pota_reference: "US-0817",
  sota_summit_ref: null, spotter: "K1ABC", spot_time: "2026-10-14T14:00:05Z",
} as RecentSpot;

// renderPage mounts its element at one exact route, so this mounts the real /sources/:id route instead.
function open(path: string, subs: SubscriptionWithLinks[] = []) {
  return render(
    wrap(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/sources/:id" element={<SourceDetailPage prefs={UTC} subs={subs} />} />
          <Route path="/sources" element={<p>catalog</p>} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>,
      appValue(),
    ),
  );
}

beforeEach(() => {
  setMobile(false);
  vi.mocked(loadIngestHealth).mockReset().mockResolvedValue([
    { source: "pota", seconds_since_last_success: 20 }, { source: "rbn", seconds_since_last_success: 5 },
  ] as IngestHealth[]);
  vi.mocked(loadRecentSpots).mockReset().mockResolvedValue([spot]);
  vi.mocked(useStats).mockReturnValue({ stats: stats(), loading: false, error: null });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("SourceDetailPage", () => {
  it("shows RBN's alert, figures, schema and peak", async () => {
    open("/sources/rbn");
    expect(screen.getByRole("heading", { level: 1, name: "Reverse Beacon Network" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sources" })).toHaveAttribute("href", "/sources");
    expect(screen.getByText("High volume source: a callsign filter is required")).toBeInTheDocument();
    // (167 × 192 + 708) / 7 = 4,681.7 → "4,700"
    expect(screen.getByText(/^Reverse Beacon Network sends about 4,700 spots a day\./)).toBeInTheDocument();
    expect(screen.getByText("Peak 708 / hour, Oct 12, 05:00 UTC")).toBeInTheDocument();
    expect(screen.getByText("Oct 12, 05:00 UTC")).toBeInTheDocument(); // Busiest moment card
    expect(screen.getByText("708 / hour")).toBeInTheDocument(); // Peak, 7 days
    expect(screen.getByText("Callsign of the skimmer that heard the signal.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Visit reversebeacon.net/ })).toHaveAttribute("href", "https://reversebeacon.net");
    expect(screen.getByText("High volume")).toBeInTheDocument();
    expect(await screen.findByText("Connected")).toBeInTheDocument();
  });

  it("shows POTA's own fields, recent spots and last fetch", async () => {
    open("/sources/pota");
    expect(screen.getByText("pota_park_name")).toBeInTheDocument();
    expect(screen.getAllByText("Derived").length).toBeGreaterThan(0);
    expect(screen.getByText("Fields for other programs are present and null.")).toBeInTheDocument();
    expect(screen.queryByText("High volume source: a callsign filter is required")).not.toBeInTheDocument();
    expect(await screen.findByText("W1AW")).toBeInTheDocument();
    expect(loadRecentSpots).toHaveBeenCalledWith("pota");
    expect(await screen.findByText("Last fetch 20s ago, every 60s")).toBeInTheDocument();
    expect(screen.getByText(/"pota_reference": "US-2763"/)).toBeInTheDocument();
    expect(screen.getByText("Standard volume")).toBeInTheDocument();
    expect(screen.getByText("pota.app")).toBeInTheDocument(); // Run by > Website
  });

  it("creates a subscription from the source and lists the ones that use it", async () => {
    const user = userEvent.setup();
    open("/sources/pota", [
      { id: "s1", name: "NC parks", sources: ["pota"] }, { id: "s2", name: "Summits", sources: ["sotawatch"] },
    ] as SubscriptionWithLinks[]);
    expect(screen.getByRole("link", { name: "NC parks" })).toHaveAttribute("href", "/subscriptions/s1");
    expect(screen.queryByRole("link", { name: "Summits" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Create subscription" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/subscriptions/new");
    expect(screen.getByTestId("location")).toHaveAttribute("data-search", "?source=pota");
  });

  it("says when no subscription uses the source, and offers none on APRS-IS", () => {
    const { unmount } = open("/sources/sotawatch");
    expect(screen.getByText("None yet.")).toBeInTheDocument();
    unmount();
    open("/sources/aprs");
    expect(screen.queryByText("Your subscriptions")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Create subscription" })).not.toBeInTheDocument();
  });

  it("shows a delayed source", async () => {
    vi.mocked(loadIngestHealth).mockResolvedValue([{ source: "pota", seconds_since_last_success: 900 }] as IngestHealth[]);
    open("/sources/pota");
    expect(await screen.findByText("Delayed")).toBeInTheDocument();
  });

  it("shows why recent spots failed", async () => {
    vi.mocked(loadRecentSpots).mockRejectedValue(new Error("Couldn't load recent spots."));
    open("/sources/pota");
    expect(await screen.findByText("Couldn't load recent spots.")).toBeInTheDocument();
  });

  it("leaves schema, example and recent spots off APRS-IS", () => {
    open("/sources/aprs");
    expect(screen.getByText("High volume source: stored only")).toBeInTheDocument();
    expect(screen.getByText(/^APRS-IS sends about 7\.9 million packets a day\./)).toBeInTheDocument();
    expect(screen.queryByText("Schema")).not.toBeInTheDocument();
    expect(screen.queryByText("Example spot")).not.toBeInTheDocument();
    expect(screen.queryByText("Recent spots")).not.toBeInTheDocument();
    expect(loadRecentSpots).not.toHaveBeenCalled();
  });

  it("shows no rates for DX Cluster on a snapshot from before dx", () => {
    vi.mocked(useStats).mockReturnValue({ stats: stats(false), loading: false, error: null });
    vi.mocked(loadRecentSpots).mockResolvedValue([]); // SpotsTable may print "–" for null fields
    open("/sources/dxcluster");
    expect(screen.getAllByText("–")).toHaveLength(4);
    expect(screen.getByText("No rates yet. They appear after the next hourly stats refresh.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Visit/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Website")).not.toBeInTheDocument();
  });

  it("drops the per-day sentence from the RBN alert without rates", () => {
    vi.mocked(useStats).mockReturnValue({ stats: null, loading: false, error: null });
    open("/sources/rbn");
    expect(screen.queryByText(/spots a day/)).not.toBeInTheDocument();
    expect(screen.getByText(/^A subscription only gets its spots if it names callsigns/)).toBeInTheDocument();
  });

  it("drops the per-day sentence from the APRS-IS alert without rates", () => {
    vi.mocked(useStats).mockReturnValue({ stats: null, loading: false, error: null });
    open("/sources/aprs");
    expect(screen.getByText(/^Long Lines stores and archives them/)).toBeInTheDocument();
  });

  it("shows skeletons while stats load", () => {
    vi.mocked(useStats).mockReturnValue({ stats: null, loading: true, error: null });
    open("/sources/pota");
    expect(screen.queryByText("–")).not.toBeInTheDocument();
    expect(screen.queryByText("No rates yet. They appear after the next hourly stats refresh.")).not.toBeInTheDocument();
  });

  it("keeps the page when stats fail", () => {
    vi.mocked(useStats).mockReturnValue({ stats: null, loading: false, error: "Couldn't load stats." });
    open("/sources/pota");
    expect(screen.getByText("Couldn't load rates.")).toBeInTheDocument();
    expect(screen.getByText("About this source")).toBeInTheDocument();
  });

  it("keeps the page when ingest health fails", async () => {
    vi.mocked(loadIngestHealth).mockRejectedValue(new Error("x"));
    open("/sources/pota");
    expect(await screen.findByText("W1AW")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByText(/^Last fetch/)).not.toBeInTheDocument();
  });

  it.each(["/sources/nope"])("redirects %s to the catalog", (path) => {
    open(path);
    expect(screen.getByText("catalog")).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/sources");
  });

  it("stops refreshing recent spots when it unmounts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { unmount } = open("/sources/pota");
    await screen.findByText("W1AW");
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(loadRecentSpots).toHaveBeenCalledTimes(2);
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(loadRecentSpots).toHaveBeenCalledTimes(2);
  });

  it("lays out in one column on a phone", () => {
    setMobile(true);
    open("/sources/rbn");
    expect(screen.getByRole("heading", { level: 1, name: "Reverse Beacon Network" })).toBeInTheDocument();
    expect(screen.getByText("About this source")).toBeInTheDocument();
  });
});

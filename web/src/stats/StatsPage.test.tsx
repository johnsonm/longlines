import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderPage } from "../test/render";
import { setMobile } from "../test/media";
import { StatsPage } from "./StatsPage";
import type { LatestStats, StatsPayload } from "./types";
import { useStats } from "./useStats";

vi.mock("./useStats", () => ({ useStats: vi.fn() }));

export const PAYLOAD: StatsPayload = {
  totals: {
    spots: 12345, potaSpots: 10000, sotaSpots: 2345,
    activations: 1500, potaActivations: 1200, sotaActivations: 300,
    chasers: 4321, potaChasers: 4000, sotaChasers: 321,
    activators: 812, references: 640,
  },
  peakHour: 14,
  busiestSlot: { day: "2026-10-03", hour: 15 },
  daily: ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"].map((day, i) => ({
    day, pota: 1000 + i, sota: 300 + i, rbn: 24000,
  })),
  potaByState: { NC: 900, CA: 700, TX: 0 },
  sotaAssociations: [{ code: "W4C", spots: 120 }, { code: "W7A", spots: 90 }],
  bands: [{ band: "40m", pota: 3000, sota: 500 }, { band: "20m", pota: 5000, sota: 900 }],
  modes: [{ label: "CW", percent: 40 }, { label: "SSB", percent: 35 }, { label: "FT8/FT4", percent: 25 }],
  topActivators: [{ callsign: "KK4PWJ", references: 9, activations: 11, spots: 120, topBand: "20m" },
    { callsign: "W1AW", references: 2, activations: 2, spots: 10, topBand: null }],
  topReferences: [
    { reference: "US-0817", name: "Pisgah National Forest", program: "POTA", activations: 14, spots: 80 },
    { reference: "W4C/CM-001", name: null, program: "SOTA", activations: 6, spots: 40 },
  ],
  hourly: Array.from({ length: 168 }, (_, i) => ({
    hour: new Date(Date.UTC(2026, 8, 29) + i * 3_600_000).toISOString().replace(".000", ""),
    pota: 50, sota: 10, rbn: 1000,
  })),
  rbn: {
    spots: 168000, skimmers: 312,
    bands: [{ band: "40m", spots: 50000 }, { band: "20m", spots: 70000 }],
    topStations: [{ callsign: "K3LR", spots: 18420, skimmers: 214 }, { callsign: "DL1ABC", spots: 14870, skimmers: 176 }],
  },
};

const STATS: LatestStats = { payload: PAYLOAD, generatedAt: "2026-10-05T13:00:00Z" };

beforeEach(() => {
  vi.mocked(useStats).mockReset();
});

describe("StatsPage", () => {
  it("shows progress while loading", () => {
    vi.mocked(useStats).mockReturnValue({ stats: null, loading: true, error: null });
    renderPage(<StatsPage />);
    expect(screen.getAllByRole("progressbar").length).toBeGreaterThan(0);
  });

  it("shows the load error", () => {
    vi.mocked(useStats).mockReturnValue({ stats: null, loading: false, error: "Couldn't load stats." });
    renderPage(<StatsPage />);
    expect(screen.getByText("Couldn't load stats.")).toBeInTheDocument();
  });

  it("shows the empty state before there is data", () => {
    vi.mocked(useStats).mockReturnValue({ stats: null, loading: false, error: null });
    renderPage(<StatsPage />);
    expect(screen.getByText(/Not enough data yet/)).toBeInTheDocument();
  });

  it("renders the dashboard from the snapshot", () => {
    vi.mocked(useStats).mockReturnValue({ stats: STATS, loading: false, error: null });
    renderPage(<StatsPage />);
    expect(screen.getByText("All times UTC. Updated hourly, last at 13:00 UTC Oct 5.")).toBeInTheDocument();
    expect(screen.getByText("180,345")).toBeInTheDocument();
    expect(screen.getByText("168,000 RBN, 10,000 POTA, 2,345 SOTA")).toBeInTheDocument();
    expect(screen.getByText("1,200 POTA, 300 SOTA")).toBeInTheDocument();
    expect(screen.getByText("4,000 POTA, 321 SOTA")).toBeInTheDocument();
    expect(screen.getByText("14:00")).toBeInTheDocument();
    expect(screen.getByText("Busiest slot: Sat 15:00")).toBeInTheDocument();
    expect(screen.getByText("1. North Carolina")).toBeInTheDocument();
    expect(screen.getByText("2. California")).toBeInTheDocument();
    expect(screen.queryByText(/Texas/)).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Map of spots by state" })).toBeInTheDocument();
    expect(screen.getByText("Most active activators")).toBeInTheDocument();
  });

  it("shows ingest volume across all three sources", () => {
    vi.mocked(useStats).mockReturnValue({ stats: STATS, loading: false, error: null });
    renderPage(<StatsPage />);
    // 180,345 spots over 10,080 minutes; every hour of the fixture is 50 + 10 + 1,000.
    expect(screen.getByText("18/min")).toBeInTheDocument();
    expect(screen.getByText("Peak hour: 1,060 spots")).toBeInTheDocument();
    expect(screen.getByText("312")).toBeInTheDocument();
    expect(screen.getByText("Spots processed per hour")).toBeInTheDocument();
    // One per-day chart per source; the RBN subheader sums its seven days.
    expect(screen.getByText("168,000 spots")).toBeInTheDocument();
    expect(screen.getByText("RBN bands")).toBeInTheDocument();
    expect(screen.getByText("Most heard on RBN")).toBeInTheDocument();
    expect(screen.getByText("K3LR")).toBeInTheDocument();
  });

  it("renders on phones", () => {
    setMobile(true);
    vi.mocked(useStats).mockReturnValue({ stats: STATS, loading: false, error: null });
    renderPage(<StatsPage />);
    expect(screen.getByText("Most spotted parks and summits")).toBeInTheDocument();
  });

  it("renders a snapshot written before activations and chasers existed", () => {
    // After a migration the newest row keeps its old shape until the next hourly refresh.
    const totals: Record<string, number> = { ...PAYLOAD.totals };
    for (const key of ["activations", "potaActivations", "sotaActivations", "chasers", "potaChasers", "sotaChasers"]) {
      delete totals[key];
    }
    const stats = { ...STATS, payload: { ...PAYLOAD, totals } } as unknown as LatestStats;
    vi.mocked(useStats).mockReturnValue({ stats, loading: false, error: null });
    renderPage(<StatsPage />);
    expect(screen.getByText("180,345")).toBeInTheDocument();
    expect(screen.getAllByText("0 POTA, 0 SOTA")).toHaveLength(2);
  });

  it("renders a snapshot written before RBN figures and the hourly series existed", () => {
    const { hourly: _hourly, rbn: _rbn, ...old } = PAYLOAD;
    const stats = { ...STATS, payload: { ...old, daily: PAYLOAD.daily.map(({ rbn: _r, ...d }) => d) } } as unknown as LatestStats;
    vi.mocked(useStats).mockReturnValue({ stats, loading: false, error: null });
    renderPage(<StatsPage />);
    expect(screen.getByText("12,345")).toBeInTheDocument();
    expect(screen.getByText("0 RBN, 10,000 POTA, 2,345 SOTA")).toBeInTheDocument();
    expect(screen.getByText("Peak hour: 0 spots")).toBeInTheDocument();
    expect(screen.queryByText("Spots processed per hour")).not.toBeInTheDocument();
  });
});

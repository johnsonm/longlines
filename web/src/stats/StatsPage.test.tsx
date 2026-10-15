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
    day, pota: 1000 + i, sota: 300 + i, rbn: 24000, aprs: 250000, dx: 40,
  })),
  potaByState: { NC: 900, CA: 700, TX: 0 },
  countries: [
    { code: "US", pota: 9000, sota: 1500, dx: 2000, rbn: 90000 },
    { code: "DE", pota: 400, sota: 100, dx: 900, rbn: 30000 },
    { code: "MT", pota: 3, sota: 0, dx: 12, rbn: 0 },
  ],
  sotaAssociations: [{ code: "W4C", spots: 120 }, { code: "W7A", spots: 90 }],
  bands: [{ band: "40m", pota: 3000, sota: 500 }, { band: "20m", pota: 5000, sota: 900 }],
  modes: [{ label: "CW", percent: 40 }, { label: "SSB", percent: 35 }, { label: "FT8/FT4", percent: 25 }],
  topActivators: [{ callsign: "KK4PWJ/P", base: "KK4PWJ", references: 9, activations: 11, spots: 120, topBand: "20m" },
    { callsign: "W1AW", base: "W1AW", references: 2, activations: 2, spots: 10, topBand: null }],
  topReferences: [
    { reference: "US-0817", name: "Pisgah National Forest", program: "POTA", activations: 14, spots: 80 },
    { reference: "W4C/CM-001", name: null, program: "SOTA", activations: 6, spots: 40 },
  ],
  hourly: Array.from({ length: 168 }, (_, i) => ({
    hour: new Date(Date.UTC(2026, 8, 29) + i * 3_600_000).toISOString().replace(".000", ""),
    pota: 50, sota: 10, rbn: 1000, aprs: 10000, dx: 2,
  })),
  rbn: {
    spots: 168000, skimmers: 312,
    bands: [{ band: "40m", spots: 50000 }, { band: "20m", spots: 70000 }],
    topStations: [{ callsign: "K3LR", spots: 18420, skimmers: 214 }, { callsign: "DL1ABC", spots: 14870, skimmers: 176 }],
  },
  aprs: {
    packets: 1750000, stations: 41234, igates: 9876,
    types: [{ type: "position", packets: 1000000 }, { type: "mic_e", packets: 500000 }, { type: "weather", packets: 250000 }],
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
    expect(screen.getByText("1,930,345")).toBeInTheDocument();
    expect(screen.getByText("168,000 RBN, 1,750,000 APRS, 10,000 POTA, 2,345 SOTA")).toBeInTheDocument();
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

  it("shows ingest volume across every source", () => {
    vi.mocked(useStats).mockReturnValue({ stats: STATS, loading: false, error: null });
    renderPage(<StatsPage />);
    // 1,930,345 spots and packets over 10,080 minutes; every hour of the fixture is 50 + 10 + 1,000 + 10,000.
    expect(screen.getByText("192/min")).toBeInTheDocument();
    expect(screen.getByText("Peak hour: 11,060 spots")).toBeInTheDocument();
    expect(screen.getByText("312")).toBeInTheDocument();
    expect(screen.getByText("Spots processed per hour")).toBeInTheDocument();
    // One per-day chart per source; the RBN subheader sums its seven days.
    expect(screen.getByText("168,000 spots")).toBeInTheDocument();
    expect(screen.getByText("1,750,000 packets")).toBeInTheDocument();
    expect(screen.getByText("RBN bands")).toBeInTheDocument();
    expect(screen.getByText("Most heard on RBN")).toBeInTheDocument();
    expect(screen.getByText("K3LR")).toBeInTheDocument();
  });

  it("links every callsign to its profile by base call", async () => {
    vi.mocked(useStats).mockReturnValue({ stats: STATS, loading: false, error: null });
    const { user } = renderPage(<StatsPage />);
    expect(screen.getByRole("link", { name: "W1AW" })).toHaveAttribute("href", "/call/W1AW");
    expect(screen.getByRole("link", { name: "K3LR" })).toHaveAttribute("href", "/call/K3LR");
    expect(screen.getByRole("link", { name: "DL1ABC" })).toHaveAttribute("href", "/call/DL1ABC");
    await user.click(screen.getByRole("link", { name: "KK4PWJ/P" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/call/KK4PWJ");
  });

  it("links an activator by callsign in a snapshot written before base calls existed", () => {
    // The profile page swaps KK4PWJ/P for its base call.
    const topActivators = PAYLOAD.topActivators.map(({ base: _base, ...a }) => a);
    const stats = { ...STATS, payload: { ...PAYLOAD, topActivators } } as unknown as LatestStats;
    vi.mocked(useStats).mockReturnValue({ stats, loading: false, error: null });
    renderPage(<StatsPage />);
    expect(screen.getByRole("link", { name: "KK4PWJ/P" })).toHaveAttribute("href", "/call/KK4PWJ/P");
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
    expect(screen.getByText("1,930,345")).toBeInTheDocument();
    expect(screen.getAllByText("0 POTA, 0 SOTA")).toHaveLength(2);
  });

  it("renders a snapshot written before RBN figures and the hourly series existed", () => {
    const { hourly: _hourly, rbn: _rbn, aprs: _aprs, ...old } = PAYLOAD;
    const daily = PAYLOAD.daily.map(({ rbn: _r, aprs: _a, ...d }) => d);
    const stats = { ...STATS, payload: { ...old, daily } } as unknown as LatestStats;
    vi.mocked(useStats).mockReturnValue({ stats, loading: false, error: null });
    renderPage(<StatsPage />);
    expect(screen.getByText("12,345")).toBeInTheDocument();
    expect(screen.getByText("0 RBN, 0 APRS, 10,000 POTA, 2,345 SOTA")).toBeInTheDocument();
    expect(screen.getByText("Peak hour: 0 spots")).toBeInTheDocument();
    expect(screen.queryByText("Spots processed per hour")).not.toBeInTheDocument();
  });

  it("shows the APRS-IS section", () => {
    vi.mocked(useStats).mockReturnValue({ stats: STATS, loading: false, error: null });
    renderPage(<StatsPage />);
    expect(screen.getByText("APRS-IS")).toBeInTheDocument();
    expect(screen.getByText("Every packet on the APRS-IS full feed. Packets aren't spots and never trigger alerts.")).toBeInTheDocument();
    expect(screen.getByText("APRS packets")).toBeInTheDocument();
    expect(screen.getByText("1,750,000")).toBeInTheDocument();
    expect(screen.getByText("Stations heard")).toBeInTheDocument();
    expect(screen.getByText("41,234")).toBeInTheDocument();
    expect(screen.getByText("Unique callsigns that sent a packet, SSIDs combined")).toBeInTheDocument();
    expect(screen.getByText("Igates")).toBeInTheDocument();
    expect(screen.getByText("9,876")).toBeInTheDocument();
    expect(screen.getByText("Packet types")).toBeInTheDocument();
    expect(screen.getByText("What APRS stations sent")).toBeInTheDocument();
    expect(screen.getByText(/RBN and APRS run 100 times the volume of POTA or more/)).toBeInTheDocument();
  });

  it("shows spots by country", () => {
    vi.mocked(useStats).mockReturnValue({ stats: STATS, loading: false, error: null });
    renderPage(<StatsPage />);
    expect(screen.getByText("Activity by country")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Map of spots by country" })).toBeInTheDocument();
    expect(screen.getByText("Busiest countries")).toBeInTheDocument();
    expect(screen.getByText("1. United States")).toBeInTheDocument();
    expect(screen.getByText("102,500")).toBeInTheDocument();
    // Malta is too small for the atlas but still listed.
    expect(screen.getByText("3. Malta")).toBeInTheDocument();
  });

  it("renders a snapshot written before countries existed", () => {
    const { countries: _countries, ...old } = PAYLOAD;
    const stats = { ...STATS, payload: old } as unknown as LatestStats;
    vi.mocked(useStats).mockReturnValue({ stats, loading: false, error: null });
    renderPage(<StatsPage />);
    expect(screen.getByRole("img", { name: "Map of spots by country" })).toBeInTheDocument();
    expect(screen.queryByText("1. United States")).not.toBeInTheDocument();
  });

  it("renders a snapshot written before APRS figures existed", () => {
    const { aprs: _aprs, ...old } = PAYLOAD;
    const daily = PAYLOAD.daily.map(({ aprs: _a, ...d }) => d);
    const hourly = PAYLOAD.hourly.map(({ aprs: _a, ...h }) => h);
    const stats = { ...STATS, payload: { ...old, daily, hourly } } as unknown as LatestStats;
    vi.mocked(useStats).mockReturnValue({ stats, loading: false, error: null });
    renderPage(<StatsPage />);
    expect(screen.getByText("180,345")).toBeInTheDocument();
    expect(screen.getByText("168,000 RBN, 0 APRS, 10,000 POTA, 2,345 SOTA")).toBeInTheDocument();
    expect(screen.getByText("Peak hour: 1,060 spots")).toBeInTheDocument();
    expect(screen.getByText("0 packets")).toBeInTheDocument();
    expect(screen.getByText("APRS packets")).toBeInTheDocument();
  });
});

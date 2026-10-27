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
    spots: 13000, potaSpots: 10000, sotaSpots: 2345, wwffSpots: 655,
    activations: 1600, potaActivations: 1200, sotaActivations: 300, wwffActivations: 100,
    chasers: 4400, potaChasers: 4000, sotaChasers: 321, wwffChasers: 79,
    activators: 812, references: 640,
  },
  peakHour: 14,
  busiestSlot: { day: "2026-10-03", hour: 15 },
  daily: ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"].map((day, i) => ({
    day, pota: 1000 + i, sota: 300 + i, wwff: 90 + i, rbn: 24000, aprs: 250000, dx: 40,
  })),
  potaByState: { NC: 900, CA: 700, TX: 0 },
  countries: [
    { code: "US", pota: 9000, sota: 1500, wwff: 300, dx: 2000, rbn: 90000 },
    { code: "DE", pota: 400, sota: 100, wwff: 600, dx: 900, rbn: 30000 },
    { code: "MT", pota: 3, sota: 0, wwff: 0, dx: 12, rbn: 0 },
  ],
  sotaAssociations: [{ code: "W4C", spots: 120 }, { code: "W7A", spots: 90 }],
  wwffPrograms: [{ code: "KFF", spots: 300 }, { code: "ONFF", spots: 120 }],
  bands: [{ band: "40m", pota: 3000, sota: 500, wwff: 200 }, { band: "20m", pota: 5000, sota: 900, wwff: 400 }],
  modes: [{ label: "CW", percent: 40 }, { label: "SSB", percent: 35 }, { label: "FT8/FT4", percent: 25 }],
  topActivators: [{ callsign: "KK4PWJ/P", base: "KK4PWJ", references: 9, activations: 11, spots: 120, topBand: "20m" },
    { callsign: "W1AW", base: "W1AW", references: 2, activations: 2, spots: 10, topBand: null }],
  topReferences: [
    { reference: "US-0817", name: "Pisgah National Forest", program: "POTA", activations: 14, spots: 80 },
    { reference: "W4C/CM-001", name: null, program: "SOTA", activations: 6, spots: 40 },
    { reference: "KFF-5268", name: "T.M. Goodwin", program: "WWFF", activations: 4, spots: 30 },
  ],
  hourly: Array.from({ length: 168 }, (_, i) => ({
    hour: new Date(Date.UTC(2026, 8, 29) + i * 3_600_000).toISOString().replace(".000", ""),
    pota: 50, sota: 10, wwff: 5, rbn: 1000, aprs: 10000, dx: 2,
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
    expect(screen.getByText("1,931,000")).toBeInTheDocument();
    expect(screen.getByText("168,000 RBN, 1,750,000 APRS, 10,000 POTA, 2,345 SOTA, 655 WWFF")).toBeInTheDocument();
    expect(screen.getByText("1,200 POTA, 300 SOTA, 100 WWFF")).toBeInTheDocument();
    expect(screen.getByText("4,000 POTA, 321 SOTA, 79 WWFF")).toBeInTheDocument();
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
    // 1,931,000 spots and packets over 10,080 minutes; every hour of the fixture is 50 + 10 + 5 + 1,000 + 10,000 + 2 (DX Cluster).
    expect(screen.getByText("192/min")).toBeInTheDocument();
    expect(screen.getByText("Peak hour: 11,067 spots")).toBeInTheDocument();
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
    expect(screen.getByText("Most spotted parks, summits and WWFF references")).toBeInTheDocument();
  });

  it("renders a snapshot written before activations and chasers existed", () => {
    // After a migration the newest row keeps its old shape until the next hourly refresh.
    const totals: Record<string, number> = { ...PAYLOAD.totals };
    for (const key of [
      "activations", "potaActivations", "sotaActivations", "wwffActivations", "chasers", "potaChasers", "sotaChasers", "wwffChasers",
    ]) {
      delete totals[key];
    }
    const stats = { ...STATS, payload: { ...PAYLOAD, totals } } as unknown as LatestStats;
    vi.mocked(useStats).mockReturnValue({ stats, loading: false, error: null });
    renderPage(<StatsPage />);
    expect(screen.getByText("1,931,000")).toBeInTheDocument();
    expect(screen.getAllByText("0 POTA, 0 SOTA, 0 WWFF")).toHaveLength(2);
  });

  it("renders a snapshot written before RBN figures and the hourly series existed", () => {
    const { hourly: _hourly, rbn: _rbn, aprs: _aprs, ...old } = PAYLOAD;
    const daily = PAYLOAD.daily.map(({ rbn: _r, aprs: _a, ...d }) => d);
    const stats = { ...STATS, payload: { ...old, daily } } as unknown as LatestStats;
    vi.mocked(useStats).mockReturnValue({ stats, loading: false, error: null });
    renderPage(<StatsPage />);
    expect(screen.getByText("13,000")).toBeInTheDocument();
    expect(screen.getByText("0 RBN, 0 APRS, 10,000 POTA, 2,345 SOTA, 655 WWFF")).toBeInTheDocument();
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
    expect(screen.getByText("102,800")).toBeInTheDocument();
    expect(screen.getByText("POTA, SOTA, WWFF, DX Cluster and RBN spots by the country of the station on the air. Darker means more activity.")).toBeInTheDocument();
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

  it("leaves DX Cluster out of the hourly sum on a snapshot from before dx", () => {
    const hourly = PAYLOAD.hourly.map(({ dx: _d, ...h }) => h);
    const stats = { ...STATS, payload: { ...PAYLOAD, hourly } } as unknown as LatestStats;
    vi.mocked(useStats).mockReturnValue({ stats, loading: false, error: null });
    renderPage(<StatsPage />);
    expect(screen.getByText("Peak hour: 11,065 spots")).toBeInTheDocument();
  });

  it("renders a snapshot written before APRS figures existed", () => {
    const { aprs: _aprs, ...old } = PAYLOAD;
    const daily = PAYLOAD.daily.map(({ aprs: _a, ...d }) => d);
    const hourly = PAYLOAD.hourly.map(({ aprs: _a, ...h }) => h);
    const stats = { ...STATS, payload: { ...old, daily, hourly } } as unknown as LatestStats;
    vi.mocked(useStats).mockReturnValue({ stats, loading: false, error: null });
    renderPage(<StatsPage />);
    expect(screen.getByText("181,000")).toBeInTheDocument();
    expect(screen.getByText("168,000 RBN, 0 APRS, 10,000 POTA, 2,345 SOTA, 655 WWFF")).toBeInTheDocument();
    expect(screen.getByText("Peak hour: 1,067 spots")).toBeInTheDocument();
    expect(screen.getByText("0 packets")).toBeInTheDocument();
    expect(screen.getByText("APRS packets")).toBeInTheDocument();
  });

  it("shows WWFF next to POTA and SOTA", () => {
    vi.mocked(useStats).mockReturnValue({ stats: STATS, loading: false, error: null });
    renderPage(<StatsPage />);
    expect(screen.getByText("Peak POTA/SOTA/WWFF hour")).toBeInTheDocument();
    expect(screen.getByText("Unique POTA, SOTA and WWFF callsigns")).toBeInTheDocument();
    expect(screen.getByText("Parks, summits and WWFF")).toBeInTheDocument();
    // The WWFF per-day chart sums 90 + 91 + ... + 96.
    expect(screen.getByText("651 spots")).toBeInTheDocument();
    expect(screen.getByText("WWFF bands")).toBeInTheDocument();
    expect(screen.getByText("Where WWFF activators are operating")).toBeInTheDocument();
    expect(screen.getByText("Top WWFF programs")).toBeInTheDocument();
    expect(screen.getByText("Programs with the most WWFF spots")).toBeInTheDocument();
    expect(screen.getByText("Share of POTA, SOTA and WWFF spots")).toBeInTheDocument();
    expect(screen.getByText("By number of parks, summits and WWFF references activated")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "KFF-5268" })).toHaveAttribute("href", "/ref/wwff/KFF-5268");
    expect(screen.getByRole("link", { name: "US-0817" })).toHaveAttribute("href", "/ref/pota/US-0817");
  });

  it("renders a snapshot written before WWFF existed", () => {
    const { wwffPrograms: _programs, ...old } = PAYLOAD;
    const { wwffSpots: _s, wwffActivations: _a, wwffChasers: _c, ...totals } = PAYLOAD.totals;
    const daily = PAYLOAD.daily.map(({ wwff: _w, ...d }) => d);
    const hourly = PAYLOAD.hourly.map(({ wwff: _w, ...h }) => h);
    const bands = PAYLOAD.bands.map(({ wwff: _w, ...b }) => b);
    const countries = PAYLOAD.countries.map(({ wwff: _w, ...c }) => c);
    const stats = { ...STATS, payload: { ...old, totals, daily, hourly, bands, countries } } as unknown as LatestStats;
    vi.mocked(useStats).mockReturnValue({ stats, loading: false, error: null });
    renderPage(<StatsPage />);
    expect(screen.getByText("168,000 RBN, 1,750,000 APRS, 10,000 POTA, 2,345 SOTA, 0 WWFF")).toBeInTheDocument();
    expect(screen.getByText("Peak hour: 11,062 spots")).toBeInTheDocument();
    expect(screen.getByText("0 spots")).toBeInTheDocument();
    expect(screen.getByText("102,500")).toBeInTheDocument();
    expect(screen.getByText("Top WWFF programs")).toBeInTheDocument();
  });
});

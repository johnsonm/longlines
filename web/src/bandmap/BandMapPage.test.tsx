import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { renderPage } from "../test/render";
import { setMobile } from "../test/media";
import { BandMapPage } from "./BandMapPage";
import type { BandMapPayload, BandMapSpot } from "./types";
import { useBandMap } from "./useBandMap";

vi.mock("./useBandMap", () => ({ useBandMap: vi.fn() }));

// jsdom lays nothing out, so the chart's own Voronoi click can't run here. The stand-in draws each
// point as a button that calls onItemClick the way the chart does, with the tooltip text as its
// name, and shows what the strip asked the chart for.
interface StubPoint { x: number; y: number; id: number }
interface StubSeries { id: string; color: string; markerSize: number; data: StubPoint[]; valueFormatter: (v: StubPoint) => string | null }
interface StubProps {
  series: StubSeries[];
  xAxis: { min: number; max: number; tickNumber: number }[];
  height: number;
  onItemClick: (e: { clientX: number; clientY: number }, item: { type: "scatter"; seriesId: string; dataIndex: number }) => void;
  children: ReactNode;
}
vi.mock("@mui/x-charts/ScatterChart", () => ({
  ScatterChart: ({ series, xAxis, height, onItemClick, children }: StubProps) => (
    <div data-testid="chart" data-height={height} data-ticks={xAxis[0]!.tickNumber} data-range={`${xAxis[0]!.min}-${xAxis[0]!.max}`}>
      {series.map((s) => s.data.map((p, i) => (
        <button
          key={p.id}
          type="button"
          data-lane={p.y}
          data-series={s.id}
          data-size={s.markerSize}
          onClick={() => onItemClick({ clientX: 100, clientY: 200 }, { type: "scatter", seriesId: s.id, dataIndex: i })}
        >
          {s.valueFormatter(p)}
        </button>
      )))}
      {children}
    </div>
  ),
}));
vi.mock("@mui/x-charts/ChartsReferenceLine", () => ({
  ChartsReferenceLine: ({ x, label, lineStyle }: { x: number; label?: string; lineStyle: { stroke: string } }) => (
    <span data-testid="segment" data-x={x} data-stroke={lineStyle.stroke}>{label ?? ""}</span>
  ),
}));

let nextId = 1;
function spot(over: Partial<BandMapSpot>): BandMapSpot {
  const id = nextId++;
  return {
    id, callsign: `N${id}ABC`, base_callsign: `N${id}ABC`, frequency_khz: 14062, mode: "cw", source: "pota",
    spot_time: new Date(Date.now() - 120_000).toISOString(), spotter: null, reference: null, reference_name: null, ...over,
  };
}

const ALONE = spot({ callsign: "KK4PWJ/P", base_callsign: "KK4PWJ", frequency_khz: 14285, mode: "ssb", source: "sotawatch", reference: "W4C/CM-001" });
const FT8 = [14074, 14074.5, 14075.2].map((f) => spot({ frequency_khz: f, mode: "ft8", source: "dxcluster" }));
const PARK = spot({ callsign: "W1AW", base_callsign: "W1AW", frequency_khz: 14010, reference: "US-0817" });
const FORTY = spot({ frequency_khz: 7030, source: "pota" });

const PAYLOAD: BandMapPayload = {
  bands: [{ band: "40m", spots: [FORTY] }, { band: "20m", spots: [PARK, ...FT8, ALONE] }],
  generated_at: new Date(Date.now() - 30_000).toISOString(),
};

function strip(band: string): HTMLElement {
  return screen.getByRole("heading", { name: new RegExp(`^${band} · `) }).closest(".MuiCard-root") as HTMLElement;
}

beforeEach(() => {
  setMobile(false);
  vi.mocked(useBandMap).mockReturnValue({ payload: PAYLOAD, loading: false, error: null });
});

describe("BandMapPage", () => {
  it("shows the title, the copy, every band in band plan order and when the snapshot was made", () => {
    renderPage(<BandMapPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Band map" })).toBeInTheDocument();
    expect(screen.getByText("Stations spotted in the last 5 minutes, by frequency. Select a station to open its profile.")).toBeInTheDocument();
    expect(screen.getByText(/Reverse Beacon Network spots aren't shown here/)).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "160m · 0 heard", "80m · 0 heard", "40m · 1 heard", "30m · 0 heard", "20m · 5 heard",
      "17m · 0 heard", "15m · 0 heard", "12m · 0 heard", "10m · 0 heard", "6m · 0 heard",
    ]);
    expect(screen.getByText(/^Updated \d+ seconds ago$/)).toBeInTheDocument();
  });

  it("says nothing was heard on an empty band and draws no chart there", () => {
    renderPage(<BandMapPage />);
    expect(within(strip("160m")).getByText("Nothing heard in the last 5 minutes.")).toBeInTheDocument();
    expect(within(strip("160m")).queryByTestId("chart")).toBeNull();
    expect(screen.getAllByTestId("chart")).toHaveLength(2);
  });

  it("puts each source in its lane, with the band's range and the desktop size", () => {
    renderPage(<BandMapPage />);
    const chart = within(strip("20m")).getByTestId("chart");
    expect(chart).toHaveAttribute("data-range", "14000-14350");
    expect(chart).toHaveAttribute("data-ticks", "8");
    expect(chart).toHaveAttribute("data-height", "120");
    const lanes = within(chart).getAllByRole("button").map((b) => `${b.dataset.series}:${b.dataset.lane}`);
    expect(new Set(lanes)).toEqual(new Set(["dxcluster:0", "pota:1", "sotawatch:2"]));
  });

  it("labels the segments, hiding a cramped label and the band edge's line", () => {
    renderPage(<BandMapPage />);
    const segments = within(strip("20m")).getAllByTestId("segment");
    expect(segments.map((s) => s.textContent)).toEqual(["CW", "Digital", "Phone"]);
    expect(segments[0]).toHaveAttribute("data-stroke", "transparent");
    expect(segments[1]!.dataset.stroke).not.toBe("transparent");
  });

  it("gives each dot a tooltip with its call, frequency, mode and age", () => {
    renderPage(<BandMapPage />);
    expect(within(strip("20m")).getByRole("button", { name: "KK4PWJ/P 14285.0 kHz SSB · 2m ago" })).toBeInTheDocument();
  });

  it("turns a source off and on, updating the counts", async () => {
    const { user } = renderPage(<BandMapPage />);
    const dx = screen.getByRole("button", { name: "DX Cluster" });
    expect(dx).toHaveAttribute("aria-pressed", "true");
    await user.click(dx);
    expect(dx).toHaveAttribute("aria-pressed", "false");
    expect(dx).toHaveClass("MuiChip-outlined");
    expect(screen.getByRole("heading", { name: "20m · 2 heard" })).toBeInTheDocument();
    expect(within(strip("20m")).queryAllByRole("button").map((b) => b.dataset.series)).not.toContain("dxcluster");
    await user.click(screen.getByRole("button", { name: "POTA" }));
    expect(screen.getByRole("heading", { name: "40m · 0 heard" })).toBeInTheDocument();
    await user.click(dx);
    expect(screen.getByRole("heading", { name: "20m · 4 heard" })).toBeInTheDocument();
  });

  it("opens an isolated station's profile at its base call", async () => {
    const { user } = renderPage(<BandMapPage />, { route: "/band-map" });
    await user.click(within(strip("20m")).getByRole("button", { name: /^KK4PWJ\/P / }));
    expect(screen.getByTestId("location")).toHaveTextContent("/call/KK4PWJ");
  });

  it("opens the crowd menu on a crowded spot, and a choice opens that profile", async () => {
    const { user } = renderPage(<BandMapPage />, { route: "/band-map" });
    await user.click(within(strip("20m")).getAllByRole("button", { name: /14074\.5 kHz FT8/ })[0]!);
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("3 stations near 14.075")).toBeInTheDocument();
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(FT8.map((s) => `${s.callsign}${s.frequency_khz.toFixed(1)} kHz FT8 · DX Cluster · 2m ago`));
    await user.click(items[2]!);
    expect(screen.getByTestId("location")).toHaveTextContent(`/call/${FT8[2]!.base_callsign}`);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("links a crowd row's park or summit to its reference page", async () => {
    const park = spot({ callsign: "N4MTS/P", base_callsign: "N4MTS", frequency_khz: 14062, reference: "US-2763" });
    const summit = spot({ frequency_khz: 14062.5, source: "sotawatch", reference: "W4C/CM-001" });
    vi.mocked(useBandMap).mockReturnValue({
      payload: { bands: [{ band: "20m", spots: [park, summit] }], generated_at: PAYLOAD.generated_at }, loading: false, error: null,
    });
    const { user } = renderPage(<BandMapPage />, { route: "/band-map" });
    await user.click(within(strip("20m")).getByRole("button", { name: /^N4MTS\/P / }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "W4C/CM-001" })).toHaveAttribute("href", "/ref/sota/W4C/CM-001");
    await user.click(within(menu).getByRole("menuitem", { name: "US-2763" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/ref/pota/US-2763");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("reaches a crowd row's reference with the arrow keys", async () => {
    const park = spot({ callsign: "N4MTS/P", base_callsign: "N4MTS", frequency_khz: 14062, reference: "US-2763" });
    const summit = spot({ frequency_khz: 14062.5, source: "sotawatch", reference: "W4C/CM-001" });
    vi.mocked(useBandMap).mockReturnValue({
      payload: { bands: [{ band: "20m", spots: [park, summit] }], generated_at: PAYLOAD.generated_at }, loading: false, error: null,
    });
    const { user } = renderPage(<BandMapPage />, { route: "/band-map" });
    await user.click(within(strip("20m")).getByRole("button", { name: /^N4MTS\/P / }));
    const menu = await screen.findByRole("menu");
    const target = within(menu).getByRole("menuitem", { name: "US-2763" });
    for (let i = 0; i < 4 && document.activeElement !== target; i++) await user.keyboard("{ArrowDown}");
    expect(target).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("location")).toHaveTextContent("/ref/pota/US-2763");
  });

  it("uses a phone's wider crowd net, fewer ticks and bigger dots on mobile", async () => {
    setMobile(true);
    const { user } = renderPage(<BandMapPage />, { route: "/band-map" });
    const chart = within(strip("20m")).getByTestId("chart");
    expect(chart).toHaveAttribute("data-ticks", "4");
    expect(chart).toHaveAttribute("data-height", "130");
    expect(within(chart).getAllByRole("button")[0]).toHaveAttribute("data-size", "5");
    // 350 / 45 ≈ 7.8 kHz: W1AW at 14010 is still alone, the FT8 three are a crowd.
    await user.click(within(chart).getByRole("button", { name: /^W1AW / }));
    expect(screen.getByTestId("location")).toHaveTextContent("/call/W1AW");
  });

  it("shows progress while loading and the error when loading failed", () => {
    vi.mocked(useBandMap).mockReturnValue({ payload: null, loading: true, error: null });
    const { unmount } = renderPage(<BandMapPage />);
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    unmount();
    vi.mocked(useBandMap).mockReturnValue({ payload: null, loading: false, error: "The band map is unavailable right now." });
    renderPage(<BandMapPage />);
    expect(screen.getByRole("alert")).toHaveTextContent("The band map is unavailable right now.");
  });
});

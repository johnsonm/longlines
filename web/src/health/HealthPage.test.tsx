import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { renderPage } from "../test/render";
import { healthChecks, healthPayload } from "../test/health";
import { HealthPage } from "./HealthPage";
import { useHealth } from "./useHealth";

vi.mock("./useHealth", () => ({ useHealth: vi.fn() }));

// jsdom lays nothing out, so the charts are stand-ins that show what the page asked for: each
// series' label and the formatted first and last values, the axis labels for the first bucket, the
// y axis top and the limit line.
type Formatter = (v: unknown, ctx: { location: string }) => string;
interface StubAxis { data: unknown[]; valueFormatter: Formatter; tickInterval?: (v: unknown, i: number) => boolean; tickLabelInterval?: (v: unknown, i: number) => boolean }
interface StubSeries { label: string; data: (number | null)[]; valueFormatter?: (v: number | null) => string }
interface StubProps { xAxis: StubAxis[]; yAxis: { max?: number }[]; series: StubSeries[]; children?: ReactNode }

function Stub({ kind, xAxis, yAxis, series, children }: StubProps & { kind: string }) {
  const axis = xAxis[0]!;
  const first = axis.data[0]!;
  const ticks = axis.data.filter((d, i) => axis.tickInterval?.(d, i) ?? true).length;
  const labelled = axis.data.filter((d, i) => axis.tickLabelInterval?.(d, i) ?? true).length;
  return (
    <figure data-testid={kind} data-max={yAxis[0]?.max ?? ""} data-ticks={ticks} data-labelled={labelled}>
      <span>{`tick ${axis.valueFormatter(first, { location: "tick" })}; tooltip ${axis.valueFormatter(first, { location: "tooltip" })}`}</span>
      {series.map((s) => (
        <span key={s.label}>{`${s.label}: ${s.valueFormatter ? `${s.valueFormatter(s.data.at(-1) ?? null)}|${s.valueFormatter(null)}` : s.data.at(-1)}`}</span>
      ))}
      {children}
    </figure>
  );
}
vi.mock("@mui/x-charts", () => ({
  LineChart: (p: StubProps) => <Stub kind="line" {...p} />,
  BarChart: (p: StubProps) => <Stub kind="bar" {...p} />,
}));
vi.mock("@mui/x-charts/ChartsReferenceLine", () => ({
  ChartsReferenceLine: ({ y, label }: { y: number; label: string }) => <span data-testid="limit">{`${label} at ${y}`}</span>,
}));

const refresh = vi.fn();

beforeEach(() => {
  vi.mocked(useHealth).mockReset();
  refresh.mockReset();
});

const chart = (title: string) => screen.getByRole("heading", { name: title }).closest(".MuiCard-root") as HTMLElement;

describe("HealthPage", () => {
  it("shows progress and the load error", () => {
    vi.mocked(useHealth).mockReturnValue({ payload: null, loading: true, error: "Health is unavailable right now.", refresh });
    renderPage(<HealthPage />);
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(screen.getByText("Health is unavailable right now.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
    expect(screen.queryByText("Current status")).not.toBeInTheDocument();
  });

  it("renders every check, with no banner while all are Healthy", () => {
    vi.mocked(useHealth).mockReturnValue({ payload: healthPayload(), loading: false, error: null, refresh });
    renderPage(<HealthPage />);
    expect(screen.getByRole("heading", { name: "Health", level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/^Updated \d\d:\d\d:\d\d$/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const rows = within(screen.getByText("Current status").closest(".MuiCard-root") as HTMLElement).getAllByRole("row");
    expect(rows.map((r) => r.textContent)).toEqual([
      "CheckStatusNowRule",
      "Pulled sourcesPOTA, SOTAwatch, WWFF, WWBOTAHealthyLast success 22 s agoDelayed after 3 min without a success",
      "Inbound feedsRBN, DX Cluster, APRS-ISHealthyLast push 41 s ago · 0 reconnects in 24 hDelayed after 3 min without a push",
      "Match queuespot_eventsHealthy9 waiting · oldest 3 sDelayed when the oldest waits over 2 min",
      "Delivery queuedeliveries_queueHealthy12 waiting · oldest ready 4 sDelayed when the oldest ready waits over 2 min",
      "SenderFly.io, longlines-senderHealthyLast progress 6 s ago · 0 restarts in 24 hFailing after 2 min without progress",
      "DatabaseHealthy38 of 60 connections · disk 61% fullDelayed over 80% of either",
      "Scheduled jobsHealthy10 jobs · 0 failed runs in the last hourFailing when a job fails 3 runs in a row; delayed when one is slower or fails more than usual",
      "ArchiveHealthyLast slice written 6 min agoDelayed after 2 hours",
    ]);
  });

  it("shows the banner and each status's chip", () => {
    const checks = healthChecks({
      delivery_queue: { status: "delayed", waiting: 184, oldest_ready_seconds: 240, throttled: 3 },
      sender: { status: "failing", progress_seconds: 600, restarts_24h: 1, memory_bytes: null },
      inbound: { status: "unknown", feeds: [], reconnects_24h: null },
    });
    vi.mocked(useHealth).mockReturnValue({ payload: healthPayload({ checks }), loading: false, error: null, refresh });
    renderPage(<HealthPage />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Outbound is slower than usual184 waiting · oldest ready 4 min · 3 destinations throttled2 checks need attention.");
    expect(alert).toHaveClass("MuiAlert-colorError");
    expect(screen.getAllByText("Delayed").length).toBe(1);
    expect(screen.getAllByText("Failing").length).toBe(1);
    expect(screen.getAllByText("No data").length).toBe(3); // the inbound worker chip and Now, and the memory figure
  });

  it("draws the charts with their limits and figures", () => {
    const payload = healthPayload();
    payload.series.expired[47] = 3;
    payload.series.latency_p95[47] = 210.4;
    vi.mocked(useHealth).mockReturnValue({ payload, loading: false, error: null, refresh });
    renderPage(<HealthPage />);
    expect(within(chart("Match queue")).getByText("9 waiting")).toBeInTheDocument();
    expect(within(chart("Match queue")).getByTestId("limit")).toHaveTextContent("500 per run at 500");
    expect(within(chart("Match queue")).getByTestId("line")).toHaveAttribute("data-max", "600");
    expect(within(chart("Delivery queue")).getByText("12 waiting")).toBeInTheDocument();
    expect(within(chart("Oldest ready delivery")).getByText("4 s")).toBeInTheDocument();
    expect(within(chart("Oldest ready delivery")).getByText("Oldest ready: 4 s|")).toBeInTheDocument();
    expect(within(chart("Oldest ready delivery")).getByTestId("limit")).toHaveTextContent("2 min limit at 120");
    expect(within(chart("Failed and expired deliveries")).getByText("3 expired")).toBeInTheDocument();
    expect(within(chart("Failed and expired deliveries")).getByText(/^Per 30 minutes\. Failed means/)).toBeInTheDocument();
    expect(within(chart("Failed and expired deliveries")).getByTestId("bar")).toHaveAttribute("data-ticks", "4");
    expect(within(chart("Failed and expired deliveries")).getByTestId("bar")).toHaveAttribute("data-max", "6");
    expect(within(chart("Failed and expired deliveries")).getByText(/^tick \d\d:\d\d; tooltip \d\d:\d\d$/)).toBeInTheDocument();
    expect(Number(within(chart("Delivery queue")).getByTestId("line").dataset.max)).toBeCloseTo(14.4);
    expect(within(chart("Spots ingested")).getByText("3 sources reporting")).toBeInTheDocument();
    expect(within(chart("Spots ingested")).getByText(/^Per 30 minutes, by source\./)).toBeInTheDocument();
    expect(within(chart("Spots ingested")).getByText("POTA: 80|")).toBeInTheDocument();
    expect(within(chart("Time from match to sent")).getByText("p95 210 s")).toBeInTheDocument();
    expect(within(chart("Database size")).getByText("4.88 of 8 GB")).toBeInTheDocument();
    expect(within(chart("Database size")).getByText("Size: 4.88 GB|")).toBeInTheDocument();
    expect(within(chart("Database size")).getByTestId("limit")).toHaveTextContent("8 GB disk at 8");
    expect(within(chart("Database connections")).getByText("38 of 60")).toBeInTheDocument();
    expect(within(chart("Database connections")).getByTestId("limit")).toHaveTextContent("Limit of 60 at 60");
    expect(within(chart("Worker memory")).getByText("Sender 92 MB")).toBeInTheDocument();
    expect(within(chart("Worker memory")).getByText("Inbound: 20 MB|")).toBeInTheDocument();
    expect(within(chart("Worker memory")).getByTestId("limit")).toHaveTextContent("Machine limit at 256");
    // The first bucket, 12:30Z, in local time on both the tick and the tooltip.
    expect(within(chart("Match queue")).getByText(/^tick \d\d:\d\d; tooltip \d\d:\d\d$/)).toBeInTheDocument();
  });

  it("says when there is nothing to show yet", () => {
    const payload = healthPayload({
      range: "7d",
      checks: healthChecks({ delivery_queue: { status: "healthy", waiting: 0, oldest_ready_seconds: null, throttled: 0 } }),
    });
    payload.series.latency_p95 = payload.series.latency_p95.map(() => null);
    payload.series.sender_memory = payload.series.sender_memory.map(() => null);
    vi.mocked(useHealth).mockReturnValue({ payload, loading: false, error: null, refresh });
    renderPage(<HealthPage />);
    expect(within(chart("Oldest ready delivery")).getByText("None ready")).toBeInTheDocument();
    expect(within(chart("Time from match to sent")).getByText("No deliveries")).toBeInTheDocument();
    expect(within(chart("Worker memory")).getByText("Sender: |")).toBeInTheDocument();
    expect(within(chart("Spots ingested")).getByText(/^Per 3 hours, by source\./)).toBeInTheDocument();
    expect(within(chart("Match queue")).getByText(/^tick \d+ \w{3}; tooltip \d+ \w{3}, \d\d:\d\d$/)).toBeInTheDocument();
  });

  it("lists the scheduled jobs", () => {
    const payload = healthPayload();
    payload.jobs.push({
      name: "archive-spots", schedule: "*/10 * * * *", last_run_at: null, result: null, status: "failing", failed_24h: 1234, failed_1h: 6,
    });
    payload.jobs.push({
      name: "ingest-wwff", schedule: "* * * * *", last_run_at: "2026-10-21T11:57:00Z",
      result: { ok: false, http_status: 500, timed_out: false, seconds: 1 }, status: "delayed", failed_24h: 1, failed_1h: 1,
      timing: { runs: 1440, failed: 4, average: 12.34, sd: 3.1, p95: null }, unusual: "slow",
    });
    vi.mocked(useHealth).mockReturnValue({ payload, loading: false, error: null, refresh });
    renderPage(<HealthPage />);
    const rows = within(screen.getByText("Scheduled jobs", { selector: "h2" }).closest(".MuiCard-root") as HTMLElement).getAllByRole("row");
    expect(rows.map((r) => r.textContent)).toEqual([
      "JobScheduleLast runLast resultAverageStd devp95Runs failedFailed in 24 h",
      "ingest-sotawatchEvery 30 s4 s agoHealthyHTTP 200 in 0.4 s0.42 s0.11 s0.61 s1 of 2,8800",
      "refresh-stats-snapshotHourly at :0552 min agoHealthyDone in 0.6 s––––0",
      "archive-spotsEvery 10 minNeverFailingNo runs yet––––1,234",
      "ingest-wwffEvery minute8 s agoLast run failedSlower than usualHTTP 500 in 1.0 s12.3 s3.10 s–4 of 1,4401",
    ]);
  });

  it("offers Refresh to signed-in users only", () => {
    vi.mocked(useHealth).mockReturnValue({ payload: healthPayload(), loading: false, error: null, refresh });
    renderPage(<HealthPage />, { app: { session: null } });
    expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
    expect(screen.getByText(/^Updated /)).toBeInTheDocument();
  });

  it("switches the range and refreshes", async () => {
    vi.mocked(useHealth).mockReturnValue({ payload: healthPayload(), loading: false, error: null, refresh });
    const { user } = renderPage(<HealthPage />);
    expect(vi.mocked(useHealth)).toHaveBeenLastCalledWith("24h");
    expect(screen.getByRole("button", { name: "24 hours" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "7 days" }));
    expect(vi.mocked(useHealth)).toHaveBeenLastCalledWith("7d");
    // Pressing the selected button again keeps the range.
    await user.click(screen.getByRole("button", { name: "7 days" }));
    expect(vi.mocked(useHealth)).toHaveBeenLastCalledWith("7d");
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

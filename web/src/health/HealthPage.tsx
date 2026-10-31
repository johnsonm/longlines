import { useState, type ReactNode } from "react";
import {
  Alert, AlertTitle, Box, Button, Card, CardContent, Chip, Grid, LinearProgress, Stack, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, ToggleButton, ToggleButtonGroup, Typography, useTheme,
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import { BarChart, LineChart } from "@mui/x-charts";
import { ChartsReferenceLine } from "@mui/x-charts/ChartsReferenceLine";
import { useApp } from "../app/hooks";
import { PageTitle } from "../layout/PageTitle";
import {
  axisMax, banner, BUCKET_TEXT, bucketLabel, bucketTimes, CHECKS, checkNow, gb, JOB_STATUS_LABEL, JOB_UNUSUAL_LABEL, lastRunText, latest, mb,
  RANGES, resultText, runSeconds, scheduleText, sourcesReporting, STATUS_LABEL, tickLabel, updatedText,
} from "./model";
import type { HealthPayload, HealthRange, HealthStatus, Series } from "./types";
import { useHealth } from "./useHealth";

const CHART_HEIGHT = 200;

function StatusChip({ status, label }: { status: HealthStatus; label: string }) {
  if (status === "healthy") return <Chip size="small" variant="outlined" color="success" label={label} />;
  if (status === "delayed") return <Chip size="small" color="warning" label={label} />;
  if (status === "failing") return <Chip size="small" color="error" label={label} />;
  return <Chip size="small" variant="outlined" label={label} />;
}

function ChartBox({ title, figure, caption, children }: { title: string; figure: string; caption: string; children: ReactNode }) {
  return (
    <Card variant="outlined" sx={{ height: "100%" }}>
      <CardContent>
        <Stack direction="row" sx={{ justifyContent: "space-between", alignItems: "baseline", gap: 1 }}>
          <Typography variant="subtitle1" component="h3">{title}</Typography>
          <Typography variant="subtitle2">{figure}</Typography>
        </Stack>
        <Typography variant="caption" color="text.secondary" component="p">{caption}</Typography>
        {children}
      </CardContent>
    </Card>
  );
}

interface Line {
  label: string;
  data: Series;
  color: string;
}

/** Lines over the range's buckets in local time, with an optional dashed limit. */
function TimeChart({ payload, lines, unit, limit }: {
  payload: HealthPayload;
  lines: Line[];
  unit?: string;
  limit?: { value: number; label: string };
}) {
  const theme = useTheme();
  const times = bucketTimes(payload, lines[0]?.data.length ?? 0);
  const fmt = (v: number | null) => (v === null ? "" : unit ? `${v.toLocaleString("en-US")} ${unit}` : v.toLocaleString("en-US"));
  return (
    <LineChart
      height={CHART_HEIGHT}
      skipAnimation
      xAxis={[{
        scaleType: "time",
        data: times,
        valueFormatter: (d: Date, ctx) => (ctx.location === "tick" ? tickLabel(payload.range, d) : bucketLabel(payload.range, d)),
      }]}
      // A floor of 5 keeps an empty chart's ticks whole; a limit stays in view with room above it.
      yAxis={[{ min: 0, width: 56, max: axisMax(lines.flatMap((l) => l.data), limit?.value ?? 5) }]}
      series={lines.map((l) => ({ label: l.label, data: l.data, color: l.color, showMark: false, connectNulls: false, valueFormatter: fmt }))}
    >
      {limit && (
        <ChartsReferenceLine
          y={limit.value}
          label={limit.label}
          labelAlign="end"
          lineStyle={{ strokeDasharray: "4 3", stroke: theme.palette.error.main }}
          labelStyle={{ fill: theme.palette.error.main, fontSize: 12 }}
        />
      )}
    </LineChart>
  );
}

/** Counts per bucket as bars; about four labelled ticks. The band axis is the bucket index, since 7 days' labels repeat. */
function CountChart({ payload, bars }: { payload: HealthPayload; bars: Line[] }) {
  const times = bucketTimes(payload, bars[0]?.data.length ?? 0);
  const step = Math.max(1, Math.round(times.length / 4));
  const at = (i: number) => times[i] ?? new Date(payload.start);
  return (
    <BarChart
      height={CHART_HEIGHT}
      skipAnimation
      xAxis={[{
        scaleType: "band",
        data: times.map((_, i) => i),
        tickInterval: (i: number) => i % step === 0,
        tickLabelInterval: (i: number) => i % step === 0,
        valueFormatter: (i: number, ctx) => (ctx.location === "tick" ? tickLabel(payload.range, at(i)) : bucketLabel(payload.range, at(i))),
      }]}
      yAxis={[{ min: 0, width: 56, max: axisMax(bars.flatMap((b) => b.data), 5) }]}
      series={bars.map((b) => ({ label: b.label, data: b.data, color: b.color }))}
    />
  );
}

function StatusTable({ payload }: { payload: HealthPayload }) {
  return (
    <Card variant="outlined">
      <CardContent sx={{ pb: 0 }}>
        <Typography variant="h6" component="h2">Current status</Typography>
        <Typography variant="caption" color="text.secondary">Each rule is the point where a row turns Delayed or Failing.</Typography>
      </CardContent>
      <TableContainer>
        {/* Wider than a phone: the container scrolls sideways instead of squeezing the columns. */}
        <Table size="small" sx={{ minWidth: 760 }}>
          <TableHead>
            <TableRow>
              <TableCell>Check</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Now</TableCell>
              <TableCell>Rule</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {CHECKS.map((c) => {
              const status = payload.checks[c.id].status;
              return (
                <TableRow key={c.id}>
                  <TableCell>
                    {c.name}
                    {c.caption && <Typography variant="caption" color="text.secondary" component="div">{c.caption}</Typography>}
                  </TableCell>
                  <TableCell><StatusChip status={status} label={STATUS_LABEL[status]} /></TableCell>
                  <TableCell>{checkNow(c.id, payload.checks)}</TableCell>
                  <TableCell><Typography variant="body2" color="text.secondary">{c.rule}</Typography></TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </Card>
  );
}

function JobsTable({ payload, now }: { payload: HealthPayload; now: Date }) {
  return (
    <Card variant="outlined">
      <CardContent sx={{ pb: 0 }}>
        <Typography variant="h6" component="h2">Scheduled jobs</Typography>
        <Typography variant="caption" color="text.secondary">
          Jobs that call a function show the HTTP status it returned, not just that the request was sent.
          Average, standard deviation and p95 are successful runs over the range shown; a function's time is its own.
          A job is flagged when its last hour is well outside its previous 7 days.
        </Typography>
      </CardContent>
      <TableContainer>
        <Table size="small" sx={{ minWidth: 900 }}>
          <TableHead>
            <TableRow>
              <TableCell>Job</TableCell>
              <TableCell>Schedule</TableCell>
              <TableCell>Last run</TableCell>
              <TableCell>Last result</TableCell>
              <TableCell align="right">Average</TableCell>
              <TableCell align="right">Std dev</TableCell>
              <TableCell align="right">p95</TableCell>
              <TableCell align="right">Runs failed</TableCell>
              <TableCell>Failed in 24 h</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {payload.jobs.map((j) => (
              <TableRow key={j.name}>
                <TableCell>{j.name}</TableCell>
                <TableCell><Typography variant="body2" color="text.secondary">{scheduleText(j.schedule)}</Typography></TableCell>
                <TableCell>{lastRunText(j.last_run_at, now)}</TableCell>
                <TableCell>
                  <Stack direction="row" sx={{ alignItems: "center", gap: 1, flexWrap: "wrap" }}>
                    <StatusChip status={j.status} label={JOB_STATUS_LABEL[j.status]} />
                    {j.unusual && <Chip size="small" variant="outlined" color="warning" label={JOB_UNUSUAL_LABEL[j.unusual]} />}
                    <Typography variant="caption" color="text.secondary">{resultText(j.result)}</Typography>
                  </Stack>
                </TableCell>
                <TableCell align="right">{runSeconds(j.timing?.average)}</TableCell>
                <TableCell align="right">{runSeconds(j.timing?.sd)}</TableCell>
                <TableCell align="right">{runSeconds(j.timing?.p95)}</TableCell>
                <TableCell align="right">{j.timing ? `${j.timing.failed.toLocaleString("en-US")} of ${j.timing.runs.toLocaleString("en-US")}` : "–"}</TableCell>
                <TableCell>{j.failed_24h.toLocaleString("en-US")}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Card>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Stack spacing={2} component="section">
      <Typography variant="h6" component="h2">{title}</Typography>
      <Grid container spacing={2}>{children}</Grid>
    </Stack>
  );
}

function Half({ children }: { children: ReactNode }) {
  return <Grid size={{ xs: 12, md: 6 }}>{children}</Grid>;
}

function Charts({ payload }: { payload: HealthPayload }) {
  const theme = useTheme();
  const { checks, limits, series } = payload;
  const text = theme.palette.text.primary;
  const muted = theme.palette.text.secondary;
  const memory = (s: Series) => s.map((v) => (v === null ? null : mb(v)));
  const senderMb = checks.sender.memory_bytes === null ? null : mb(checks.sender.memory_bytes);
  const p95 = latest(series.latency_p95);
  return (
    <>
      <Section title="Queues">
        <Half>
          <ChartBox
            title="Match queue"
            figure={`${checks.match_queue.waiting.toLocaleString("en-US")} waiting`}
            caption="Spots waiting in spot_events. The matcher takes 500 a run, so staying under the dashed line means it keeps up."
          >
            <TimeChart
              payload={payload}
              lines={[{ label: "Waiting", data: series.match_waiting, color: text }]}
              limit={{ value: limits.match_batch, label: "500 per run" }}
            />
          </ChartBox>
        </Half>
        <Half>
          <ChartBox
            title="Delivery queue"
            figure={`${checks.delivery_queue.waiting.toLocaleString("en-US")} waiting`}
            caption="Deliveries waiting to be sent. Climbing and not coming back down means the sender can't keep up or a destination is held."
          >
            <TimeChart payload={payload} lines={[{ label: "Waiting", data: series.delivery_waiting, color: text }]} />
          </ChartBox>
        </Half>
        <Half>
          <ChartBox
            title="Oldest ready delivery"
            figure={checks.delivery_queue.oldest_ready_seconds === null ? "None ready" : `${checks.delivery_queue.oldest_ready_seconds} s`}
            caption="How long a destination has had a deliverable message waiting. Over the dashed line, outbound is stuck or throttled."
          >
            <TimeChart
              payload={payload}
              unit="s"
              lines={[{ label: "Oldest ready", data: series.oldest_ready_seconds, color: text }]}
              limit={{ value: limits.oldest_ready_seconds, label: "2 min limit" }}
            />
          </ChartBox>
        </Half>
        <Half>
          <ChartBox
            title="Failed and expired deliveries"
            figure={`${(latest(series.expired) ?? 0).toLocaleString("en-US")} expired`}
            caption={`${BUCKET_TEXT[payload.range]} Failed means the destination answered with an error. Expired means the delivery waited past its limit and was dropped.`}
          >
            <CountChart
              payload={payload}
              bars={[
                { label: "Failed", data: series.failed, color: theme.palette.error.main },
                { label: "Expired", data: series.expired, color: muted },
              ]}
            />
          </ChartBox>
        </Half>
      </Section>

      <Section title="Throughput and speed">
        <Half>
          <ChartBox
            title="Spots ingested"
            figure={`${sourcesReporting(series.spots)} sources reporting`}
            caption={`${BUCKET_TEXT[payload.range].replace(/\.$/, ",")} by source. A line stuck at zero means that source has stopped. RBN and APRS-IS are left out because their volume swamps the rest.`}
          >
            <TimeChart
              payload={payload}
              lines={[
                { label: "POTA", data: series.spots.pota, color: theme.palette.primary.main },
                { label: "SOTAwatch", data: series.spots.sotawatch, color: theme.palette.secondary.main },
                { label: "WWFF", data: series.spots.wwff, color: theme.palette.success.main },
                { label: "WWBOTA", data: series.spots.wwbota, color: theme.palette.warning.main },
                { label: "DX Cluster", data: series.spots.dxcluster, color: theme.palette.info.main },
              ]}
            />
          </ChartBox>
        </Half>
        <Half>
          <ChartBox
            title="Time from match to sent"
            figure={p95 === null ? "No deliveries" : `p95 ${Math.round(p95)} s`}
            caption="Seconds from a delivery being created to it being sent. The median is the typical delivery, p95 is the slowest 1 in 20."
          >
            <TimeChart
              payload={payload}
              unit="s"
              lines={[
                { label: "Median", data: series.latency_p50, color: muted },
                { label: "p95", data: series.latency_p95, color: text },
              ]}
            />
          </ChartBox>
        </Half>
      </Section>

      <Section title="Capacity">
        <Half>
          <ChartBox
            title="Database size"
            figure={`${gb(checks.database.bytes)} of ${gb(checks.database.disk_limit_bytes)} GB`}
            caption="Space the database takes on its disk. Spots are archived and retired as they age, so the line should level off. One that keeps climbing toward the dashed line means the archive isn't keeping up."
          >
            <TimeChart
              payload={payload}
              unit="GB"
              lines={[{ label: "Size", data: series.db_bytes.map((v) => (v === null ? null : gb(v))), color: text }]}
              limit={{ value: gb(checks.database.disk_limit_bytes), label: `${gb(checks.database.disk_limit_bytes)} GB disk` }}
            />
          </ChartBox>
        </Half>
        <Half>
          <ChartBox
            title="Database connections"
            figure={`${checks.database.connections} of ${checks.database.max_connections}`}
            caption="Open connections against the connection limit. Sitting near the dashed line means it's time to raise the limit or the compute size."
          >
            <TimeChart
              payload={payload}
              lines={[{ label: "Connections", data: series.connections, color: text }]}
              limit={{ value: limits.max_connections, label: `Limit of ${limits.max_connections}` }}
            />
          </ChartBox>
        </Half>
        <Half>
          <ChartBox
            title="Worker memory"
            figure={senderMb === null ? "No data" : `Sender ${senderMb} MB`}
            caption="The two Fly.io machines have 256 MB each. A line that keeps climbing toward the dashed line means it's time for a bigger machine."
          >
            <TimeChart
              payload={payload}
              unit="MB"
              lines={[
                { label: "Sender", data: memory(series.sender_memory), color: text },
                { label: "Inbound", data: memory(series.inbound_memory), color: muted },
              ]}
              limit={{ value: mb(limits.worker_memory_bytes), label: "Machine limit" }}
            />
          </ChartBox>
        </Half>
      </Section>
    </>
  );
}

/** Public: signed-out visitors see it under PublicShell's top nav. */
export function HealthPage() {
  const [range, setRange] = useState<HealthRange>("24h");
  // Refresh is for signed-in users; everyone gets the once-a-minute refresh.
  const { session } = useApp();
  const { payload, loading, error, refresh } = useHealth(range);
  const alert = payload ? banner(payload.checks) : null;
  return (
    <Stack spacing={3}>
      <Stack direction={{ xs: "column", md: "row" }} sx={{ justifyContent: "space-between", alignItems: { md: "flex-end" }, gap: 2 }}>
        <Box>
          <PageTitle>Health</PageTitle>
          <Typography color="text.secondary">
            How Long Lines is running right now: queues, workers, database and scheduled jobs. Times are local.
          </Typography>
        </Box>
        <Stack direction="row" sx={{ alignItems: "center", gap: 2, flexWrap: "wrap" }}>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={range}
            onChange={(_, v: HealthRange | null) => v && setRange(v)}
            aria-label="Time range"
          >
            {RANGES.map((r) => <ToggleButton key={r.id} value={r.id}>{r.label}</ToggleButton>)}
          </ToggleButtonGroup>
          <Stack direction="row" sx={{ alignItems: "center", gap: 1 }}>
            {payload && <Typography variant="caption" color="text.secondary">{updatedText(payload.generated_at)}</Typography>}
            {session && <Button startIcon={<RefreshIcon />} onClick={refresh} disabled={loading}>Refresh</Button>}
          </Stack>
        </Stack>
      </Stack>
      {loading && <LinearProgress />}
      {error && <Alert severity="error">{error}</Alert>}
      {alert && (
        <Alert severity={alert.severity}>
          <AlertTitle>{alert.title}</AlertTitle>
          <Typography variant="body2" component="div">{alert.body}</Typography>
          {alert.more && <Typography variant="body2" component="div">{alert.more}</Typography>}
        </Alert>
      )}
      {payload && (
        <>
          <StatusTable payload={payload} />
          <Charts payload={payload} />
          <JobsTable payload={payload} now={new Date(payload.generated_at)} />
        </>
      )}
    </Stack>
  );
}

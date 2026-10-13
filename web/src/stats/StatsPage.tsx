import {
  Alert, Box, Card, CardContent, Grid, LinearProgress, Link, List, ListItem, ListItemText, Stack, Typography,
  useMediaQuery, useTheme,
} from "@mui/material";
// MUI X Charts and Data Grid are the MIT community packages (not Pro/Premium):
// fixed charts and three read-only tables. Nothing on this page is adjustable.
import { BarChart, LineChart, PieChart } from "@mui/x-charts";
import { DataGrid, type GridColDef, type GridRenderCellParams } from "@mui/x-data-grid";
import { Link as RouterLink } from "react-router";
import { PageTitle } from "../layout/PageTitle";
import { lookupPath } from "../profile/format";
import { ChartCard, GRID, Kpi } from "./parts";
import { compact, dayLabel, fmt, hasData, hourLabel, midnightTicks, slotLabel, topStates, updatedCaption, weekday } from "./format";
import { stateName } from "./stateShapes";
import type { StatsPayload } from "./types";
import { UsStateMap } from "./UsStateMap";
import { useStats } from "./useStats";

// A callsign cell links to the station's profile, /call/<base>. The row's base is the base call SQL
// worked out (TypeScript never does).
function callsignColumn(minWidth: number): GridColDef {
  return {
    field: "callsign", headerName: "Callsign", flex: 1, minWidth, sortable: false,
    renderCell: ({ row, value }: GridRenderCellParams<{ base: string }, string>) => (
      <Link component={RouterLink} to={lookupPath(row.base) ?? "/lookup"}>{value}</Link>
    ),
  };
}

const ACTIVATOR_COLUMNS: GridColDef[] = [
  callsignColumn(70),
  { field: "references", headerName: "Refs", type: "number", width: 70, sortable: false },
  { field: "activations", headerName: "Activations", type: "number", width: 100, sortable: false },
  { field: "spots", headerName: "Spots", type: "number", width: 80, sortable: false },
  { field: "topBand", headerName: "Top band", width: 90, sortable: false },
];

const RBN_STATION_COLUMNS: GridColDef[] = [
  callsignColumn(100),
  { field: "spots", headerName: "Spots", type: "number", width: 100, sortable: false },
  { field: "skimmers", headerName: "Skimmers", type: "number", width: 100, sortable: false },
];

// A snapshot written before RBN figures existed renders zeros for them (the newest row keeps its
// old shape until the next hourly refresh).
const NO_RBN: StatsPayload["rbn"] = { spots: 0, skimmers: 0, bands: [], topStations: [] };
const MINUTES_PER_WEEK = 7 * 24 * 60;

const REFERENCE_COLUMNS: GridColDef[] = [
  { field: "reference", headerName: "Reference", width: 120, sortable: false },
  { field: "name", headerName: "Name", flex: 1, minWidth: 140, sortable: false },
  { field: "program", headerName: "Program", width: 90, sortable: false },
  { field: "activations", headerName: "Activations", type: "number", width: 100, sortable: false },
  { field: "spots", headerName: "Spots", type: "number", width: 80, sortable: false },
];

export function StatsPage() {
  const { stats, loading, error } = useStats();
  return (
    <Stack spacing={3} useFlexGap>
      <Box>
        <PageTitle>Stats</PageTitle>
        <Typography color="text.secondary">
          Everything Long Lines took in over the last 7 days. Use it to pick when to activate or when to hunt.
        </Typography>
        {hasData(stats) && (
          <Typography variant="caption" color="text.secondary">{updatedCaption(stats.generatedAt)}</Typography>
        )}
      </Box>
      {loading && <LinearProgress />}
      {error && <Alert severity="error">{error}</Alert>}
      {!loading && !error && (hasData(stats) ? <Dashboard payload={stats.payload} /> : <EmptyState />)}
    </Stack>
  );
}

function EmptyState() {
  return (
    <Card variant="outlined">
      <CardContent>
        <Typography color="text.secondary">Not enough data yet. Stats appear after the first full day of spots.</Typography>
      </CardContent>
    </Card>
  );
}

function Dashboard({ payload }: { payload: StatsPayload }) {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down("sm"));
  // Color follows the source everywhere on the page: POTA is primary, SOTA is secondary, RBN is warning.
  // The hourly total belongs to no source and keeps the chart's default color.
  const pota = theme.palette.primary.main;
  const sota = theme.palette.secondary.main;
  const rbnColor = theme.palette.warning.main;
  const weekdays = payload.daily.map((d) => weekday(d.day));
  const bands = payload.bands.map((b) => b.band);
  const busiest = topStates(payload.potaByState);
  // Also covers fields missing from a snapshot written before they existed (the newest row
  // keeps its old shape until the next hourly refresh), so an older payload renders 0, not a crash.
  const count = (v: number | null | undefined) => fmt(v ?? 0);
  const axis = (v: unknown) => compact(Number(v));
  const rbn = payload.rbn ?? NO_RBN;
  const hourly = payload.hourly ?? [];
  const hours = hourly.map((h) => new Date(h.hour));
  const hourTotals = hourly.map((h) => h.pota + h.sota + h.rbn);
  // Midnight ticks; every other day on phones so the labels do not collide.
  const midnights = midnightTicks(hours, mobile);
  const processed = payload.totals.spots + rbn.spots;
  const perDay: [string, number[], string][] = [
    ["RBN", payload.daily.map((d) => d.rbn ?? 0), rbnColor],
    ["POTA", payload.daily.map((d) => d.pota), pota],
    ["SOTA", payload.daily.map((d) => d.sota), sota],
  ];
  const rbnBands = bands.map((band) => rbn.bands.find((b) => b.band === band)?.spots ?? 0);
  const perBand: [string, string, number[], string][] = [
    ["RBN bands", "Where skimmers are hearing stations", rbnBands, rbnColor],
    ["POTA bands", "Where park activators are operating", payload.bands.map((b) => b.pota), pota],
    ["SOTA bands", "Where summit activators are operating", payload.bands.map((b) => b.sota), sota],
  ];

  return (
    <>
      {/* The first row is volume (every source); the second is POTA and SOTA activity. Spots, activations
          and chasers are different counts of the same week: a spot is one report, an activation is one
          callsign at one reference on one UTC day, and a chaser is one spotter who is not the activator. */}
      <Grid container spacing={2}>
        <Grid size={{ xs: 6, md: 3 }}>
          <Kpi
            label="Spots processed"
            value={fmt(processed)}
            detail={`${fmt(rbn.spots)} RBN, ${fmt(payload.totals.potaSpots)} POTA, ${fmt(payload.totals.sotaSpots)} SOTA`}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Kpi
            label="Average rate"
            value={`${fmt(Math.round(processed / MINUTES_PER_WEEK))}/min`}
            detail={`Peak hour: ${fmt(Math.max(0, ...hourTotals))} spots`}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Kpi label="RBN skimmers" value={fmt(rbn.skimmers)} detail="Reported at least one spot" />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Kpi
            label="Peak POTA/SOTA hour"
            value={hourLabel(payload.peakHour)}
            detail={`Busiest slot: ${weekday(payload.busiestSlot.day)} ${hourLabel(payload.busiestSlot.hour)}`}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Kpi
            label="Activations"
            value={count(payload.totals.activations)}
            detail={`${count(payload.totals.potaActivations)} POTA, ${count(payload.totals.sotaActivations)} SOTA`}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Kpi
            label="Chasers"
            value={count(payload.totals.chasers)}
            detail={`${count(payload.totals.potaChasers)} POTA, ${count(payload.totals.sotaChasers)} SOTA`}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Kpi label="Activators" value={fmt(payload.totals.activators)} detail="Unique POTA and SOTA callsigns" />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Kpi label="Parks and summits" value={fmt(payload.totals.references)} detail="Unique references activated" />
        </Grid>
      </Grid>

      {hourly.length > 0 && (
        <ChartCard title="Spots processed per hour" subheader="All sources combined, every hour of the last 7 days">
          <LineChart
            height={mobile ? 240 : 300}
            hideLegend
            skipAnimation
            xAxis={[{
              scaleType: "time",
              data: hours,
              tickInterval: midnights,
              valueFormatter: (d: Date, ctx) => (ctx.location === "tick" ? dayLabel(d.toISOString().slice(0, 10)) : `${slotLabel(d)} UTC`),
            }]}
            yAxis={[{ valueFormatter: axis, width: 48 }]}
            series={[{ label: "Spots", data: hourTotals, area: true, showMark: false, valueFormatter: count }]}
          />
        </ChartCard>
      )}

      <Box>
        <Typography variant="h6" gutterBottom>Spots per day</Typography>
        <Typography variant="body2" color="text.secondary">
          One chart per source. RBN runs about 100 times the volume of POTA, so they don't share a scale.
        </Typography>
      </Box>
      <Grid container spacing={2}>
        {perDay.map(([label, data, color]) => (
          <Grid key={label} size={{ xs: 12, md: 4 }}>
            <ChartCard title={label} subheader={`${fmt(data.reduce((sum, n) => sum + n, 0))} spots`}>
              <LineChart
                height={200}
                hideLegend
                xAxis={[{ scaleType: "point", data: weekdays }]}
                yAxis={[{ min: 0, valueFormatter: axis, width: 48 }]}
                series={[{ label, data, color, valueFormatter: count }]}
              />
            </ChartCard>
          </Grid>
        ))}
      </Grid>

      <ChartCard title="POTA activity by state" subheader="Park spots per state. Darker means more activity.">
        <Grid container spacing={3} sx={{ alignItems: "center" }}>
          <Grid size={{ xs: 12, md: 8 }}>
            <UsStateMap values={payload.potaByState} />
          </Grid>
          <Grid size={{ xs: 12, md: 4 }}>
            <Typography variant="subtitle2" gutterBottom>Busiest states</Typography>
            <List dense disablePadding>
              {busiest.map((s, i) => (
                <ListItem
                  key={s.code}
                  disableGutters
                  secondaryAction={<Typography variant="body2" color="text.secondary">{fmt(s.spots)}</Typography>}
                >
                  <ListItemText primary={`${i + 1}. ${stateName(s.code)}`} />
                </ListItem>
              ))}
            </List>
          </Grid>
        </Grid>
      </ChartCard>

      <Grid container spacing={2}>
        {perBand.map(([title, subheader, data, color]) => (
          <Grid key={title} size={{ xs: 12, md: 4 }}>
            <ChartCard title={title} subheader={subheader}>
              <BarChart
                height={260}
                hideLegend
                xAxis={[{ scaleType: "band", data: bands }]}
                yAxis={[{ valueFormatter: axis, width: 48 }]}
                series={[{ label: "Spots", data, color, valueFormatter: count }]}
              />
            </ChartCard>
          </Grid>
        ))}
      </Grid>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 6 }}>
          <ChartCard title="Top SOTA associations" subheader="Associations with the most summit spots">
            <BarChart
              height={340}
              hideLegend
              layout="horizontal"
              yAxis={[{ scaleType: "band", data: payload.sotaAssociations.map((a) => a.code), width: 56 }]}
              xAxis={[{ valueFormatter: axis }]}
              series={[{ label: "Spots", data: payload.sotaAssociations.map((a) => a.spots), color: sota, valueFormatter: count }]}
            />
          </ChartCard>
        </Grid>
        <Grid size={{ xs: 12, md: 6 }}>
          <ChartCard title="Modes" subheader="Share of POTA and SOTA spots">
            <PieChart
              height={340}
              series={[{
                data: payload.modes.map((m) => ({ id: m.label, label: m.label, value: m.percent })),
                innerRadius: 50,
                paddingAngle: 2,
                cornerRadius: 4,
                valueFormatter: (item) => `${item.value}%`,
              }]}
              slotProps={{ legend: { direction: "horizontal", position: { vertical: "bottom", horizontal: "center" } } }}
            />
          </ChartCard>
        </Grid>
      </Grid>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 6 }}>
          <ChartCard title="Most active activators" subheader="By number of parks and summits activated">
            <DataGrid
              {...GRID}
              // A snapshot written before 20261012000090 has no base; its profile redirects to the base call.
              rows={payload.topActivators.map((r, id) => ({ id, ...r, base: r.base ?? r.callsign, topBand: r.topBand ?? "" }))}
              columns={ACTIVATOR_COLUMNS}
              columnVisibilityModel={{ topBand: !mobile }}
            />
          </ChartCard>
        </Grid>
        <Grid size={{ xs: 12, md: 6 }}>
          <ChartCard title="Most spotted parks and summits" subheader="Hunters found these most often">
            <DataGrid
              {...GRID}
              rows={payload.topReferences.map((r, id) => ({ id, ...r, name: r.name ?? "" }))}
              columns={REFERENCE_COLUMNS}
              columnVisibilityModel={{ name: !mobile, program: !mobile }}
            />
          </ChartCard>
        </Grid>
      </Grid>

      <ChartCard title="Most heard on RBN" subheader="Stations with the most skimmer spots">
        <DataGrid
          {...GRID}
          rows={rbn.topStations.map((r, id) => ({ id, ...r, base: r.callsign }))}
          columns={RBN_STATION_COLUMNS}
        />
      </ChartCard>
    </>
  );
}

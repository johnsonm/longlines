import type { ReactNode } from "react";
import {
  Alert, Box, Card, CardContent, CardHeader, Grid, LinearProgress, List, ListItem, ListItemText, Stack, Typography,
  useMediaQuery, useTheme,
} from "@mui/material";
// MUI X Charts and Data Grid are the MIT community packages (not Pro/Premium):
// fixed charts and two read-only tables. Nothing on this page is adjustable.
import { BarChart, LineChart, PieChart } from "@mui/x-charts";
import { DataGrid, type GridColDef } from "@mui/x-data-grid";
import { PageTitle } from "../layout/PageTitle";
import { dayLabel, fmt, hasData, hourLabel, topStates, updatedCaption, weekday } from "./format";
import { stateName } from "./stateShapes";
import type { StatsPayload } from "./types";
import { UsStateMap } from "./UsStateMap";
import { useStats } from "./useStats";

// Shared by both grids: no menus, filters, selection, footer or sorting.
const GRID = {
  disableColumnMenu: true,
  disableColumnFilter: true,
  disableColumnSelector: true,
  disableRowSelectionOnClick: true,
  hideFooter: true,
  density: "compact",
  autoHeight: true,
} as const;

const ACTIVATOR_COLUMNS: GridColDef[] = [
  { field: "callsign", headerName: "Callsign", flex: 1, minWidth: 70, sortable: false },
  { field: "references", headerName: "Refs", type: "number", width: 70, sortable: false },
  { field: "activations", headerName: "Activations", type: "number", width: 100, sortable: false },
  { field: "spots", headerName: "Spots", type: "number", width: 80, sortable: false },
  { field: "topBand", headerName: "Top band", width: 90, sortable: false },
];

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
          What POTA and SOTA activity looked like over the last 7 days. Use it to pick when to activate or when to hunt.
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

function Kpi({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <Card variant="outlined" sx={{ height: "100%" }}>
      <CardContent>
        <Typography variant="overline" color="text.secondary">{label}</Typography>
        <Typography variant="h4" component="div">{value}</Typography>
        <Typography variant="body2" color="text.secondary">{detail}</Typography>
      </CardContent>
    </Card>
  );
}

function ChartCard({ title, subheader, children }: { title: string; subheader: string; children: ReactNode }) {
  return (
    <Card variant="outlined" sx={{ height: "100%" }}>
      <CardHeader title={title} subheader={subheader} slotProps={{ title: { variant: "h6" } }} />
      <CardContent sx={{ pt: 0 }}>{children}</CardContent>
    </Card>
  );
}

function Dashboard({ payload }: { payload: StatsPayload }) {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down("sm"));
  // Color follows the program everywhere on the page: POTA is primary, SOTA is secondary.
  const pota = theme.palette.primary.main;
  const sota = theme.palette.secondary.main;
  const days = payload.daily.map((d) => dayLabel(d.day));
  const bands = payload.bands.map((b) => b.band);
  const busiest = topStates(payload.potaByState);
  // Also covers fields missing from a snapshot written before they existed (the newest row
  // keeps its old shape until the next hourly refresh), so an older payload renders 0, not a crash.
  const count = (v: number | null | undefined) => fmt(v ?? 0);
  const axis = (v: unknown) => fmt(Number(v));

  return (
    <>
      {/* Spots, activations and chasers are three different counts of the same week: a spot is one
          report, an activation is one callsign at one reference on one UTC day, and a chaser is one
          spotter who is not the activator. The first row keeps them side by side on purpose. */}
      <Grid container spacing={2}>
        <Grid size={{ xs: 6, md: 4 }}>
          <Kpi
            label="Spots"
            value={fmt(payload.totals.spots)}
            detail={`${fmt(payload.totals.potaSpots)} POTA, ${fmt(payload.totals.sotaSpots)} SOTA`}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 4 }}>
          <Kpi
            label="Activations"
            value={count(payload.totals.activations)}
            detail={`${count(payload.totals.potaActivations)} POTA, ${count(payload.totals.sotaActivations)} SOTA`}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 4 }}>
          <Kpi
            label="Chasers"
            value={count(payload.totals.chasers)}
            detail={`${count(payload.totals.potaChasers)} POTA, ${count(payload.totals.sotaChasers)} SOTA`}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 4 }}>
          <Kpi label="Activators" value={fmt(payload.totals.activators)} detail="Unique callsigns spotted" />
        </Grid>
        <Grid size={{ xs: 6, md: 4 }}>
          <Kpi label="Parks and summits" value={fmt(payload.totals.references)} detail="Unique references activated" />
        </Grid>
        <Grid size={{ xs: 6, md: 4 }}>
          <Kpi
            label="Peak hour"
            value={hourLabel(payload.peakHour)}
            detail={`Busiest slot: ${weekday(payload.busiestSlot.day)} ${hourLabel(payload.busiestSlot.hour)}`}
          />
        </Grid>
      </Grid>

      <ChartCard title="Spots per day" subheader="By source">
        <LineChart
          height={300}
          xAxis={[{ scaleType: "point", data: days }]}
          yAxis={[{ valueFormatter: axis, width: 60 }]}
          series={[
            { label: "POTA", data: payload.daily.map((d) => d.pota), color: pota, valueFormatter: count },
            { label: "SOTA", data: payload.daily.map((d) => d.sota), color: sota, valueFormatter: count },
          ]}
        />
      </ChartCard>

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
        <Grid size={{ xs: 12, md: 6 }}>
          <ChartCard title="POTA bands" subheader="Where park activators are operating">
            <BarChart
              height={300}
              hideLegend
              xAxis={[{ scaleType: "band", data: bands }]}
              yAxis={[{ valueFormatter: axis, width: 60 }]}
              series={[{ label: "POTA spots", data: payload.bands.map((b) => b.pota), color: pota, valueFormatter: count }]}
            />
          </ChartCard>
        </Grid>
        <Grid size={{ xs: 12, md: 6 }}>
          <ChartCard title="SOTA bands" subheader="Where summit activators are operating">
            <BarChart
              height={300}
              hideLegend
              xAxis={[{ scaleType: "band", data: bands }]}
              yAxis={[{ valueFormatter: axis, width: 50 }]}
              series={[{ label: "SOTA spots", data: payload.bands.map((b) => b.sota), color: sota, valueFormatter: count }]}
            />
          </ChartCard>
        </Grid>
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
          <ChartCard title="Modes" subheader="Share of all spots">
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
              rows={payload.topActivators.map((r, id) => ({ id, ...r, topBand: r.topBand ?? "" }))}
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
    </>
  );
}

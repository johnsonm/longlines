import { useMemo, useState } from "react";
import {
  Box, Button, Card, CardContent, Grid, Link, MenuItem, Stack, TextField, Typography, useMediaQuery, useTheme,
} from "@mui/material";
import { BarChart } from "@mui/x-charts";
import { DataGrid, type GridColDef } from "@mui/x-data-grid";
import { Link as RouterLink } from "react-router";
import { compact, fmt } from "../stats/format";
import { ChartCard, GRID, Kpi } from "../stats/parts";
import { plural } from "../profile/format";
import { GroupHeatMap } from "./GroupHeatMap";
import {
  activationsLine, comparisonLine, heardAgo, modeLabel, PERIODS, periodDays, placesLine, totalActivations, totalPlaces, updatedAgo,
} from "./stats/model";
import type { GroupMember, GroupPeriod, GroupStatistics as Stats, TopList } from "./stats/types";

const MEMBERS_SHOWN = 10;
/** The MIT DataGrid always paginates, at most 100 rows a page; past that its footer pages. */
const GRID_PAGE = 100;

const TOP_CARDS: { list: TopList; title: string; subtitle: string }[] = [
  { list: "spots", title: "Most spots", subtitle: "All modes and sources" },
  { list: "days", title: "Most days on the air", subtitle: "Days heard in the period" },
  { list: "cw", title: "CW", subtitle: "Spots heard" },
  { list: "ssb", title: "SSB", subtitle: "Spots heard" },
  { list: "digital", title: "Digital", subtitle: "FT8 and FT4 spots heard" },
  { list: "parks", title: "POTA activations", subtitle: "Parks activated" },
];

interface Props {
  stats: Stats;
  /** The Period menu's choice; the labels follow `stats.period`, the period the figures are for. */
  period: GroupPeriod;
  onPeriod: (period: GroupPeriod) => void;
  now?: Date;
}

/**
 * Everything under the tabs on page 10's Statistics tab, shared by the
 * owner's page and the public page. It renders only what SQL sent: a public
 * payload without callsigns has no `top` or `members`, and those sections go.
 */
export function GroupStatistics({ stats, period, onPeriod, now: pinned }: Props) {
  // Ages count from when the page rendered first; tests pin the clock.
  const [rendered] = useState(() => new Date());
  const now = pinned ?? rendered;
  const { kpis } = stats;
  return (
    <Stack spacing={3}>
      <Stack direction="row" spacing={2} useFlexGap sx={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
        <Typography variant="body2" color="text.secondary">
          {`Updated ${updatedAgo(stats.generatedAt, now)}. Statistics refresh every hour.`}
        </Typography>
        <TextField
          select size="small" label="Period" value={period} onChange={(e) => onPeriod(e.target.value as GroupPeriod)} sx={{ width: 170 }}
        >
          {PERIODS.map((p) => <MenuItem key={p.value} value={p.value}>{p.label}</MenuItem>)}
        </TextField>
      </Stack>

      <Grid container spacing={2}>
        <Grid size={{ xs: 6, md: 3 }}>
          <Kpi label="Spots heard" value={fmt(kpis.spots)} detail={comparisonLine(kpis.spots, kpis.previousSpots, stats.period)} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Kpi label="Active members" value={`${fmt(kpis.membersHeard)} of ${fmt(stats.memberCount)}`} detail="Heard at least once" />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Kpi label="Activations" value={fmt(totalActivations(kpis.activations))} detail={activationsLine(kpis.activations)} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Kpi label="Places activated" value={fmt(totalPlaces(kpis.places))} detail={placesLine(kpis.places)} />
        </Grid>
      </Grid>

      <GroupHeatMap stats={stats} />

      {stats.top && (
        <>
          <Typography variant="h6" component="h2">Who is most active</Typography>
          <Grid container spacing={2}>
            {TOP_CARDS.map((c) => (
              <Grid size={{ xs: 12, sm: 6, md: 4 }} key={c.list}>
                <TopCard
                  title={c.title} subtitle={c.subtitle} entries={stats.top?.[c.list] ?? []}
                  value={(v) => (c.list === "days" ? `${fmt(v)} of ${periodDays(stats.period)}` : fmt(v))}
                />
              </Grid>
            ))}
          </Grid>
        </>
      )}

      {stats.members && <MembersCard members={stats.members} heard={kpis.membersHeard} count={stats.memberCount} now={now} />}

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 6 }}>
          <ChartCard title="Bands" subheader="Club spots by band">
            <BarChart
              height={320}
              hideLegend
              layout="horizontal"
              yAxis={[{ scaleType: "band", data: stats.bands.map((b) => b.band), width: 48 }]}
              xAxis={[{ valueFormatter: (v: number) => compact(v) }]}
              series={[{ label: "Spots", data: stats.bands.map((b) => b.spots), valueFormatter: (v) => fmt(v ?? 0) }]}
            />
          </ChartCard>
        </Grid>
        <Grid size={{ xs: 12, md: 6 }}>
          <ChartCard title="Modes" subheader="Club spots by mode">
            <BarChart
              height={320}
              hideLegend
              layout="horizontal"
              yAxis={[{ scaleType: "band", data: stats.modes.map((m) => modeLabel(m.label)), width: 96 }]}
              xAxis={[{ valueFormatter: (v: number) => compact(v) }]}
              series={[{ label: "Spots", data: stats.modes.map((m) => m.spots), valueFormatter: (v) => fmt(v ?? 0) }]}
            />
          </ChartCard>
        </Grid>
      </Grid>

      <PlacesCard places={stats.places} />
    </Stack>
  );
}

/** A member's call links to its profile; members are base calls from SQL. */
export function CallLink({ call }: { call: string }) {
  return <Link component={RouterLink} to={`/call/${call}`} underline="hover">{call}</Link>;
}

/** "KK4PWJ, W4ABC", each a profile link. */
export function CallList({ calls }: { calls: string[] }) {
  return (
    <>
      {calls.map((c, i) => (
        <span key={c}>
          {i > 0 && ", "}
          <CallLink call={c} />
        </span>
      ))}
    </>
  );
}

function TopCard({ title, subtitle, entries, value }: {
  title: string;
  subtitle: string;
  entries: { callsign: string; value: number }[];
  value: (v: number) => string;
}) {
  return (
    <Card variant="outlined" sx={{ height: "100%" }}>
      <CardContent>
        <Typography variant="subtitle2" component="h3">{title}</Typography>
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 1 }}>{subtitle}</Typography>
        {entries.length === 0
          ? <Typography variant="body2" color="text.secondary">Nobody yet</Typography>
          : (
            <Box component="ol" sx={{ m: 0, p: 0, listStyle: "none" }}>
              {entries.map((e, i) => (
                <Stack component="li" key={e.callsign} direction="row" spacing={1} sx={{ justifyContent: "space-between", py: 0.75 }}>
                  <Typography variant="body2">
                    <Typography component="span" variant="body2" color="text.secondary" sx={{ display: "inline-block", width: 20 }}>{i + 1}</Typography>
                    <CallLink call={e.callsign} />
                  </Typography>
                  <Typography variant="body2" color="text.secondary">{value(e.value)}</Typography>
                </Stack>
              ))}
            </Box>
          )}
      </CardContent>
    </Card>
  );
}

function MembersCard({ members, heard, count, now }: { members: GroupMember[]; heard: number; count: number; now: Date }) {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down("sm"));
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(false);
  // The rank is SQL's order; search only narrows what is shown.
  const ranked = useMemo(() => members.map((m, i) => ({ ...m, id: m.callsign, rank: i + 1 })), [members]);
  const q = query.trim().toUpperCase();
  const matching = q ? ranked.filter((m) => m.callsign.includes(q)) : ranked;
  const shown = all || q ? matching : matching.slice(0, MEMBERS_SHOWN);

  const columns: GridColDef<(typeof ranked)[number]>[] = [
    { field: "rank", headerName: "#", width: 56, sortable: false },
    { field: "callsign", headerName: "Callsign", flex: 1, minWidth: 110, sortable: false, renderCell: (p) => <CallLink call={p.row.callsign} /> },
    { field: "spots", headerName: "Spots", type: "number", width: 90, sortable: false, valueFormatter: (v: number) => fmt(v) },
    { field: "days", headerName: "Days", type: "number", width: 70, sortable: false },
    ...(mobile ? [] : [{
      field: "mainMode", headerName: "Main mode", width: 120, sortable: false,
      valueFormatter: (v: GroupMember["mainMode"]) => modeLabel(v),
    } satisfies GridColDef<(typeof ranked)[number]>]),
    {
      field: "lastHeard", headerName: "Last heard", width: 130, sortable: false,
      valueFormatter: (v: string | null) => heardAgo(v, now),
    },
  ];

  return (
    <ChartCard title="Members" subheader={`Ranked by spots heard in the period. ${heard} of ${plural(count, "member", "members")} were heard.`}>
      <Stack spacing={1.5}>
        <TextField size="small" label="Search members" value={query} onChange={(e) => setQuery(e.target.value)} sx={{ maxWidth: 280 }} />
        <DataGrid
          {...GRID}
          hideFooter={shown.length <= GRID_PAGE}
          pageSizeOptions={[GRID_PAGE]}
          initialState={{ pagination: { paginationModel: { pageSize: GRID_PAGE } } }}
          rows={shown}
          columns={columns}
          localeText={{ noRowsLabel: "No members match" }}
        />
        {!all && !q && members.length > MEMBERS_SHOWN && (
          <Box>
            <Button size="small" onClick={() => setAll(true)}>{`Show all ${plural(members.length, "member", "members")}`}</Button>
          </Box>
        )}
      </Stack>
    </ChartCard>
  );
}

function PlacesCard({ places }: { places: Stats["places"] }) {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down("sm"));
  const hasBy = places.some((p) => p.by !== undefined);
  const columns: GridColDef[] = [
    { field: "reference", headerName: "Reference", width: 120, sortable: false },
    { field: "name", headerName: "Name", flex: 1, minWidth: 140, sortable: false, valueFormatter: (v: string | null) => v ?? "" },
    { field: "program", headerName: "Program", width: 90, sortable: false },
    { field: "times", headerName: "Times", type: "number", width: 70, sortable: false },
    ...(hasBy && !mobile
      ? [{
        field: "by", headerName: "By", flex: 1, minWidth: 140, sortable: false,
        renderCell: (p) => <CallList calls={(p.row as { by?: string[] }).by ?? []} />,
      } satisfies GridColDef]
      : []),
  ];
  return (
    <ChartCard title="Most activated places" subheader="Parks, summits, bunkers and islands the club activated in the period">
      <DataGrid
        {...GRID}
        rows={places.map((p) => ({ ...p, id: `${p.program}/${p.reference}` }))}
        columns={columns}
        localeText={{ noRowsLabel: "No activations in the period" }}
      />
    </ChartCard>
  );
}

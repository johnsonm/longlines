import { useState } from "react";
import {
  Alert, Box, Button, Card, CardContent, Chip, Divider, Grid, LinearProgress, Link, List, ListItem, ListItemText, Stack, Table,
  TableBody, TableCell, TableRow, Typography, useMediaQuery, useTheme,
} from "@mui/material";
import NotificationsActiveIcon from "@mui/icons-material/NotificationsActive";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import ShareIcon from "@mui/icons-material/Share";
// MUI X Charts and Data Grid are the MIT community packages, fixed and read-only as on the callsign profile.
import { BarChart, PieChart } from "@mui/x-charts";
import { DataGrid, type GridColDef, type GridRenderCellParams } from "@mui/x-data-grid";
import { Navigate, Link as RouterLink, useLocation, useNavigate, useParams } from "react-router";
import { errorText, useApp } from "../app/hooks";
import { PageTitle } from "../layout/PageTitle";
import { shareLink } from "../lib/share";
import { dateLabel, frequencyLabel, lookupPath, monthLabel, onAirNow } from "../profile/format";
import { compact, fmt } from "../stats/format";
import { ChartCard, GRID, Kpi } from "../stats/parts";
import {
  aboutRows, aboutSubheader, aboutTitle, activationDetail, footerText, headerChips, isRetired, isToday, lastActivatedWhen, modesLabel, neverActivatedMessage,
  notFoundMessage, notInListMessage, phoneSpotTime, PROGRAMS, retiredMessage, shortDay, spotDetail, spotTime, todayLine, topActivatorDetail,
} from "./format";
import { programSource, referencePath, referenceProgram, referenceUrl } from "./paths";
import { ReferenceHeatMap } from "./ReferenceHeatMap";
import type { ReferenceCatalog, ReferenceLast, ReferenceProfile, ReferenceProgram } from "./types";
import { useReferenceProfile } from "./useReferenceProfile";

/** A callsign's profile link; the base call comes from SQL. */
function CallLink({ callsign, base }: { callsign: string; base: string }) {
  return <Link component={RouterLink} to={lookupPath(base) ?? "/lookup"} underline="hover">{callsign}</Link>;
}

/**
 * /ref/:program/*. The reference keeps SOTA's "/" as a path separator. The URL
 * is made canonical (program lower case, reference upper case) before the
 * page asks for it; whether it exists is the function's question.
 */
export function ReferencePage({ signedIn }: { signedIn: boolean }) {
  const params = useParams();
  const program = params.program ?? "";
  const raw = params["*"] ?? "";
  const reference = raw.replace(/^\/+|\/+$/g, "").toUpperCase();
  if (!reference) return <Navigate to="/ref" replace />;
  const known = referenceProgram(program);
  const path = known && referencePath(known, reference);
  // A program without pages, or a reference the router can't hold, is no page; neither costs a request.
  if (!known || !path) return <NotFound program={program} reference={reference} />;
  if (program !== known || raw !== reference) return <Navigate to={path} replace />;
  return <Profile key={path} program={known} reference={reference} signedIn={signedIn} />;
}

function Profile({ program, reference, signedIn }: { program: ReferenceProgram; reference: string; signedIn: boolean }) {
  const { profile, notFound, error, loading } = useReferenceProfile(program, reference);
  const [now] = useState(() => new Date());

  if (loading) return <LinearProgress />;
  if (notFound) return <NotFound program={program} reference={reference} />;
  if (!profile) return <Alert severity="error">{errorText(error, "Couldn't load this reference.")}</Alert>;

  const { catalog } = profile;
  const activated = profile.totals.activations > 0;
  return (
    <Stack spacing={3} useFlexGap>
      <Header profile={profile} signedIn={signedIn} now={now} />
      {catalog && !catalog.active && <Alert severity="info">{retiredMessage(profile.program, catalog)}</Alert>}
      {!catalog && <Alert severity="warning">{notInListMessage(profile.program, profile.reference)}</Alert>}
      {activated ? <Activated profile={profile} now={now} /> : <NeverActivated profile={profile} />}
      <Typography variant="body2" color="text.secondary">{footerText(profile)}</Typography>
    </Stack>
  );
}

function NotFound({ program, reference }: { program: string; reference: string }) {
  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2} useFlexGap>
          <PageTitle>Reference not found</PageTitle>
          <Alert severity="warning">{notFoundMessage(program, reference)}</Alert>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
            <Button variant="outlined" component={RouterLink} to="/lookup">Callsign lookup</Button>
            <Button component={RouterLink} to="/stats">Stats</Button>
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}

function Header({ profile, signedIn, now }: { profile: ReferenceProfile; signedIn: boolean; now: Date }) {
  const { notify } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down("sm"));
  const { program, reference, catalog } = profile;
  const info = PROGRAMS[program];

  const share = () =>
    shareLink({ title: `${reference} on Long Lines`, url: referenceUrl(window.location.origin, program, reference), copied: "Link copied.", notify });

  // The editor opens on the program's source with this reference as its filter; nothing is saved until the user saves there.
  const getAlerts = () => {
    if (!signedIn) void navigate("/signin", { state: { from: location.pathname } });
    else void navigate(`/connections/new?source=${programSource(program)}&reference=${encodeURIComponent(reference)}`);
  };

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ justifyContent: "space-between" }}>
          <Box sx={{ minWidth: 0 }}>
            <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
              <Typography variant={mobile ? "h4" : "h3"} component="h1">{reference}</Typography>
              <Chip size="small" color={info.color} label={info.short} />
            </Stack>
            {catalog?.name && <Typography variant="h6" component="p" color="text.secondary">{catalog.name}</Typography>}
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", mt: 1 }}>
              {headerChips(profile).map((c) => <Chip key={c.label} size="small" variant={c.outlined ? "outlined" : "filled"} label={c.label} />)}
            </Stack>
          </Box>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexShrink: 0, flexWrap: "wrap", alignItems: "flex-start" }}>
            {!isRetired(catalog) && (
              <Button variant="contained" startIcon={<NotificationsActiveIcon />} onClick={getAlerts} sx={{ flexGrow: mobile ? 1 : 0 }}>
                {signedIn ? `Get alerts for ${reference}` : "Sign in to get alerts"}
              </Button>
            )}
            <Button variant="outlined" startIcon={<ShareIcon />} onClick={() => void share()}>Share</Button>
            {catalog && profile.sourceUrl && (
              <Button variant="outlined" startIcon={<OpenInNewIcon />} href={profile.sourceUrl} target="_blank" rel="noopener noreferrer">
                {info.short}
              </Button>
            )}
          </Stack>
        </Stack>
      </CardContent>
      {profile.last && <LastActivated last={profile.last} now={now} mobile={mobile} />}
    </Card>
  );
}

/** The header's band: the newest spot at the reference, from the live read. */
function LastActivated({ last, now, mobile }: { last: ReferenceLast; now: Date; mobile: boolean }) {
  const when = lastActivatedWhen(last.time, now);
  // SQL sends today's figures only for a spot from today; a page left open past midnight drops them.
  const today = last.today && isToday(last.time, now) ? last.today : null;
  return (
    <>
      <Divider />
      <CardContent>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Typography variant="overline" color="text.secondary">Last activated</Typography>
          {onAirNow(last.time, now) && <Chip size="small" color="success" label="On the air now" />}
        </Stack>
        <Typography variant="h4" component="p"><CallLink callsign={last.callsign} base={last.base} /></Typography>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center", mt: 1 }}>
          {last.frequencyKhz !== null && <Chip size="small" variant="outlined" label={frequencyLabel(last.frequencyKhz)} />}
          {last.mode && <Chip size="small" variant="outlined" label={last.mode.toUpperCase()} />}
          {last.band && <Chip size="small" variant="outlined" label={last.band} />}
          {!mobile && <Typography variant="body2" color="text.secondary">{when}</Typography>}
        </Stack>
        {mobile && <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{when}</Typography>}
        {!mobile && today && <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{todayLine(today)}</Typography>}
      </CardContent>
    </>
  );
}

function AboutCard({ program, catalog, mobile }: { program: ReferenceProgram; catalog: ReferenceCatalog; mobile: boolean }) {
  return (
    <ChartCard title={aboutTitle(program)} subheader={aboutSubheader(program)}>
      <Table size="small">
        <TableBody>
          {aboutRows(program, catalog).map(([label, value]) => (
            <TableRow key={label}>
              <TableCell component="th" scope="row">{label}</TableCell>
              <TableCell align={mobile ? "right" : "left"}>{value}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ChartCard>
  );
}

function NeverActivated({ profile }: { profile: ReferenceProfile }) {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down("sm"));
  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, md: 6 }}>
        <Card variant="outlined" sx={{ height: "100%" }}>
          <CardContent>
            <Typography color="text.secondary">{neverActivatedMessage(profile.reference)}</Typography>
          </CardContent>
        </Card>
      </Grid>
      {profile.catalog && (
        <Grid size={{ xs: 12, md: 6 }}>
          <AboutCard program={profile.program} catalog={profile.catalog} mobile={mobile} />
        </Grid>
      )}
    </Grid>
  );
}

type CallRow = { callsign: string; base: string };

const callColumn = (headerName: string): GridColDef => ({
  field: "callsign", headerName, flex: 1, minWidth: 100, sortable: false,
  renderCell: ({ row, value }: GridRenderCellParams<CallRow, string>) => <CallLink callsign={value ?? row.callsign} base={row.base} />,
});

const TOP_COLUMNS: GridColDef[] = [
  callColumn("Callsign"),
  { field: "activations", headerName: "Activations", type: "number", width: 110, sortable: false },
  { field: "last", headerName: "Last", width: 120, sortable: false },
];

const ACTIVATION_COLUMNS: GridColDef[] = [
  { field: "date", headerName: "Day", width: 120, sortable: false },
  callColumn("Activator"),
  { field: "spots", headerName: "Spots", type: "number", width: 80, sortable: false },
  { field: "bands", headerName: "Bands", flex: 1, minWidth: 90, sortable: false },
  { field: "modes", headerName: "Modes", flex: 1, minWidth: 80, sortable: false },
];

const SPOT_COLUMNS: GridColDef[] = [
  { field: "when", headerName: "Time (UTC)", width: 120, sortable: false },
  callColumn("Activator"),
  { field: "frequency", headerName: "Frequency", width: 120, align: "right", headerAlign: "right", sortable: false },
  { field: "mode", headerName: "Mode", width: 80, sortable: false },
  { field: "spotter", headerName: "Spotter", width: 110, sortable: false },
  { field: "comment", headerName: "Comment", flex: 1, minWidth: 140, sortable: false },
];

/** A phone list row: the activator linked, a detail line, and a short figure on the right. */
interface PhoneRow extends CallRow {
  key: string;
  detail: string | null;
  right: string;
}

function PhoneRows({ rows }: { rows: PhoneRow[] }) {
  return (
    <List dense disablePadding>
      {rows.map((r, i) => (
        <ListItem
          key={r.key}
          disableGutters
          divider={i < rows.length - 1}
          secondaryAction={<Typography variant="body2" color="text.secondary">{r.right}</Typography>}
        >
          <ListItemText
            primary={<CallLink callsign={r.callsign} base={r.base} />}
            secondary={r.detail}
            slotProps={{ primary: { variant: "subtitle2" } }}
          />
        </ListItem>
      ))}
    </List>
  );
}

function Activated({ profile, now }: { profile: ReferenceProfile; now: Date }) {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down("sm"));
  const { program, catalog, totals, firstActivation } = profile;
  const kind = PROGRAMS[program].kind;
  const axis = (v: unknown) => compact(Number(v));
  const modes = profile.modes.filter((m) => m.percent > 0);

  return (
    <>
      <Grid container spacing={2}>
        <Grid size={{ xs: 6, md: 3 }}>
          <Kpi label="Activations" value={fmt(totals.activations)} detail="Since Long Lines started" />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Kpi label="Activators" value={fmt(totals.activators)} detail="Different callsigns" />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Kpi label="Spots" value={fmt(totals.spots)} detail="All time" />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Kpi
            label="First activated"
            value={firstActivation ? dateLabel(firstActivation.day) : "–"}
            small={mobile}
            detail={firstActivation ? <>By <CallLink callsign={firstActivation.callsign} base={firstActivation.base} /></> : ""}
          />
        </Grid>
      </Grid>

      <ReferenceHeatMap reference={profile.reference} calendar={profile.calendar} />

      <Grid container spacing={2}>
        {catalog && (
          <Grid size={{ xs: 12, md: 4 }}>
            <AboutCard program={program} catalog={catalog} mobile={mobile} />
          </Grid>
        )}
        <Grid size={{ xs: 12, md: catalog ? 8 : 12 }}>
          <ChartCard title="Activity" subheader="Activations per month, since Long Lines started">
            <BarChart
              height={mobile ? 220 : 260}
              hideLegend
              xAxis={[{ scaleType: "band", data: profile.monthly.map((m) => monthLabel(m.month)) }]}
              yAxis={[{ valueFormatter: axis, width: 48 }]}
              series={[{ label: "Activations", data: profile.monthly.map((m) => m.activations), valueFormatter: (v) => fmt(v ?? 0) }]}
            />
          </ChartCard>
        </Grid>
      </Grid>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 6 }}>
          <ChartCard title="Bands" subheader={`Spots from this ${kind}, by band`}>
            <BarChart
              height={mobile ? 200 : 260}
              hideLegend
              xAxis={[{ scaleType: "band", data: profile.bands.map((b) => b.band) }]}
              yAxis={[{ valueFormatter: axis, width: 48 }]}
              series={[{ label: "Spots", data: profile.bands.map((b) => b.spots), valueFormatter: (v) => fmt(v ?? 0) }]}
            />
          </ChartCard>
        </Grid>
        <Grid size={{ xs: 12, md: 6 }}>
          <ChartCard title="Modes" subheader="Share of spots">
            <PieChart
              height={mobile ? 160 : 260}
              series={[{
                // The phone legend adds each percent: "CW 46%".
                data: modes.map((m) => ({ id: m.label, label: mobile ? `${m.label} ${m.percent}%` : m.label, value: m.percent })),
                innerRadius: mobile ? 35 : 50,
                paddingAngle: 2,
                cornerRadius: 4,
                valueFormatter: (item) => `${item.value}%`,
              }]}
              slotProps={{
                legend: mobile
                  ? { direction: "vertical", position: { vertical: "middle", horizontal: "end" } }
                  : { direction: "horizontal", position: { vertical: "bottom", horizontal: "center" } },
              }}
            />
          </ChartCard>
        </Grid>
      </Grid>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 5 }}>
          <ChartCard title="Top activators" subheader="Most activations here, all time">
            {mobile
              ? (
                <PhoneRows
                  rows={profile.topActivators.map((a) => ({
                    key: a.base, callsign: a.callsign, base: a.base, detail: null, right: topActivatorDetail(a.activations, a.lastDay, now),
                  }))}
                />
              )
              : (
                <DataGrid
                  {...GRID}
                  rows={profile.topActivators.map((a) => ({ id: a.base, ...a, last: dateLabel(a.lastDay) }))}
                  columns={TOP_COLUMNS}
                />
              )}
          </ChartCard>
        </Grid>
        <Grid size={{ xs: 12, md: 7 }}>
          <ChartCard title="Recent activations" subheader="Newest first. An activation is one activator spotted here on one UTC day.">
            {mobile
              ? (
                <PhoneRows
                  rows={profile.recentActivations.map((a) => ({
                    key: `${a.day} ${a.base}`, callsign: a.callsign, base: a.base, detail: activationDetail(a), right: shortDay(a.day, now),
                  }))}
                />
              )
              : (
                <DataGrid
                  {...GRID}
                  rows={profile.recentActivations.map((a) => ({
                    id: `${a.day} ${a.base}`, ...a, date: dateLabel(a.day), bands: a.bands.join(", "), modes: modesLabel(a.modes),
                  }))}
                  columns={ACTIVATION_COLUMNS}
                />
              )}
          </ChartCard>
        </Grid>
      </Grid>

      {profile.recentSpots.length > 0 && (
        <ChartCard title="Recent spots" subheader={`Spots from this ${kind} in the last 7 days, newest first`}>
          {mobile
            ? (
              <PhoneRows
                rows={profile.recentSpots.map((s, i) => ({
                  key: `${i}`, callsign: s.callsign, base: s.base, detail: spotDetail(s), right: phoneSpotTime(s.time, now),
                }))}
              />
            )
            : (
              <DataGrid
                {...GRID}
                rows={profile.recentSpots.map((s, i) => ({
                  id: i, callsign: s.callsign, base: s.base, when: spotTime(s.time),
                  frequency: s.frequencyKhz === null ? "–" : frequencyLabel(s.frequencyKhz),
                  mode: s.mode ? s.mode.toUpperCase() : "–", spotter: s.spotter, comment: s.comment || "–",
                }))}
                columns={SPOT_COLUMNS}
              />
            )}
        </ChartCard>
      )}
    </>
  );
}

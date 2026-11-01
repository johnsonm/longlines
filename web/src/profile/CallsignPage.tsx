import { useEffect, useState } from "react";
import {
  Alert, Box, Button, Card, CardContent, Chip, Divider, Grid, LinearProgress, Link, List, ListItem, ListItemText, Stack, Tab, Table, TableBody,
  TableCell, TableRow, Tabs, Typography, useMediaQuery, useTheme, type Theme,
} from "@mui/material";
import NotificationsActiveIcon from "@mui/icons-material/NotificationsActive";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import ShareIcon from "@mui/icons-material/Share";
// MUI X Charts and Data Grid are the MIT community packages, fixed and read-only as on the Stats page.
import { BarChart, PieChart } from "@mui/x-charts";
import { DataGrid, type GridColDef, type GridRenderCellParams } from "@mui/x-data-grid";
import { Navigate, Link as RouterLink, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { ActivationsTab } from "../activations/ActivationsTab";
import { errorText, useApp } from "../app/hooks";
import { ApiError } from "../lib/api";
import { ReferenceLink } from "../references/ReferenceLink";
import { SourcePickerDialog } from "../subscriptions/SourcePickerDialog";
import type { TimePrefs } from "../lib/time";
import { shareLink } from "../lib/share";
import { PageTitle } from "../layout/PageTitle";
import { SpotsTable } from "../sources/SpotsTable";
import { sourceName } from "../sources/sources";
import { compact, fmt } from "../stats/format";
import { ChartCard, GRID, Kpi } from "../stats/parts";
import { UsStateMap } from "../stats/UsStateMap";
import {
  activationsDetail, dateLabel, frequencyLabel, lastHeardDetail, lastHeardSpot, lastHeardWhen, lookupPath, monthLabel,
  noLicenseMessage, onAirNow, otherForms, placeLabel, plural, profileUrl, qrzUrl, shortDay, sourceSeries, sourcesDetail,
  spotRows, totalActivations, usStates,
} from "./format";
import { ActivityHeatMap } from "./ActivityHeatMap";
import { Flag } from "./Flag";
import { LookupForm } from "./LookupForm";
import type { CallsignProfile, HeardProfile, License } from "./types";
import { useCallsignProfile } from "./useCallsignProfile";

const CONTACT_EMAIL = (import.meta.env.VITE_CONTACT_EMAIL as string | undefined) ?? "";

/** The profile's tabs; Activity is the page with no `tab` in the query string. */
type ProfileTab = "activity" | "activations" | "spots";

/** The tab a query string's `tab` names; anything else is Activity. */
function profileTab(value: string | null): ProfileTab {
  return value === "activations" || value === "spots" ? value : "activity";
}

/**
 * /call/:callsign. The URL is made canonical in two steps: input is trimmed and
 * uppercased here, then swapped for the base call the profile comes back with
 * (KK4PWJ/P becomes KK4PWJ), which SQL works out, never TypeScript. Both keep
 * the query string, so the tab survives.
 */
export function CallsignPage({ prefs, signedIn = false }: { prefs: TimePrefs; signedIn?: boolean }) {
  const raw = useParams()["*"] ?? "";
  const { search } = useLocation();
  const path = lookupPath(raw.replace(/^\/+|\/+$/g, ""));
  if (!path) return <Navigate to="/lookup" replace />;
  if (path !== lookupPath(raw) || raw !== raw.toUpperCase()) return <Navigate to={`${path}${search}`} replace />;
  return <Profile key={raw} callsign={raw} prefs={prefs} signedIn={signedIn} />;
}

function Profile({ callsign, prefs, signedIn }: { callsign: string; prefs: TimePrefs; signedIn: boolean }) {
  const { profile, error, loading } = useCallsignProfile(callsign);
  const navigate = useNavigate();
  const { search } = useLocation();
  const [params] = useSearchParams();
  const tab = profileTab(params.get("tab"));

  useEffect(() => {
    if (profile && profile.callsign !== callsign) {
      const path = lookupPath(profile.callsign);
      void navigate(path ? `${path}${search}` : "/lookup", { replace: true });
    }
  }, [profile, callsign, navigate, search]);

  if (loading) return <LinearProgress />;
  if (error instanceof ApiError && error.code === "400") return <Invalid callsign={callsign} message={error.message} />;
  if (!profile) return <Alert severity="error">{errorText(error, "Couldn't load this profile.")}</Alert>;

  const heard = profile.heard && profile.heard.spots > 0 ? profile.heard : null;
  return (
    <Stack spacing={3} useFlexGap>
      <Header profile={profile} signedIn={signedIn} />
      <ProfileTabs callsign={profile.callsign} tab={tab} />
      {tab === "activity" && (heard ? <Heard profile={profile} heard={heard} /> : <NotHeard profile={profile} />)}
      {/* Mounted only while selected, so the list is asked for only when someone opens the tab. */}
      {tab === "activations" && <ActivationsTab callsign={profile.callsign} />}
      {tab === "spots" && <RecentSpots profile={profile} heard={heard} prefs={prefs} />}
      <Footer email={CONTACT_EMAIL} />
    </Stack>
  );
}

const TABS: { value: ProfileTab; label: string; query: string }[] = [
  { value: "activity", label: "Activity", query: "" },
  { value: "activations", label: "Spotted activations", query: "?tab=activations" },
  { value: "spots", label: "Spots", query: "?tab=spots" },
];

/** Activity, Spotted activations and Spots: links, so each tab has its own address and Back works. */
function ProfileTabs({ callsign, tab }: { callsign: string; tab: ProfileTab }) {
  const mobile = useMediaQuery((t: Theme) => t.breakpoints.down("sm"));
  const path = lookupPath(callsign) ?? "/lookup";
  return (
    <Box>
      <Tabs value={tab} variant={mobile ? "scrollable" : "standard"} scrollButtons={false} aria-label="Profile sections">
        {TABS.map((t) => <Tab key={t.value} value={t.value} label={t.label} component={RouterLink} to={`${path}${t.query}`} />)}
      </Tabs>
      <Divider />
    </Box>
  );
}

/** The Spots tab: the newest spots of the last 7 days. */
function RecentSpots({ profile, heard, prefs }: { profile: CallsignProfile; heard: HeardProfile | null; prefs: TimePrefs }) {
  if (!heard || heard.recentSpots.length === 0) {
    return (
      <Card variant="outlined">
        <CardContent>
          <Typography color="text.secondary">
            {heard ? `No spots of ${profile.callsign} in the last 7 days.` : `Long Lines hasn't heard ${profile.callsign} on the air yet.`}
          </Typography>
        </CardContent>
      </Card>
    );
  }
  return (
    <ChartCard title="Recent spots" subheader="Newest first">
      <SpotsTable spots={spotRows(heard.recentSpots)} dense prefs={prefs} />
    </ChartCard>
  );
}

function Invalid({ callsign, message }: { callsign: string; message: string }) {
  return (
    <Stack spacing={3} useFlexGap>
      <PageTitle>Callsign lookup</PageTitle>
      <Alert severity="warning">{`${callsign} isn't a valid callsign. ${message}`}</Alert>
      <LookupForm initial={callsign} />
    </Stack>
  );
}

// Each source keeps one color across the page, matching Stats where they overlap.
const SOURCE_COLORS: Record<string, "primary" | "secondary" | "warning" | "info" | "success" | "error"> = {
  pota: "primary", sotawatch: "secondary", rbn: "warning", dxcluster: "info", wwff: "success", wwbota: "error",
  logged: "secondary",
};

function Header({ profile, signedIn }: { profile: CallsignProfile; signedIn: boolean }) {
  const { notify } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const mobile = useMediaQuery((t: Theme) => t.breakpoints.down("sm"));
  const [picking, setPicking] = useState(false);
  const { callsign, license, heard } = profile;
  const url = profileUrl(window.location.origin, callsign);
  const place = placeLabel(profile);
  const others = heard ? otherForms(heard, callsign) : [];

  const share = () => shareLink({ title: `${callsign} on Long Lines`, url, copied: "Link copied.", notify });

  const getAlerts = () => {
    if (!signedIn) void navigate("/signin", { state: { from: location.pathname } });
    else setPicking(true);
  };

  // The editor opens on the picked source with this call as its filter; nothing is saved until the user saves there.
  const pick = (source: string) =>
    void navigate(`/connections/new?source=${encodeURIComponent(source)}&callsign=${encodeURIComponent(callsign)}`);

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ justifyContent: "space-between" }}>
          <Box sx={{ minWidth: 0 }}>
            <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
              <Typography variant={mobile ? "h4" : "h3"} component="h1">{callsign}</Typography>
              <Flag country={profile.country?.name} />
            </Stack>
            {license?.name && <Typography variant="h6" component="p" color="text.secondary">{license.name}</Typography>}
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", mt: 1 }}>
              {license?.operatorClass && <Chip size="small" label={license.operatorClass} />}
              {place && <Chip size="small" label={place} />}
            </Stack>
            {others.length > 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>Also heard as {others.join(", ")}</Typography>
            )}
          </Box>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexShrink: 0, flexWrap: "wrap", alignItems: "flex-start" }}>
            <Button variant="contained" startIcon={<NotificationsActiveIcon />} onClick={getAlerts}>
              {signedIn ? `Get alerts for ${callsign}` : "Sign in to get alerts"}
            </Button>
            <Button variant="outlined" startIcon={<ShareIcon />} onClick={() => void share()}>Share</Button>
            <Button variant="outlined" startIcon={<OpenInNewIcon />} href={qrzUrl(callsign)} target="_blank" rel="noopener noreferrer">
              QRZ
            </Button>
          </Stack>
        </Stack>
      </CardContent>
      {heard?.lastHeard && <LastHeard heard={heard} last={heard.lastHeard} />}
      {picking && <SourcePickerDialog open fullScreen={mobile} onClose={() => setPicking(false)} onContinue={pick} />}
    </Card>
  );
}

/** The header's middle band: where and when the station was last spotted. */
function LastHeard({ heard, last }: { heard: HeardProfile; last: NonNullable<HeardProfile["lastHeard"]> }) {
  const [now] = useState(() => new Date());
  const spot = lastHeardSpot(heard);
  const detail = spot ? lastHeardDetail(spot, heard) : "";
  return (
    <>
      <Divider />
      <CardContent>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Typography variant="overline" color="text.secondary">Last heard</Typography>
          {onAirNow(last.time, now) && <Chip size="small" color="success" label="On the air now" />}
        </Stack>
        <Typography variant="h4" component="p">{frequencyLabel(last.frequencyKhz)}</Typography>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center", mt: 1 }}>
          {last.mode && <Chip size="small" variant="outlined" label={last.mode.toUpperCase()} />}
          {spot?.band && <Chip size="small" variant="outlined" label={spot.band} />}
          {spot && <Chip size="small" color={SOURCE_COLORS[spot.source] ?? "default"} label={sourceName(spot.source)} />}
          <Typography variant="body2" color="text.secondary">{lastHeardWhen(last.time, now)}</Typography>
        </Stack>
        {detail && <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{detail}</Typography>}
      </CardContent>
    </>
  );
}

function LicenseCard({ license, usPrefix }: { license: License | null; usPrefix: boolean }) {
  const rows: [string, string | null][] = license
    ? [
      ["Name", license.name],
      ["Class", license.operatorClass],
      ["Status", license.status],
      ["Granted", license.grantedOn && dateLabel(license.grantedOn)],
      ["Expires", license.expiresOn && dateLabel(license.expiresOn)],
      ["State", license.state],
    ]
    : [];
  return (
    <ChartCard title="License" subheader="From the FCC Universal Licensing System. Refreshed weekly.">
      {license
        ? (
          <Table size="small">
            <TableBody>
              {rows.map(([label, value]) => (
                <TableRow key={label}>
                  <TableCell component="th" scope="row">{label}</TableCell>
                  <TableCell>{value ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )
        : <Typography color="text.secondary">{noLicenseMessage(usPrefix)}</Typography>}
    </ChartCard>
  );
}

function NotHeard({ profile }: { profile: CallsignProfile }) {
  const hunting = profile.heard?.hunting;
  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, md: 6 }}>
        <LicenseCard license={profile.license} usPrefix={profile.usPrefix} />
      </Grid>
      <Grid size={{ xs: 12, md: 6 }}>
        <Card variant="outlined" sx={{ height: "100%" }}>
          <CardContent>
            <Typography color="text.secondary">Long Lines hasn't heard {profile.callsign} on the air yet.</Typography>
          </CardContent>
        </Card>
      </Grid>
      {hunting && hunting.spots > 0 && (
        <Grid size={{ xs: 12, md: 6 }}>
          <HuntingCard hunting={hunting} />
        </Grid>
      )}
    </Grid>
  );
}

function HuntingCard({ hunting }: { hunting: HeardProfile["hunting"] }) {
  return (
    <ChartCard title="Hunting" subheader="Spots this station posted for other activators">
      <Typography variant="h4" component="div">{fmt(hunting.spots)}</Typography>
      <Typography variant="body2" color="text.secondary">{sourcesDetail(hunting.sources)}</Typography>
    </ChartCard>
  );
}

// SQL sends up to 100, newest first; the card shows the latest few.
const RECENT_REFERENCES = 10;

const REFERENCE_COLUMNS: GridColDef[] = [
  {
    field: "reference", headerName: "Reference", width: 110, sortable: false,
    renderCell: ({ row, value }: GridRenderCellParams<{ program: string }, string>) => <ReferenceLink program={row.program} reference={value ?? ""} />,
  },
  { field: "name", headerName: "Name", flex: 1, minWidth: 120, sortable: false },
  { field: "program", headerName: "Program", width: 80, sortable: false },
  { field: "activations", headerName: "Visits", type: "number", width: 70, sortable: false },
  { field: "last", headerName: "Last", width: 110, sortable: false },
];

const HEARD_BY_COLUMNS: GridColDef[] = [
  { field: "spotter", headerName: "Spotter", flex: 1, minWidth: 90, sortable: false },
  { field: "spots", headerName: "Spots", type: "number", width: 80, sortable: false },
  { field: "snr", headerName: "Best SNR", width: 90, sortable: false },
  { field: "topBand", headerName: "Top band", width: 90, sortable: false },
];

function Heard({ profile, heard }: { profile: CallsignProfile; heard: HeardProfile }) {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down("sm"));
  const sources = heard.sources.map((s) => s.source);
  const color = (source: string) => theme.palette[SOURCE_COLORS[source] ?? "success"].main;
  const stacked = (rows: { sources: Record<string, number> }[]) =>
    sourceSeries(rows, sources).map(({ source, data }) => ({
      label: sourceName(source), data, stack: "spots", color: color(source), valueFormatter: (v: number | null) => fmt(v ?? 0),
    }));
  const axis = (v: unknown) => compact(Number(v));
  const states = usStates(heard.activationsByLocation);
  const hasMap = Object.keys(states).length > 0;
  const modes = heard.modes.filter((m) => m.percent > 0);

  return (
    <>
      <Grid container spacing={2}>
        <Grid size={{ xs: 6, md: 3 }}>
          <Kpi label="Spots" value={fmt(heard.spots)} detail="All time" />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Kpi label="Days on the air" value={fmt(heard.daysOnAir)} detail={heard.firstHeard ? `Since ${dateLabel(heard.firstHeard.slice(0, 10))}` : ""} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Kpi label="Heard from" value={plural(heard.countries, "country", "countries")} detail={plural(heard.continents, "continent", "continents")} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <Kpi label="Park/summit/WWFF visits" value={fmt(totalActivations(heard.activations))} detail={activationsDetail(heard.activations)} />
        </Grid>
      </Grid>

      {heard.calendar && <ActivityHeatMap callsign={profile.callsign} calendar={heard.calendar} />}

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 4 }}>
          <LicenseCard license={profile.license} usPrefix={profile.usPrefix} />
        </Grid>
        <Grid size={{ xs: 12, md: 8 }}>
          <ChartCard title="Activity" subheader="Spots per month, since Long Lines started">
            <BarChart
              height={260}
              xAxis={[{ scaleType: "band", data: heard.monthly.map((m) => monthLabel(m.month)) }]}
              yAxis={[{ valueFormatter: axis, width: 48 }]}
              series={stacked(heard.monthly)}
            />
          </ChartCard>
        </Grid>
      </Grid>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 6 }}>
          <ChartCard title="Last 30 days" subheader="Spots per day">
            <BarChart
              height={240}
              xAxis={[{ scaleType: "band", data: heard.daily.map((d) => shortDay(d.day)), tickLabelInterval: (_v, i) => i % (mobile ? 7 : 3) === 0 }]}
              yAxis={[{ valueFormatter: axis, width: 48 }]}
              series={stacked(heard.daily)}
            />
          </ChartCard>
        </Grid>
        <Grid size={{ xs: 12, md: 6 }}>
          <ChartCard title="When they're on the air" subheader="Spots by hour of day (UTC). Useful for knowing when to listen.">
            <BarChart
              height={240}
              hideLegend
              xAxis={[{
                scaleType: "band",
                data: heard.hours.map((_n, h) => String(h).padStart(2, "0")),
                tickLabelInterval: (_v, i) => i % (mobile ? 6 : 3) === 0,
              }]}
              yAxis={[{ valueFormatter: axis, width: 48 }]}
              series={[{ label: "Spots", data: heard.hours, valueFormatter: (v) => fmt(v ?? 0) }]}
            />
          </ChartCard>
        </Grid>
      </Grid>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 6 }}>
          <ChartCard title="Bands" subheader="All sources">
            <BarChart
              height={260}
              hideLegend
              xAxis={[{ scaleType: "band", data: heard.bands.map((b) => b.band) }]}
              yAxis={[{ valueFormatter: axis, width: 48 }]}
              series={[{ label: "Spots", data: heard.bands.map((b) => b.spots), valueFormatter: (v) => fmt(v ?? 0) }]}
            />
          </ChartCard>
        </Grid>
        <Grid size={{ xs: 12, md: 6 }}>
          <ChartCard title="Modes" subheader="Share of spots">
            <PieChart
              height={260}
              series={[{
                data: modes.map((m) => ({ id: m.label, label: m.label, value: m.percent })),
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

      {heard.references.length > 0 && (
        <ChartCard title="Where they've been spotted" subheader="Parks, summits, WWFF references, bunkers and islands, most recent first. A visit is one reference on one UTC day.">
          <Grid container spacing={3}>
            {hasMap && (
              <Grid size={{ xs: 12, md: 6 }}>
                <UsStateMap values={states} unit="visits" />
              </Grid>
            )}
            <Grid size={{ xs: 12, md: hasMap ? 6 : 12 }}>
              <DataGrid
                {...GRID}
                rows={heard.references.slice(0, RECENT_REFERENCES).map((r) => ({ id: `${r.program} ${r.reference}`, ...r, name: r.name ?? "", last: dateLabel(r.lastDay) }))}
                columns={REFERENCE_COLUMNS}
                columnVisibilityModel={{ name: !mobile, program: !mobile }}
              />
            </Grid>
          </Grid>
        </ChartCard>
      )}

      {(heard.reach.length > 0 || heard.hunting.spots > 0) && (
        <Grid container spacing={2}>
          {heard.reach.length > 0 && (
            <Grid size={{ xs: 12, md: 6 }}>
              <ChartCard title="Heard from" subheader="Countries of the spotters and skimmers who heard this station. Self-spots don't count.">
                <List dense disablePadding>
                  {heard.reach.slice(0, 10).map((r) => (
                    <ListItem
                      key={r.country}
                      disableGutters
                      secondaryAction={<Typography variant="body2" color="text.secondary">{fmt(r.spots)}</Typography>}
                    >
                      <ListItemText primary={r.country} />
                    </ListItem>
                  ))}
                </List>
              </ChartCard>
            </Grid>
          )}
          {heard.hunting.spots > 0 && (
            <Grid size={{ xs: 12, md: 6 }}>
              <HuntingCard hunting={heard.hunting} />
            </Grid>
          )}
        </Grid>
      )}

      {heard.heardBy.length > 0 && (
        <ChartCard title="Heard by" subheader="Spotters and skimmers that picked up this station in the last 7 days">
          <DataGrid
            {...GRID}
            rows={heard.heardBy.map((r) => ({
              id: r.spotter, spotter: r.spotter, spots: r.spots, snr: r.bestSnr === null ? "" : `${r.bestSnr} dB`, topBand: r.topBand ?? "",
            }))}
            columns={HEARD_BY_COLUMNS}
            columnVisibilityModel={{ topBand: !mobile }}
          />
        </ChartCard>
      )}

    </>
  );
}

/** The page's closing note; the hide-this-page sentence needs VITE_CONTACT_EMAIL. */
export function Footer({ email }: { email: string }) {
  return (
    <Typography variant="body2" color="text.secondary">
      License data comes from the public FCC database. Long Lines never shows street addresses.
      {email && (
        <>
          {" "}To have this page hidden, email <Link href={`mailto:${email}`}>{email}</Link>.
        </>
      )}
    </Typography>
  );
}

import { useEffect, useState } from "react";
import {
  Alert, Box, Button, Card, CardContent, Chip, Grid, LinearProgress, Link, List, ListItem, ListItemText, Stack, Table, TableBody,
  TableCell, TableRow, Typography, useMediaQuery, useTheme, type Theme,
} from "@mui/material";
import NotificationsActiveIcon from "@mui/icons-material/NotificationsActive";
import ShareIcon from "@mui/icons-material/Share";
// MUI X Charts and Data Grid are the MIT community packages, fixed and read-only as on the Stats page.
import { BarChart, PieChart } from "@mui/x-charts";
import { DataGrid, type GridColDef } from "@mui/x-data-grid";
import { Navigate, useLocation, useNavigate, useParams } from "react-router";
import { errorText, useApp } from "../app/hooks";
import { ApiError, saveSubscription, type Destination } from "../lib/api";
import type { TimePrefs } from "../lib/time";
import { PageTitle } from "../layout/PageTitle";
import { SpotsTable } from "../sources/SpotsTable";
import { sourceName } from "../sources/sources";
import { compact, fmt } from "../stats/format";
import { ChartCard, GRID, Kpi } from "../stats/parts";
import { UsStateMap } from "../stats/UsStateMap";
import {
  activationsDetail, dateLabel, lastHeardLabel, lookupPath, monthLabel, noLicenseMessage, otherForms, placeLabel, plural,
  profileUrl, shortDay, sourceSeries, sourcesDetail, spotRows, totalActivations, usStates,
} from "./format";
import { LookupForm } from "./LookupForm";
import type { CallsignProfile, HeardProfile, License } from "./types";
import { useCallsignProfile } from "./useCallsignProfile";

const CONTACT_EMAIL = (import.meta.env.VITE_CONTACT_EMAIL as string | undefined) ?? "";

/** What Get alerts needs from a signed-in user; absent when signed out. */
export interface AlertAccount {
  dests: Destination[];
  reload: () => Promise<void>;
}

/**
 * /call/:callsign. The URL is made canonical in two steps: input is trimmed and
 * uppercased here, then swapped for the base call the profile comes back with
 * (KK4PWJ/P becomes KK4PWJ), which SQL works out, never TypeScript.
 */
export function CallsignPage({ prefs, account }: { prefs: TimePrefs; account?: AlertAccount }) {
  const raw = useParams()["*"] ?? "";
  const path = lookupPath(raw.replace(/^\/+|\/+$/g, ""));
  if (!path) return <Navigate to="/lookup" replace />;
  if (path !== lookupPath(raw) || raw !== raw.toUpperCase()) return <Navigate to={path} replace />;
  return <Profile key={raw} callsign={raw} prefs={prefs} account={account} />;
}

function Profile({ callsign, prefs, account }: { callsign: string; prefs: TimePrefs; account?: AlertAccount }) {
  const { profile, error, loading } = useCallsignProfile(callsign);
  const navigate = useNavigate();

  useEffect(() => {
    if (profile && profile.callsign !== callsign) void navigate(lookupPath(profile.callsign) ?? "/lookup", { replace: true });
  }, [profile, callsign, navigate]);

  if (loading) return <LinearProgress />;
  if (error instanceof ApiError && error.code === "400") return <Invalid callsign={callsign} message={error.message} />;
  if (!profile) return <Alert severity="error">{errorText(error, "Couldn't load this profile.")}</Alert>;

  const heard = profile.heard && profile.heard.spots > 0 ? profile.heard : null;
  return (
    <Stack spacing={3} useFlexGap>
      <Header profile={profile} account={account} />
      {heard ? <Heard profile={profile} heard={heard} prefs={prefs} /> : <NotHeard profile={profile} />}
      <Footer email={CONTACT_EMAIL} />
    </Stack>
  );
}

function Invalid({ callsign, message }: { callsign: string; message: string }) {
  return (
    <Stack spacing={3} useFlexGap>
      <PageTitle>Callsign lookup</PageTitle>
      <Alert severity="warning">{`${callsign} isn't a valid callsign. ${message}`}</Alert>
      <LookupForm />
    </Stack>
  );
}

function Header({ profile, account }: { profile: CallsignProfile; account?: AlertAccount }) {
  const { notify } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const mobile = useMediaQuery((t: Theme) => t.breakpoints.down("sm"));
  const [busy, setBusy] = useState(false);
  const [now] = useState(() => new Date());
  const { callsign, license } = profile;
  const url = profileUrl(window.location.origin, callsign);
  const place = placeLabel(profile);
  const lastHeard = profile.heard?.lastHeard;
  const others = profile.heard ? otherForms(profile.heard, callsign) : [];

  const share = async () => {
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: `${callsign} on Long Lines`, url });
      } catch {
        // dismissed
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      notify("Link copied.");
    } catch {
      notify("Couldn't copy the link.");
    }
  };

  const getAlerts = async () => {
    if (!account) {
      void navigate("/signin", { state: { from: location.pathname } });
      return;
    }
    // save_subscription requires a destination, so with none there is nothing to create yet.
    const dest = account.dests.find((d) => d.health === "ok") ?? account.dests[0];
    if (!dest) {
      notify("Add a destination to start getting alerts.");
      void navigate("/destinations");
      return;
    }
    const name = `${callsign} on the air`;
    setBusy(true);
    try {
      await saveSubscription({
        name, enabled: true, quiet_minutes: 30, destinations: [dest.id],
        sources: [], bands: [], modes: [], callsigns: [callsign], reference: "",
      });
      await account.reload();
      notify(`Created ${name}`);
      void navigate("/subscriptions");
    } catch (err) {
      notify(errorText(err, "Couldn't save the subscription."));
      setBusy(false);
    }
  };

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ justifyContent: "space-between" }}>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant={mobile ? "h4" : "h3"} component="h1">{callsign}</Typography>
            {license?.name && <Typography variant="h6" color="text.secondary">{license.name}</Typography>}
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", mt: 1 }}>
              {license?.operatorClass && <Chip size="small" label={license.operatorClass} />}
              {place && <Chip size="small" label={place} />}
              {lastHeard && (
                <Chip size="small" color="success" variant="outlined" label={lastHeardLabel(lastHeard, now)} sx={{ maxWidth: "100%" }} />
              )}
            </Stack>
            {others.length > 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>Also heard as {others.join(", ")}</Typography>
            )}
          </Box>
          <Stack direction="row" spacing={1} sx={{ flexShrink: 0, alignItems: "flex-start" }}>
            <Button variant="contained" startIcon={<NotificationsActiveIcon />} disabled={busy} onClick={() => void getAlerts()}>
              {account ? "Get alerts" : "Sign in to get alerts"}
            </Button>
            <Button variant="outlined" startIcon={<ShareIcon />} onClick={() => void share()}>Share</Button>
          </Stack>
        </Stack>
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1, overflowWrap: "anywhere" }}>{url}</Typography>
      </CardContent>
    </Card>
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

const REFERENCE_COLUMNS: GridColDef[] = [
  { field: "reference", headerName: "Reference", width: 110, sortable: false },
  { field: "name", headerName: "Name", flex: 1, minWidth: 120, sortable: false },
  { field: "program", headerName: "Program", width: 80, sortable: false },
  { field: "activations", headerName: "Times", type: "number", width: 70, sortable: false },
  { field: "last", headerName: "Last", width: 110, sortable: false },
];

const HEARD_BY_COLUMNS: GridColDef[] = [
  { field: "spotter", headerName: "Spotter", flex: 1, minWidth: 90, sortable: false },
  { field: "spots", headerName: "Spots", type: "number", width: 80, sortable: false },
  { field: "snr", headerName: "Best SNR", width: 90, sortable: false },
  { field: "topBand", headerName: "Top band", width: 90, sortable: false },
];

// Each source keeps one color across the page, matching Stats where they overlap.
const SOURCE_COLORS: Record<string, "primary" | "secondary" | "warning" | "info"> = {
  pota: "primary", sotawatch: "secondary", rbn: "warning", dxcluster: "info",
};

function Heard({ profile, heard, prefs }: { profile: CallsignProfile; heard: HeardProfile; prefs: TimePrefs }) {
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
          <Kpi label="Activations" value={fmt(totalActivations(heard.activations))} detail={activationsDetail(heard.activations)} />
        </Grid>
      </Grid>

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
        <ChartCard title="Where they've activated" subheader="Parks and summits">
          <Grid container spacing={3}>
            {hasMap && (
              <Grid size={{ xs: 12, md: 6 }}>
                <UsStateMap values={states} unit="activations" />
              </Grid>
            )}
            <Grid size={{ xs: 12, md: hasMap ? 6 : 12 }}>
              <DataGrid
                {...GRID}
                rows={heard.references.map((r) => ({ id: `${r.program} ${r.reference}`, ...r, name: r.name ?? "", last: dateLabel(r.lastDay) }))}
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
              <ChartCard title="Heard from" subheader="Countries the spotters and skimmers who heard this station are in">
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

      {heard.recentSpots.length > 0 && (
        <ChartCard title="Recent spots" subheader="Newest first">
          <SpotsTable spots={spotRows(heard.recentSpots)} dense prefs={prefs} />
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

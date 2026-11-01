import { useEffect, type ReactNode } from "react";
import {
  Alert, AlertTitle, Box, Button, Card, CardContent, Chip, Grid, LinearProgress, Link, Stack, Typography, useMediaQuery, useTheme,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import LinkIcon from "@mui/icons-material/Link";
import { Navigate, Link as RouterLink } from "react-router";
import { errorText, useApp } from "../app/hooks";
import { PageTitle } from "../layout/PageTitle";
import { copyLink } from "../lib/share";
import { lookupPath } from "../profile/format";
import { ChartCard } from "../stats/parts";
import { ActivationSpots } from "./ActivationSpots";
import { HeardMap } from "./HeardMap";
import {
  bandsLabel, bandsModesLabel, chips, CONTACTS_UNKNOWN, continuedFrom as continuedFromText, continuedOn as continuedOnText, dateLine, documentTitle, EMPTY, estimateNote, farthestLabel, heardIn, modesLabel,
  namesLabel, NOT_FOUND, overline, referencesLabel, spotsLine, timeOnAirRow,
} from "./model";
import { activationPath, activationsTabPath, activationUrl } from "./paths";
import { SpotsTimeline } from "./SpotsTimeline";
import type { SpottedActivation } from "./types";
import { useSpottedActivation } from "./useActivations";

/**
 * /activations/:id, public. The id goes to the function as it is in the URL; the payload's id is
 * the canonical one, so a redirected id lands on it (replacing the URL).
 */
export function ActivationPage({ id }: { id: string }) {
  const { data, notFound, error, loading } = useSpottedActivation(id);
  const title = data ? documentTitle(data) : null;

  useEffect(() => {
    if (!title) return;
    const before = document.title;
    document.title = title;
    return () => {
      document.title = before;
    };
  }, [title]);

  if (loading) return <LinearProgress />;
  if (notFound) return <NotFound />;
  if (!data) return <Alert severity="error">{errorText(error, "Couldn't load this activation.")}</Alert>;
  if (data.id !== id) return <Navigate to={activationPath(data.id)} replace />;
  return <Activation activation={data} />;
}

function NotFound() {
  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2} useFlexGap>
          <PageTitle>Spotted activation not found</PageTitle>
          <Alert severity="warning">{NOT_FOUND}</Alert>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
            <Button variant="outlined" component={RouterLink} to="/lookup">Callsign lookup</Button>
            <Button component={RouterLink} to="/stats">Stats</Button>
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}

/** One "On the air" entry: a label over its value. */
function Entry({ label, children, muted = false }: { label: string; children: ReactNode; muted?: boolean }) {
  return (
    <>
      <Typography component="dt" variant="overline" color="text.secondary">{label}</Typography>
      <Typography component="dd" variant="body2" color={muted ? "text.secondary" : "text.primary"} sx={{ m: 0, mb: 1.5 }}>
        {children}
      </Typography>
    </>
  );
}

function OnTheAir({ activation: a, mobile }: { activation: SpottedActivation; mobile: boolean }) {
  return (
    <ChartCard title="On the air">
      <Box component="dl" sx={{ m: 0 }}>
        <Entry label="Time on air">{timeOnAirRow(a)}</Entry>
        {mobile
          ? <Entry label="Bands · modes">{bandsModesLabel(a.bands, a.modes) || EMPTY}</Entry>
          : (
            <>
              <Entry label="Bands">{bandsLabel(a.bands) || EMPTY}</Entry>
              <Entry label="Modes">{modesLabel(a.modes) || EMPTY}</Entry>
            </>
          )}
        <Entry label="Spots">{spotsLine(a.spotCount, a.sources)}</Entry>
        <Entry label="Heard in">
          {heardIn(a.heard.filter((p) => p.kind === "state").length, a.heard.filter((p) => p.kind === "country").length) ?? EMPTY}
        </Entry>
        <Entry label="Farthest">{a.farthest ? farthestLabel(a.farthest) : EMPTY}</Entry>
        <Entry label="Contacts" muted>{CONTACTS_UNKNOWN}</Entry>
      </Box>
    </ChartCard>
  );
}

/** A POTA midnight split links its two halves: the earlier is the UTC day before, the later the day after. */
function SplitLinks({ activation: a }: { activation: SpottedActivation }) {
  const { continuedFrom, continuedBy } = a.split;
  if (continuedFrom === null && continuedBy === null) return null;
  return (
    <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: "wrap" }}>
      {continuedFrom !== null && (
        <Link component={RouterLink} to={activationPath(continuedFrom)} variant="body2" underline="hover">{continuedFromText(a.day)}</Link>
      )}
      {continuedBy !== null && (
        <Link component={RouterLink} to={activationPath(continuedBy)} variant="body2" underline="hover">{continuedOnText(a.day)}</Link>
      )}
    </Stack>
  );
}

function Activation({ activation: a }: { activation: SpottedActivation }) {
  const { notify } = useApp();
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down("sm"));
  const names = namesLabel(a.referenceNames);
  // The heading already lists a two-fer's references, so only the other chips show here.
  const labels = chips({ ...a, ...a.split }).filter((l) => l !== "Two-fer");
  const copy = () => copyLink({ url: activationUrl(window.location.origin, a.id), notify });

  return (
    <Stack spacing={3} useFlexGap>
      <Box>
        <Button component={RouterLink} to={activationsTabPath(a.callsign)} startIcon={<ArrowBackIcon />}>
          {`${a.callsign} spotted activations`}
        </Button>
      </Box>

      <Stack direction={{ xs: "column", sm: "row" }} spacing={2} useFlexGap sx={{ justifyContent: "space-between", alignItems: { sm: "flex-end" } }}>
        <Stack spacing={0.5} sx={{ minWidth: 0 }}>
          <Typography variant="overline" color="text.secondary">{overline(a.program)}</Typography>
          <Typography variant={mobile ? "h5" : "h4"} component="h1">
            <Link component={RouterLink} to={lookupPath(a.callsign) ?? "/lookup"} color="inherit" underline="hover">{a.callsign}</Link>
            {` at ${referencesLabel(a.references)}`}
          </Typography>
          {names && <Typography variant="body1">{names}</Typography>}
          <Typography variant="body2" color="text.secondary">{dateLine(a)}</Typography>
          <SplitLinks activation={a} />
          {labels.length > 0 && (
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", pt: 0.5 }}>
              {labels.map((l) => <Chip key={l} size="small" label={l} />)}
            </Stack>
          )}
        </Stack>
        <Box sx={{ flexShrink: 0 }}>
          <Button variant="contained" startIcon={<LinkIcon />} onClick={() => void copy()} fullWidth={mobile}>Copy link</Button>
        </Box>
      </Stack>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 8 }}>
          <HeardMap activation={a} />
        </Grid>
        <Grid size={{ xs: 12, md: 4 }}>
          <OnTheAir activation={a} mobile={mobile} />
        </Grid>
      </Grid>

      <SpotsTimeline spots={a.spots} from={a.startedAt} to={a.lastSpotAt} mobile={mobile} />
      <ActivationSpots spots={a.spots} mobile={mobile} />

      <Alert severity="info">
        <AlertTitle>How this was estimated</AlertTitle>
        {estimateNote(a)}
      </Alert>
    </Stack>
  );
}

import type { ReactNode } from "react";
import {
  Alert, AlertTitle, Box, Breadcrumbs, Button, Card, CardContent, Chip, Grid, Link, Skeleton, Stack, Table, TableBody,
  TableCell, TableHead, TableRow, Typography,
} from "@mui/material";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { Navigate, Link as RouterLink, useParams } from "react-router";
import type { TimePrefs } from "../lib/time";
import { PageTitle } from "../layout/PageTitle";
import { ChartCard } from "../stats/parts";
import { useStats } from "../stats/useStats";
import { findLiveSource, type SourceInfo } from "./sources";
import { STATUS_COLOR, STATUS_LABEL, sourceStatus } from "./status";
import { formatHour, formatPerDay, formatRate, rateUnitShort, sourceRates, type Rates } from "./rates";
import { RateChart } from "./RateChart";
import { RecentSpotsCard } from "./RecentSpotsCard";
import { SourceMark } from "./SourceMark";
import { useIngestHealth } from "./useIngestHealth";

const NO_RATES = "No rates yet. They appear after the next hourly stats refresh.";
// Three columns leave Description a sliver at phone width, so the type moves under the field name.
const TYPE_COLUMN = { xs: "none", sm: "table-cell" };
const TYPE_UNDER_FIELD = { xs: "block", sm: "none" };

/** RBN and APRS-IS only; the per-day sentence is left out until there are rates. */
function volumeAlert(source: SourceInfo, rates: Rates | null): { title: string; body: string } | null {
  const perDay = rates ? formatPerDay(rates.perDay) : null;
  if (source.id === "rbn") {
    return {
      title: "High volume source: a callsign filter is required",
      body: `${perDay ? `Reverse Beacon Network sends about ${perDay} spots a day. ` : ""}A subscription only gets its spots if it names callsigns, typed or through a group. One that lists only RBN can't be saved without them.`,
    };
  }
  if (source.id === "aprs") {
    return {
      title: "High volume source: stored only",
      body: `${perDay ? `APRS-IS sends about ${perDay} packets a day. ` : ""}Long Lines stores and archives them but does not match them, so they can't be used in subscriptions.`,
    };
  }
  return null;
}

function Figure({ label, value, loading }: { label: string; value: string; loading: boolean }) {
  return (
    <Card variant="outlined" sx={{ height: "100%" }}>
      <CardContent>
        <Typography variant="overline" color="text.secondary">{label}</Typography>
        <Typography variant="h5">{loading ? <Skeleton width="60%" /> : value}</Typography>
      </CardContent>
    </Card>
  );
}

function Lines({ lines }: { lines: string[] }) {
  return (
    <Stack spacing={1}>
      {lines.map((line) => <Typography key={line} variant="body2">{line}</Typography>)}
    </Stack>
  );
}

// A bare <code> keeps the browser's monospace font; a Typography variant would replace it, and MUI 9 has no fontFamily prop.
function Mono({ children }: { children: ReactNode }) {
  return <Box component="code">{children}</Box>;
}

export function SourceDetailPage({ prefs }: { prefs: TimePrefs }) {
  const { id } = useParams();
  const source = findLiveSource(id);
  // Hooks stay above the redirect; a bad id costs one extra health load.
  const { health } = useIngestHealth(30_000);
  const { stats, loading, error: statsError } = useStats();
  if (!source) return <Navigate to="/sources" replace />;

  const rates = source.statsKey && stats ? sourceRates(stats.payload.hourly, source.statsKey, source.volume) : null;
  const status = sourceStatus(source, health);
  const alert = volumeAlert(source, rates);
  const unit = rateUnitShort(source.volume);
  const rate = (n: number | undefined) => (n === undefined ? "–" : `${formatRate(n)} ${unit}`);
  const figures: [string, string][] = [
    ["Average, 7 days", rate(rates?.average)],
    ["Peak, 7 days", rate(rates?.peak)],
    ["Minimum, 7 days", rate(rates?.minimum)],
    ["Busiest moment", rates ? formatHour(rates.peakHour) : "–"],
  ];

  return (
    <Stack spacing={3}>
      <Breadcrumbs>
        <Link component={RouterLink} to="/sources" underline="hover" color="inherit">Sources</Link>
        <Typography color="text.primary">{source.title}</Typography>
      </Breadcrumbs>

      <Stack direction={{ xs: "column", sm: "row" }} spacing={2} useFlexGap sx={{ alignItems: "flex-start" }}>
        <SourceMark source={source} size="large" />
        <Box sx={{ flexGrow: 1 }}>
          <PageTitle>{source.title}</PageTitle>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", mb: 1 }}>
            <Chip size="small" color={STATUS_COLOR[status]} label={STATUS_LABEL[status]} />
            <Chip size="small" variant="outlined" color={source.volume === "high" ? "warning" : "default"}
              label={source.volume === "high" ? "High volume" : "Standard volume"} />
          </Stack>
          <Typography color="text.secondary">{source.tagline}</Typography>
        </Box>
        {source.site && (
          <Button variant="outlined" endIcon={<OpenInNewIcon />} href={`https://${source.site}`} target="_blank" rel="noopener">
            Visit {source.site}
          </Button>
        )}
      </Stack>

      {alert && (
        <Alert severity="warning">
          <AlertTitle>{alert.title}</AlertTitle>
          {alert.body}
        </Alert>
      )}

      <Grid container spacing={2}>
        {figures.map(([label, value]) => (
          <Grid key={label} size={{ xs: 6, md: 3 }}>
            <Figure label={label} value={value} loading={loading} />
          </Grid>
        ))}
      </Grid>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 8 }}>
          <Stack spacing={2}>
            <ChartCard title="Rate over time" subheader="Last 7 days. The red dot marks the busiest moment, so you can size downstream systems for it">
              {loading
                ? <Skeleton variant="rectangular" height={220} />
                : statsError
                  ? <Alert severity="error">Couldn't load rates.</Alert>
                  : rates
                    ? <RateChart rates={rates} volume={source.volume} color={source.markColor} />
                    : <Typography color="text.secondary">{NO_RATES}</Typography>}
            </ChartCard>
            {source.schema && (
              <ChartCard title="Schema" subheader={`Every field on a ${source.title} spot, as a webhook receives it.`}>
                <Box sx={{ overflowX: "auto" }}>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Field</TableCell>
                        <TableCell sx={{ display: TYPE_COLUMN }}>Type</TableCell>
                        <TableCell>Description</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {source.schema.map((f) => (
                        <TableRow key={f.name}>
                          <TableCell>
                            <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
                              <Mono>{f.name}</Mono>
                              {f.derived && <Chip size="small" variant="outlined" label="Derived" />}
                            </Stack>
                            <Typography variant="caption" color="text.secondary" sx={{ display: TYPE_UNDER_FIELD }}>{f.type}</Typography>
                          </TableCell>
                          <TableCell sx={{ display: TYPE_COLUMN }}>{f.type}</TableCell>
                          <TableCell>{f.description}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Box>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  Fields for other programs are present and null.
                </Typography>
              </ChartCard>
            )}
            {source.example && (
              <ChartCard title="Example spot" subheader="How a webhook receives a spot">
                <Box component="pre" sx={{ overflow: "auto", m: 0 }}>
                  <Mono>{JSON.stringify(source.example, null, 2)}</Mono>
                </Box>
              </ChartCard>
            )}
            {source.alerts && <RecentSpotsCard source={source} prefs={prefs} health={health} />}
          </Stack>
        </Grid>
        <Grid size={{ xs: 12, md: 4 }}>
          <Stack spacing={2}>
            <ChartCard title="About this source"><Lines lines={source.about} /></ChartCard>
            {source.runBy && (
              <ChartCard title="Run by">
                <Table size="small">
                  <TableBody>
                    <TableRow><TableCell>Operator</TableCell><TableCell>{source.runBy.operator}</TableCell></TableRow>
                    {source.site && <TableRow><TableCell>Website</TableCell><TableCell>{source.site}</TableCell></TableRow>}
                    <TableRow><TableCell>Feed</TableCell><TableCell>{source.runBy.feed}</TableCell></TableRow>
                    <TableRow><TableCell>Modes</TableCell><TableCell>{source.runBy.modes}</TableCell></TableRow>
                  </TableBody>
                </Table>
              </ChartCard>
            )}
            <ChartCard title="Where it shows up"><Lines lines={source.showsUp} /></ChartCard>
          </Stack>
        </Grid>
      </Grid>
    </Stack>
  );
}

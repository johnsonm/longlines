import { useCallback, useEffect, useState } from "react";
import { Alert, Box, Card, CardContent, Chip, Divider, Grid, LinearProgress, Paper, Stack, Tab, Tabs, Typography } from "@mui/material";
import { PageTitle } from "../layout/PageTitle";
import { loadIngestHealth, loadRecentSpots, type IngestHealth, type RecentSpot } from "../lib/api";
import { relativeAge, type TimePrefs } from "../lib/time";
import { errorText } from "../app/hooks";
import { LIVE_SOURCES, SOURCES } from "./sources";
import { SpotsTable } from "./SpotsTable";

const REFRESH_MS = 30_000;

export function SourcesPage({ prefs }: { prefs: TimePrefs }) {
  const [tab, setTab] = useState("all");
  const [health, setHealth] = useState<IngestHealth[]>([]);
  const [spots, setSpots] = useState<RecentSpot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [h, s] = await Promise.all([loadIngestHealth(), loadRecentSpots()]);
      setHealth(h);
      setSpots(s);
      setError(null);
    } catch (err) {
      setError(errorText(err, "Couldn't load sources."));
    } finally {
      setLoading(false);
    }
  }, []);

  // Refresh every 30 seconds while the tab is visible.
  useEffect(() => {
    void refresh();
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh]);

  const shown = tab === "all" ? spots : spots.filter((s) => s.source === tab);

  return (
    <Stack spacing={3}>
      <Box>
        <PageTitle>Sources</PageTitle>
        <Typography color="text.secondary">
          Long Lines connects to each network once and shares that feed with every subscription, so upstream servers only ever see a single client.
        </Typography>
      </Box>
      {error && <Alert severity="error">{error}</Alert>}
      <Grid container spacing={2}>
        {SOURCES.map((s) => {
          const h = health.find((x) => x.source === s.id);
          const age = h?.seconds_since_last_success ?? null;
          const delayed = s.pollSeconds !== null && (age === null || age > 3 * s.pollSeconds);
          return (
            <Grid size={{ xs: 12, sm: 6, md: 4 }} key={s.id}>
              <Card variant="outlined" sx={{ height: "100%" }}>
                <CardContent>
                  <Stack direction="row" sx={{ justifyContent: "space-between", alignItems: "center", mb: 1 }}>
                    <Typography variant="h6">{s.name}</Typography>
                    {s.status === "live"
                      ? (delayed
                        ? <Chip size="small" color="warning" label="Delayed" />
                        : <Chip size="small" color="success" label="Connected" />)
                      : <Chip size="small" variant="outlined" label="Not yet available" />}
                  </Stack>
                  <Typography variant="body2" color="text.secondary" gutterBottom>{s.full}. {s.desc}.</Typography>
                  {s.status === "live" ? (
                    <Stack direction="row" spacing={3} useFlexGap sx={{ flexWrap: "wrap", mt: 2 }}>
                      <Box>
                        <Typography variant="h5">{h ? Number(h.spots_last_hour ?? 0) : "–"}</Typography>
                        <Typography variant="caption" color="text.secondary">spots in the last hour</Typography>
                      </Box>
                      <Box>
                        <Typography variant="h5">{h ? relativeAge(age) : "–"}</Typography>
                        <Typography variant="caption" color="text.secondary">last fetch, {s.interval}</Typography>
                      </Box>
                    </Stack>
                  ) : (
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>Needs a persistent connection worker. Planned for phase 2.</Typography>
                  )}
                </CardContent>
              </Card>
            </Grid>
          );
        })}
      </Grid>
      <Paper variant="outlined">
        <Box sx={{ px: 2, pt: 2 }}>
          <Typography variant="h6">Recent spots</Typography>
          <Typography variant="body2" color="text.secondary">Everything ingested, before any subscription filters.</Typography>
        </Box>
        <Tabs value={tab} onChange={(_e, v: string) => setTab(v)} variant="scrollable" sx={{ px: 1 }}>
          <Tab value="all" label="All" />
          {LIVE_SOURCES.map((s) => <Tab key={s.id} value={s.id} label={s.name} />)}
        </Tabs>
        <Divider />
        {loading ? <LinearProgress /> : <SpotsTable spots={shown} dense prefs={prefs} />}
      </Paper>
    </Stack>
  );
}

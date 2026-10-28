import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, LinearProgress, Stack, Typography } from "@mui/material";
import { errorText } from "../app/hooks";
import { loadRecentSpots, type IngestHealth, type RecentSpot } from "../lib/api";
import { relativeAge, type TimePrefs } from "../lib/time";
import { ChartCard } from "../stats/parts";
import { healthId, type SourceInfo } from "./sources";
import { SpotsTable } from "./SpotsTable";
import { useVisibleInterval } from "./useVisibleInterval";

/** The source's latest spots, refreshed every 30 s while the tab is visible. */
export function RecentSpotsCard({ source, prefs, health }: { source: SourceInfo; prefs: TimePrefs; health: IngestHealth[] | null }) {
  const [spots, setSpots] = useState<RecentSpot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  // Only the newest request may land: an older one (an earlier tick, or another source before
  // the key changed) finishing late must not replace what a newer one showed.
  const latest = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++latest.current;
    const current = () => mounted.current && request === latest.current;
    try {
      const rows = await loadRecentSpots(source.id);
      if (!current()) return;
      setSpots(rows);
      setError(null);
    } catch (err) {
      if (current()) setError(errorText(err, "Couldn't load recent spots."));
    }
  }, [source.id]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  useVisibleInterval(() => void refresh(), 30_000);

  const age = health?.find((h) => h.source === healthId(source))?.seconds_since_last_success;
  return (
    <ChartCard title="Recent spots" subheader="Everything ingested, before any connection filters.">
      <Stack spacing={1}>
        {error && <Alert severity="error">{error}</Alert>}
        {spots === null ? (!error && <LinearProgress />) : <SpotsTable spots={spots} dense prefs={prefs} />}
        {health && (
          <Typography variant="caption" color="text.secondary">
            {source.pollSeconds === null ? `Last contact ${relativeAge(age)}` : `Last fetch ${relativeAge(age)}, ${source.interval}`}
          </Typography>
        )}
      </Stack>
    </ChartCard>
  );
}

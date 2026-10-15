import { useState } from "react";
import { Alert, Box, Chip, LinearProgress, Stack, Typography, useMediaQuery, type Theme } from "@mui/material";
import { PageTitle } from "../layout/PageTitle";
import { BAND_PLAN } from "../lib/bandplan";
import { useVisibleInterval } from "../sources/useVisibleInterval";
import { BandStrip } from "./BandStrip";
import { bandStations, SOURCES, updatedLabel } from "./model";
import type { BandMapSource } from "./types";
import { useBandMap } from "./useBandMap";

/** Ticks on its own so the strips don't re-render every second. */
function Updated({ generatedAt }: { generatedAt: string }) {
  const [now, setNow] = useState(() => new Date());
  useVisibleInterval(() => setNow(new Date()), 1000);
  return <Typography variant="caption" color="text.secondary">{updatedLabel(generatedAt, now)}</Typography>;
}

/** Public: signed-out visitors see it in PublicShell, signed-in users in AppShell. */
export function BandMapPage() {
  const mobile = useMediaQuery((t: Theme) => t.breakpoints.down("sm"));
  const { payload, loading, error } = useBandMap();
  // The chips filter what is already loaded; they never ask the server for anything.
  const [shown, setShown] = useState<ReadonlySet<BandMapSource>>(() => new Set(SOURCES.map((s) => s.id)));
  const toggle = (id: BandMapSource) =>
    setShown((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Stack spacing={2}>
      <Box>
        <PageTitle>Band map</PageTitle>
        <Typography color="text.secondary">
          Stations spotted in the last 5 minutes, by frequency. Select a station to open its profile.
        </Typography>
      </Box>
      <Stack direction={{ xs: "column", sm: "row" }} sx={{ justifyContent: "space-between", alignItems: { sm: "center" }, gap: 1 }}>
        <Stack direction="row" sx={{ alignItems: "center", gap: 1, flexWrap: "wrap" }}>
          <Typography variant="body2" color="text.secondary">Show</Typography>
          {SOURCES.map((s) => (
            <Chip
              key={s.id}
              size="small"
              label={s.label}
              color={s.color}
              variant={shown.has(s.id) ? "filled" : "outlined"}
              aria-pressed={shown.has(s.id)}
              onClick={() => toggle(s.id)}
            />
          ))}
        </Stack>
        {payload && <Updated generatedAt={payload.generated_at} />}
      </Stack>
      <Typography variant="caption" color="text.secondary">
        Each band runs left to right by frequency. Bottom lane DX Cluster, middle POTA, top SOTA. Tap a crowded spot to see
        everyone there. Reverse Beacon Network spots aren't shown here; you'll find them on each station's profile.
      </Typography>
      {loading && <LinearProgress />}
      {error && <Alert severity="error">{error}</Alert>}
      {payload && (
        <Stack spacing={1.5}>
          {BAND_PLAN.map((plan) => (
            <BandStrip key={plan.band} plan={plan} stations={bandStations(payload, plan, shown)} shown={shown} mobile={mobile} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

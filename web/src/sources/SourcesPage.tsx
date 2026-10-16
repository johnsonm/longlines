import { useMemo, useState } from "react";
import { Alert, Box, Chip, Grid, Stack, TextField, Typography } from "@mui/material";
import { PageTitle } from "../layout/PageTitle";
import { useStats } from "../stats/useStats";
import { SOURCES, type SourceInfo } from "./sources";
import { sourceStatus } from "./status";
import { sourceRates } from "./rates";
import { SourceTile } from "./SourceTile";
import { useIngestHealth } from "./useIngestHealth";

type Filter = "all" | "connected" | "planned";
// "Not yet available" shows only while some source is planned; an empty filter would hint at nothing.
const FILTERS: [Filter, string][] = [
  ["all", "All"], ["connected", "Connected"],
  ...(SOURCES.some((s) => s.status === "planned") ? [["planned", "Not yet available"] as [Filter, string]] : []),
];

/** Search covers the tile title, short name and tagline, ignoring case and surrounding spaces. */
function matches(s: SourceInfo, query: string, filter: Filter): boolean {
  if (filter === "connected" && s.status !== "live") return false;
  if (filter === "planned" && s.status !== "planned") return false;
  const q = query.trim().toLowerCase();
  return q === "" || [s.title, s.name, s.tagline].some((t) => t.toLowerCase().includes(q));
}

export function SourcesPage() {
  const { health, error } = useIngestHealth(null);
  const { stats } = useStats();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const shown = useMemo(() => SOURCES.filter((s) => matches(s, query, filter)), [query, filter]);
  const hourly = stats?.payload.hourly ?? [];

  return (
    <Stack spacing={3}>
      <Box>
        <PageTitle>Sources</PageTitle>
        <Typography color="text.secondary">Where spots come from. Pick a source to see what it sends and what you can do with it.</Typography>
      </Box>
      {error && <Alert severity="error">{error}</Alert>}
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2} useFlexGap sx={{ alignItems: { sm: "center" }, flexWrap: "wrap" }}>
        <TextField size="small" label="Search sources" value={query} onChange={(e) => setQuery(e.target.value)} sx={{ minWidth: 220, maxWidth: 420, flexGrow: 1 }} />
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
          {FILTERS.map(([value, label]) => (
            <Chip key={value} label={label} onClick={() => setFilter(value)} aria-pressed={filter === value}
              color={filter === value ? "primary" : "default"} variant={filter === value ? "filled" : "outlined"} />
          ))}
        </Stack>
      </Stack>
      {shown.length === 0
        ? <Typography color="text.secondary">No sources match.</Typography>
        : (
          <Grid container spacing={2} data-testid="source-grid">
            {shown.map((s) => (
              <Grid key={s.id} size={{ xs: 12, sm: 6, md: 4 }}>
                <SourceTile source={s} status={sourceStatus(s, health)}
                  rates={s.statsKey ? sourceRates(hourly, s.statsKey) : null} />
              </Grid>
            ))}
          </Grid>
        )}
    </Stack>
  );
}

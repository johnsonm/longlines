import { Card, CardContent, CardHeader, Typography, useTheme } from "@mui/material";
// MUI X Charts is the MIT community package, as on the band map: no Pro components.
import { ScatterChart } from "@mui/x-charts/ScatterChart";
import { sourceColor } from "../home/colors";
import { sourceLabel, sourcesPresent, utcTime } from "./model";
import type { ActivationSpot } from "./types";

// Room either side of the first and last spot, so their marks are not cut by the plot's edge.
const PAD_MS = 2 * 60 * 1000;

/** "18:12" for epoch milliseconds, in UTC. */
function clock(ms: number): string {
  return utcTime(new Date(ms).toISOString());
}

/**
 * "Spots over time": a ScatterChart with time across and one lane per source present, top to
 * bottom in the page's source order, each in its catalog colour (sourceColor), as BandStrip draws
 * the band map. Read-only: the tooltip names the spot.
 */
export function SpotsTimeline({ spots, from, to, mobile }: { spots: ActivationSpot[]; from: string; to: string; mobile: boolean }) {
  const theme = useTheme();
  const lanes = sourcesPresent(spots);
  // The first lane on top: the y axis grows upward.
  const laneOf = (source: string) => lanes.length - 1 - lanes.indexOf(source);
  const start = Date.parse(from) - PAD_MS;
  const end = Date.parse(to) + PAD_MS;

  const series = lanes.map((source) => {
    const rows = spots.filter((s) => s.source === source);
    return {
      id: source,
      label: sourceLabel(source),
      color: sourceColor(theme, source),
      markerSize: mobile ? 5 : 4,
      data: rows.map((s, i) => ({ x: Date.parse(s.time), y: laneOf(source), id: i })),
      valueFormatter: (value: { id?: string | number }) => {
        const spot = rows[Number(value.id)];
        return spot ? `${utcTime(spot.time)} · ${spot.spotter ?? sourceLabel(source)}` : null;
      },
    };
  });

  return (
    <Card variant="outlined">
      <CardHeader
        title="Spots over time"
        slotProps={{ title: { variant: "h6" } }}
        action={<Typography variant="caption" color="text.secondary">Time (UTC)</Typography>}
      />
      <CardContent sx={{ pt: 0 }}>
        <ScatterChart
          height={40 + lanes.length * 36}
          margin={{ left: 8, right: 16, top: 8, bottom: 4 }}
          hideLegend
          xAxis={[{ min: start, max: end, height: 24, tickNumber: mobile ? 3 : 5, valueFormatter: (v: number) => clock(v) }]}
          yAxis={[{
            min: -0.5,
            max: lanes.length - 0.5,
            width: mobile ? 72 : 96,
            disableLine: true,
            disableTicks: true,
            tickInterval: lanes.map((_s, i) => i),
            valueFormatter: (v: number) => sourceLabel(lanes[lanes.length - 1 - v] ?? ""),
          }]}
          series={series}
        />
      </CardContent>
    </Card>
  );
}

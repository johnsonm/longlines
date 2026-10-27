import { useMemo, useState } from "react";
import { Card, CardContent, ListItemText, ListSubheader, Menu, MenuItem, Typography, useTheme } from "@mui/material";
import { ChartsReferenceLine } from "@mui/x-charts/ChartsReferenceLine";
import { ScatterChart } from "@mui/x-charts/ScatterChart";
import type { ScatterItemIdentifier } from "@mui/x-charts/models";
import { Link as RouterLink, useNavigate } from "react-router";
import type { BandPlan } from "../lib/bandplan";
import { lookupPath } from "../profile/format";
import { referencePath, sourceProgram } from "../references/paths";
import {
  crowdAround, crowdDetail, crowdTitle, crowdTolerance, heardLabel, mhz, segmentMarks, SOURCES, tooltipText,
} from "./model";
import type { BandMapSource, BandMapSpot } from "./types";

interface Crowd {
  stations: BandMapSpot[];
  khz: number;
  /** When the menu opened; its rows' ages count from here. */
  at: Date;
  top: number;
  left: number;
}

/**
 * One band: a card holding a ScatterChart with frequency across and one lane
 * per source. A click picks the nearest dot (the chart's Voronoi handler) and
 * opens that station's profile, or a menu of everyone within the crowd
 * tolerance when it is not alone there.
 */
export function BandStrip({ plan, stations, shown, mobile }: {
  plan: BandPlan;
  /** What bandStations() returned for this band. */
  stations: BandMapSpot[];
  shown: ReadonlySet<BandMapSource>;
  mobile: boolean;
}) {
  const theme = useTheme();
  const navigate = useNavigate();
  const [crowd, setCrowd] = useState<Crowd | null>(null);
  const byId = useMemo(() => new Map(stations.map((s) => [s.id, s])), [stations]);
  const marks = segmentMarks(plan);

  const open = (spot: BandMapSpot) => {
    setCrowd(null);
    void navigate(lookupPath(spot.base_callsign) ?? "/lookup");
  };

  const series = SOURCES.filter((src) => shown.has(src.id)).map((src) => ({
    id: src.id,
    label: src.label,
    color: theme.palette[src.color].main,
    markerSize: mobile ? 5 : 4,
    data: stations.filter((s) => s.source === src.id).map((s) => ({ x: s.frequency_khz, y: src.lane, id: s.id })),
    valueFormatter: (value: { id?: string | number }) => {
      const spot = value.id === undefined ? undefined : byId.get(Number(value.id));
      return spot ? tooltipText(spot, new Date()) : null;
    },
  }));

  return (
    <Card>
      <CardContent sx={{ pb: 0 }}>
        <Typography variant="subtitle1" component="h2"><strong>{heardLabel(plan.band, stations.length)}</strong></Typography>
        {stations.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ pb: 2 }}>Nothing heard in the last 5 minutes.</Typography>
        )}
      </CardContent>
      {stations.length > 0 && (
        <ScatterChart
          height={mobile ? 130 : 120}
          // The spec's 28px below the plot is the x axis (24) plus 4: in MUI X 9 the axis sits outside the margin.
          margin={{ left: 24, right: 28, top: 24, bottom: 4 }}
          hideLegend
          xAxis={[{ min: plan.from, max: plan.to, height: 24, tickNumber: mobile ? 4 : 8, valueFormatter: (v: number) => mhz(v) }]}
          yAxis={[{ min: -0.7, max: 2.7, position: "none" }]}
          series={series}
          onItemClick={(event: { clientX: number; clientY: number }, item: ScatterItemIdentifier) => {
            const point = series.find((s) => s.id === item.seriesId)?.data[item.dataIndex];
            const spot = point ? byId.get(point.id) : undefined;
            if (!spot) return;
            const near = crowdAround(stations, spot, crowdTolerance(plan, mobile));
            if (near.length === 1) open(spot);
            else setCrowd({ stations: near, khz: spot.frequency_khz, at: new Date(), top: event.clientY, left: event.clientX });
          }}
        >
          {marks.map((m) => (
            <ChartsReferenceLine
              key={m.x}
              x={m.x}
              label={m.label}
              labelAlign="start"
              spacing={{ x: 4, y: -18 }}
              lineStyle={{ strokeDasharray: "3 3", stroke: m.line ? theme.palette.text.disabled : "transparent" }}
              labelStyle={{ fill: theme.palette.text.secondary, fontSize: 12 }}
            />
          ))}
        </ScatterChart>
      )}
      <Menu
        open={crowd !== null}
        onClose={() => setCrowd(null)}
        anchorReference="anchorPosition"
        anchorPosition={crowd ? { top: crowd.top, left: crowd.left } : undefined}
        slotProps={{ paper: { sx: { maxHeight: 360 } } }}
      >
        {crowd && <ListSubheader>{crowdTitle(crowd.stations.length, crowd.khz)}</ListSubheader>}
        {crowd?.stations.flatMap((s) => {
          const program = sourceProgram(s.source);
          const path = s.reference && program ? referencePath(program, s.reference) : null;
          const station = (
            <MenuItem key={s.id} onClick={() => open(s)}>
              <ListItemText primary={s.callsign} secondary={crowdDetail(s, crowd.at)} />
            </MenuItem>
          );
          // The park or summit is an item of its own under the station, so the arrow keys reach it;
          // a link inside the station's item could only be clicked.
          return path === null ? [station] : [
            station,
            <MenuItem key={`${s.id}-reference`} dense component={RouterLink} to={path} onClick={() => setCrowd(null)}>
              <ListItemText inset primary={s.reference} slotProps={{ primary: { color: "primary", variant: "body2" } }} />
            </MenuItem>,
          ];
        })}
      </Menu>
    </Card>
  );
}

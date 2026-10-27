import { useState } from "react";
import { Typography, useMediaQuery, useTheme } from "@mui/material";
import type { GridColDef } from "@mui/x-data-grid";
import { fmt } from "../stats/format";
import { cellCount, cellDate, cellSources, gridLabel, heatGrid, heatScale, periodDays, periodLabel, periodTitle } from "./calendar";
import { dateLabel, plural } from "./format";
import { HeatMapCard } from "./HeatMapCard";
import type { Calendar } from "./types";

const TABLE_COLUMNS: GridColDef[] = [
  { field: "date", headerName: "Day", flex: 1, minWidth: 120, sortable: false },
  { field: "spots", headerName: "Spots", type: "number", width: 90, sortable: false },
  { field: "sources", headerName: "Sources", flex: 2, minWidth: 160, sortable: false },
];

/**
 * Spots heard per UTC day as a GitHub-style grid, one column per week, with
 * the period's totals from SQL. Hover (or tap) a day for its count; the table
 * view lists the same numbers for screen readers and phones.
 */
export function ActivityHeatMap({ callsign, calendar }: { callsign: string; calendar: Calendar }) {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down("sm"));
  const [chosen, setChosen] = useState("past");
  // Phones show the past year only, as drawn: the menu is desktop's.
  const period = calendar.periods.find((p) => p.period === (mobile ? "past" : chosen)) ?? calendar.periods[0];
  if (!period) return null;
  const grid = heatGrid(period, calendar.days);
  const scale = heatScale(grid.cells.map((c) => c.spots));
  const busiest = period.busiest;

  return (
    <HeatMapCard
      title={periodTitle(period)}
      subheader={`Spots heard for ${callsign} each day. Hover a day to see the count.`}
      figures={[
        { label: "Spots heard", value: fmt(period.spots) },
        { label: "Days on the air", value: `${fmt(period.daysOnAir)} of ${fmt(period.days)}` },
        { label: "Longest streak", value: plural(period.longestStreak, "day", "days") },
        { label: "Busiest day", value: busiest ? plural(busiest.spots, "spot", "spots") : "None", detail: busiest ? dateLabel(busiest.day) : undefined },
      ]}
      periods={mobile ? null : calendar.periods.map((p) => ({ value: p.period, label: periodLabel(p) }))}
      period={period.period}
      onPeriod={setChosen}
      grid={grid}
      gridLabel={gridLabel(period)}
      level={(c) => scale(c.spots)}
      tooltip={(c) => {
        const sources = cellSources(c.sources);
        return (
          <>
            <Typography variant="subtitle2" component="div">{cellCount(c.spots)}</Typography>
            <Typography variant="caption" component="div">{cellDate(c.day)}</Typography>
            {sources && <Typography variant="caption" component="div">{sources}</Typography>}
          </>
        );
      }}
      table={{
        rows: periodDays(period, calendar.days).map((d) => ({ id: d.day, date: dateLabel(d.day), spots: d.spots, sources: cellSources(d.sources) })),
        columns: TABLE_COLUMNS,
        noRowsLabel: "No spots",
      }}
      mobile={mobile}
    />
  );
}

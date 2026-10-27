import { useState } from "react";
import { Typography, useMediaQuery, useTheme } from "@mui/material";
import type { GridColDef, GridRenderCellParams } from "@mui/x-data-grid";
import { CallList } from "../groups/GroupStatistics";
import { cellDate, heatGrid, heatScale, periodDays } from "../profile/calendar";
import { dateLabel, plural } from "../profile/format";
import { HeatMapCard } from "../profile/HeatMapCard";
import { fmt } from "../stats/format";
import { cellActivators, gridLabel, periodLabel, periodTitle } from "./format";
import type { ReferenceCalendar } from "./types";

const TABLE_COLUMNS: GridColDef[] = [
  { field: "date", headerName: "Day", width: 130, sortable: false },
  { field: "activations", headerName: "Activations", type: "number", width: 110, sortable: false },
  {
    field: "activators", headerName: "Activators", flex: 1, minWidth: 160, sortable: false,
    renderCell: ({ value }: GridRenderCellParams<{ activators: string[] }, string[]>) => <CallList calls={value ?? []} />,
  },
];

/**
 * Activators spotted at the reference per UTC day, on the callsign profile's
 * grid. A day's shade is its activator count ranked within the period
 * (heatScale); hover or tap it for who was there.
 */
export function ReferenceHeatMap({ reference, calendar }: { reference: string; calendar: ReferenceCalendar }) {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down("sm"));
  const [chosen, setChosen] = useState("past");
  // Phones show the past year only, as drawn: the menu is desktop's.
  const period = calendar.periods.find((p) => p.period === (mobile ? "past" : chosen)) ?? calendar.periods[0];
  if (!period) return null;
  const who = new Map(calendar.days.map((d) => [d.day, d.activators]));
  const grid = heatGrid(period, calendar.days.map((d) => ({ day: d.day, spots: d.activators.length, sources: {} })));
  const scale = heatScale(grid.cells.map((c) => c.spots));
  const busiest = period.busiest;

  return (
    <HeatMapCard
      title={periodTitle(period)}
      subheader={`Activators spotted at ${reference} each day. ${mobile ? "Tap" : "Hover"} a day to see who.`}
      figures={[
        { label: "Activations", value: fmt(period.activations) },
        { label: "Days activated", value: `${fmt(period.daysActivated)} of ${fmt(period.days)}` },
        { label: "Longest streak", value: plural(period.longestStreak, "day", "days") },
        {
          label: "Busiest day",
          value: busiest ? plural(busiest.activators, "activator", "activators") : "None",
          detail: busiest ? dateLabel(busiest.day) : undefined,
        },
      ]}
      periods={mobile ? null : calendar.periods.map((p) => ({ value: p.period, label: periodLabel(p) }))}
      period={period.period}
      onPeriod={setChosen}
      grid={grid}
      gridLabel={gridLabel(period)}
      level={(c) => scale(c.spots)}
      tooltip={(c) => {
        const calls = who.get(c.day) ?? [];
        return (
          <>
            <Typography variant="subtitle2" component="div">{cellActivators(calls.length)}</Typography>
            <Typography variant="caption" component="div">{cellDate(c.day)}</Typography>
            {calls.length > 0 && <Typography variant="caption" component="div">{calls.join(", ")}</Typography>}
          </>
        );
      }}
      table={{
        rows: periodDays(period, calendar.days).map((d) => ({
          id: d.day, date: dateLabel(d.day), activations: d.activators.length, activators: d.activators,
        })),
        columns: TABLE_COLUMNS,
        noRowsLabel: "No activations",
      }}
      mobile={mobile}
    />
  );
}

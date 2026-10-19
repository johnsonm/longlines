import { useLayoutEffect, useRef, useState } from "react";
import { Box, Button, MenuItem, Stack, TextField, Tooltip, Typography, useMediaQuery, useTheme } from "@mui/material";
import { alpha } from "@mui/material/styles";
import CalendarMonthIcon from "@mui/icons-material/CalendarMonth";
import TableRowsIcon from "@mui/icons-material/TableRows";
import { DataGrid, type GridColDef } from "@mui/x-data-grid";
import { fmt } from "../stats/format";
import { ChartCard, GRID } from "../stats/parts";
import {
  cellCount, cellDate, cellSources, gridLabel, HEAT_LEVELS, heatGrid, heatScale, periodDays, periodLabel, periodTitle,
} from "./calendar";
import { dateLabel, plural } from "./format";
import type { Calendar } from "./types";

// SVG units: a 12-unit day square on a 15-unit pitch, with room for the day
// names on the left and the month names on top.
const PITCH = 15;
const CELL = 12;
const LEFT = 30;
const TOP = 16;
const DAY_NAMES = [[1, "Mon"], [3, "Wed"], [5, "Fri"]] as const;
const OPACITY = [0, 0.3, 0.5, 0.75, 1];

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
  const [table, setTable] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  // Phones show the past year only, as drawn: the menu is desktop's.
  const period = calendar.periods.find((p) => p.period === (mobile ? "past" : chosen)) ?? calendar.periods[0];
  const grid = period ? heatGrid(period, calendar.days) : null;

  // The newest weeks are on the right; a phone scrolls sideways back from them.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [period, table, mobile]);

  if (!period || !grid) return null;
  const level = heatScale(grid.cells.map((c) => c.spots));
  const fill = (level: number) =>
    level === 0 ? theme.palette.action.hover : alpha(theme.palette.primary.main, OPACITY[level]!);
  const width = LEFT + grid.weeks * PITCH;
  const height = TOP + 7 * PITCH;
  const busiest = period.busiest;

  return (
    <ChartCard title={periodTitle(period)} subheader={`Spots heard for ${callsign} each day. Hover a day to see the count.`}>
      <Stack direction="row" spacing={2} useFlexGap sx={{ justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", mb: 1.5 }}>
        <Stack direction="row" spacing={3} useFlexGap sx={{ flexWrap: "wrap" }}>
          <Figure label="Spots heard" value={fmt(period.spots)} />
          <Figure label="Days on the air" value={`${fmt(period.daysOnAir)} of ${fmt(period.days)}`} />
          <Figure label="Longest streak" value={plural(period.longestStreak, "day", "days")} />
          <Figure
            label="Busiest day"
            value={busiest ? plural(busiest.spots, "spot", "spots") : "None"}
            detail={busiest ? dateLabel(busiest.day) : undefined}
          />
        </Stack>
        {!mobile && (
          <TextField select size="small" label="Period" value={period.period} onChange={(e) => setChosen(e.target.value)} sx={{ width: 190 }}>
            {calendar.periods.map((p) => <MenuItem key={p.period} value={p.period}>{periodLabel(p)}</MenuItem>)}
          </TextField>
        )}
      </Stack>

      {table ? (
        <DataGrid
          {...GRID}
          hideFooter={false}
          pageSizeOptions={[10]}
          initialState={{ pagination: { paginationModel: { pageSize: 10 } } }}
          localeText={{ noRowsLabel: "No spots" }}
          rows={periodDays(period, calendar.days).map((d) => ({ id: d.day, date: dateLabel(d.day), spots: d.spots, sources: cellSources(d.sources) }))}
          columns={TABLE_COLUMNS}
        />
      ) : (
        <Box ref={scroller} sx={{ overflowX: mobile ? "auto" : "visible" }}>
          <Box
            component="svg"
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={gridLabel(period)}
            sx={{ width: "100%", minWidth: mobile ? 700 : undefined, height: "auto", display: "block" }}
          >
            {grid.months.map((m) => (
              <text key={m.col} x={LEFT + m.col * PITCH} y={10} fontSize={10} fill={theme.palette.text.secondary}>{m.label}</text>
            ))}
            {DAY_NAMES.map(([row, name]) => (
              <text key={name} x={0} y={TOP + row * PITCH + CELL - 2} fontSize={10} fill={theme.palette.text.secondary}>{name}</text>
            ))}
            {grid.cells.map((c) => {
              const sources = cellSources(c.sources);
              return (
                <Tooltip
                  key={c.day}
                  enterTouchDelay={0}
                  title={
                    <>
                      <Typography variant="subtitle2" component="div">{cellCount(c.spots)}</Typography>
                      <Typography variant="caption" component="div">{cellDate(c.day)}</Typography>
                      {sources && <Typography variant="caption" component="div">{sources}</Typography>}
                    </>
                  }
                >
                  <rect x={LEFT + c.col * PITCH} y={TOP + c.row * PITCH} width={CELL} height={CELL} rx={2} fill={fill(level(c.spots))} />
                </Tooltip>
              );
            })}
          </Box>
        </Box>
      )}

      <Stack direction="row" spacing={2} useFlexGap sx={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", mt: 1.5 }}>
        <Typography variant="caption" color="text.secondary">
          {mobile && !table ? "Scroll sideways for earlier months." : ""}
        </Typography>
        <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
          <Typography variant="caption" color="text.secondary">Less</Typography>
          <Box component="svg" viewBox="0 0 76 12" aria-hidden sx={{ width: 76, height: 12 }}>
            {Array.from({ length: HEAT_LEVELS + 1 }, (_, level) => (
              <rect key={level} x={level * 16} width={12} height={12} rx={2} fill={fill(level)} />
            ))}
          </Box>
          <Typography variant="caption" color="text.secondary">More</Typography>
        </Stack>
      </Stack>
      <Box sx={{ mt: 0.5 }}>
        <Button size="small" startIcon={table ? <CalendarMonthIcon /> : <TableRowsIcon />} onClick={() => setTable(!table)}>
          {table ? "View as heat map" : "View as table"}
        </Button>
      </Box>
    </ChartCard>
  );
}

function Figure({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div>
      <Typography variant="overline" color="text.secondary" component="div">{label}</Typography>
      <Typography variant="h6" component="div">{value}</Typography>
      {detail && <Typography variant="caption" color="text.secondary" component="div">{detail}</Typography>}
    </div>
  );
}

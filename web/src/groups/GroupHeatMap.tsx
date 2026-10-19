import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, Button, Stack, Tooltip, Typography, useMediaQuery, useTheme } from "@mui/material";
import { alpha } from "@mui/material/styles";
import CalendarMonthIcon from "@mui/icons-material/CalendarMonth";
import TableRowsIcon from "@mui/icons-material/TableRows";
import { DataGrid, type GridColDef } from "@mui/x-data-grid";
import { ChartCard, GRID } from "../stats/parts";
import { cellCount, cellDate, heatGrid, periodDays } from "../profile/calendar";
import { dateLabel, plural } from "../profile/format";
import type { CalendarPeriod } from "../profile/types";
import { GROUP_HEAT_LEVELS, groupHeatLevel } from "./stats/model";
import type { GroupStatistics } from "./stats/types";

// The profile heat map's SVG units (ActivityHeatMap): a 12-unit day square on a 15-unit pitch.
const PITCH = 15;
const CELL = 12;
const LEFT = 30;
const TOP = 16;
const DAY_NAMES = [[1, "Mon"], [3, "Wed"], [5, "Fri"]] as const;
const OPACITY = [0, 0.3, 0.5, 0.75, 1];
const DAY_MS = 86_400_000;

const TABLE_COLUMNS: GridColDef[] = [
  { field: "date", headerName: "Day", flex: 1, minWidth: 120, sortable: false },
  { field: "spots", headerName: "Spots", type: "number", width: 90, sortable: false },
  { field: "members", headerName: "Members on the air", type: "number", width: 170, sortable: false },
];

/**
 * Club spots per UTC day over the past 365 days ending on the payload's day,
 * on the profile's grid helpers with the club's fixed levels (spec, decision
 * 17). Hover (or tap) a day for its count; the table lists the same numbers.
 */
export function GroupHeatMap({ stats }: { stats: GroupStatistics }) {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down("sm"));
  const [table, setTable] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  const { period, days, members } = useMemo(() => {
    const today = Date.parse(`${stats.generatedAt.slice(0, 10)}T00:00:00Z`);
    const from = new Date(today - 364 * DAY_MS).toISOString().slice(0, 10);
    // heatGrid and periodDays read only `from` and `days`.
    const p: CalendarPeriod = {
      period: "past", from, to: stats.generatedAt.slice(0, 10), days: 365, spots: 0, daysOnAir: 0, longestStreak: 0, busiest: null,
    };
    return {
      period: p,
      days: stats.calendar.map((d) => ({ day: d.day, spots: d.spots, sources: {} })),
      members: new Map(stats.calendar.map((d) => [d.day, d.members])),
    };
  }, [stats]);
  const grid = heatGrid(period, days);

  // The newest weeks are on the right; a phone scrolls sideways back from them.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [table, mobile]);

  const fill = (level: number) =>
    level === 0 ? theme.palette.action.hover : alpha(theme.palette.primary.main, OPACITY[level]!);
  const width = LEFT + grid.weeks * PITCH;
  const height = TOP + 7 * PITCH;
  const onAir = (day: string) => plural(members.get(day) ?? 0, "member", "members") + " on the air";

  return (
    <ChartCard
      title="Club activity over the past year"
      subheader="Spots heard each day for all members combined. Hover a day for the count. Ignores the period above."
    >
      {table ? (
        <DataGrid
          {...GRID}
          hideFooter={false}
          pageSizeOptions={[10]}
          initialState={{ pagination: { paginationModel: { pageSize: 10 } } }}
          localeText={{ noRowsLabel: "No spots" }}
          rows={periodDays(period, days).map((d) => ({ id: d.day, date: dateLabel(d.day), spots: d.spots, members: members.get(d.day) ?? 0 }))}
          columns={TABLE_COLUMNS}
        />
      ) : (
        <Box ref={scroller} sx={{ overflowX: mobile ? "auto" : "visible" }}>
          <Box
            component="svg"
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label="Heat map of club spots per day for the past 365 days. A table view has the same numbers."
            sx={{ width: "100%", minWidth: mobile ? 700 : undefined, height: "auto", display: "block" }}
          >
            {grid.months.map((m) => (
              <text key={m.col} x={LEFT + m.col * PITCH} y={10} fontSize={10} fill={theme.palette.text.secondary}>{m.label}</text>
            ))}
            {DAY_NAMES.map(([row, name]) => (
              <text key={name} x={0} y={TOP + row * PITCH + CELL - 2} fontSize={10} fill={theme.palette.text.secondary}>{name}</text>
            ))}
            {grid.cells.map((c) => (
              <Tooltip
                key={c.day}
                enterTouchDelay={0}
                title={
                  <>
                    <Typography variant="subtitle2" component="div">{cellCount(c.spots)}</Typography>
                    <Typography variant="caption" component="div">{cellDate(c.day)}</Typography>
                    {c.spots > 0 && <Typography variant="caption" component="div">{onAir(c.day)}</Typography>}
                  </>
                }
              >
                <rect
                  data-testid="heat-cell" data-day={c.day} data-level={groupHeatLevel(c.spots)}
                  x={LEFT + c.col * PITCH} y={TOP + c.row * PITCH} width={CELL} height={CELL} rx={2} fill={fill(groupHeatLevel(c.spots))}
                />
              </Tooltip>
            ))}
          </Box>
        </Box>
      )}

      <Stack direction="row" spacing={2} useFlexGap sx={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", mt: 1.5 }}>
        <Typography variant="caption" color="text.secondary">
          {"Club spots per day: none, 1 to 99, 100 to 199, 200 to 399, 400 or more."}
          {mobile && !table ? " Scroll sideways for earlier months." : ""}
        </Typography>
        <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
          <Typography variant="caption" color="text.secondary">Less</Typography>
          <Box component="svg" viewBox="0 0 76 12" aria-hidden sx={{ width: 76, height: 12 }}>
            {Array.from({ length: GROUP_HEAT_LEVELS + 1 }, (_, level) => (
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

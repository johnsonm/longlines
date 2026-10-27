import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Box, Button, MenuItem, Stack, TextField, Tooltip, Typography, useTheme } from "@mui/material";
import { alpha } from "@mui/material/styles";
import CalendarMonthIcon from "@mui/icons-material/CalendarMonth";
import TableRowsIcon from "@mui/icons-material/TableRows";
import { DataGrid, type GridColDef, type GridValidRowModel } from "@mui/x-data-grid";
import { ChartCard, GRID } from "../stats/parts";
import { HEAT_LEVELS, type HeatCell, type HeatGrid } from "./calendar";

// SVG units: a 12-unit day square on a 15-unit pitch, with room for the day
// names on the left and the month names on top.
const PITCH = 15;
const CELL = 12;
const LEFT = 30;
const TOP = 16;
const DAY_NAMES = [[1, "Mon"], [3, "Wed"], [5, "Fri"]] as const;
const OPACITY = [0, 0.3, 0.5, 0.75, 1];

export interface HeatFigure {
  label: string;
  value: string;
  detail?: string;
}

export interface HeatMapCardProps {
  title: string;
  subheader: string;
  figures: HeatFigure[];
  /** The Period menu's choices; null leaves the menu out (phones show the past year only). */
  periods: { value: string; label: string }[] | null;
  period: string;
  onPeriod: (period: string) => void;
  grid: HeatGrid;
  gridLabel: string;
  /** The cell's shade, 0 (none) to HEAT_LEVELS, relative to the period (heatScale). */
  level: (cell: HeatCell) => number;
  tooltip: (cell: HeatCell) => ReactNode;
  table: { rows: GridValidRowModel[]; columns: GridColDef[]; noRowsLabel: string };
  mobile: boolean;
}

/**
 * The year heat map card shared by callsign and reference profiles: a
 * GitHub-style grid, one column per week, with the period's figures from SQL
 * above it and a table view with the same numbers for screen readers and
 * phones. What a day counts and says is the caller's.
 */
export function HeatMapCard(props: HeatMapCardProps) {
  const { title, subheader, figures, periods, period, onPeriod, grid, gridLabel, level, tooltip, table, mobile } = props;
  const theme = useTheme();
  const [showTable, setShowTable] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  // The newest weeks are on the right; a phone scrolls sideways back from them.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [period, showTable, mobile]);

  const fill = (n: number) => (n === 0 ? theme.palette.action.hover : alpha(theme.palette.primary.main, OPACITY[n]!));
  const width = LEFT + grid.weeks * PITCH;
  const height = TOP + 7 * PITCH;

  return (
    <ChartCard title={title} subheader={subheader}>
      <Stack direction="row" spacing={2} useFlexGap sx={{ justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", mb: 1.5 }}>
        <Stack direction="row" spacing={3} useFlexGap sx={{ flexWrap: "wrap" }}>
          {figures.map((f) => <Figure key={f.label} {...f} />)}
        </Stack>
        {periods && (
          <TextField select size="small" label="Period" value={period} onChange={(e) => onPeriod(e.target.value)} sx={{ width: 190 }}>
            {periods.map((p) => <MenuItem key={p.value} value={p.value}>{p.label}</MenuItem>)}
          </TextField>
        )}
      </Stack>

      {showTable ? (
        <DataGrid
          {...GRID}
          hideFooter={false}
          pageSizeOptions={[10]}
          initialState={{ pagination: { paginationModel: { pageSize: 10 } } }}
          localeText={{ noRowsLabel: table.noRowsLabel }}
          rows={table.rows}
          columns={table.columns}
        />
      ) : (
        <Box ref={scroller} sx={{ overflowX: mobile ? "auto" : "visible" }}>
          <Box
            component="svg"
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={gridLabel}
            sx={{ width: "100%", minWidth: mobile ? 700 : undefined, height: "auto", display: "block" }}
          >
            {grid.months.map((m) => (
              <text key={m.col} x={LEFT + m.col * PITCH} y={10} fontSize={10} fill={theme.palette.text.secondary}>{m.label}</text>
            ))}
            {DAY_NAMES.map(([row, name]) => (
              <text key={name} x={0} y={TOP + row * PITCH + CELL - 2} fontSize={10} fill={theme.palette.text.secondary}>{name}</text>
            ))}
            {grid.cells.map((c) => (
              <Tooltip key={c.day} enterTouchDelay={0} title={tooltip(c)}>
                <rect x={LEFT + c.col * PITCH} y={TOP + c.row * PITCH} width={CELL} height={CELL} rx={2} fill={fill(level(c))} />
              </Tooltip>
            ))}
          </Box>
        </Box>
      )}

      <Stack direction="row" spacing={2} useFlexGap sx={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", mt: 1.5 }}>
        <Typography variant="caption" color="text.secondary">
          {mobile && !showTable ? "Scroll sideways for earlier months." : ""}
        </Typography>
        <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
          <Typography variant="caption" color="text.secondary">Less</Typography>
          <Box component="svg" viewBox="0 0 76 12" aria-hidden sx={{ width: 76, height: 12 }}>
            {Array.from({ length: HEAT_LEVELS + 1 }, (_, n) => (
              <rect key={n} x={n * 16} width={12} height={12} rx={2} fill={fill(n)} />
            ))}
          </Box>
          <Typography variant="caption" color="text.secondary">More</Typography>
        </Stack>
      </Stack>
      <Box sx={{ mt: 0.5 }}>
        <Button size="small" startIcon={showTable ? <CalendarMonthIcon /> : <TableRowsIcon />} onClick={() => setShowTable(!showTable)}>
          {showTable ? "View as heat map" : "View as table"}
        </Button>
      </Box>
    </ChartCard>
  );
}

function Figure({ label, value, detail }: HeatFigure) {
  return (
    <div>
      <Typography variant="overline" color="text.secondary" component="div">{label}</Typography>
      <Typography variant="h6" component="div">{value}</Typography>
      {detail && <Typography variant="caption" color="text.secondary" component="div">{detail}</Typography>}
    </div>
  );
}

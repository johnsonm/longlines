import { Stack, Typography, useTheme } from "@mui/material";
import { LineChart } from "@mui/x-charts";
import type { MarkColor, Volume } from "./sources";
import { formatHour, formatRate, rateUnitShort, type Rates } from "./rates";

const DAY_LABEL = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** Seven days of hourly rates; the busiest hour is marked in the error colour. */
export function RateChart({ rates, volume, color }: { rates: Rates; volume: Volume; color: MarkColor }) {
  const theme = useTheme();
  const hours = rates.hours.map((h) => new Date(h));
  const midnights = hours.filter((d) => d.getUTCHours() === 0);
  const peakIndex = rates.hours.indexOf(rates.peakHour);
  const unit = rateUnitShort(volume);
  const line = color === "default" ? theme.palette.grey[500] : theme.palette[color].main;
  const label = (v: number | null) => (v === null ? "" : `${formatRate(v)} ${unit}`);
  return (
    <Stack spacing={1}>
      <Typography variant="subtitle2">
        Peak {formatRate(rates.peak)} {unit}, {formatHour(rates.peakHour)}
      </Typography>
      <LineChart
        height={220}
        hideLegend
        skipAnimation
        xAxis={[{
          scaleType: "time",
          data: hours,
          tickInterval: midnights,
          valueFormatter: (d: Date, ctx) => (ctx.location === "tick" ? DAY_LABEL.format(d) : formatHour(d.toISOString())),
        }]}
        yAxis={[{ min: 0, width: 48 }]}
        series={[
          { label: "Rate", data: rates.series, area: true, showMark: false, color: line, valueFormatter: label },
          { label: "Peak", data: rates.series.map((v, i) => (i === peakIndex ? v : null)), showMark: true, color: theme.palette.error.main, valueFormatter: label },
        ]}
      />
    </Stack>
  );
}

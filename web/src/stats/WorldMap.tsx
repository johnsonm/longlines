import { useId } from "react";
import { Box, Stack, Tooltip, Typography, useTheme } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { countryName } from "./countries";
import { COUNTRY_SHAPES, WORLD_VIEWBOX } from "./countryShapes";
import { countryDetail, countryTotal, fmt, logFillOpacity } from "./format";
import type { CountrySpots } from "./types";

const NONE: CountrySpots = { code: "", pota: 0, sota: 0, wwff: 0, dx: 0, rbn: 0 };

/**
 * Choropleth of spots per country on a log scale, the world counterpart of
 * UsStateMap. Static: the only interaction is the per-country tooltip (total,
 * then each source), which also works on tap. Countries too small for the
 * 1:110m atlas are not drawn; the list beside the map still names them.
 */
export function WorldMap({ countries }: { countries: CountrySpots[] }) {
  const theme = useTheme();
  const gradientId = useId();
  const byCode = new Map(countries.map((c) => [c.code, c]));
  const max = Math.max(0, ...countries.map(countryTotal));
  const fill = (value: number) => {
    const a = logFillOpacity(value, max);
    return a === 0 ? theme.palette.action.hover : alpha(theme.palette.primary.main, a);
  };

  return (
    <Stack spacing={1}>
      <Box
        component="svg"
        viewBox={WORLD_VIEWBOX}
        role="img"
        aria-label="Map of spots by country"
        sx={{ width: "100%", height: "auto", display: "block" }}
      >
        {COUNTRY_SHAPES.map((s, i) => {
          const c = byCode.get(s.code) ?? NONE;
          const total = countryTotal(c);
          const title = (
            <>
              <Box component="span" sx={{ display: "block" }}>{`${countryName(s.code)}: ${fmt(total)} spots`}</Box>
              {total > 0 && <Box component="span" sx={{ display: "block" }}>{countryDetail(c)}</Box>}
            </>
          );
          return (
            <Tooltip key={i} title={title} followCursor enterTouchDelay={0}>
              <path d={s.d} fill={fill(total)} stroke={theme.palette.background.paper} strokeWidth={0.5} />
            </Tooltip>
          );
        })}
      </Box>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <Typography variant="caption" color="text.secondary">0</Typography>
        <Box component="svg" viewBox="0 0 200 10" preserveAspectRatio="none" aria-hidden sx={{ width: 160, height: 10 }}>
          <defs>
            <linearGradient id={gradientId}>
              <stop offset="0%" stopColor={alpha(theme.palette.primary.main, 0.12)} />
              <stop offset="100%" stopColor={theme.palette.primary.main} />
            </linearGradient>
          </defs>
          <rect width="200" height="10" rx="2" fill={`url(#${gradientId})`} />
        </Box>
        <Typography variant="caption" color="text.secondary">{fmt(max)} spots</Typography>
      </Stack>
    </Stack>
  );
}

import { Box, Stack, Tooltip, Typography, useTheme } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { ChartCard } from "../stats/parts";
import { STATE_SHAPES } from "../stats/stateShapes";
import { heardGeometry, MAP_HEIGHT, MAP_WIDTH } from "./geometry";
import { heardSentence, LOCATION_UNKNOWN, namesLabel, referencesLabel } from "./model";
import type { SpottedActivation } from "./types";

/** The map's accessible name: where the lines run from and to. */
function mapLabel(a: SpottedActivation, lines: number): string {
  const from = namesLabel(a.referenceNames.slice(0, 1)) || referencesLabel(a.references);
  if (lines === 0) return `Map of the states where ${a.callsign} was heard`;
  return `Lines from ${from} to ${lines} ${lines === 1 ? "state" : "states"} where ${a.callsign} was heard`;
}

/**
 * "Where KK4PWJ was heard": us-atlas's states (UsStateMap's fills and strokes) with the
 * reference's own states shaded, every heard state shaded lighter, and one line from the
 * reference to each other heard state. Countries are words in the caption only. Every
 * coordinate is SQL's (geometry.ts only projects); colours come from the theme, so dark mode
 * just works. A plain SVG with MUI tooltips, never a chart library.
 */
export function HeardMap({ activation }: { activation: SpottedActivation }) {
  const theme = useTheme();
  const g = heardGeometry(activation);
  const primary = theme.palette.primary.main;
  const fill = (code: string) => {
    if (g.home.includes(code)) return alpha(primary, 0.5);
    if (g.heard.includes(code)) return alpha(primary, 0.16);
    return theme.palette.action.hover;
  };
  const spotsIn = new Map(activation.heard.filter((p) => p.kind === "state").map((p) => [p.code, p.spots]));
  const label = (name: string, code: string) => {
    const spots = spotsIn.get(code);
    return spots ? `${name}: ${spots} ${spots === 1 ? "spot" : "spots"}` : name;
  };

  return (
    <ChartCard title={`Where ${activation.callsign} was heard`}>
      <Stack spacing={1.5}>
        <Box
          component="svg"
          viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
          role="img"
          aria-label={mapLabel(activation, g.lines.length)}
          sx={{ width: "100%", height: "auto", display: "block" }}
        >
          {STATE_SHAPES.map((s) => (
            <Tooltip key={s.code} title={label(s.name, s.code)} followCursor enterTouchDelay={0}>
              <path d={s.d} fill={fill(s.code)} stroke={theme.palette.background.paper} strokeWidth={1} />
            </Tooltip>
          ))}
          {g.origin && (
            <g data-testid="heard-lines">
              {g.lines.map((l) => (
                <line
                  key={l.code}
                  x1={g.origin?.x}
                  y1={g.origin?.y}
                  x2={l.x}
                  y2={l.y}
                  stroke={primary}
                  strokeOpacity={0.55}
                  strokeWidth={2}
                />
              ))}
              {g.lines.map((l) => (
                <Tooltip key={l.code} title={label(l.name, l.code)} enterTouchDelay={0}>
                  <g>
                    <circle cx={l.x} cy={l.y} r={6} fill={primary} />
                    <text x={l.x + 9} y={l.y - 6} fontSize={18} fill={theme.palette.text.secondary}>{l.code}</text>
                  </g>
                </Tooltip>
              ))}
              <circle cx={g.origin.x} cy={g.origin.y} r={10} fill={primary} stroke={theme.palette.background.paper} strokeWidth={3} />
              <text x={g.origin.x + 14} y={g.origin.y + 24} fontSize={18} fontWeight={500} fill={theme.palette.text.primary}>
                {referencesLabel(activation.references)}
              </text>
            </g>
          )}
        </Box>
        <Typography variant="body2" color="text.secondary">{heardSentence(activation.heard)}</Typography>
        {!activation.location && <Typography variant="body2" color="text.secondary">{LOCATION_UNKNOWN}</Typography>}
      </Stack>
    </ChartCard>
  );
}

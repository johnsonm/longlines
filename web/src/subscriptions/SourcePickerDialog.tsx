import { useState } from "react";
import {
  Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Paper, Radio, RadioGroup, Stack, Typography,
} from "@mui/material";
import { useStats } from "../stats/useStats";
import { useTour } from "../tour/hooks";
import { LIVE_SOURCES, SOURCES, type SourceInfo } from "../sources/sources";
import { SourceMark } from "../sources/SourceMark";
import { formatRate, RATE_UNIT_SHORT, sourceRates } from "../sources/rates";

// Planned sources that will alert are listed, disabled, so people can see what is coming.
const PLANNED = SOURCES.filter((s) => s.status === "planned" && s.alerts);

function caption(source: SourceInfo): string {
  return source.volume === "high" ? "High volume. Needs a callsign filter" : source.tagline;
}

interface Props {
  open: boolean;
  fullScreen: boolean;
  onClose: () => void;
  onContinue: (source: string) => void;
}

export function SourcePickerDialog({ open, fullScreen, onClose, onContinue }: Props) {
  const [picked, setPicked] = useState(LIVE_SOURCES[0]?.id ?? "");
  const { stats } = useStats();
  const { active: tourActive } = useTour();

  const rate = (s: SourceInfo): string | null => {
    const rates = s.statsKey && stats ? sourceRates(stats.payload.hourly, s.statsKey) : null;
    return rates ? `${formatRate(rates.average)} ${RATE_UNIT_SHORT}` : null;
  };

  const row = (s: SourceInfo, live: boolean) => (
    <Paper key={s.id} variant="outlined">
      <FormControlLabel
        value={s.id} disabled={!live} labelPlacement="start"
        control={<Radio />}
        sx={{ m: 0, px: 2, py: 1.5, width: "100%", boxSizing: "border-box" }}
        slotProps={{ typography: { component: "div", sx: { flexGrow: 1, minWidth: 0 } } }}
        label={
          <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
            <SourceMark source={s} />
            <Box sx={{ flexGrow: 1, minWidth: 0 }}>
              <Typography variant="subtitle2">{s.title}</Typography>
              <Typography variant="caption" color="text.secondary">{caption(s)}</Typography>
            </Box>
            {live
              ? <Typography variant="body2" color="text.secondary" sx={{ flexShrink: 0 }}>{rate(s)}</Typography>
              : <Chip size="small" label="Not yet available" />}
          </Stack>
        }
      />
    </Paper>
  );

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" fullScreen={fullScreen} disableEnforceFocus={tourActive}>
      <DialogTitle>New subscription</DialogTitle>
      <DialogContent>
        <Typography variant="subtitle1">Pick your source</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          A subscription uses one source. You can add destinations and a filter next.
        </Typography>
        <RadioGroup aria-label="Source" value={picked} onChange={(e) => setPicked(e.target.value)}>
          <Stack spacing={1}>
            {LIVE_SOURCES.map((s) => row(s, true))}
            {PLANNED.map((s) => row(s, false))}
          </Stack>
        </RadioGroup>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!picked} onClick={() => onContinue(picked)} data-tour="source-continue">Continue</Button>
      </DialogActions>
    </Dialog>
  );
}

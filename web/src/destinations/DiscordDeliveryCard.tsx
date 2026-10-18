import { Alert, Card, CardContent, CardHeader, MenuItem, Stack, TextField } from "@mui/material";
import type { DiscordSettings } from "../lib/api";
import { BATCH_OPTIONS } from "./discordModel";

interface Props {
  settings: DiscordSettings;
  onChange: (patch: Partial<DiscordSettings>) => void;
}

/** The Discord editor's Delivery card: the timed grouping select and the rate-limit note. No pause row (spec decision 9). */
export function DiscordDeliveryCard({ settings, onChange }: Props) {
  return (
    <Card variant="outlined">
      <CardHeader title="Delivery" subheader="How messages are sent" slotProps={{ title: { variant: "subtitle1" } }} />
      <CardContent sx={{ pt: 0 }}>
        <Stack spacing={2.5}>
          <TextField
            select label="Messages" value={settings.batch_seconds} fullWidth
            onChange={(e) => onChange({ batch_seconds: Number(e.target.value) })}
            helperText="Or group spots into one message every 10, 30 or 60 seconds, up to 10 spots each."
          >
            {BATCH_OPTIONS.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
          </TextField>
          <Alert severity="info">
            Discord allows about 30 messages a minute per webhook. If a connection is busier than that, spots are grouped automatically so none are
            dropped.
          </Alert>
        </Stack>
      </CardContent>
    </Card>
  );
}

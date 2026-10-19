import { Card, CardContent, CardHeader, MenuItem, Stack, TextField } from "@mui/material";
import type { WebhookSettings } from "../lib/api";
import { SettingSwitch } from "./SettingSwitch";
import { PAUSE_AFTER, REQUEST_OPTIONS, requestsHelper, RETRY_POLICIES } from "./webhookModel";

export interface WebhookDeliveryCardProps {
  settings: WebhookSettings;
  onChange: (patch: Partial<WebhookSettings>) => void;
}

/**
 * Page 7's Delivery card: one request per spot or grouped, the retry policy,
 * and the pause switch (on is PAUSE_AFTER failures, off is null). The
 * schedules, the hold and the pause itself are SQL's.
 */
export function WebhookDeliveryCard({ settings, onChange }: WebhookDeliveryCardProps) {
  return (
    <Card variant="outlined">
      <CardHeader
        title="Delivery" subheader="How requests are sent and what happens when they fail" slotProps={{ title: { variant: "subtitle1" } }}
      />
      <CardContent sx={{ pt: 0 }}>
        <Stack spacing={2.5}>
          <TextField
            select label="Requests" value={settings.batch_seconds} fullWidth helperText={requestsHelper(settings.batch_seconds)}
            onChange={(e) => onChange({ batch_seconds: Number(e.target.value) })}
          >
            {REQUEST_OPTIONS.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
          </TextField>
          <TextField
            select label="Retry a failed request" value={settings.retry_policy} fullWidth
            helperText="A request fails on a timeout after 10 seconds or any status other than 2xx."
            onChange={(e) => onChange({ retry_policy: e.target.value as WebhookSettings["retry_policy"] })}
          >
            {RETRY_POLICIES.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
          </TextField>
          <SettingSwitch
            label="Pause this destination after repeated failures"
            help={`After ${PAUSE_AFTER} failed requests in a row, deliveries stop. Turn it back on here.`}
            ariaLabel="Pause after repeated failures"
            checked={settings.pause_after_failures !== null}
            onChange={(on) => onChange({ pause_after_failures: on ? PAUSE_AFTER : null })}
          />
        </Stack>
      </CardContent>
    </Card>
  );
}

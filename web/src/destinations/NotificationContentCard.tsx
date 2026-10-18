import { Button, Card, CardContent, CardHeader, Grid, MenuItem, Stack, TextField } from "@mui/material";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import type { PushSettings } from "../lib/api";
import { FieldPicker } from "./FieldPicker";
import { SettingSwitch } from "./SettingSwitch";
import { BODY_MAX, DEFAULT_SETTINGS, PUSH_FIELDS, SEPARATORS, TAP_TARGETS, TITLE_MAX, TITLE_MIN } from "./pushModel";

interface Props {
  settings: PushSettings;
  onChange: (patch: Partial<PushSettings>) => void;
}

/** Page 5's Notification content card, as redrawn 2026-10-16: field picks, labels, the body joiner, the tap target and action buttons. */
export function NotificationContentCard({ settings, onChange }: Props) {
  return (
    <Card variant="outlined">
      <CardHeader
        title="Notification content" subheader="Choose which fields appear and in what order. Notifications cannot contain custom text."
        slotProps={{ title: { variant: "subtitle1" } }}
      />
      <CardContent sx={{ pt: 0 }}>
        <Stack spacing={3}>
          <Grid container spacing={3}>
            <Grid size={{ xs: 12, sm: 6 }}>
              <FieldPicker
                heading="Title" fields={settings.title_fields} all={PUSH_FIELDS} min={TITLE_MIN} max={TITLE_MAX}
                helper="Shown in bold. Phones cut off long titles." onChange={(title_fields) => onChange({ title_fields })}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <FieldPicker
                heading="Body" fields={settings.body_fields} all={PUSH_FIELDS} min={0} max={BODY_MAX}
                helper="Place name is the park or summit." onChange={(body_fields) => onChange({ body_fields })}
              />
            </Grid>
          </Grid>
          <SettingSwitch
            label="Show field names" help="Adds a label before each value, such as State: NC."
            checked={settings.show_field_names} onChange={(on) => onChange({ show_field_names: on })}
          />
          <TextField
            select label="Separate body fields with" value={settings.body_separator} fullWidth
            onChange={(e) => onChange({ body_separator: e.target.value as PushSettings["body_separator"] })}
            helperText="If a spot does not have a field, that field is skipped."
          >
            {SEPARATORS.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
          </TextField>
          <TextField
            select label="When tapped, open" value={settings.tap_target} fullWidth
            onChange={(e) => onChange({ tap_target: e.target.value as PushSettings["tap_target"] })}
          >
            {TAP_TARGETS.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
          </TextField>
          <SettingSwitch
            label="Show action buttons" help="Open profile, Open on the source site."
            checked={settings.action_buttons} onChange={(on) => onChange({ action_buttons: on })}
          />
          <div>
            <Button
              size="small" startIcon={<RestartAltIcon />}
              onClick={() => onChange({ title_fields: [...DEFAULT_SETTINGS.title_fields], body_fields: [...DEFAULT_SETTINGS.body_fields] })}
            >
              Reset to default fields
            </Button>
          </div>
        </Stack>
      </CardContent>
    </Card>
  );
}

import { Box, Button, Card, CardContent, CardHeader, Grid, MenuItem, Paper, Stack, TextField, Typography } from "@mui/material";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import type { WebhookSettings } from "../lib/api";
import { FieldPicker } from "./FieldPicker";
import type { Option } from "./fieldList";
import {
  defaultFields, FIELDS_MAX, FIELDS_MIN, FREQUENCY_UNITS, KEY_STYLES, missingHelper, MISSING_VALUES, TIME_FORMATS, timeExample, WEBHOOK_FIELDS,
  webhookKey,
} from "./webhookModel";

export interface WebhookPayloadCardProps {
  settings: WebhookSettings;
  onChange: (patch: Partial<WebhookSettings>) => void;
}

const COMMENT_NOTE = "Comment is text typed by the person who spotted, so treat it as untrusted. It is sent as a quoted JSON string, never as markup.";

/** A bare <code> keeps the browser's monospace font; MUI 9 has no fontFamily prop. */
function Key({ children }: { children: string }) {
  return <Box component="code">{children}</Box>;
}

interface SelectProps<T extends string> {
  label: string;
  value: T;
  options: Option<T>[];
  helper: string;
  onChange: (value: T) => void;
}

function SettingSelect<T extends string>({ label, value, options, helper, onChange }: SelectProps<T>) {
  return (
    <TextField select label={label} value={value} fullWidth helperText={helper} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
    </TextField>
  );
}

/**
 * Page 7's Payload card: the fixed envelope, the ordered pick of spot fields
 * with each one's key under the current style and unit, and the four
 * selects. Keys are shown for reference only; SQL names and renders every
 * key of the preview and the request.
 */
export function WebhookPayloadCard({ settings, onChange }: WebhookPayloadCardProps) {
  const keyOf = (id: WebhookSettings["fields"][number]) => webhookKey(id, settings.key_style, settings.frequency_unit);
  return (
    <Card variant="outlined">
      <CardHeader
        title="Payload"
        subheader="Choose which fields are in each request and in what order. Key names are fixed, and you cannot add custom fields or text."
        slotProps={{ title: { variant: "subtitle1" } }}
      />
      <CardContent sx={{ pt: 0 }}>
        <Stack spacing={3}>
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="subtitle2" component="h3" gutterBottom>Always sent</Typography>
            <Typography variant="body2" color="text.secondary">
              <Key>delivery_id</Key> identifies the delivery, so you can spot a retry. <Key>connection</Key> names the connection that matched. Spot
              fields go inside <Key>spot</Key>.
            </Typography>
          </Paper>
          <FieldPicker
            heading="Included, in this order" fields={settings.fields} all={WEBHOOK_FIELDS} min={FIELDS_MIN} max={FIELDS_MAX}
            helper={COMMENT_NOTE} keyOf={keyOf} addAs="chips" onChange={(fields) => onChange({ fields })}
          />
          <Grid container spacing={2}>
            <Grid size={{ xs: 12, sm: 6 }}>
              <SettingSelect
                label="Key style" value={settings.key_style} options={KEY_STYLES} helper="Keys such as place_name or placeName."
                onChange={(key_style) => onChange({ key_style })}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <SettingSelect
                label="Time format" value={settings.time_format} options={TIME_FORMATS} helper={timeExample(settings.time_format)}
                onChange={(time_format) => onChange({ time_format })}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <SettingSelect
                label="Frequency unit" value={settings.frequency_unit} options={FREQUENCY_UNITS} helper="Changes the key name too."
                onChange={(frequency_unit) => onChange({ frequency_unit })}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <SettingSelect
                label="When a spot has no value" value={settings.missing_values} options={MISSING_VALUES}
                helper={missingHelper(settings.missing_values)} onChange={(missing_values) => onChange({ missing_values })}
              />
            </Grid>
          </Grid>
          <div>
            {/* Only the field list goes back to the defaults; the selects keep their choices (as Discord's Reset). */}
            <Button size="small" startIcon={<RestartAltIcon />} onClick={() => onChange({ fields: defaultFields() })}>
              Reset to default fields
            </Button>
          </div>
        </Stack>
      </CardContent>
    </Card>
  );
}

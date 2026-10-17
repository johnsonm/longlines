import {
  Avatar, Button, Card, CardContent, CardHeader, FormHelperText, Grid, IconButton, List, ListItem, ListItemAvatar, ListItemText, MenuItem, Paper,
  Stack, TextField, Typography,
} from "@mui/material";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import CloseIcon from "@mui/icons-material/Close";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import type { PushField, PushSettings } from "../lib/api";
import { SettingSwitch } from "./SettingSwitch";
import {
  addField, BODY_MAX, DEFAULT_SETTINGS, fieldLabel, moveField, removeField, SEPARATORS, TAP_TARGETS, TITLE_MAX, TITLE_MIN, unpickedFields,
} from "./pushModel";

interface PickerProps {
  heading: "Title" | "Body";
  fields: PushField[];
  min: number;
  max: number;
  helper: string;
  onChange: (fields: PushField[]) => void;
}

/**
 * An ordered pick of fields (decision 4): a numbered list with move and
 * remove buttons and a select of the fields not yet picked. There is no
 * text input; SQL renders every field and checks the lists again on save.
 */
function FieldPicker({ heading, fields, min, max, helper, onChange }: PickerProps) {
  const unpicked = unpickedFields(fields);
  const full = fields.length >= max;
  const selectId = `add-${heading.toLowerCase()}-field`;
  return (
    <Stack spacing={1.5}>
      <Typography variant="subtitle2" component="h3">{heading}</Typography>
      <Paper variant="outlined">
        <List dense disablePadding>
          {fields.map((f, i) => (
            <ListItem
              key={f} divider={i < fields.length - 1}
              secondaryAction={
                <Stack direction="row" spacing={0}>
                  <IconButton size="small" aria-label={`Move ${fieldLabel(f)} up`} disabled={i === 0} onClick={() => onChange(moveField(fields, i, -1))}>
                    <ArrowUpwardIcon fontSize="small" />
                  </IconButton>
                  <IconButton
                    size="small" aria-label={`Move ${fieldLabel(f)} down`} disabled={i === fields.length - 1}
                    onClick={() => onChange(moveField(fields, i, 1))}
                  >
                    <ArrowDownwardIcon fontSize="small" />
                  </IconButton>
                  <IconButton
                    size="small" edge="end" aria-label={`Remove ${fieldLabel(f)}`} disabled={fields.length <= min}
                    onClick={() => onChange(removeField(fields, i, min))}
                  >
                    <CloseIcon fontSize="small" />
                  </IconButton>
                </Stack>
              }
            >
              <ListItemAvatar>
                <Avatar>{i + 1}</Avatar>
              </ListItemAvatar>
              <ListItemText primary={fieldLabel(f)} sx={{ pr: 12 }} />
            </ListItem>
          ))}
          {fields.length === 0 && (
            <ListItem>
              <ListItemText secondary="No fields" />
            </ListItem>
          )}
        </List>
      </Paper>
      <TextField
        select id={selectId} label="Add a field" value="" fullWidth size="small" disabled={full || unpicked.length === 0}
        onChange={(e) => onChange(addField(fields, e.target.value as PushField, max))}
        slotProps={{
          inputLabel: { shrink: true },
          select: { displayEmpty: true, renderValue: () => <Typography component="span" color="text.secondary">Choose a field</Typography> },
        }}
      >
        {unpicked.map((f) => <MenuItem key={f.id} value={f.id}>{f.label}</MenuItem>)}
      </TextField>
      <FormHelperText>{helper}</FormHelperText>
    </Stack>
  );
}

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
                heading="Title" fields={settings.title_fields} min={TITLE_MIN} max={TITLE_MAX}
                helper="Shown in bold. Phones cut off long titles." onChange={(title_fields) => onChange({ title_fields })}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <FieldPicker
                heading="Body" fields={settings.body_fields} min={0} max={BODY_MAX}
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

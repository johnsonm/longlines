import {
  Avatar, FormHelperText, IconButton, List, ListItem, ListItemAvatar, ListItemText, MenuItem, Paper, Stack, TextField, Typography,
} from "@mui/material";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import CloseIcon from "@mui/icons-material/Close";
import { addField, labelOf, moveField, removeField, unpickedFields, type FieldInfo } from "./fieldList";

export interface FieldPickerProps<T extends string> {
  /** The list's heading; also names the select's id, so it must be unique on the page. */
  heading: string;
  fields: T[];
  /** Every field the list can take, in the order the select offers them. */
  all: readonly FieldInfo<T>[];
  min: number;
  max: number;
  helper: string;
  onChange: (fields: T[]) => void;
}

/**
 * An ordered pick of fields (decision 4 of the push and Discord specs): a
 * numbered list with move and remove buttons and a select of the fields not
 * yet picked. There is no text input; SQL renders every field and checks
 * the lists again on save.
 */
export function FieldPicker<T extends string>({ heading, fields, all, min, max, helper, onChange }: FieldPickerProps<T>) {
  const unpicked = unpickedFields(fields, all);
  const full = fields.length >= max;
  const selectId = `add-${heading.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-field`;
  const headingId = `${selectId}-heading`;
  const helperId = `${selectId}-helper`;
  const fieldLabel = (id: T) => labelOf(all, id);
  return (
    // The group carries the list's heading, so every "Add a field" select says which list it adds to.
    <Stack spacing={1.5} role="group" aria-labelledby={headingId}>
      <Typography variant="subtitle2" component="h3" id={headingId}>{heading}</Typography>
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
        onChange={(e) => onChange(addField(fields, e.target.value as T, max))}
        slotProps={{
          inputLabel: { shrink: true },
          select: {
            displayEmpty: true, SelectDisplayProps: { "aria-describedby": helperId },
            renderValue: () => <Typography component="span" color="text.secondary">Choose a field</Typography>,
          },
        }}
      >
        {unpicked.map((f) => <MenuItem key={f.id} value={f.id}>{f.label}</MenuItem>)}
      </TextField>
      <FormHelperText id={helperId}>{helper}</FormHelperText>
    </Stack>
  );
}

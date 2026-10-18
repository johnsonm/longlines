import {
  Box, Button, Card, CardContent, CardHeader, FormControl, FormControlLabel, FormLabel, Grid, MenuItem, Radio, RadioGroup, Stack, TextField,
  Typography,
} from "@mui/material";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import type { DiscordSettings } from "../lib/api";
import { FieldPicker } from "./FieldPicker";
import { SettingSwitch } from "./SettingSwitch";
import {
  CARD_COLORS, DETAILS_MAX, DISCORD_FIELDS, GRID_MAX, LINE_MAX, LINE_MIN, LINK_PREVIEWS, SEPARATORS, STYLES, TITLE_LINKS, TITLE_MAX, TITLE_MIN,
  defaultFields,
} from "./discordModel";

export interface DiscordMessageCardProps {
  settings: DiscordSettings;
  onChange: (patch: Partial<DiscordSettings>) => void;
}

/**
 * Page 8's Message card: the style, then the chosen style's field lists,
 * selects and switches. Each style keeps its own lists (decision 3), so
 * switching styles only changes `style`. The fields are picked here and
 * rendered only in SQL.
 */
export function DiscordMessageCard({ settings, onChange }: DiscordMessageCardProps) {
  const separator = (
    <TextField
      select label="Separate fields with" value={settings.separator} fullWidth
      onChange={(e) => onChange({ separator: e.target.value as DiscordSettings["separator"] })}
    >
      {SEPARATORS.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
    </TextField>
  );
  return (
    <Card variant="outlined">
      <CardHeader
        title="Message" subheader="Choose the style, then which fields appear and in what order."
        slotProps={{ title: { variant: "subtitle1" } }}
      />
      <CardContent sx={{ pt: 0 }}>
        <Stack spacing={3}>
          <FormControl>
            <FormLabel id="discord-message-style">Message style</FormLabel>
            <RadioGroup
              aria-labelledby="discord-message-style" value={settings.style}
              onChange={(e) => onChange({ style: e.target.value as DiscordSettings["style"] })}
            >
              {STYLES.map((s) => (
                <FormControlLabel
                  key={s.value} value={s.value} control={<Radio />} sx={{ alignItems: "flex-start", mt: 1 }}
                  slotProps={{ typography: { component: "div" } }}
                  label={
                    <Box sx={{ pt: 1 }}>
                      <Typography>{s.label}</Typography>
                      <Typography variant="body2" color="text.secondary">{s.help}</Typography>
                    </Box>
                  }
                />
              ))}
            </RadioGroup>
          </FormControl>
          {settings.style === "card"
            ? (
              <>
                <Grid container spacing={3}>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <FieldPicker
                      heading="Title" fields={settings.title_fields} all={DISCORD_FIELDS} min={TITLE_MIN} max={TITLE_MAX}
                      helper="Shown in bold at the top of the card." onChange={(title_fields) => onChange({ title_fields })}
                    />
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <FieldPicker
                      heading="Details" fields={settings.detail_fields} all={DISCORD_FIELDS} min={0} max={DETAILS_MAX}
                      helper="Shown under the title." onChange={(detail_fields) => onChange({ detail_fields })}
                    />
                  </Grid>
                </Grid>
                <FieldPicker
                  heading="Small grid" fields={settings.grid_fields} all={DISCORD_FIELDS} min={0} max={GRID_MAX}
                  helper="Short values shown side by side under the details. Leave empty for no grid."
                  onChange={(grid_fields) => onChange({ grid_fields })}
                />
                {/* Side by side as on the canvas (an auto-fit grid); phones stack them. */}
                <Grid container spacing={2}>
                  <Grid size={{ xs: 12, sm: 4 }}>
                    <TextField
                      select label="Title links to" value={settings.title_link} fullWidth
                      onChange={(e) => onChange({ title_link: e.target.value as DiscordSettings["title_link"] })}
                      helperText="Or the spot on the source site, or nothing."
                    >
                      {TITLE_LINKS.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
                    </TextField>
                  </Grid>
                  <Grid size={{ xs: 12, sm: 4 }}>
                    <TextField
                      select label="Card color" value={settings.card_color} fullWidth
                      onChange={(e) => onChange({ card_color: e.target.value as DiscordSettings["card_color"] })}
                      helperText="POTA green, SOTA purple and so on. Or one color for all."
                    >
                      {CARD_COLORS.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
                    </TextField>
                  </Grid>
                  <Grid size={{ xs: 12, sm: 4 }}>{separator}</Grid>
                </Grid>
                <SettingSwitch
                  label="Show field names in details" help="Adds a label before each value, such as State: NC."
                  checked={settings.show_field_names} onChange={(on) => onChange({ show_field_names: on })}
                />
                <SettingSwitch
                  label="Footer with source and time" help="For example POTA, 17:42 UTC."
                  checked={settings.footer} onChange={(on) => onChange({ footer: on })}
                />
              </>
            )
            : (
              <>
                <FieldPicker
                  heading="Message" fields={settings.line_fields} all={DISCORD_FIELDS} min={LINE_MIN} max={LINE_MAX}
                  helper="Place name is the park or summit." onChange={(line_fields) => onChange({ line_fields })}
                />
                {separator}
                <SettingSwitch
                  label="Bold the first field" help="Makes the callsign stand out in a busy channel."
                  checked={settings.bold_first} onChange={(on) => onChange({ bold_first: on })}
                />
                <SettingSwitch
                  label="Show field names" help="Adds a label before each value, such as State: NC."
                  checked={settings.show_field_names} onChange={(on) => onChange({ show_field_names: on })}
                />
                <TextField
                  select label="Link preview" value={settings.link_preview} fullWidth
                  onChange={(e) => onChange({ link_preview: e.target.value as DiscordSettings["link_preview"] })}
                  helperText="Stops Discord from expanding links in the message."
                >
                  {LINK_PREVIEWS.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
                </TextField>
              </>
            )}
          <Stack spacing={1}>
            <Typography variant="body2" color="text.secondary">
              Messages can only contain the fields chosen above. You cannot add your own text or markup. Mentions such as @everyone are always
              turned off.
            </Typography>
            <Typography variant="body2" color="text.secondary">
              If a spot does not have a field, that field is skipped. Comment is not available here, because it is text typed by the spotter.
            </Typography>
          </Stack>
          <div>
            <Button size="small" startIcon={<RestartAltIcon />} onClick={() => onChange(defaultFields())}>
              Reset to default fields
            </Button>
          </div>
        </Stack>
      </CardContent>
    </Card>
  );
}

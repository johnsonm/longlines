import { useEffect, useMemo, useState } from "react";
import {
  Alert, Autocomplete, Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, Divider, FormControl,
  FormControlLabel, FormGroup, FormLabel, Grid, InputLabel, LinearProgress, Link, List, ListItem, ListItemText, MenuItem, Paper,
  Select, Stack, TextField, Typography,
} from "@mui/material";
import { Link as RouterLink } from "react-router";
import { previewSubscription, type Destination, type Preview, type SubscriptionInput } from "../lib/api";
import { formatSpotTime, type TimePrefs } from "../lib/time";
import { errorText } from "../app/hooks";
import { useTour } from "../tour/hooks";
import { BANDS, LIVE_SOURCES, MODES, modeLabel, sourceName } from "../sources/sources";
import { spotReference } from "../sources/spots";
import { typeLabel } from "../destinations/types";
import type { CallsignGroup } from "../groups/types";
import { PREVIEW_WINDOW } from "./model";

const DEBOUNCE_MS = 300;

interface Props {
  open: boolean;
  initial: SubscriptionInput;
  dests: Destination[];
  // null when the list hasn't loaded: the picker is hidden and the subscription's groups are kept as they are.
  groups: CallsignGroup[] | null;
  prefs: TimePrefs;
  busy: boolean;
  onClose: () => void;
  onSave: (sub: SubscriptionInput) => void;
  fullScreen: boolean;
}

export function SubscriptionDialog({ open, initial, dests, groups, prefs, busy, onClose, onSave, fullScreen }: Props) {
  const [sub, setSub] = useState<SubscriptionInput>(initial);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // During the tour a tooltip sits beside the dialog; let keyboard focus reach it.
  const { active: tourActive } = useTour();
  const set = <K extends keyof SubscriptionInput>(k: K, v: SubscriptionInput[K]) => setSub((s) => ({ ...s, [k]: v }));

  const filterKey = useMemo(
    () => JSON.stringify({
      sources: sub.sources, bands: sub.bands, modes: sub.modes, callsigns: sub.callsigns, reference: sub.reference, group_ids: sub.group_ids,
    }),
    [sub.sources, sub.bands, sub.modes, sub.callsigns, sub.reference, sub.group_ids],
  );

  // Preview is computed by the database with the same predicate the matcher uses.
  useEffect(() => {
    if (!open) return;
    const filter = JSON.parse(filterKey) as Parameters<typeof previewSubscription>[0];
    const timer = setTimeout(() => {
      previewSubscription(filter)
        .then((p) => {
          setPreview(p);
          setPreviewError(null);
        })
        .catch((err: unknown) => setPreviewError(errorText(err, "Couldn't load the preview.")));
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [filterKey, open]);

  const sortedDests = [...dests].sort((a, b) => typeLabel(a.type).localeCompare(typeLabel(b.type)) || a.name.localeCompare(b.name));
  const count = preview?.count ?? 0;
  // Membership and the station count are resolved in SQL (preview_subscription); the last count stays while a new one loads.
  const stations = preview?.station_count ?? 0;
  const stationsText = preview && (sub.callsigns.length > 0 || sub.group_ids.length > 0)
    ? `Matches ${stations} ${stations === 1 ? "station" : "stations"} from your groups and callsigns.`
    : undefined;

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" fullScreen={fullScreen} disableEnforceFocus={tourActive}>
      <DialogTitle>{initial.id ? "Edit subscription" : "New subscription"}</DialogTitle>
      <DialogContent dividers>
        <Grid container spacing={3}>
          <Grid size={{ xs: 12, md: 6 }}>
            <Stack spacing={2.5}>
              <TextField label="Name" value={sub.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. NC parks on 20m" fullWidth required />
              <FormControl component="fieldset">
                <FormLabel>Sources</FormLabel>
                <FormGroup row>
                  {LIVE_SOURCES.map((s) => (
                    <FormControlLabel
                      key={s.id} label={s.name}
                      control={
                        <Checkbox
                          checked={sub.sources.includes(s.id)}
                          onChange={(e) => set("sources", e.target.checked ? [...sub.sources, s.id] : sub.sources.filter((x) => x !== s.id))}
                        />
                      }
                    />
                  ))}
                </FormGroup>
                <Typography variant="caption" color="text.secondary">Leave all unchecked to match every source.</Typography>
              </FormControl>
              <Autocomplete multiple options={BANDS} value={sub.bands} onChange={(_e, v) => set("bands", v)}
                renderInput={(p) => <TextField {...p} label="Bands" placeholder="Any band" />} />
              <Autocomplete multiple options={MODES} value={sub.modes} onChange={(_e, v) => set("modes", v)} getOptionLabel={modeLabel}
                renderInput={(p) => <TextField {...p} label="Modes" placeholder="Any mode" helperText="SOTAwatch reports every digital mode as DATA. Choose Any digital to include those spots." />} />
              <Autocomplete
                multiple freeSolo options={[] as string[]} value={sub.callsigns}
                onChange={(_e, v) => set("callsigns", v.map((x) => x.toUpperCase().trim()).filter(Boolean))}
                renderInput={(p) => (
                  <TextField
                    {...p} label="Callsigns" placeholder="Type a call and press Enter"
                    helperText={sub.group_ids.length ? "Added to the groups below." : "Leave empty to match any station."}
                  />
                )}
              />
              {groups && groups.length > 0 && (
                <Autocomplete
                  multiple options={groups} getOptionLabel={(g) => g.name} isOptionEqualToValue={(a, b) => a.id === b.id}
                  value={groups.filter((g) => sub.group_ids.includes(g.id))}
                  onChange={(_e, v) => set("group_ids", v.map((g) => g.id))}
                  renderInput={(p) => <TextField {...p} label="Callsign groups" helperText={stationsText} />}
                />
              )}
              {groups && groups.length === 0 && (
                <Typography variant="caption" color="text.secondary">
                  No callsign groups yet. <Link component={RouterLink} to="/groups">Create a group</Link> to watch a club roster or an award list.
                </Typography>
              )}
              <TextField
                label="Park, summit, or location contains" value={sub.reference} onChange={(e) => set("reference", e.target.value)}
                placeholder="US-NC, W4C/, US-0817" helperText="Matches POTA references and locations, and SOTA summit codes." fullWidth
              />
              <FormControl fullWidth>
                <InputLabel id="quiet">Repeat spots for the same station</InputLabel>
                <Select labelId="quiet" label="Repeat spots for the same station" value={sub.quiet_minutes} onChange={(e) => set("quiet_minutes", Number(e.target.value))}>
                  <MenuItem value={0}>Send every spot</MenuItem>
                  <MenuItem value={5}>At most once every 5 minutes</MenuItem>
                  <MenuItem value={10}>At most once every 10 minutes</MenuItem>
                  <MenuItem value={30}>At most once every 30 minutes</MenuItem>
                  <MenuItem value={60}>At most once an hour</MenuItem>
                </Select>
              </FormControl>
              <Autocomplete
                multiple disableCloseOnSelect options={sortedDests}
                groupBy={(d) => typeLabel(d.type)}
                getOptionLabel={(d) => d.name}
                isOptionEqualToValue={(a, b) => a.id === b.id}
                value={dests.filter((d) => sub.destinations.includes(d.id))}
                onChange={(_e, v) => set("destinations", v.map((d) => d.id))}
                noOptionsText="No destinations match"
                renderOption={(props, d, { selected }) => {
                  const { key, ...rest } = props as typeof props & { key: string };
                  return (
                    <Box component="li" key={key} {...rest}>
                      <Checkbox size="small" checked={selected} sx={{ mr: 1 }} />
                      <ListItemText primary={d.name} secondary={d.health === "failing" ? "Failing" : null} slotProps={{ secondary: { color: "error" } }} />
                    </Box>
                  );
                }}
                renderInput={(p) => (
                  <TextField
                    {...p} label="Send matches to" placeholder={sub.destinations.length ? "" : "Search destinations"} required
                    error={dests.length === 0} helperText={dests.length === 0 ? "Add a destination first." : "Pick one or more."}
                  />
                )}
              />
            </Stack>
          </Grid>
          <Grid size={{ xs: 12, md: 6 }}>
            <Paper variant="outlined" sx={{ height: "100%" }}>
              <Box sx={{ p: 2 }}>
                <Typography variant="subtitle1">Preview</Typography>
                <Typography variant="body2" color="text.secondary">
                  {preview ? `${count} of the last ${PREVIEW_WINDOW} spots would have matched.` : "Checking recent spots…"}
                </Typography>
                <LinearProgress variant={preview ? "determinate" : "indeterminate"} value={(count / PREVIEW_WINDOW) * 100} sx={{ mt: 1 }} />
                {previewError && <Alert severity="error" sx={{ mt: 2 }}>{previewError}</Alert>}
                {preview && count >= PREVIEW_WINDOW && (
                  <Alert severity="warning" sx={{ mt: 2 }}>This matches everything. Add a filter or expect a lot of messages.</Alert>
                )}
              </Box>
              <Divider />
              <List dense sx={{ maxHeight: { xs: 280, md: 420 }, overflowY: "auto" }}>
                {(preview?.spots ?? []).map((s, i) => (
                  <ListItem key={s.id ?? i}>
                    <ListItemText
                      primary={`${s.callsign} on ${Number(s.frequency_khz).toFixed(1)} kHz ${(s.mode ?? "").toUpperCase()}`}
                      secondary={`${spotReference(s)} · ${sourceName(s.source ?? "")} · ${s.spot_time ? formatSpotTime(s.spot_time, prefs) : ""}`}
                    />
                  </ListItem>
                ))}
                {preview && count === 0 && (
                  <ListItem><ListItemText secondary="Nothing recent matches. That can be fine for a narrow filter." /></ListItem>
                )}
              </List>
            </Paper>
          </Grid>
        </Grid>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button
          variant="contained" disabled={!sub.name.trim() || sub.destinations.length === 0 || busy} onClick={() => onSave(sub)}
          data-tour="subscription-save"
        >
          {initial.id ? "Save changes" : "Create subscription"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

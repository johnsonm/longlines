import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Alert, Avatar, Box, Breadcrumbs, Button, Card, CardContent, CardHeader, Chip, Divider, FormControlLabel, Grid, IconButton,
  LinearProgress, Link, List, ListItem, ListItemText, Menu, MenuItem, Paper, Stack, Switch, TextField, Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import CloseIcon from "@mui/icons-material/Close";
import SendIcon from "@mui/icons-material/Send";
import { Navigate, Link as RouterLink, useNavigate } from "react-router";
import { PageTitle } from "../layout/PageTitle";
import {
  listGroups, previewSubscription, saveSubscription, type Destination, type Preview, type SubscriptionInput, type SubscriptionWithLinks,
} from "../lib/api";
import type { CallsignGroup } from "../groups/types";
import { formatSpotTime, type TimePrefs } from "../lib/time";
import { errorText, useNotify } from "../app/hooks";
import { useTour } from "../tour/hooks";
import { sourceName, type SourceInfo } from "../sources/sources";
import { spotReference } from "../sources/spots";
import { SourceMark } from "../sources/SourceMark";
import { formatPerDay, formatRate, RATE_UNIT, sourceRates } from "../sources/rates";
import { useStats } from "../stats/useStats";
import { HealthChip } from "../destinations/HealthChip";
import { typeLabel } from "../destinations/types";
import { FilterStep } from "./FilterStep";
import {
  blankSub, linkedDestinations, needsCallsign, newRow, pickableSource, picksStations, rowInvalid, rowsOf, rulesOf, singleSource, toInput,
  type RuleRow,
} from "./model";

const DEBOUNCE_MS = 300;
const PREVIEW_SHOWN = 4;

interface Props {
  /** Set when editing; otherwise `source` names the new subscription's source. */
  id?: string;
  source?: string | null;
  subs: SubscriptionWithLinks[];
  dests: Destination[];
  loading: boolean;
  reload: () => Promise<void>;
  prefs: TimePrefs;
  mobile: boolean;
}

/** /subscriptions/new?source=… and /subscriptions/:id. An unknown id or source goes back to the list. */
export function SubscriptionEditorPage({ id, source, subs, loading, ...rest }: Props) {
  if (id) {
    const existing = subs.find((s) => s.id === id);
    if (!existing) return loading ? <LinearProgress /> : <Navigate to="/subscriptions" replace />;
    return <Editor key={id} initial={toInput(existing)} {...rest} />;
  }
  const picked = pickableSource(source ?? null);
  if (!picked) return <Navigate to="/subscriptions" replace />;
  return <Editor key={picked.id} initial={blankSub(picked.id)} {...rest} />;
}

function Step({ n, title, subheader, children }: { n: number; title: string; subheader: string; children: ReactNode }) {
  return (
    <Card variant="outlined">
      <CardHeader
        avatar={<Avatar>{n}</Avatar>}
        title={title} subheader={subheader}
        slotProps={{ title: { variant: "subtitle1" } }}
      />
      <CardContent sx={{ pt: 0 }}>{children}</CardContent>
    </Card>
  );
}

function Arrow() {
  return (
    <Box sx={{ display: "flex", justifyContent: "center", py: 0.5 }}>
      <ArrowDownwardIcon color="disabled" aria-hidden />
    </Box>
  );
}

interface EditorProps {
  initial: SubscriptionInput;
  dests: Destination[];
  reload: () => Promise<void>;
  prefs: TimePrefs;
  mobile: boolean;
}

function Editor({ initial, dests, reload, prefs, mobile }: EditorProps) {
  const notify = useNotify();
  const navigate = useNavigate();
  const { report } = useTour();
  const isNew = !initial.id;
  const [sub, setSub] = useState(initial);
  // The builder's rows; sub.rules is what they store, worked out on preview and save.
  const [rows, setRows] = useState<RuleRow[]>(() => {
    const r = rowsOf(initial.rules);
    return r.length === 0 && needsCallsign(initial.sources, initial.rules) ? [newRow(["callsign"], [])] : r;
  });
  const [groups, setGroups] = useState<CallsignGroup[] | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [destMenu, setDestMenu] = useState<HTMLElement | null>(null);
  const { stats } = useStats();

  const source = singleSource(sub.sources);
  const rates = source?.statsKey && stats ? sourceRates(stats.payload.hourly, source.statsKey) : null;
  const rules = useMemo(() => rulesOf(rows), [rows]);
  const missingCall = needsCallsign(sub.sources, rules);
  const invalid = rows.some(rowInvalid);

  useEffect(() => {
    if (isNew) report("subscription-form-opened");
  }, [isNew, report]);

  useEffect(() => {
    let active = true;
    listGroups()
      .then((g) => {
        if (active) setGroups(g);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const filterKey = useMemo(() => JSON.stringify({ sources: sub.sources, rules }), [sub.sources, rules]);

  // Preview is computed by the database with the same predicate the matcher uses.
  useEffect(() => {
    let active = true;
    const filter = JSON.parse(filterKey) as Parameters<typeof previewSubscription>[0];
    const timer = setTimeout(() => {
      previewSubscription(filter)
        .then((p) => {
          if (!active) return;
          setPreview(p);
          setPreviewError(null);
        })
        .catch((err: unknown) => {
          if (active) setPreviewError(errorText(err, "Couldn't load the preview."));
        });
    }, DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [filterKey]);

  const save = async () => {
    setBusy(true);
    try {
      await saveSubscription({ ...sub, name: sub.name.trim(), rules });
      await reload();
      notify(isNew ? `Created ${sub.name.trim()}` : "Saved changes");
      // Reported before navigating, so the tour moves on before it sees the page change.
      if (isNew) report("subscription-created");
      void navigate("/subscriptions");
    } catch (err) {
      notify(errorText(err, "Couldn't save the subscription."));
      setBusy(false);
    }
  };

  const cancel = () => {
    report("subscription-form-cancelled");
    void navigate("/subscriptions");
  };

  const chosen = linkedDestinations(sub.destinations, dests);
  const remaining = dests
    .filter((d) => !sub.destinations.includes(d.id))
    .sort((a, b) => typeLabel(a.type).localeCompare(typeLabel(b.type)) || a.name.localeCompare(b.name));
  const addDest = (id: string) => {
    setDestMenu(null);
    setSub({ ...sub, destinations: [...sub.destinations, id] });
  };

  const title = isNew ? "New subscription" : "Edit subscription";
  const actions = (
    <Stack direction="row" spacing={1}>
      <Button onClick={cancel} disabled={busy}>Cancel</Button>
      <Button variant="contained" disabled={!sub.name.trim() || missingCall || invalid || busy} onClick={() => void save()} data-tour="subscription-save">
        Save subscription
      </Button>
    </Stack>
  );

  return (
    <Stack spacing={3}>
      <Breadcrumbs>
        <Link component={RouterLink} to="/subscriptions" underline="hover" color="inherit">Subscriptions</Link>
        <Typography color="text.primary">{initial.name || title}</Typography>
      </Breadcrumbs>
      <Stack direction="row" spacing={2} useFlexGap sx={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
        <PageTitle>{title}</PageTitle>
        {actions}
      </Stack>

      <Grid container spacing={3} sx={{ alignItems: "flex-start" }}>
        <Grid size={{ xs: 12, md: 8 }}>
          <Stack spacing={3}>
            <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
              <TextField
                label="Name" value={sub.name} onChange={(e) => setSub({ ...sub, name: e.target.value })}
                placeholder="e.g. NC parks on 20m" fullWidth required
              />
              <FormControlLabel
                label="Enabled" labelPlacement="start" sx={{ flexShrink: 0 }}
                control={<Switch checked={sub.enabled} onChange={(e) => setSub({ ...sub, enabled: e.target.checked })} />}
              />
            </Stack>

            <Box>
              <Step n={1} title="Source" subheader="Where spots come from">
                <SourceStep sources={sub.sources} source={source} average={rates ? `${formatRate(rates.average)} ${RATE_UNIT} on average` : null} />
              </Step>
              <Arrow />
              <Step n={2} title="Filter" subheader={source?.volume === "high" ? "Required for this source" : "Optional. Leave it empty to pass every spot"}>
                <FilterStep
                  sub={sub} setSub={setSub} rows={rows} setRows={setRows} groups={groups} source={source} mobile={mobile}
                  perDay={rates ? formatPerDay(rates.perDay) : null}
                  stationCount={preview && picksStations(rules) ? preview.station_count : null}
                />
              </Step>
              <Arrow />
              <Step n={3} title="Destinations" subheader="Zero or more. Spots that pass the filter are sent to each one">
                <Stack spacing={1}>
                  {chosen.length === 0 ? (
                    <Paper variant="outlined" sx={{ p: 2 }}>
                      <Typography variant="subtitle2">No destinations yet</Typography>
                      <Typography variant="body2" color="text.secondary">
                        That is fine. The subscription still matches spots, and you can add a destination whenever you are ready.
                      </Typography>
                    </Paper>
                  ) : (
                    <List disablePadding>
                      {chosen.map((d) => (
                        <ListItem
                          key={d.id} divider disableGutters
                          secondaryAction={
                            <IconButton edge="end" aria-label={`Remove ${d.name}`} onClick={() => setSub({ ...sub, destinations: sub.destinations.filter((x) => x !== d.id) })}>
                              <CloseIcon />
                            </IconButton>
                          }
                        >
                          <Stack direction="row" spacing={2} sx={{ alignItems: "center", flexGrow: 1, pr: 6, minWidth: 0 }}>
                            <SendIcon color="action" aria-hidden />
                            <ListItemText primary={d.name} secondary={typeLabel(d.type)} sx={{ minWidth: 0 }} />
                            <HealthChip health={d.health} />
                          </Stack>
                        </ListItem>
                      ))}
                    </List>
                  )}
                  <Box>
                    <Button
                      size="small" startIcon={<AddIcon />} onClick={(e) => setDestMenu(e.currentTarget)}
                      disabled={dests.length > 0 && remaining.length === 0}
                    >
                      Add destination
                    </Button>
                    <Menu anchorEl={destMenu} open={!!destMenu} onClose={() => setDestMenu(null)}>
                      {remaining.map((d) => (
                        <MenuItem key={d.id} onClick={() => addDest(d.id)}>
                          <ListItemText primary={d.name} secondary={typeLabel(d.type)} />
                        </MenuItem>
                      ))}
                      {dests.length === 0 && (
                        <MenuItem onClick={() => void navigate("/destinations")}>Add one on the Destinations page</MenuItem>
                      )}
                    </Menu>
                  </Box>
                </Stack>
              </Step>
            </Box>
          </Stack>
        </Grid>
        <Grid size={{ xs: 12, md: 4 }} sx={{ position: { md: "sticky" }, top: { md: 16 } }}>
          <PreviewCard preview={preview} error={previewError} source={source} missingCall={missingCall} prefs={prefs} />
        </Grid>
      </Grid>
    </Stack>
  );
}

function SourceStep({ sources, source, average }: { sources: string[]; source: SourceInfo | null; average: string | null }) {
  if (!source) {
    // An older subscription with several sources, or none for "any source". It keeps them as they are.
    return (
      <Stack spacing={1}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
          {sources.length ? sources.map((s) => <Chip key={s} label={sourceName(s)} />) : <Chip label="All sources" />}
        </Stack>
        <Typography variant="body2" color="text.secondary">
          This subscription was made before subscriptions had one source. Saving keeps its sources as they are.
        </Typography>
      </Stack>
    );
  }
  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
        <SourceMark source={source} />
        <Box sx={{ flexGrow: 1 }}>
          <Typography variant="h6">{source.title}</Typography>
          {average && <Typography variant="body2" color="text.secondary">{average}</Typography>}
        </Box>
        <Button size="small" component={RouterLink} to={`/sources/${source.id}`}>View schema</Button>
      </Stack>
      <Typography variant="body2" color="text.secondary">
        A subscription has one source. To use a different source, create a new subscription.
      </Typography>
    </Stack>
  );
}

interface PreviewProps {
  preview: Preview | null;
  error: string | null;
  source: SourceInfo | null;
  missingCall: boolean;
  prefs: TimePrefs;
}

function PreviewCard({ preview, error, source, missingCall, prefs }: PreviewProps) {
  const name = source ? `${source.name} ` : "";
  const size = preview?.window_size ?? 0;
  const count = preview?.count ?? 0;
  const shown = (preview?.spots ?? []).slice(0, PREVIEW_SHOWN);

  let headline: string;
  if (missingCall) headline = "Add a callsign to see a preview";
  else if (!preview) headline = "Checking recent spots…";
  else if (size === 0) headline = `No recent ${name}spots to preview yet`;
  else headline = `${count} of the last ${size} ${name}spots would pass`;

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="overline" color="text.secondary">Preview</Typography>
          <Typography variant="h6">{headline}</Typography>
          {missingCall ? (
            <Typography variant="body2" color="text.secondary">
              The preview shows how many of the last {size || "200"} {name}spots would pass your filter.
            </Typography>
          ) : (
            <>
              <LinearProgress variant={preview ? "determinate" : "indeterminate"} value={size ? (count / size) * 100 : 0} />
              {error && <Alert severity="error">{error}</Alert>}
              {preview && size > 0 && count === size && (
                <Alert severity="warning">This passes everything. Add a filter or expect a lot of messages.</Alert>
              )}
              {shown.length > 0 && (
                <List dense disablePadding>
                  {shown.map((s, i) => (
                    <Box key={s.id ?? i}>
                      {i > 0 && <Divider component="div" />}
                      <ListItem disableGutters>
                        <ListItemText
                          primary={`${s.callsign} ${spotReference(s)}`.trim()}
                          secondary={`${Number(s.frequency_khz).toFixed(1)} kHz ${(s.mode ?? "").toUpperCase()} · ${s.spot_time ? formatSpotTime(s.spot_time, prefs) : ""}`}
                        />
                      </ListItem>
                    </Box>
                  ))}
                </List>
              )}
              {preview && size > 0 && count === 0 && (
                <Typography variant="body2" color="text.secondary">Nothing recent passes. That can be fine for a narrow filter.</Typography>
              )}
              {preview && count > 0 && (
                <Typography variant="caption" color="text.secondary">
                  Showing {shown.length} of {count}. Preview uses the last {size} {name}spots.
                </Typography>
              )}
            </>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}

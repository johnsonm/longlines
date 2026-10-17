import { useEffect, useState } from "react";
import {
  Alert, Box, Breadcrumbs, Button, Card, CardContent, CardHeader, Chip, Divider, FormControlLabel, Grid, LinearProgress, Link, MenuItem,
  Stack, Switch, TextField, Typography,
} from "@mui/material";
import { Navigate, Link as RouterLink, useNavigate } from "react-router";
import { PageTitle } from "../layout/PageTitle";
import { getPushDestination, savePushDestination, type Destination, type PushSettings } from "../lib/api";
import { errorText, useApp } from "../app/hooks";
import { DEST_TYPES, typeLabel } from "./types";
import { blankForm, formOf, QUIET_MODES, toInput, TTL_OPTIONS, URGENCIES, type PushForm } from "./pushModel";

interface Props {
  /** Set when editing; otherwise `type` must be "push" (the Add destination picker's hand-off). */
  id?: string;
  type?: string | null;
  dests: Destination[];
  loading: boolean;
  reload: () => Promise<void>;
  mobile: boolean;
}

/** /destinations/new?type=push and /destinations/:id. Anything else (a Discord or webhook id, another type) goes back to the list. */
export function PushDestinationPage({ id, type, dests, loading, reload, mobile }: Props) {
  if (id) {
    const existing = dests.find((d) => d.id === id);
    if (!existing) return loading ? <LinearProgress /> : <Navigate to="/destinations" replace />;
    if (existing.type !== "push") return <Navigate to="/destinations" replace />;
    return <Loader key={id} id={id} reload={reload} mobile={mobile} />;
  }
  if (type !== "push") return <Navigate to="/destinations" replace />;
  return <Editor key="new" initial={blankForm()} reload={reload} mobile={mobile} />;
}

/** The settings and members come from get_push_destination; the list's row has only the name and enabled. */
function Loader({ id, reload, mobile }: { id: string; reload: () => Promise<void>; mobile: boolean }) {
  const [initial, setInitial] = useState<PushForm | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getPushDestination(id)
      .then((d) => {
        if (active) setInitial(formOf(d));
      })
      .catch((err: unknown) => {
        if (active) setError(errorText(err, "Couldn't load the destination."));
      });
    return () => {
      active = false;
    };
  }, [id]);

  if (error) return <Alert severity="error">{error}</Alert>;
  if (!initial) return <LinearProgress />;
  return <Editor initial={initial} reload={reload} mobile={mobile} />;
}

interface EditorProps {
  initial: PushForm;
  reload: () => Promise<void>;
  mobile: boolean;
}

function Editor({ initial, reload, mobile }: EditorProps) {
  const { notify, profile } = useApp();
  const navigate = useNavigate();
  const isNew = !initial.id;
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const timezone = profile?.timezone ?? "UTC";

  const setSettings = (patch: Partial<PushSettings>) => setForm((f) => ({ ...f, settings: { ...f.settings, ...patch } }));

  const save = async () => {
    setBusy(true);
    const input = toInput(form);
    try {
      await savePushDestination(input);
      await reload();
      notify(isNew ? `Added ${input.name}` : "Saved changes");
      void navigate("/destinations");
    } catch (err) {
      const message = errorText(err, "Couldn't save the destination.");
      // The unique-name error is the field's; everything else is a toast.
      if (/already exists/.test(message)) setNameError(message);
      else notify(message);
      setBusy(false);
    }
  };

  const cancel = () => void navigate("/destinations");

  const title = isNew ? "New destination" : "Edit destination";
  const saveLabel = isNew ? "Add destination" : mobile ? "Save" : "Save destination";
  const pushType = DEST_TYPES.find((t) => t.id === "push");
  const TypeIcon = pushType?.icon;

  return (
    <Stack spacing={3}>
      <Breadcrumbs>
        <Link component={RouterLink} to="/destinations" underline="hover" color="inherit">Destinations</Link>
        <Typography color="text.primary">{initial.name || title}</Typography>
      </Breadcrumbs>
      <Stack direction="row" spacing={2} useFlexGap sx={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
        <PageTitle>{title}</PageTitle>
        <Stack direction="row" spacing={1}>
          <Button onClick={cancel} disabled={busy}>Cancel</Button>
          <Button variant="contained" disabled={!form.name.trim() || busy} onClick={() => void save()}>{saveLabel}</Button>
        </Stack>
      </Stack>

      <Stack direction="row" spacing={2} sx={{ alignItems: "flex-start" }}>
        <TextField
          label="Name" value={form.name} fullWidth required
          onChange={(e) => {
            setNameError(null);
            setForm({ ...form, name: e.target.value });
          }}
          error={nameError !== null}
          helperText={nameError ?? "Names are unique. A name can be reused after the destination that has it is deleted."}
        />
        <FormControlLabel
          label="Enabled" labelPlacement="start" sx={{ flexShrink: 0, mt: 1 }}
          control={<Switch checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />}
        />
      </Stack>
      <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
        <Chip label={typeLabel("push")} icon={TypeIcon ? <TypeIcon /> : undefined} />
        <Typography variant="body2" color="text.secondary">
          Filtering and repeat limits are set on each subscription. This page controls where and how notifications arrive.
        </Typography>
      </Stack>

      <Grid container spacing={3} sx={{ alignItems: "flex-start" }}>
        <Grid size={{ xs: 12, md: 7 }}>
          <Stack spacing={3}>
            <DeliveryCard settings={form.settings} timezone={timezone} onChange={setSettings} />
          </Stack>
        </Grid>
        <Grid size={{ xs: 12, md: 5 }} sx={{ position: { md: "sticky" }, top: { md: 16 } }} />
      </Grid>
    </Stack>
  );
}

/** A switch with its sentence under the label; the switch is named by the label alone. */
function SettingSwitch({ label, help, checked, onChange }: { label: string; help: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <Stack direction="row" spacing={2} sx={{ justifyContent: "space-between", alignItems: "center" }}>
      <Box>
        <Typography>{label}</Typography>
        <Typography variant="body2" color="text.secondary">{help}</Typography>
      </Box>
      <Switch checked={checked} onChange={(e) => onChange(e.target.checked)} slotProps={{ input: { "aria-label": label } }} />
    </Stack>
  );
}

interface DeliveryProps {
  settings: PushSettings;
  timezone: string;
  onChange: (patch: Partial<PushSettings>) => void;
}

/** Page 5's Delivery card. Every value is a column of push_destination_settings; the sender reads them from the claim. */
function DeliveryCard({ settings, timezone, onChange }: DeliveryProps) {
  const quiet = settings.quiet_enabled;
  return (
    <Card variant="outlined">
      <CardHeader title="Delivery" subheader="How notifications behave on the device" slotProps={{ title: { variant: "subtitle1" } }} />
      <CardContent sx={{ pt: 0 }}>
        <Stack spacing={2.5}>
          <TextField
            select label="Urgency" value={settings.urgency} fullWidth
            onChange={(e) => onChange({ urgency: e.target.value as PushSettings["urgency"] })}
            helperText="High can wake a sleeping phone. Normal fits most subscriptions."
          >
            {URGENCIES.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
          </TextField>
          <TextField
            select label="Drop if the device is offline for" value={settings.ttl_seconds} fullWidth
            onChange={(e) => onChange({ ttl_seconds: Number(e.target.value) })}
            helperText="Old spots are rarely useful. Late notifications are dropped, not queued."
          >
            {TTL_OPTIONS.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
          </TextField>
          <SettingSwitch
            label="Replace the earlier notification for the same station"
            help="A station that keeps getting spotted updates one notification instead of stacking many."
            checked={settings.replace_same_station} onChange={(on) => onChange({ replace_same_station: on })}
          />
          <Divider />
          <SettingSwitch
            label="Sound and vibration" help="Uses the device default. Custom sounds are not supported."
            checked={settings.sound} onChange={(on) => onChange({ sound: on })}
          />
          <Divider />
          <SettingSwitch
            label="Quiet hours" help={`Uses your account time zone, ${timezone}.`}
            checked={quiet} onChange={(on) => onChange({ quiet_enabled: on })}
          />
          <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
            <TextField
              label="From" type="time" value={settings.quiet_from} disabled={!quiet} fullWidth
              onChange={(e) => onChange({ quiet_from: e.target.value })} slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField
              label="Until" type="time" value={settings.quiet_until} disabled={!quiet} fullWidth
              onChange={(e) => onChange({ quiet_until: e.target.value })} slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField
              select label="During quiet hours" value={settings.quiet_mode} disabled={!quiet} fullWidth
              onChange={(e) => onChange({ quiet_mode: e.target.value as PushSettings["quiet_mode"] })}
            >
              {QUIET_MODES.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
            </TextField>
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}

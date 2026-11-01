import { useEffect, useState } from "react";
import { Alert, Breadcrumbs, Button, Chip, FormControlLabel, Grid, LinearProgress, Link, Stack, Switch, TextField, Typography } from "@mui/material";
import { Navigate, Link as RouterLink, useNavigate } from "react-router";
import { PageTitle } from "../layout/PageTitle";
import { getDiscordDestination, saveDiscordDestination, type Destination, type DiscordSettings } from "../lib/api";
import { errorText, useApp } from "../app/hooks";
import { timeAgo } from "../lib/time";
import { DEST_TYPES, typeLabel } from "./types";
import { DiscordChannelCard } from "./DiscordChannelCard";
import { DiscordMessageCard } from "./DiscordMessageCard";
import { DiscordDeliveryCard } from "./DiscordDeliveryCard";
import { DiscordPreviewCard } from "./DiscordPreviewCard";
import { blankForm, dirty, discordPausedLine, formOf, looksLikeWebhookUrl, toInput, type DiscordForm } from "./discordModel";

interface Props {
  /** Set when editing; otherwise `type` must be "discord" (the Add destination picker's hand-off). */
  id?: string;
  type?: string | null;
  dests: Destination[];
  loading: boolean;
  reload: () => Promise<void>;
  mobile: boolean;
}

/** /destinations/new?type=discord and /destinations/:id for a Discord id. Anything else goes back to the list. */
export function DiscordDestinationPage({ id, type, dests, loading, reload, mobile }: Props) {
  if (id) {
    const existing = dests.find((d) => d.id === id);
    if (!existing) return loading ? <LinearProgress /> : <Navigate to="/destinations" replace />;
    if (existing.type !== "discord") return <Navigate to="/destinations" replace />;
    return <Loader key={id} id={id} reload={reload} mobile={mobile} />;
  }
  if (type !== "discord") return <Navigate to="/destinations" replace />;
  return <Editor key="new" initial={blankForm()} urlDisplay={null} autoDisabledAt={null} reload={reload} mobile={mobile} />;
}

interface Loaded {
  form: DiscordForm;
  urlDisplay: string;
  autoDisabledAt: string | null;
}

/** The settings come from get_discord_destination, which returns the masked URL and never the URL itself. */
function Loader({ id, reload, mobile }: { id: string; reload: () => Promise<void>; mobile: boolean }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getDiscordDestination(id)
      .then((d) => {
        if (active) setLoaded({ form: formOf(d), urlDisplay: d.url_display, autoDisabledAt: d.auto_disabled_at });
      })
      .catch((err: unknown) => {
        if (active) setError(errorText(err, "Couldn't load the destination."));
      });
    return () => {
      active = false;
    };
  }, [id]);

  if (error) return <Alert severity="error">{error}</Alert>;
  if (!loaded) return <LinearProgress />;
  return (
    <Editor initial={loaded.form} urlDisplay={loaded.urlDisplay} autoDisabledAt={loaded.autoDisabledAt} reload={reload} mobile={mobile} />
  );
}

interface EditorProps {
  initial: DiscordForm;
  /** The saved URL, masked; null for a new destination. */
  urlDisplay: string | null;
  /** When Discord's answer paused the destination; null when it is not paused or is new. */
  autoDisabledAt: string | null;
  reload: () => Promise<void>;
  mobile: boolean;
}

function Editor({ initial, urlDisplay, autoDisabledAt, reload, mobile }: EditorProps) {
  const { notify } = useApp();
  const navigate = useNavigate();
  const isNew = !initial.id;
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  const setSettings = (patch: Partial<DiscordSettings>) => setForm((f) => ({ ...f, settings: { ...f.settings, ...patch } }));

  const typedUrl = form.url?.trim() ?? "";
  const urlValid = looksLikeWebhookUrl(typedUrl);
  // A saved destination already has a URL; a new one needs a webhook URL typed.
  const hasUrl = !isNew || urlValid;
  // A new destination needs a webhook URL; a replacement left empty keeps the stored one, a typed one must look right.
  const blocked = busy || !form.name.trim() || (isNew ? !urlValid : typedUrl !== "" && !urlValid);

  const save = async () => {
    setBusy(true);
    const input = toInput(form, initial);
    try {
      await saveDiscordDestination(input);
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
  const discordType = DEST_TYPES.find((t) => t.id === "discord");
  const TypeIcon = discordType?.icon;

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
          <Button variant="contained" disabled={blocked} onClick={() => void save()}>{saveLabel}</Button>
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
        <Chip label={typeLabel("discord")} icon={TypeIcon ? <TypeIcon /> : undefined} />
        <Typography variant="body2" color="text.secondary">
          Filtering and repeat limits are set on each connection. This page controls what the Discord message looks like.
        </Typography>
      </Stack>
      {autoDisabledAt && (
        // Shown whatever the switch now says: it reports what happened, and saving with Enabled on clears it.
        <Alert severity="warning">{discordPausedLine(timeAgo(autoDisabledAt))}</Alert>
      )}

      <Grid container spacing={3} sx={{ alignItems: "flex-start" }}>
        <Grid size={{ xs: 12, md: 7 }}>
          <Stack spacing={3}>
            <DiscordChannelCard urlDisplay={urlDisplay} url={form.url} onUrlChange={(url) => setForm((f) => ({ ...f, url }))} />
            <DiscordMessageCard settings={form.settings} onChange={setSettings} />
            <DiscordDeliveryCard settings={form.settings} onChange={setSettings} />
          </Stack>
        </Grid>
        <Grid size={{ xs: 12, md: 5 }} sx={{ position: { md: "sticky" }, top: { md: 16 } }}>
          <DiscordPreviewCard
            settings={form.settings} destinationId={initial.id} name={initial.name} hasUrl={hasUrl} dirty={dirty(initial, form)}
          />
        </Grid>
      </Grid>
    </Stack>
  );
}

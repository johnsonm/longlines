import { useEffect, useState } from "react";
import { Alert, Breadcrumbs, Button, Chip, FormControlLabel, Grid, LinearProgress, Link, Stack, Switch, TextField, Typography } from "@mui/material";
import { Navigate, Link as RouterLink, useNavigate } from "react-router";
import { PageTitle } from "../layout/PageTitle";
import { getWebhookDestination, rotateSigningSecret, saveWebhookDestination, type Destination, type WebhookSettings } from "../lib/api";
import { errorText, useApp } from "../app/hooks";
import { timeAgo } from "../lib/time";
import { DEST_TYPES, typeLabel } from "./types";
import { WebhookEndpointCard } from "./WebhookEndpointCard";
import { WebhookPayloadCard } from "./WebhookPayloadCard";
import { WebhookDeliveryCard } from "./WebhookDeliveryCard";
import { WebhookPreviewCard } from "./WebhookPreviewCard";
import { SigningSecretDialog } from "./SigningSecretDialog";
import {
  blankForm, dirty, extraHeaderLines, formOf, headerNeedsName, headerNeedsValue, looksLikeHttpsUrl, requestPath, toInput, type WebhookForm,
} from "./webhookModel";

interface Props {
  /** Set when editing; otherwise `type` must be "webhook" (the Add destination picker's hand-off). */
  id?: string;
  type?: string | null;
  dests: Destination[];
  loading: boolean;
  reload: () => Promise<void>;
  mobile: boolean;
}

/** /destinations/new?type=webhook and /destinations/:id for a webhook id. Anything else goes back to the list. */
export function WebhookDestinationPage({ id, type, dests, loading, reload, mobile }: Props) {
  if (id) {
    const existing = dests.find((d) => d.id === id);
    if (!existing) return loading ? <LinearProgress /> : <Navigate to="/destinations" replace />;
    if (existing.type !== "webhook") return <Navigate to="/destinations" replace />;
    return <Loader key={id} id={id} reload={reload} mobile={mobile} />;
  }
  if (type !== "webhook") return <Navigate to="/destinations" replace />;
  return <Editor key="new" initial={blankForm()} saved={null} reload={reload} mobile={mobile} />;
}

/** What get_webhook_destination says about a saved destination beyond the form: never the URL, the secret or a header value. */
interface Saved {
  urlDisplay: string;
  secretRotatedAt: string | null;
  autoDisabledAt: string | null;
}

function Loader({ id, reload, mobile }: { id: string; reload: () => Promise<void>; mobile: boolean }) {
  const [loaded, setLoaded] = useState<{ form: WebhookForm; saved: Saved } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getWebhookDestination(id)
      .then((d) => {
        if (!active) return;
        setLoaded({
          form: formOf(d),
          saved: { urlDisplay: d.url_display, secretRotatedAt: d.secret_rotated_at, autoDisabledAt: d.auto_disabled_at },
        });
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
  return <Editor initial={loaded.form} saved={loaded.saved} reload={reload} mobile={mobile} />;
}

interface EditorProps {
  initial: WebhookForm;
  /** Null for a new destination. */
  saved: Saved | null;
  reload: () => Promise<void>;
  mobile: boolean;
}

/** The secret on show: from the save that created the destination, or from Rotate. */
interface SecretShown {
  variant: "created" | "rotated";
  secret: string;
  name: string;
  batchSeconds: number;
}

function Editor({ initial, saved, reload, mobile }: EditorProps) {
  const { notify } = useApp();
  const navigate = useNavigate();
  const isNew = !initial.id;
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  // Rotate sets this locally, so "Rotated 1 minute ago" shows without a reload that would lose unsaved edits.
  const [rotatedAt, setRotatedAt] = useState(saved?.secretRotatedAt ?? null);
  const [rotating, setRotating] = useState(false);
  const [shown, setShown] = useState<SecretShown | null>(null);

  const setSettings = (patch: Partial<WebhookSettings>) => setForm((f) => ({ ...f, settings: { ...f.settings, ...patch } }));

  const typedUrl = form.url?.trim() ?? "";
  const urlValid = looksLikeHttpsUrl(typedUrl);
  // A saved destination already has a URL; a new one needs one typed.
  const hasUrl = !isNew || urlValid;
  const headersBlocked = form.headers.some((r) => headerNeedsName(r) || headerNeedsValue(r));
  // Save, Cancel and Rotate block each other: a save leaves the page, which would lose a rotated secret before it is shown.
  const pending = busy || rotating;
  // A replacement left empty keeps the stored URL; a typed one must start with https://.
  const blocked = pending || !form.name.trim() || headersBlocked || (isNew ? !urlValid : typedUrl !== "" && !urlValid);

  const save = async () => {
    setBusy(true);
    const input = toInput(form, initial);
    try {
      const result = await saveWebhookDestination(input);
      await reload();
      if (isNew && result.signingSecret) {
        // The secret is shown once; the page leaves when the dialog's Done is pressed.
        setShown({ variant: "created", secret: result.signingSecret, name: input.name, batchSeconds: input.settings.batch_seconds });
        return;
      }
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

  const rotate = async () => {
    if (!initial.id) return;
    setRotating(true);
    try {
      const secret = await rotateSigningSecret(initial.id);
      setRotatedAt(new Date().toISOString());
      setShown({ variant: "rotated", secret, name: initial.name, batchSeconds: initial.settings.batch_seconds });
    } catch (err) {
      notify(errorText(err, "Couldn't rotate the secret."));
    } finally {
      setRotating(false);
    }
  };

  const done = () => {
    const was = shown;
    setShown(null);
    if (was?.variant === "created") {
      notify(`Added ${was.name}`);
      void navigate("/destinations");
    }
  };

  const cancel = () => void navigate("/destinations");

  const title = isNew ? "New destination" : "Edit destination";
  const saveLabel = isNew ? "Add destination" : mobile ? "Save" : "Save destination";
  const webhookType = DEST_TYPES.find((t) => t.id === "webhook");
  const TypeIcon = webhookType?.icon;
  const autoDisabledAt = saved?.autoDisabledAt ?? null;

  return (
    <Stack spacing={3}>
      <Breadcrumbs>
        <Link component={RouterLink} to="/destinations" underline="hover" color="inherit">Destinations</Link>
        <Typography color="text.primary">{initial.name || title}</Typography>
      </Breadcrumbs>
      <Stack direction="row" spacing={2} useFlexGap sx={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
        <PageTitle>{title}</PageTitle>
        <Stack direction="row" spacing={1}>
          <Button onClick={cancel} disabled={pending}>Cancel</Button>
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
        <Chip label={typeLabel("webhook")} icon={TypeIcon ? <TypeIcon /> : undefined} />
        <Typography variant="body2" color="text.secondary">
          Filtering and repeat limits are set on each connection. This page controls where spots are sent and what the request contains.
        </Typography>
      </Stack>
      {autoDisabledAt && (
        // Shown whatever the pause switch now says: it reports what happened, and saving with Enabled on clears it.
        <Alert severity="warning">
          {`Paused ${timeAgo(autoDisabledAt)} after repeated failed requests. Spots waiting to be sent were dropped. Turn Enabled on and save to resume.`}
        </Alert>
      )}

      <Grid container spacing={3} sx={{ alignItems: "flex-start" }}>
        <Grid size={{ xs: 12, md: 7 }}>
          <Stack spacing={3}>
            <WebhookEndpointCard
              urlDisplay={saved?.urlDisplay ?? null} url={form.url} onUrlChange={(url) => setForm((f) => ({ ...f, url }))}
              rotatedAt={rotatedAt} onRotate={isNew ? undefined : () => void rotate()} rotating={pending}
              headers={form.headers} onHeadersChange={(headers) => setForm((f) => ({ ...f, headers }))}
            />
            <WebhookPayloadCard settings={form.settings} onChange={setSettings} />
            <WebhookDeliveryCard settings={form.settings} onChange={setSettings} />
          </Stack>
        </Grid>
        <Grid size={{ xs: 12, md: 5 }} sx={{ position: { md: "sticky" }, top: { md: 16 } }}>
          <WebhookPreviewCard
            settings={form.settings} destinationId={initial.id} path={requestPath(form.url, saved?.urlDisplay ?? null)}
            headerLines={extraHeaderLines(form.headers)} hasUrl={hasUrl} dirty={dirty(initial, form)}
          />
        </Grid>
      </Grid>

      <SigningSecretDialog
        key={shown?.secret ?? "none"} variant={shown?.variant ?? "created"} name={shown?.name ?? ""} batchSeconds={shown?.batchSeconds ?? 0}
        secret={shown?.secret ?? null} onDone={done}
      />
    </Stack>
  );
}

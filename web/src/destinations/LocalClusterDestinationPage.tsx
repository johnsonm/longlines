import { useEffect, useState } from "react";
import { Alert, Breadcrumbs, Button, FormControlLabel, Grid, LinearProgress, Link, Stack, Switch, TextField, Typography } from "@mui/material";
import { Navigate, Link as RouterLink, useNavigate } from "react-router";
import { PageTitle } from "../layout/PageTitle";
import { getLocalClusterDestination, loadRelayTokens, saveLocalClusterDestination, type Destination, type RelayToken } from "../lib/api";
import { errorText, useApp } from "../app/hooks";
import { typeLabel } from "./types";
import { LocalClusterRelayCard } from "./LocalClusterRelayCard";
import { LocalClusterLineCard } from "./LocalClusterLineCard";
import { LocalClusterPreviewCard } from "./LocalClusterPreviewCard";
import { blankForm, firstRelay, formOf, toInput, type LocalClusterForm } from "./localClusterModel";

interface Props {
  /** Set when editing; otherwise `type` must be "local_cluster" (the Add destination picker's hand-off). */
  id?: string;
  type?: string | null;
  dests: Destination[];
  loading: boolean;
  reload: () => Promise<void>;
  mobile: boolean;
}

/** /destinations/new?type=local_cluster and /destinations/:id for a Local DX cluster id. Anything else goes back to the list. */
export function LocalClusterDestinationPage({ id, type, dests, loading, reload, mobile }: Props) {
  if (id) {
    const existing = dests.find((d) => d.id === id);
    if (!existing) return loading ? <LinearProgress /> : <Navigate to="/destinations" replace />;
    if (existing.type !== "local_cluster") return <Navigate to="/destinations" replace />;
    return <Loader key={id} id={id} reload={reload} mobile={mobile} />;
  }
  if (type !== "local_cluster") return <Navigate to="/destinations" replace />;
  return <Editor key="new" initial={blankForm()} reload={reload} mobile={mobile} />;
}

function Loader({ id, reload, mobile }: { id: string; reload: () => Promise<void>; mobile: boolean }) {
  const [form, setForm] = useState<LocalClusterForm | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getLocalClusterDestination(id)
      .then((d) => {
        if (active) setForm(formOf(d));
      })
      .catch((err: unknown) => {
        if (active) setError(errorText(err, "Couldn't load the destination."));
      });
    return () => {
      active = false;
    };
  }, [id]);

  if (error) return <Alert severity="error">{error}</Alert>;
  if (!form) return <LinearProgress />;
  return <Editor initial={form} reload={reload} mobile={mobile} />;
}

interface EditorProps {
  initial: LocalClusterForm;
  reload: () => Promise<void>;
  mobile: boolean;
}

/** The page itself (DestinationDxCluster): name and type, the info line, the Relay and Spot line cards, and the preview beside them. */
function Editor({ initial, reload, mobile }: EditorProps) {
  const { notify } = useApp();
  const navigate = useNavigate();
  const isNew = !initial.id;
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [relays, setRelays] = useState<RelayToken[] | null>(null);
  const [relayError, setRelayError] = useState<string | null>(null);

  // The caller's relays, once; a new destination starts on the first one that can receive spots.
  useEffect(() => {
    let active = true;
    loadRelayTokens()
      .then((list) => {
        if (!active) return;
        setRelays(list);
        setForm((f) => (f.id || f.relayId !== null ? f : { ...f, relayId: firstRelay(list) }));
      })
      .catch((err: unknown) => {
        if (!active) return;
        setRelays([]);
        setRelayError(errorText(err, "Couldn't load your relays."));
      });
    return () => {
      active = false;
    };
  }, []);

  const blocked = busy || !form.name.trim() || form.relayId === null;

  const save = async () => {
    setBusy(true);
    const input = toInput(form);
    try {
      await saveLocalClusterDestination(input);
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

  return (
    <Stack spacing={3}>
      <Breadcrumbs>
        <Link component={RouterLink} to="/destinations" underline="hover" color="inherit">Destinations</Link>
        <Typography color="text.primary">{isNew ? "New destination" : initial.name}</Typography>
      </Breadcrumbs>
      <Stack direction="row" spacing={2} useFlexGap sx={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
        <PageTitle>{isNew ? "Add destination" : "Edit destination"}</PageTitle>
        <Stack direction="row" spacing={1}>
          <Button onClick={cancel} disabled={busy}>Cancel</Button>
          <Button variant="contained" disabled={blocked} onClick={() => void save()}>{mobile ? "Save" : "Save destination"}</Button>
        </Stack>
      </Stack>

      <Grid container spacing={3} sx={{ alignItems: "flex-start" }}>
        <Grid size={{ xs: 12, md: 7 }}>
          <Stack spacing={3}>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ alignItems: { sm: "flex-start" } }}>
              <TextField
                label="Name" value={form.name} fullWidth required
                onChange={(e) => {
                  setNameError(null);
                  setForm({ ...form, name: e.target.value });
                }}
                error={nameError !== null} helperText={nameError ?? undefined}
              />
              <TextField
                label="Type" value={typeLabel("local_cluster")} sx={{ flexShrink: 0, minWidth: { sm: 200 } }}
                slotProps={{ htmlInput: { readOnly: true } }}
              />
              <FormControlLabel
                label="Enabled" labelPlacement="start" sx={{ flexShrink: 0, mt: { sm: 1 } }}
                control={<Switch checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />}
              />
            </Stack>
            <Alert severity="info">Spots show up in your logging software's bandmap. Nothing tunes your radio until you pick a spot.</Alert>
            <LocalClusterRelayCard
              relays={relays} loadError={relayError} relayId={form.relayId} onChange={(relayId) => setForm((f) => ({ ...f, relayId }))}
            />
            <LocalClusterLineCard fields={form.fields} onChange={(fields) => setForm((f) => ({ ...f, fields }))} />
          </Stack>
        </Grid>
        <Grid size={{ xs: 12, md: 5 }} sx={{ position: { md: "sticky" }, top: { md: 16 } }}>
          <LocalClusterPreviewCard fields={form.fields} />
        </Grid>
      </Grid>
    </Stack>
  );
}

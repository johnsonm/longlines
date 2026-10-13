import { useEffect, useState } from "react";
import {
  Alert, Box, Button, Card, CardActions, CardContent, Chip, FormControlLabel, Grid, LinearProgress, Stack, Switch, Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import { useNavigate } from "react-router";
import { PageTitle } from "../layout/PageTitle";
import {
  deleteSubscription, listGroups, previewSubscription, saveSubscription, setSubscriptionEnabled,
  type Destination, type SubscriptionInput, type SubscriptionWithLinks,
} from "../lib/api";
import type { TimePrefs } from "../lib/time";
import type { CallsignGroup } from "../groups/types";
import { errorText, useNotify } from "../app/hooks";
import { useTour } from "../tour/hooks";
import { SubscriptionDialog } from "./SubscriptionDialog";
import { blankSub, filterChips, PREVIEW_WINDOW, toInput } from "./model";

interface Props {
  subs: SubscriptionWithLinks[];
  dests: Destination[];
  loading: boolean;
  reload: () => Promise<void>;
  prefs: TimePrefs;
  fullScreen: boolean;
}

export function SubscriptionsPage({ subs, dests, loading, reload, prefs, fullScreen }: Props) {
  const notify = useNotify();
  const navigate = useNavigate();
  const tour = useTour();
  const [editing, setEditing] = useState<SubscriptionInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [hits, setHits] = useState<Record<string, number>>({});
  // Names for the chips and the dialog's picker. null until loaded, and if loading fails.
  const [groups, setGroups] = useState<CallsignGroup[] | null>(null);

  // Groups change only on the Groups page, which is another route, so one load per visit is enough.
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

  // "N of the last 200 spots matched", from the same predicate the matcher uses.
  useEffect(() => {
    let active = true;
    void Promise.all(subs.map(async (s) => [s.id, (await previewSubscription(toInput(s)).catch(() => null))?.count ?? null] as const))
      .then((pairs) => {
        if (!active) return;
        setHits(Object.fromEntries(pairs.filter(([, n]) => n !== null) as Array<[string, number]>));
      });
    return () => {
      active = false;
    };
  }, [subs]);

  const startNew = () => {
    setEditing(blankSub());
    tour.report("subscription-dialog-opened");
  };

  const cancelEdit = () => {
    setEditing(null);
    tour.report("subscription-dialog-closed");
  };

  const save = async (s: SubscriptionInput) => {
    setBusy(true);
    try {
      await saveSubscription(s);
      await reload();
      notify(s.id ? "Saved changes" : `Created ${s.name}`);
      setEditing(null);
      if (!s.id) tour.report("subscription-created");
    } catch (err) {
      notify(errorText(err, "Couldn't save the subscription."));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: SubscriptionWithLinks) => {
    try {
      await deleteSubscription(s.id);
      await reload();
      notify(`Deleted ${s.name}`);
    } catch (err) {
      notify(errorText(err, "Couldn't delete the subscription."));
    }
  };

  const toggle = async (s: SubscriptionWithLinks, enabled: boolean) => {
    try {
      await setSubscriptionEnabled(s.id, enabled);
      await reload();
    } catch (err) {
      notify(errorText(err, "Couldn't update the subscription."));
    }
  };

  return (
    <Stack spacing={3}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ justifyContent: "space-between", alignItems: { sm: "flex-end" } }}>
        <Box>
          <PageTitle>Subscriptions</PageTitle>
          <Typography color="text.secondary">A subscription picks which spots you care about and sends them to one or more destinations.</Typography>
        </Box>
        <Button variant="contained" startIcon={<AddIcon />} onClick={startNew} data-tour="new-subscription" sx={{ flexShrink: 0 }}>New subscription</Button>
      </Stack>
      {loading && <LinearProgress />}
      {!loading && dests.length === 0 && (
        <Alert severity="info" action={<Button color="inherit" size="small" onClick={() => void navigate("/destinations")}>Add one</Button>}>
          You need at least one destination before creating a subscription.
        </Alert>
      )}
      <Grid container spacing={2}>
        {subs.map((s) => (
          <Grid size={{ xs: 12, md: 6 }} key={s.id}>
            <Card variant="outlined">
              <CardContent>
                <Stack direction="row" spacing={1} sx={{ justifyContent: "space-between", alignItems: "center" }}>
                  <Typography variant="h6" sx={{ minWidth: 0, overflowWrap: "anywhere" }}>{s.name}</Typography>
                  <FormControlLabel
                    label={s.enabled ? "On" : "Paused"} labelPlacement="start"
                    control={<Switch checked={s.enabled} onChange={(e) => void toggle(s, e.target.checked)} />}
                  />
                </Stack>
                <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", my: 1.5 }}>
                  {filterChips(toInput(s), groups).map((c, i) => <Chip key={i} size="small" label={c} />)}
                </Stack>
                <Typography variant="body2" color="text.secondary">
                  Sends to {s.destinations.map((id) => dests.find((d) => d.id === id)?.name).filter(Boolean).join(", ") || "nothing"}.
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {hits[s.id] !== undefined ? `${hits[s.id]} of the last ${PREVIEW_WINDOW} spots matched.` : " "}
                </Typography>
              </CardContent>
              <CardActions>
                <Button size="small" startIcon={<EditIcon />} onClick={() => setEditing(toInput(s))}>Edit</Button>
                <Button size="small" color="error" startIcon={<DeleteIcon />} onClick={() => void remove(s)}>Delete</Button>
              </CardActions>
            </Card>
          </Grid>
        ))}
      </Grid>
      {editing && (
        <SubscriptionDialog
          open initial={editing} dests={dests} groups={groups} prefs={prefs} busy={busy} fullScreen={fullScreen}
          onClose={cancelEdit} onSave={(s) => void save(s)}
        />
      )}
    </Stack>
  );
}

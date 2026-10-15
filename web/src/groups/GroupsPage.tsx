import { useCallback, useEffect, useState } from "react";
import {
  Box, Button, Card, CardActions, CardContent, Chip, Grid, LinearProgress, Paper, Stack, Tooltip, Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import NotificationsActiveIcon from "@mui/icons-material/NotificationsActive";
import { useNavigate } from "react-router";
import { PageTitle } from "../layout/PageTitle";
import { deleteGroup, listGroups, loadDestinations, loadSubscriptions, saveSubscription } from "../lib/api";
import { hasPositiveRule, toInput } from "../subscriptions/model";
import { errorText, useNotify } from "../app/hooks";
import { GroupDialog } from "./GroupDialog";
import { CARD_CHIPS, groupMeta, spotLines } from "./model";
import type { CallsignGroup, GroupInput } from "./types";

interface Props {
  /** Reloads the app's subscriptions after Get alerts creates one. */
  reload: () => Promise<void>;
}

export function GroupsPage({ reload }: Props) {
  const notify = useNotify();
  const navigate = useNavigate();
  const [groups, setGroups] = useState<CallsignGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<GroupInput | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Spot ages count from when the list was read, which is when SQL worked out who is on the air.
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(async () => {
    try {
      setGroups(await listGroups());
      setNow(new Date());
    } catch (err) {
      notify(errorText(err, "Couldn't load your groups."));
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (id: string, fallback: string, action: () => Promise<void>) => {
    setBusyId(id);
    try {
      await action();
    } catch (err) {
      notify(errorText(err, fallback));
    } finally {
      setBusyId(null);
    }
  };

  // Mirrors Get alerts on a callsign profile (CallsignPage), with the group in place of the call.
  const getAlerts = (g: CallsignGroup) => run(g.id, "Couldn't save the subscription.", async () => {
    // Read fresh rather than from the app's copy, which may not have loaded yet.
    const [dests, subs] = await Promise.all([loadDestinations(), loadSubscriptions()]);
    const existing = subs.find((s) => hasPositiveRule(toInput(s).rules, "group", g.id));
    if (existing) {
      notify(`You already have ${existing.name}.`);
      void navigate("/subscriptions");
      return;
    }
    // save_subscription requires a destination, and a paused or failing one would deliver nothing.
    const dest = dests.find((d) => d.health === "ok");
    if (!dest) {
      notify("Add a destination to start getting alerts.");
      void navigate("/destinations");
      return;
    }
    const name = `${g.name} on the air`;
    await saveSubscription({
      name, enabled: true, quiet_minutes: 30, destinations: [dest.id],
      sources: [], rules: [[{ field: "group", op: "is", values: [g.id] }]],
    });
    await reload();
    notify(`Created ${name}`);
    void navigate("/subscriptions");
  });

  const remove = (g: CallsignGroup) => run(g.id, "Couldn't delete the group.", async () => {
    await deleteGroup(g.id);
    await load();
    notify(`Deleted ${g.name}`);
  });

  const onSaved = async (name: string) => {
    const created = !editing?.id;
    setEditing(null);
    await load();
    notify(created ? `Created ${name}` : "Saved changes");
  };

  const startNew = () => setEditing({ name: "", callsigns: [] });

  return (
    <Stack spacing={3}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ justifyContent: "space-between", alignItems: { sm: "flex-end" } }}>
        <Box>
          <PageTitle>Groups</PageTitle>
          <Typography color="text.secondary">
            A group is a named list of callsigns, like your club roster. Use groups in subscriptions to get alerts when any member is spotted.
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<AddIcon />} onClick={startNew} sx={{ flexShrink: 0 }}>New group</Button>
      </Stack>
      {loading && <LinearProgress />}
      {!loading && groups.length === 0
        ? (
          <Paper variant="outlined" sx={{ p: 4, textAlign: "center" }}>
            <Typography gutterBottom>No groups yet.</Typography>
            <Button onClick={startNew}>Create your first group</Button>
          </Paper>
        )
        : (
          <Grid container spacing={2}>
            {groups.map((g) => (
              <Grid size={{ xs: 12, md: 6 }} key={g.id}>
                <GroupCard
                  group={g} now={now} busy={busyId === g.id}
                  onAlerts={() => void getAlerts(g)}
                  onEdit={() => setEditing({ id: g.id, name: g.name, callsigns: g.callsigns })}
                  onDelete={() => void remove(g)}
                />
              </Grid>
            ))}
          </Grid>
        )}
      {editing && <GroupDialog initial={editing} onClose={() => setEditing(null)} onSaved={(name) => void onSaved(name)} />}
    </Stack>
  );
}

interface CardProps {
  group: CallsignGroup;
  now: Date;
  busy: boolean;
  onAlerts: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function GroupCard({ group: g, now, busy, onAlerts, onEdit, onDelete }: CardProps) {
  const used = g.subscription_count > 0;
  const hidden = g.callsigns.length - CARD_CHIPS;
  const latest = g.on_air.count > 0 ? g.on_air.latest : null;
  const lines = latest ? spotLines(latest, now) : null;
  return (
    <Card variant="outlined" sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <CardContent sx={{ flexGrow: 1 }}>
        <Typography variant="h6" component="h2" sx={{ overflowWrap: "anywhere" }}>{g.name}</Typography>
        <Typography color="text.secondary">{groupMeta(g.member_count, g.subscription_count)}</Typography>
        {g.callsigns.length > 0 && (
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", mt: 1.5 }}>
            {g.callsigns.slice(0, CARD_CHIPS).map((c) => <Chip key={c} size="small" variant="outlined" label={c} />)}
            {hidden > 0 && <Chip size="small" label={`+${hidden} more`} />}
          </Stack>
        )}
        {g.on_air.count > 0 && (
          <Box sx={{ mt: 1.5 }}>
            <Chip size="small" color="success" label={`${g.on_air.count} on the air now`} />
            {lines && (
              <Box sx={{ mt: 1 }}>
                <Typography variant="body2">{lines[0]}</Typography>
                <Typography variant="body2" color="text.secondary">{lines[1]}</Typography>
              </Box>
            )}
          </Box>
        )}
      </CardContent>
      <CardActions>
        <Button size="small" startIcon={<NotificationsActiveIcon />} disabled={busy} onClick={onAlerts}>Get alerts</Button>
        <Button size="small" startIcon={<EditIcon />} disabled={busy} onClick={onEdit}>Edit</Button>
        <Tooltip title={used ? "Remove it from its subscriptions first" : ""}>
          <Box component="span">
            <Button size="small" color="error" startIcon={<DeleteIcon />} disabled={used || busy} onClick={onDelete} aria-label={`Delete ${g.name}`}>
              Delete
            </Button>
          </Box>
        </Tooltip>
      </CardActions>
    </Card>
  );
}

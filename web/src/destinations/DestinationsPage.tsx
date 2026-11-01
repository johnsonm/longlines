import { useEffect, useMemo, useState } from "react";
import { Alert, AlertTitle, Box, Button, Grid, LinearProgress, Paper, Stack, Typography, useMediaQuery, useTheme } from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import { useNavigate } from "react-router";
import { PageTitle } from "../layout/PageTitle";
import {
  clearDestinationQueue, deleteDestination, duplicateDestination, listDestinationQueues, listDiscordDestinationSettings,
  listLocalClusterDestinationSettings, listPushDevices, listWebhookDestinationSettings, sendTest, type Destination, type DestinationQueue,
  type DiscordSettingsSummary, type LocalClusterSettingsSummary, type PushDevice, type SubscriptionWithLinks, type WebhookSettingsSummary,
} from "../lib/api";
import { currentEndpoint } from "../pwa/push";
import { errorText, useNotify } from "../app/hooks";
import { ConfirmDeleteDialog } from "../layout/ConfirmDeleteDialog";
import { ConfirmDialog } from "../layout/ConfirmDialog";
import { DestinationCard } from "./DestinationCard";
import { DestinationDialog } from "./DestinationDialog";
import { backedUpBody, backedUpTitle, CLEAR_KEEPS, clearBody, clearedToast, clearTitle } from "./queueModel";
import { answeredStatus } from "./webhookModel";

interface Props {
  dests: Destination[];
  subs: SubscriptionWithLinks[];
  loading: boolean;
  reload: () => Promise<void>;
}

/** "POTA phone", "POTA phone and Desktop", "A, B and C". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The connections that still send to a destination about to go. Deleting it unlinks them; one
 * with no other destination stays saved and waits for one, as a connection saved with none does.
 */
function DeleteWarning({ users }: { users: SubscriptionWithLinks[] }) {
  if (users.length === 0) return <Typography variant="body2">No connections use this destination.</Typography>;
  const stranded = users.filter((s) => s.destinations.length === 1);
  const one = stranded.length === 1;
  const which = stranded.length === users.length && !one
    ? "None of them has another destination"
    : `${joinNames(stranded.map((s) => s.name))} ${one ? "has" : "have"} no other destination`;
  return (
    <>
      <Typography variant="body2">
        {users.length === 1 ? "This connection sends to it" : `These ${users.length} connections send to it`}:{" "}
        {joinNames(users.map((s) => s.name))}.
      </Typography>
      {stranded.length > 0 && (
        <Alert severity="warning">{which}, so {one ? "it" : "they"} won't send spots anywhere until you add one.</Alert>
      )}
    </>
  );
}

export function DestinationsPage({ dests, subs, loading, reload }: Props) {
  const notify = useNotify();
  const navigate = useNavigate();
  const mobile = useMediaQuery(useTheme().breakpoints.down("sm"));
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [confirming, setConfirming] = useState<Destination | null>(null);
  const [clearing, setClearing] = useState<Destination | null>(null);
  const usersOf = (id: string) => subs.filter((s) => s.destinations.includes(id));
  const usedBy = (id: string) => usersOf(id).length;

  // One device list for every push card, re-read when the destinations change.
  const pushIds = useMemo(() => dests.filter((d) => d.type === "push").map((d) => d.id).join(","), [dests]);
  useEffect(() => {
    if (!pushIds) {
      setDevices([]);
      return;
    }
    let active = true;
    listPushDevices(currentEndpoint())
      .then((list) => {
        if (active) setDevices(list);
      })
      .catch((err: unknown) => {
        if (active) notify(errorText(err, "Couldn't load your devices."));
      });
    return () => {
      active = false;
    };
  }, [pushIds, notify]);

  // Likewise one settings summary list for every Discord card's type line.
  const [discord, setDiscord] = useState<DiscordSettingsSummary[]>([]);
  const discordIds = useMemo(() => dests.filter((d) => d.type === "discord").map((d) => d.id).join(","), [dests]);
  useEffect(() => {
    if (!discordIds) {
      setDiscord([]);
      return;
    }
    let active = true;
    listDiscordDestinationSettings()
      .then((list) => {
        if (active) setDiscord(list);
      })
      .catch((err: unknown) => {
        if (active) notify(errorText(err, "Couldn't load your Discord settings."));
      });
    return () => {
      active = false;
    };
  }, [discordIds, notify]);

  // And one for every webhook card's type line.
  const [webhooks, setWebhooks] = useState<WebhookSettingsSummary[]>([]);
  const webhookIds = useMemo(() => dests.filter((d) => d.type === "webhook").map((d) => d.id).join(","), [dests]);
  useEffect(() => {
    if (!webhookIds) {
      setWebhooks([]);
      return;
    }
    let active = true;
    listWebhookDestinationSettings()
      .then((list) => {
        if (active) setWebhooks(list);
      })
      .catch((err: unknown) => {
        if (active) notify(errorText(err, "Couldn't load your webhook settings."));
      });
    return () => {
      active = false;
    };
  }, [webhookIds, notify]);

  // And one for every Local DX cluster card's relay and its Relay offline chip.
  const [clusters, setClusters] = useState<LocalClusterSettingsSummary[]>([]);
  const clusterIds = useMemo(() => dests.filter((d) => d.type === "local_cluster").map((d) => d.id).join(","), [dests]);
  useEffect(() => {
    if (!clusterIds) {
      setClusters([]);
      return;
    }
    let active = true;
    listLocalClusterDestinationSettings()
      .then((list) => {
        if (active) setClusters(list);
      })
      .catch((err: unknown) => {
        if (active) notify(errorText(err, "Couldn't load your Local DX cluster settings."));
      });
    return () => {
      active = false;
    };
  }, [clusterIds, notify]);

  // And one queue list for every card's waiting count and the backed-up banners, read again after
  // a clear. A failed load is a toast and the page works without it (the web can deploy before
  // the migration that adds list_destination_queues).
  const [queues, setQueues] = useState<DestinationQueue[]>([]);
  const [queuesRead, setQueuesRead] = useState(0);
  const destIds = useMemo(() => dests.map((d) => d.id).join(","), [dests]);
  useEffect(() => {
    if (!destIds) {
      setQueues([]);
      return;
    }
    let active = true;
    listDestinationQueues()
      .then((list) => {
        if (active) setQueues(list);
      })
      .catch((err: unknown) => {
        if (active) notify(errorText(err, "Couldn't load the destination queues."));
      });
    return () => {
      active = false;
    };
  }, [destIds, queuesRead, notify]);

  const membersOf = (id: string) => devices.filter((d) => d.destination_ids.includes(id));
  const queueOf = (id: string) => queues.find((q) => q.destination_id === id) ?? null;
  const summaryOf = (id: string) => discord.find((s) => s.destination_id === id) ?? null;
  const webhookOf = (id: string) => webhooks.find((s) => s.destination_id === id) ?? null;
  const clusterOf = (id: string) => clusters.find((s) => s.destination_id === id) ?? null;

  const openDialog = () => {
    setOpen(true);
  };

  const closeDialog = () => {
    setOpen(false);
  };

  const run = async (id: string, action: () => Promise<void>) => {
    setBusyId(id);
    try {
      await action();
    } catch (err) {
      notify(errorText(err, "Something went wrong."));
    } finally {
      setBusyId(null);
    }
  };

  const remove = (d: Destination) => {
    setConfirming(null);
    void run(d.id, async () => {
      await deleteDestination(d.id);
      await reload();
      notify(`Deleted ${d.name}`);
    });
  };

  const clear = (d: Destination) => {
    setClearing(null);
    void run(d.id, async () => {
      const cleared = await clearDestinationQueue(d.id);
      notify(clearedToast(cleared, d.name));
      setQueuesRead((n) => n + 1);
    });
  };

  const test = (d: Destination) =>
    void run(d.id, async () => {
      let status: number | null;
      try {
        ({ status } = await sendTest(d.id));
      } catch (err) {
        // A receiver that answered non-2xx still answered: the toast names the destination and its status.
        status = answeredStatus(err);
        if (status === null) throw err;
      }
      // A webhook's receiver answers with a status, 2xx or not (webhook spec, Copy: Toasts).
      notify(status === null ? `Test spot sent to ${d.name}` : `${d.name} answered HTTP ${status}.`);
    });

  // Page 5's blocked alert: one per blocked device that some push destination still sends to.
  const blockedAlerts = devices
    .filter((dev) => dev.blocked_at !== null)
    .map((dev) => ({ dev, members: dests.filter((d) => d.type === "push" && dev.destination_ids.includes(d.id)) }))
    .filter(({ members }) => members.length > 0);

  const backedUp = dests.flatMap((d) => {
    const q = queueOf(d.id);
    return q?.backed_up ? [{ d, q }] : [];
  });

  return (
    <Stack spacing={3}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ justifyContent: "space-between", alignItems: { sm: "flex-end" } }}>
        <Box>
          <PageTitle>Destinations</PageTitle>
          <Typography color="text.secondary">Where matching spots are sent.</Typography>
        </Box>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openDialog} sx={{ flexShrink: 0 }}>Add destination</Button>
      </Stack>
      {loading && <LinearProgress />}
      {/* A paused destination (auto_disabled_at) keeps health failing; its Paused chip and the editor's alert cover it. */}
      {dests.filter((d) => d.health === "failing" && d.auto_disabled_at === null).map((d) => (
        <Alert
          severity="error" key={d.id}
          action={<Button color="inherit" size="small" disabled={busyId === d.id} onClick={() => test(d)}>Send test</Button>}
        >
          <AlertTitle>{d.name} is failing</AlertTitle>
          The last {d.consecutive_failures} deliveries returned {d.last_error ?? "an error"}. Spots for {usedBy(d.id)}{" "}
          connection{usedBy(d.id) === 1 ? "" : "s"} are not being sent. Check the URL, then send a test.
        </Alert>
      ))}
      {/* list_destination_queues decides backed_up (enabled, and at either knob); this only words it. */}
      {backedUp.map(({ d, q }) => (
        <Alert
          severity="warning" key={`queue-${d.id}`}
          action={<Button color="inherit" size="small" disabled={busyId === d.id} onClick={() => setClearing(d)}>Clear queue</Button>}
        >
          <AlertTitle>{backedUpTitle(d.name)}</AlertTitle>
          {backedUpBody(q)}
        </Alert>
      ))}
      {blockedAlerts.map(({ dev, members }) => (
        <Alert
          severity="warning" key={dev.id}
          action={<Button color="inherit" size="small" onClick={() => void navigate(`/destinations/${members[0]!.id}`)}>Manage devices</Button>}
        >
          <AlertTitle>{dev.label} cannot receive notifications</AlertTitle>
          Notifications are blocked for longlines.io in {dev.agent} on that device. Allow them in the browser site settings, or remove the
          device from {joinNames(members.map((m) => m.name))}.
        </Alert>
      ))}
      {!loading && dests.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: "center" }}>
          <Typography gutterBottom>No destinations yet.</Typography>
          <Button onClick={openDialog}>Add your first destination</Button>
        </Paper>
      ) : (
        <Grid container spacing={2}>
          {dests.map((d) => (
            <Grid key={d.id} size={{ xs: 12, md: 6 }}>
              <DestinationCard
                dest={d} usedBy={usedBy(d.id)} devices={membersOf(d.id)} discord={summaryOf(d.id)} webhook={webhookOf(d.id)}
                localCluster={clusterOf(d.id)} waiting={queueOf(d.id)?.waiting ?? 0}
                busy={busyId === d.id} mobile={mobile}
                onSendTest={() => test(d)}
                onEdit={() => void navigate(`/destinations/${d.id}`)}
                onDuplicate={() => void run(d.id, async () => {
                  const id = await duplicateDestination(d.id);
                  notify(`Duplicated ${d.name}`);
                  await reload();
                  await navigate(`/destinations/${id}`);
                })}
                onDelete={() => setConfirming(d)}
              />
            </Grid>
          ))}
        </Grid>
      )}
      <DestinationDialog open={open} onClose={closeDialog} />
      {clearing && (
        <ConfirmDialog
          title={clearTitle(clearing.name)} confirmLabel="Clear queue" confirmColor="warning"
          onCancel={() => setClearing(null)} onConfirm={() => clear(clearing)}
        >
          <Typography variant="body2">{clearBody(queueOf(clearing.id)?.waiting ?? 0)}</Typography>
          <Typography variant="body2" color="text.secondary">{CLEAR_KEEPS}</Typography>
        </ConfirmDialog>
      )}
      {confirming && (
        <ConfirmDeleteDialog name={confirming.name} onCancel={() => setConfirming(null)} onConfirm={() => remove(confirming)}>
          <DeleteWarning users={usersOf(confirming.id)} />
        </ConfirmDeleteDialog>
      )}
    </Stack>
  );
}

import { useEffect, useMemo, useState } from "react";
import { Alert, AlertTitle, Box, Button, Grid, LinearProgress, Paper, Stack, Typography, useMediaQuery, useTheme } from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import { useNavigate } from "react-router";
import { PageTitle } from "../layout/PageTitle";
import {
  deleteDestination, duplicateDestination, listDiscordDestinationSettings, listPushDevices, rotateSigningSecret, sendTest,
  type CreatedDestination, type Destination, type DiscordSettingsSummary, type PushDevice, type SubscriptionWithLinks,
} from "../lib/api";
import { currentEndpoint } from "../pwa/push";
import { errorText, useNotify } from "../app/hooks";
import { DestinationCard } from "./DestinationCard";
import { DestinationDialog, SecretDialog } from "./DestinationDialog";

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

export function DestinationsPage({ dests, subs, loading, reload }: Props) {
  const notify = useNotify();
  const navigate = useNavigate();
  const mobile = useMediaQuery(useTheme().breakpoints.down("sm"));
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState<{ value: string; name: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const usedBy = (id: string) => subs.filter((s) => s.destinations.includes(id)).length;

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

  const membersOf = (id: string) => devices.filter((d) => d.destination_ids.includes(id));
  const summaryOf = (id: string) => discord.find((s) => s.destination_id === id) ?? null;

  const openDialog = () => {
    setOpen(true);
  };

  const closeDialog = () => {
    setOpen(false);
  };

  const onCreated = async (d: CreatedDestination) => {
    setOpen(false);
    if (d.signing_secret) setSecret({ value: d.signing_secret, name: d.name });
    notify(`Added ${d.name}`);
    await reload();
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

  const test = (d: Destination) =>
    void run(d.id, async () => {
      await sendTest(d.id);
      notify(`Test spot sent to ${d.name}`);
    });

  // Page 5's blocked alert: one per blocked device that some push destination still sends to.
  const blockedAlerts = devices
    .filter((dev) => dev.blocked_at !== null)
    .map((dev) => ({ dev, members: dests.filter((d) => d.type === "push" && dev.destination_ids.includes(d.id)) }))
    .filter(({ members }) => members.length > 0);

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
      {dests.filter((d) => d.health === "failing").map((d) => (
        <Alert
          severity="error" key={d.id}
          action={<Button color="inherit" size="small" disabled={busyId === d.id} onClick={() => test(d)}>Send test</Button>}
        >
          <AlertTitle>{d.name} is failing</AlertTitle>
          The last {d.consecutive_failures} deliveries returned {d.last_error ?? "an error"}. Spots for {usedBy(d.id)}{" "}
          connection{usedBy(d.id) === 1 ? "" : "s"} are not being sent. Check the URL, then send a test.
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
                dest={d} usedBy={usedBy(d.id)} devices={membersOf(d.id)} discord={summaryOf(d.id)} busy={busyId === d.id} mobile={mobile}
                onSendTest={() => test(d)}
                onRotateSecret={() => void run(d.id, async () => {
                  const value = await rotateSigningSecret(d.id);
                  setSecret({ value, name: d.name });
                })}
                onEdit={() => void navigate(`/destinations/${d.id}`)}
                onDuplicate={() => void run(d.id, async () => {
                  const id = await duplicateDestination(d.id);
                  notify(`Duplicated ${d.name}`);
                  await reload();
                  await navigate(`/destinations/${id}`);
                })}
                onDelete={() => void run(d.id, async () => {
                  await deleteDestination(d.id);
                  await reload();
                  notify(`Deleted ${d.name}`);
                })}
              />
            </Grid>
          ))}
        </Grid>
      )}
      <DestinationDialog open={open} onClose={closeDialog} onCreated={(d) => void onCreated(d)} />
      <SecretDialog
        secret={secret?.value ?? null} name={secret?.name ?? ""}
        onClose={() => setSecret(null)}
      />
    </Stack>
  );
}

import { useState } from "react";
import {
  Alert, Box, Button, Divider, IconButton, LinearProgress, List, ListItem, ListItemText, Paper, Stack, Tooltip, Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import { PageTitle } from "../layout/PageTitle";
import {
  deleteDestination, rotateSigningSecret, sendTest, type CreatedDestination, type Destination, type SubscriptionWithLinks,
} from "../lib/api";
import { errorText, useNotify } from "../app/hooks";
import { useTour } from "../tour/hooks";
import { DestinationDialog, SecretDialog } from "./DestinationDialog";
import { HealthChip } from "./HealthChip";
import { typeLabel } from "./types";

interface Props {
  dests: Destination[];
  subs: SubscriptionWithLinks[];
  loading: boolean;
  reload: () => Promise<void>;
}

export function DestinationsPage({ dests, subs, loading, reload }: Props) {
  const notify = useNotify();
  const tour = useTour();
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState<{ value: string; name: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const usedBy = (id: string) => subs.filter((s) => s.destinations.includes(id)).length;

  const openDialog = () => {
    setOpen(true);
    tour.report("destination-dialog-opened");
  };

  const closeDialog = () => {
    setOpen(false);
    tour.report("destination-dialog-closed");
  };

  // The secret dialog opens and the tour advances in the same render that closes the form, so the
  // tour never points at an unmounted form while the list reloads. The Send test row the next step
  // needs appears with the reload; Joyride waits for it.
  const onCreated = async (d: CreatedDestination) => {
    setOpen(false);
    if (d.signing_secret) setSecret({ value: d.signing_secret, name: d.name });
    tour.report("destination-created", { destinationId: d.id, secret: d.signing_secret !== null });
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

  return (
    <Stack spacing={3}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ justifyContent: "space-between", alignItems: { sm: "flex-end" } }}>
        <Box>
          <PageTitle>Destinations</PageTitle>
          <Typography color="text.secondary">Places Long Lines can deliver spots. A destination does nothing until a subscription sends spots to it.</Typography>
        </Box>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openDialog} data-tour="add-destination" sx={{ flexShrink: 0 }}>Add destination</Button>
      </Stack>
      {loading && <LinearProgress />}
      {!loading && dests.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: "center" }}>
          <Typography gutterBottom>No destinations yet.</Typography>
          <Button onClick={openDialog}>Add your first destination</Button>
        </Paper>
      ) : (
        <Paper variant="outlined">
          <List disablePadding>
            {dests.map((d, i) => (
              <Box key={d.id}>
                {i > 0 && <Divider component="li" />}
                <ListItem sx={{ display: "flex", flexDirection: { xs: "column", sm: "row" }, alignItems: { xs: "stretch", sm: "center" }, gap: 1 }}>
                  <ListItemText
                    sx={{ minWidth: 0 }}
                    primary={
                      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
                        <Typography component="span">{d.name}</Typography>
                        <HealthChip health={d.health} />
                      </Stack>
                    }
                    secondary={
                      <>
                        <Box component="span" sx={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {typeLabel(d.type)} · {d.url_display}
                        </Box>
                        <Box component="span" sx={{ display: "block" }}>
                          Used by {usedBy(d.id)} subscription{usedBy(d.id) === 1 ? "" : "s"}
                        </Box>
                      </>
                    }
                    slotProps={{ secondary: { component: "div" } }}
                  />
                  <Stack direction="row" spacing={1} sx={{ alignItems: "center", justifyContent: { xs: "space-between", sm: "flex-end" }, flexShrink: 0 }}>
                    {d.type === "webhook" && (
                      <Button
                        size="small" disabled={busyId === d.id}
                        onClick={() => void run(d.id, async () => {
                          const value = await rotateSigningSecret(d.id);
                          setSecret({ value, name: d.name });
                        })}
                      >
                        Rotate secret
                      </Button>
                    )}
                    <Button
                      size="small" variant="outlined" disabled={busyId === d.id}
                      data-tour={d.id === tour.destinationId ? "send-test" : undefined}
                      onClick={() => void run(d.id, async () => {
                        await sendTest(d.id);
                        notify(`Test spot sent to ${d.name}`);
                        tour.report("test-sent");
                      })}
                    >
                      Send test
                    </Button>
                    <Tooltip title={usedBy(d.id) ? "Remove it from its subscriptions first" : "Delete"}>
                      <Box component="span">
                        <IconButton
                          aria-label={`Delete ${d.name}`} disabled={usedBy(d.id) > 0 || busyId === d.id}
                          onClick={() => void run(d.id, async () => {
                            await deleteDestination(d.id);
                            await reload();
                            notify(`Deleted ${d.name}`);
                          })}
                        >
                          <DeleteIcon />
                        </IconButton>
                      </Box>
                    </Tooltip>
                  </Stack>
                </ListItem>
              </Box>
            ))}
          </List>
        </Paper>
      )}
      {dests.filter((d) => d.health === "failing").map((d) => (
        <Alert severity="warning" key={d.id}>
          {d.name} has returned errors for the last {d.consecutive_failures} deliveries. Spots are queued and will retry for 24 hours.
        </Alert>
      ))}
      <DestinationDialog open={open} onClose={closeDialog} onCreated={(d) => void onCreated(d)} />
      <SecretDialog
        secret={secret?.value ?? null} name={secret?.name ?? ""}
        onClose={() => {
          setSecret(null);
          tour.report("secret-dismissed");
        }}
      />
    </Stack>
  );
}

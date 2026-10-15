import { useEffect, useState } from "react";
import {
  Box, Button, Card, CardActions, CardContent, Chip, Divider, Grid, LinearProgress, Stack, Switch, Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import SendIcon from "@mui/icons-material/Send";
import WarningIcon from "@mui/icons-material/Warning";
import { Link as RouterLink, useNavigate } from "react-router";
import { PageTitle } from "../layout/PageTitle";
import {
  deleteSubscription, listGroups, previewSubscription, setSubscriptionEnabled, type Destination, type Preview, type SubscriptionWithLinks,
} from "../lib/api";
import type { CallsignGroup } from "../groups/types";
import { errorText, useNotify } from "../app/hooks";
import { sourceName } from "../sources/sources";
import { linkedDestinations, quietLabel, ruleSummaries, singleSource, toInput } from "./model";
import { SourcePickerDialog } from "./SourcePickerDialog";

interface Props {
  subs: SubscriptionWithLinks[];
  dests: Destination[];
  loading: boolean;
  reload: () => Promise<void>;
  mobile: boolean;
}

function SourceLine({ sources }: { sources: string[] }) {
  const one = singleSource(sources);
  if (one) {
    return (
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
        <Chip size="small" color={one.markColor} label={one.name} />
        <Typography variant="body2">{one.full}</Typography>
      </Stack>
    );
  }
  // Older subscriptions can list several sources, or none for "any source".
  return (
    <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
      {sources.length ? sources.map((s) => <Chip key={s} size="small" label={sourceName(s)} />) : <Chip size="small" label="All sources" />}
    </Stack>
  );
}

function DestinationLine({ dests }: { dests: Destination[] }) {
  return (
    <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
      <SendIcon fontSize="small" color="action" aria-label="Sends to" />
      {dests.length === 0 && <Chip size="small" variant="outlined" label="No destinations" />}
      {dests.map((d) => d.health === "failing"
        ? <Chip key={d.id} size="small" color="warning" icon={<WarningIcon />} label={d.name} />
        : <Chip key={d.id} size="small" label={d.name} />)}
    </Stack>
  );
}

function hitsText(sub: SubscriptionWithLinks, preview: Preview | undefined): string | null {
  if (sub.destinations.length === 0) return "Waiting for a destination";
  if (!sub.enabled) return "Paused";
  if (!preview) return null;
  const one = singleSource(sub.sources);
  return `${preview.count} of the last ${preview.window_size} ${one ? `${one.name} ` : ""}spots passed`;
}

export function SubscriptionsPage({ subs, dests, loading, reload, mobile }: Props) {
  const notify = useNotify();
  const navigate = useNavigate();
  const [picking, setPicking] = useState(false);
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  // Names for the group rule lines. null until loaded, and if loading fails.
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

  // "N of the last M spots passed", from the same predicate the matcher uses.
  useEffect(() => {
    let active = true;
    void Promise.all(subs.map(async (s) => [s.id, await previewSubscription(toInput(s)).catch(() => null)] as const))
      .then((pairs) => {
        if (!active) return;
        setPreviews(Object.fromEntries(pairs.filter((p): p is readonly [string, Preview] => p[1] !== null)));
      });
    return () => {
      active = false;
    };
  }, [subs]);

  const startNew = () => {
    setPicking(true);
  };

  const cancelPick = () => {
    setPicking(false);
  };

  const pick = (source: string) => void navigate(`/subscriptions/new?source=${encodeURIComponent(source)}`);

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
          <Typography color="text.secondary">
            {mobile
              ? "One source, a filter, and zero or more destinations."
              : "A subscription takes spots from one source, filters them, and sends the ones that pass to zero or more destinations."}
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<AddIcon />} onClick={startNew} fullWidth={mobile} sx={{ flexShrink: 0 }}>
          New subscription
        </Button>
      </Stack>
      {loading && <LinearProgress />}
      <Grid container spacing={2}>
        {subs.map((s) => {
          const rules = ruleSummaries(toInput(s).rules, groups);
          const hits = hitsText(s, previews[s.id]);
          return (
            <Grid size={{ xs: 12, md: 6 }} key={s.id}>
              <Card variant="outlined" sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
                <CardContent sx={{ flexGrow: 1 }}>
                  <Stack spacing={1.5}>
                    <Stack direction="row" spacing={1} sx={{ justifyContent: "space-between", alignItems: "center" }}>
                      <Typography variant="h6" sx={{ minWidth: 0, overflowWrap: "anywhere" }}>{s.name}</Typography>
                      {/* With no destinations the matcher skips it whatever enabled says, so show it off. */}
                      <Switch
                        checked={s.enabled && s.destinations.length > 0} disabled={s.destinations.length === 0}
                        onChange={(e) => void toggle(s, e.target.checked)}
                        slotProps={{ input: { "aria-label": `${s.name} on` } }}
                      />
                    </Stack>
                    <SourceLine sources={s.sources} />
                    {rules.length > 0 && (
                      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
                        {rules.map((r, i) => [
                          r.join && <Typography key={`join-${i}`} variant="body2" color="text.secondary">{r.join}</Typography>,
                          <Typography key={`label-${i}`} variant="body2" color="text.secondary">{r.label}</Typography>,
                          ...r.values.map((v) => <Chip key={`value-${i}-${v}`} size="small" variant="outlined" label={v} />),
                        ])}
                      </Stack>
                    )}
                    <DestinationLine dests={linkedDestinations(s.destinations, dests)} />
                    <Typography variant="body2" color="text.secondary">
                      {[quietLabel(s.quiet_minutes), hits].filter(Boolean).join(" · ")}
                    </Typography>
                  </Stack>
                </CardContent>
                <Divider />
                <CardActions>
                  <Button size="small" startIcon={<EditIcon />} component={RouterLink} to={`/subscriptions/${s.id}`}>Edit</Button>
                  <Button size="small" color="error" startIcon={<DeleteIcon />} onClick={() => void remove(s)}>Delete</Button>
                </CardActions>
              </Card>
            </Grid>
          );
        })}
      </Grid>
      {picking && <SourcePickerDialog open fullScreen={mobile} onClose={cancelPick} onContinue={pick} />}
    </Stack>
  );
}

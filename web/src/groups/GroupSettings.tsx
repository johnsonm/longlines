import { useEffect, useState } from "react";
import {
  Alert, Box, Button, Card, CardContent, CardHeader, Chip, Divider, Grid, LinearProgress, Stack, Switch, TextField, Tooltip, Typography,
} from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DeleteIcon from "@mui/icons-material/Delete";
import { Link as RouterLink, useNavigate } from "react-router";
import { deleteGroup, listGroups, loadSubscriptions, saveGroup, type SubscriptionWithLinks } from "../lib/api";
import { errorText, useNotify } from "../app/hooks";
import { plural } from "../profile/format";
import { sourceName } from "../sources/sources";
import { fmt } from "../stats/format";
import { MemberEditor } from "./MemberEditor";
import { PublicConfirmDialog } from "./PublicConfirmDialog";
import { linkLabel, publicUrl } from "./stats/model";
import type { OwnerGroup } from "./stats/types";

interface Stored {
  name: string;
  calls: string[];
  isPublic: boolean;
  show: boolean;
}

/**
 * The Settings tab: the public page and its link, name, members, the
 * connections that use the group, and Delete. One Save changes saves name,
 * members and sharing through save_callsign_group.
 */
export function GroupSettings({ group, onSaved }: { group: OwnerGroup; onSaved: () => Promise<void> }) {
  const notify = useNotify();
  const navigate = useNavigate();
  const [stored, setStored] = useState<Stored | null>(null);
  const [form, setForm] = useState<Stored | null>(null);
  const [usedBy, setUsedBy] = useState<SubscriptionWithLinks[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([listGroups(), loadSubscriptions()])
      .then(([groups, subs]) => {
        if (!live) return;
        const calls = groups.find((g) => g.id === group.id)?.callsigns ?? [];
        const s = { name: group.name, calls, isPublic: group.public, show: group.show_callsigns };
        setStored(s);
        setForm(s);
        setUsedBy(subs.filter((sub) => sub.group_ids.includes(group.id)));
      })
      .catch((err: unknown) => {
        if (live) setError(errorText(err, "Couldn't load the group."));
      });
    return () => {
      live = false;
    };
  }, [group]);

  if (error && !form) return <Alert severity="error">{error}</Alert>;
  if (!form || !stored) return <LinearProgress />;

  const set = (patch: Partial<Stored>) => setForm({ ...form, ...patch });
  const url = group.public_slug ? publicUrl(window.location.origin, group.public_slug) : null;
  const used = group.subscription_count;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const name = form.name.trim();
      await saveGroup({ id: group.id, name, callsigns: form.calls, public: form.isPublic, show_callsigns: form.show });
      setStored({ ...form, name });
      notify("Saved changes");
      await onSaved();
    } catch (err) {
      setError(errorText(err, "Couldn't save the group."));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      notify("Link copied");
    } catch {
      notify("Couldn't copy the link.");
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await deleteGroup(group.id);
      notify(`Deleted ${group.name}`);
      void navigate("/groups");
    } catch (err) {
      notify(errorText(err, "Couldn't delete the group."));
      setBusy(false);
    }
  };

  return (
    <Stack spacing={3}>
      {error && <Alert severity="error">{error}</Alert>}
      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Stack direction="row" spacing={2} sx={{ justifyContent: "space-between", alignItems: "flex-start" }}>
              <Box>
                <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                  <Typography variant="h6" component="h2">Public statistics page</Typography>
                  <Chip
                    size="small" label={form.isPublic ? "Public" : "Private"} color={form.isPublic ? "success" : "default"}
                    variant={form.isPublic ? "filled" : "outlined"}
                  />
                </Stack>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  {form.isPublic
                    ? "Anyone with the link can see this page, without signing in. Your settings and member list are never shown."
                    : "Only you can see this page, when you are signed in. Turn this on to share the club statistics with a link."}
                </Typography>
              </Box>
              <Switch
                checked={form.isPublic}
                onChange={(e) => (e.target.checked ? setConfirming(true) : set({ isPublic: false }))}
                slotProps={{ input: { "aria-label": "Public statistics page" } }}
              />
            </Stack>
            {form.isPublic && (
              <>
                <Divider />
                {url && stored.isPublic && (
                  <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ alignItems: { sm: "center" } }}>
                    <Box sx={{ flexGrow: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      <code>{linkLabel(url)}</code>
                    </Box>
                    <Button variant="outlined" startIcon={<ContentCopyIcon />} onClick={() => void copy()}>Copy link</Button>
                    <Button variant="outlined" component={RouterLink} to={`/g/${group.public_slug}`}>Open page</Button>
                  </Stack>
                )}
                <Stack direction="row" spacing={2} sx={{ justifyContent: "space-between", alignItems: "center" }}>
                  <Box>
                    <Typography variant="body1">Show each member&apos;s callsign</Typography>
                    <Typography variant="body2" color="text.secondary">
                      Off shows club totals only. Rankings and top operators are hidden.
                    </Typography>
                  </Box>
                  <Switch
                    checked={form.show} onChange={(e) => set({ show: e.target.checked })}
                    slotProps={{ input: { "aria-label": "Show callsigns" } }}
                  />
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  The link is not listed anywhere and search engines are asked not to index it. Turn this off and the link stops working right away.
                </Typography>
              </>
            )}
          </Stack>
        </CardContent>
      </Card>
      <Stack direction="row" spacing={1} sx={{ justifyContent: "flex-end" }}>
        <Button onClick={() => setForm(stored)} disabled={busy}>Cancel</Button>
        <Button variant="contained" onClick={() => void save()} disabled={busy || !form.name.trim()}>Save changes</Button>
      </Stack>

      <Grid container spacing={3}>
        <Grid size={{ xs: 12, md: 7 }}>
          <Stack spacing={3}>
            <Card variant="outlined">
              <CardHeader title="Name" subheader="Shown on the statistics page and in connection rules" slotProps={{ title: { variant: "h6" } }} />
              <CardContent sx={{ pt: 0 }}>
                <TextField
                  label="Name" value={form.name} onChange={(e) => set({ name: e.target.value })} required fullWidth
                  helperText="Names are unique. A name can be reused after the group that has it is deleted."
                />
              </CardContent>
            </Card>
            <Card variant="outlined">
              <CardHeader title="Members" subheader={`${fmt(form.calls.length)} of 1,000 callsigns`} slotProps={{ title: { variant: "h6" } }} />
              <CardContent sx={{ pt: 0 }}>
                <MemberEditor calls={form.calls} onChange={(calls) => set({ calls })} />
              </CardContent>
            </Card>
          </Stack>
        </Grid>
        <Grid size={{ xs: 12, md: 5 }}>
          <Stack spacing={3}>
            <Card variant="outlined">
              <CardHeader title="Used by" subheader="Connections that use this group in a rule" slotProps={{ title: { variant: "h6" } }} />
              <CardContent sx={{ pt: 0 }}>
                {usedBy.length === 0
                  ? <Typography variant="body2" color="text.secondary">Not used by any connection</Typography>
                  : (
                    <Stack spacing={1}>
                      {usedBy.map((s) => (
                        <Stack key={s.id} direction="row" spacing={1} sx={{ justifyContent: "space-between", alignItems: "center" }}>
                          <Typography variant="body2">{s.name}</Typography>
                          <Stack direction="row" spacing={0.5}>
                            {s.sources.map((src) => <Chip key={src} size="small" color="primary" variant="outlined" label={sourceName(src)} />)}
                          </Stack>
                        </Stack>
                      ))}
                    </Stack>
                  )}
              </CardContent>
            </Card>
            <Card variant="outlined">
              <CardHeader
                title="Delete group" subheader="Removes the group and its public page. Remove it from connections first."
                slotProps={{ title: { variant: "h6" } }}
              />
              <CardContent sx={{ pt: 0 }}>
                <Tooltip title={used > 0 ? `Used by ${plural(used, "connection", "connections")}. Remove it from them first.` : ""}>
                  <Box component="span">
                    <Button color="error" variant="outlined" startIcon={<DeleteIcon />} disabled={used > 0 || busy} onClick={() => void remove()}>
                      Delete group
                    </Button>
                  </Box>
                </Tooltip>
              </CardContent>
            </Card>
          </Stack>
        </Grid>
      </Grid>
      {confirming && (
        <PublicConfirmDialog
          memberCount={form.calls.length}
          initialShow={form.show}
          onKeepPrivate={() => {
            setConfirming(false);
            set({ isPublic: false });
          }}
          onMakePublic={(show) => {
            setConfirming(false);
            set({ isPublic: true, show });
          }}
        />
      )}
    </Stack>
  );
}

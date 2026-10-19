import { useState } from "react";
import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Paper, Stack, Switch, TextField, Typography,
  useMediaQuery, type Theme,
} from "@mui/material";
import { normalizeCallsigns, saveGroup } from "../lib/api";
import { errorText } from "../app/hooks";
import { PublicConfirmDialog } from "./PublicConfirmDialog";
import { splitCallsigns } from "./parse";

interface Props {
  onClose: () => void;
  onCreated: (id: string, name: string) => void;
}

/**
 * New group: a name, a paste box of callsigns and the public page switch. The
 * calls go to save_callsign_group as typed; SQL turns them into base calls and
 * refuses a value that isn't a callsign ("Not a callsign: X."), so the dialog
 * stays open to fix it. Members are edited later on the Settings tab.
 */
export function NewGroupDialog({ onClose, onCreated }: Props) {
  const mobile = useMediaQuery((t: Theme) => t.breakpoints.down("sm"));
  const [name, setName] = useState("");
  const [calls, setCalls] = useState("");
  const [isPublic, setPublic] = useState(false);
  const [showCallsigns, setShowCallsigns] = useState(false);
  // The confirm dialog's member count: the base calls SQL would store, null while it is being worked out.
  const [confirming, setConfirming] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    const values = splitCallsigns(calls);
    try {
      setConfirming(values.length === 0 ? 0 : (await normalizeCallsigns(values)).callsigns.length);
    } catch (err) {
      setError(errorText(err, "Couldn't check those callsigns."));
    }
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const trimmed = name.trim();
      const id = await saveGroup({ name: trimmed, callsigns: splitCallsigns(calls), public: isPublic, show_callsigns: showCallsigns });
      onCreated(id, trimmed);
    } catch (err) {
      setError(errorText(err, "Couldn't save the group."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog open onClose={onClose} fullWidth maxWidth="sm" fullScreen={mobile}>
        <DialogTitle>New group</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <Typography variant="body2" color="text.secondary">Name the group and add its callsigns. You can add more later.</Typography>
            {error && <Alert severity="error">{error}</Alert>}
            <TextField
              label="Name" value={name} onChange={(e) => setName(e.target.value)} required fullWidth
              helperText="Names are unique. A name can be reused after the group that has it is deleted."
            />
            <TextField
              label="Callsigns" value={calls} onChange={(e) => setCalls(e.target.value)} multiline minRows={3} maxRows={10} fullWidth
              helperText="Separate with commas, spaces or new lines. You can also import a CSV later."
            />
            <Paper variant="outlined">
              <Stack direction="row" spacing={2} sx={{ alignItems: "center", justifyContent: "space-between", px: 2, py: 1.5 }}>
                <Box>
                  <Typography variant="body1">Public statistics page</Typography>
                  <Typography variant="body2" color="text.secondary">
                    Off by default. When on, anyone with the link can see the club statistics.
                  </Typography>
                </Box>
                <Switch
                  checked={isPublic}
                  onChange={(e) => (e.target.checked ? void confirm() : setPublic(false))}
                  slotProps={{ input: { "aria-label": "Public statistics page" } }}
                />
              </Stack>
            </Paper>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="contained" onClick={() => void create()} disabled={!name.trim() || busy}>Create group</Button>
        </DialogActions>
      </Dialog>
      {confirming !== null && (
        <PublicConfirmDialog
          memberCount={confirming}
          initialShow={showCallsigns}
          onKeepPrivate={() => {
            setConfirming(null);
            setPublic(false);
          }}
          onMakePublic={(show) => {
            setConfirming(null);
            setPublic(true);
            setShowCallsigns(show);
          }}
        />
      )}
    </>
  );
}

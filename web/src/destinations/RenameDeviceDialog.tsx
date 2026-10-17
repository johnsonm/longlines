import { useState } from "react";
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField } from "@mui/material";
import { renamePushDevice, type PushDevice } from "../lib/api";
import { errorText, useApp } from "../app/hooks";

interface Props {
  device: PushDevice;
  onClose: () => void;
  /** The device was renamed; the caller reloads its list. */
  onRenamed: () => void;
}

/** A one-field dialog: the user's name for a device (rename_push_device). */
export function RenameDeviceDialog({ device, onClose, onRenamed }: Props) {
  const { notify } = useApp();
  const [label, setLabel] = useState(device.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rename = async () => {
    setBusy(true);
    setError(null);
    try {
      await renamePushDevice(device.id, label.trim());
      notify(`Renamed ${label.trim()}`);
      onRenamed();
    } catch (err) {
      setError(errorText(err, "Couldn't rename the device."));
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={busy ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>Rename device</DialogTitle>
      <DialogContent>
        <TextField
          label="Device name" value={label} onChange={(e) => setLabel(e.target.value)} fullWidth autoFocus disabled={busy}
          error={error !== null} helperText={error ?? device.agent} sx={{ mt: 1 }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="contained" disabled={busy || !label.trim()} onClick={() => void rename()}>Rename</Button>
      </DialogActions>
    </Dialog>
  );
}

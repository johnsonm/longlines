import { useState } from "react";
import {
  Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControl, FormControlLabel, FormLabel,
  Radio, RadioGroup, Stack, TextField,
} from "@mui/material";
import { createDestination, type CreatedDestination, type DestinationType } from "../lib/api";
import { errorText } from "../app/hooks";
import { DEST_TYPES, typeLabel } from "./types";

export function DestinationDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (d: CreatedDestination) => void }) {
  const [type, setType] = useState<DestinationType>("discord");
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = DEST_TYPES.find((d) => d.id === type)!;

  const reset = () => {
    setType("discord");
    setName("");
    setTarget("");
    setError(null);
  };
  const close = () => {
    reset();
    onClose();
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await createDestination(type, name.trim() || typeLabel(type), target.trim());
      reset();
      onCreated(created);
    } catch (err) {
      setError(errorText(err, "Couldn't add the destination."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={close} fullWidth maxWidth="sm">
      <DialogTitle>Add destination</DialogTitle>
      <DialogContent dividers>
        <FormControl sx={{ mb: 2 }}>
          <FormLabel>Where should spots go?</FormLabel>
          <RadioGroup value={type} onChange={(e) => setType(e.target.value as DestinationType)}>
            {DEST_TYPES.map((d) => <FormControlLabel key={d.id} value={d.id} control={<Radio />} label={d.label} />)}
          </RadioGroup>
        </FormControl>
        <Alert severity="info" sx={{ mb: 2 }}>{t.help}</Alert>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        <Stack spacing={2}>
          <TextField label="Name" placeholder="e.g. Club Discord" value={name} onChange={(e) => setName(e.target.value)} fullWidth />
          {type === "discord" && (
            <TextField
              label="Discord webhook URL" placeholder="https://discord.com/api/webhooks/…" value={target} onChange={(e) => setTarget(e.target.value)}
              fullWidth helperText="Channel settings → Integrations → Webhooks → Copy URL"
            />
          )}
          {type === "webhook" && (
            <TextField
              label="Endpoint URL" placeholder="https://example.com/spots" value={target} onChange={(e) => setTarget(e.target.value)}
              fullWidth helperText="We'll show the signing secret once the destination is added."
            />
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={busy}>Cancel</Button>
        <Button variant="contained" onClick={() => void save()} disabled={!target || busy}>Add destination</Button>
      </DialogActions>
    </Dialog>
  );
}

/** Shows a signing secret exactly once. */
export function SecretDialog({ secret, name, onClose }: { secret: string | null; name: string; onClose: () => void }) {
  return (
    // No onClose on the Dialog: a backdrop click or Escape would lose the secret before it's copied.
    <Dialog open={secret !== null} fullWidth maxWidth="sm">
      <DialogTitle>Signing secret for {name}</DialogTitle>
      <DialogContent dividers>
        <Alert severity="warning" sx={{ mb: 2 }}>Copy it now. This is the only time it's shown.</Alert>
        <TextField
          label="Signing secret" value={secret ?? ""} fullWidth
          slotProps={{ input: { readOnly: true } }}
          helperText="Verify the X-LongLines-Signature header with this secret."
          onFocus={(e) => e.target.select()}
        />
      </DialogContent>
      <DialogActions>
        <Button variant="contained" onClick={onClose}>Done</Button>
      </DialogActions>
    </Dialog>
  );
}

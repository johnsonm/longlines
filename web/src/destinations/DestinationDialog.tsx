import { useState } from "react";
import {
  Alert, Box, Button, Card, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Radio, RadioGroup, Stack, TextField,
  Typography,
} from "@mui/material";
import { styled } from "@mui/material/styles";
import { useNavigate } from "react-router";
import { createDestination, type CreatedDestination, type DestinationType } from "../lib/api";
import { errorText } from "../app/hooks";
import { DEST_TYPES, typeLabel } from "./types";

/** An outlined card that takes the primary border while its radio is selected. */
const TypeCard = styled(Card, { shouldForwardProp: (prop) => prop !== "selected" })<{ selected: boolean }>(({ theme, selected }) => ({
  borderColor: selected ? theme.palette.primary.main : undefined,
  boxShadow: selected ? `inset 0 0 0 1px ${theme.palette.primary.main}` : undefined,
}));

/**
 * Add destination, in two steps: pick a type (page 5), then its details.
 * Only a webhook takes its name and URL here; Discord and push go to their
 * editors at /destinations/new?type=discord and ?type=push, since both have
 * settings beyond a URL.
 */
export function DestinationDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (d: CreatedDestination) => void }) {
  const navigate = useNavigate();
  const [step, setStep] = useState<"type" | "details">("type");
  const [type, setType] = useState<DestinationType>("discord");
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setStep("type");
    setType("discord");
    setName("");
    setTarget("");
    setError(null);
  };
  const close = () => {
    reset();
    onClose();
  };
  const next = () => {
    if (type === "push" || type === "discord") {
      close();
      void navigate(`/destinations/new?type=${type}`);
      return;
    }
    setStep("details");
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
      {step === "type" ? (
        <>
          <DialogContent dividers>
            <Typography color="text.secondary" sx={{ mb: 2 }}>
              Pick where matching spots should go. You can add as many of each type as you like, for example one push destination per source or
              per device.
            </Typography>
            <RadioGroup aria-label="Destination type" value={type} onChange={(e) => setType(e.target.value as DestinationType)}>
              <Stack spacing={1.5}>
                {DEST_TYPES.map((t) => {
                  const selected = type === t.id;
                  const Icon = t.icon;
                  return (
                    <TypeCard key={t.id} variant="outlined" selected={selected}>
                      <FormControlLabel
                        value={t.id} control={<Radio />}
                        sx={{ m: 0, px: 1, py: 1.5, width: "100%", alignItems: "center" }}
                        slotProps={{ typography: { component: "div", sx: { flexGrow: 1, minWidth: 0 } } }}
                        label={
                          <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
                            <Icon color={selected ? "primary" : "action"} />
                            <Box>
                              <Typography>{t.label}</Typography>
                              <Typography variant="body2" color="text.secondary">{t.help}</Typography>
                            </Box>
                          </Stack>
                        }
                      />
                    </TypeCard>
                  );
                })}
              </Stack>
            </RadioGroup>
          </DialogContent>
          <DialogActions>
            <Button onClick={close}>Cancel</Button>
            <Button variant="contained" onClick={next}>Continue</Button>
          </DialogActions>
        </>
      ) : (
        <>
          <DialogContent dividers>
            <Typography color="text.secondary" sx={{ mb: 2 }}>{typeLabel(type)}</Typography>
            {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
            <Stack spacing={2}>
              <TextField label="Name" placeholder="e.g. Club Discord" value={name} onChange={(e) => setName(e.target.value)} fullWidth />
              <TextField
                label="Endpoint URL" placeholder="https://example.com/spots" value={target} onChange={(e) => setTarget(e.target.value)}
                fullWidth helperText="We'll show the signing secret once the destination is added."
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={close} disabled={busy}>Cancel</Button>
            <Button variant="contained" onClick={() => void save()} disabled={!target || busy}>Add destination</Button>
          </DialogActions>
        </>
      )}
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

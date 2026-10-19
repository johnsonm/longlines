import { useState } from "react";
import {
  Alert, AlertTitle, Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Paper, Stack, Typography,
} from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import { createdSentence } from "./webhookModel";

export interface SigningSecretDialogProps {
  /** "created" after Add destination, "rotated" after Rotate. */
  variant: "created" | "rotated";
  /** The destination's name, as saved. */
  name: string;
  /** The saved grouping window, for the created sentence. */
  batchSeconds: number;
  /** The new secret; the dialog is open while it is set. */
  secret: string | null;
  onDone: () => void;
}

/**
 * Shows a webhook's signing secret, the only time it is ever readable
 * (create and rotate). Done stays disabled until "I have saved the secret"
 * is checked. The parent keys the dialog per secret, so Copied and the
 * checkbox start over each time.
 */
export function SigningSecretDialog({ variant, name, batchSeconds, secret, onDone }: SigningSecretDialogProps) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  const copy = async () => {
    if (secret === null) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      // The clipboard can be refused (no permission, an insecure context); the secret stays on screen to copy by hand.
      setCopied(false);
    }
  };

  return (
    // No onClose on the Dialog: a backdrop click or Escape would lose the secret before it's copied.
    <Dialog open={secret !== null} fullWidth maxWidth="sm" aria-labelledby="signing-secret-title">
      <DialogTitle id="signing-secret-title">{variant === "created" ? "Destination added" : "Signing secret rotated"}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Typography>
            {variant === "created"
              ? createdSentence(name, batchSeconds)
              : `${name} signs requests with this new secret from now on. The old one no longer works.`}
          </Typography>
          <Alert severity="warning">
            <AlertTitle>Copy your signing secret now</AlertTitle>
            It is shown once. We use it to sign each request so you can check it came from Long Lines. If you lose it, rotate it from this destination.
          </Alert>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <Paper variant="outlined" sx={{ px: 1.5, py: 1, flexGrow: 1, minWidth: 0, overflow: "hidden" }}>
              {/* A bare <code> keeps the browser's monospace font; MUI 9 has no fontFamily prop. */}
              <Box component="code" data-testid="signing-secret" sx={{ display: "block", overflowWrap: "anywhere" }}>{secret}</Box>
            </Paper>
            <Button variant="outlined" startIcon={<ContentCopyIcon />} onClick={() => void copy()} sx={{ flexShrink: 0 }}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </Stack>
          <FormControlLabel
            label="I have saved the secret"
            control={<Checkbox checked={saved} onChange={(e) => setSaved(e.target.checked)} />}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button variant="contained" disabled={!saved} onClick={onDone}>Done</Button>
      </DialogActions>
    </Dialog>
  );
}

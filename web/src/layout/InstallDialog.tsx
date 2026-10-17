import { Button, Dialog, DialogActions, DialogContent, DialogTitle } from "@mui/material";
import { Steps, type Step } from "./Steps";

// Safari has no install prompt: the spec's Home Screen steps, word for word.
const STEPS: Step[] = [
  { title: "Tap the Share button in Safari." },
  { title: "Choose Add to Home Screen, then Add." },
  { title: "Open Long Lines from your Home Screen." },
];

export function InstallDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Install Long Lines</DialogTitle>
      <DialogContent>
        <Steps steps={STEPS} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Done</Button>
      </DialogActions>
    </Dialog>
  );
}

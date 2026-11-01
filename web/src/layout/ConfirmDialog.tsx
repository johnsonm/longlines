import type { ReactNode } from "react";
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack } from "@mui/material";

interface Props {
  title: string;
  /** What the action does, one block per line of copy. */
  children: ReactNode;
  /** The confirm button's words, such as "Delete" or "Clear queue". */
  confirmLabel: string;
  confirmColor: "error" | "warning" | "primary";
  onCancel: () => void;
  onConfirm: () => void;
}

/** Asked before an action that can't be taken back. Cancel, Escape and the backdrop cancel. */
export function ConfirmDialog({ title, children, confirmLabel, confirmColor, onCancel, onConfirm }: Props) {
  return (
    <Dialog open onClose={onCancel} fullWidth maxWidth="xs">
      <DialogTitle sx={{ overflowWrap: "anywhere" }}>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>{children}</Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button color={confirmColor} variant="contained" onClick={onConfirm}>{confirmLabel}</Button>
      </DialogActions>
    </Dialog>
  );
}

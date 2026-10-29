import type { ReactNode } from "react";
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from "@mui/material";

interface Props {
  /** The name of what goes: the title reads "Delete {name}?". */
  name: string;
  /** Anything to say before "This can't be undone.", such as who still uses it. */
  children: ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Asked before a connection or a destination is deleted. Escape and the backdrop cancel. */
export function ConfirmDeleteDialog({ name, children, onCancel, onConfirm }: Props) {
  return (
    <Dialog open onClose={onCancel} fullWidth maxWidth="xs">
      <DialogTitle sx={{ overflowWrap: "anywhere" }}>Delete {name}?</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          {children}
          <Typography variant="body2" color="text.secondary">This can't be undone.</Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button color="error" variant="contained" onClick={onConfirm}>Delete</Button>
      </DialogActions>
    </Dialog>
  );
}

import type { ReactNode } from "react";
import { Typography } from "@mui/material";
import { ConfirmDialog } from "./ConfirmDialog";

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
    <ConfirmDialog title={`Delete ${name}?`} confirmLabel="Delete" confirmColor="error" onCancel={onCancel} onConfirm={onConfirm}>
      {children}
      <Typography variant="body2" color="text.secondary">This can't be undone.</Typography>
    </ConfirmDialog>
  );
}

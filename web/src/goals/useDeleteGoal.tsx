import { useState, type ReactNode } from "react";
import { Typography } from "@mui/material";
import { useNavigate } from "react-router";
import { ApiError, deleteGoal } from "../lib/api";
import { errorText, useNotify } from "../app/hooks";
import { ConfirmDeleteDialog } from "../layout/ConfirmDeleteDialog";
import { BlockedDeleteDialog } from "./BlockedDeleteDialog";
import type { GoalProgress, GoalUsedBy } from "./types";

interface Deleting {
  start: () => void;
  dialog: ReactNode;
}

/**
 * Delete a goal: while connections use it, the "Can't delete {name} yet" dialog lists them
 * (each opens in a new tab) with Close only; otherwise ConfirmDeleteDialog. Deleted, it goes back to
 * the index. A connection added since the page loaded makes SQL refuse with LL409: the page
 * reloads and the blocked dialog shows the fresh list.
 */
export function useDeleteGoal(progress: GoalProgress, reload: () => Promise<GoalProgress | null>): Deleting {
  const notify = useNotify();
  const navigate = useNavigate();
  const [open, setOpen] = useState<"blocked" | "confirm" | null>(null);
  const [usedBy, setUsedBy] = useState<GoalUsedBy[]>(progress.used_by);
  const name = progress.list.name;

  const start = () => {
    setUsedBy(progress.used_by);
    setOpen(progress.used_by.length > 0 ? "blocked" : "confirm");
  };

  const remove = async () => {
    setOpen(null);
    try {
      await deleteGoal(progress.list.id);
      notify(`Deleted ${name}`);
      void navigate("/goals");
    } catch (err) {
      if (err instanceof ApiError && err.code === "LL409") {
        const fresh = await reload();
        setUsedBy(fresh?.used_by ?? []);
        setOpen("blocked");
        return;
      }
      notify(errorText(err, "Couldn't delete the goal."));
    }
  };

  const dialog = open === "blocked"
    ? <BlockedDeleteDialog name={name} usedBy={usedBy} onClose={() => setOpen(null)} />
    : open === "confirm"
    ? (
      <ConfirmDeleteDialog name={name} onCancel={() => setOpen(null)} onConfirm={() => void remove()}>
        <Typography variant="body2">Its entries and what you've worked go with it.</Typography>
      </ConfirmDeleteDialog>
    )
    : null;
  return { start, dialog };
}

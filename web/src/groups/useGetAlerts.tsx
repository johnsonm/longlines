import { useState, type ReactNode } from "react";
import { useMediaQuery, type Theme } from "@mui/material";
import { useNavigate } from "react-router";
import { loadSubscriptions } from "../lib/api";
import { hasPositiveRule, toInput } from "../subscriptions/model";
import { SourcePickerDialog } from "../subscriptions/SourcePickerDialog";
import { errorText, useNotify } from "../app/hooks";

/**
 * Get alerts for a group, on its landing card and its page header. Mirrors Get
 * alerts on a callsign profile (CallsignPage), with the group in place of the
 * call: an existing connection with a positive group rule opens; otherwise
 * pick a source, then the editor opens with the group as its filter. Nothing
 * is saved until the user saves there.
 */
export function useGetAlerts(): { start: (groupId: string) => void; busyId: string | null; dialog: ReactNode } {
  const notify = useNotify();
  const navigate = useNavigate();
  const mobile = useMediaQuery((t: Theme) => t.breakpoints.down("sm"));
  const [picking, setPicking] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const start = (groupId: string) => {
    setBusyId(groupId);
    // Read fresh rather than from the app's copy, which may not have loaded yet.
    loadSubscriptions()
      .then((subs) => {
        const existing = subs.find((s) => hasPositiveRule(toInput(s).rules, "group", groupId));
        if (existing) {
          notify(`You already have ${existing.name}.`);
          void navigate(`/connections/${existing.id}`);
          return;
        }
        setPicking(groupId);
      })
      .catch((err: unknown) => notify(errorText(err, "Couldn't load your connections.")))
      .finally(() => setBusyId(null));
  };

  const pick = (source: string) => {
    if (!picking) return;
    void navigate(`/connections/new?source=${encodeURIComponent(source)}&group=${encodeURIComponent(picking)}`);
  };

  const dialog = picking
    ? <SourcePickerDialog open fullScreen={mobile} onClose={() => setPicking(null)} onContinue={pick} />
    : null;
  return { start, busyId, dialog };
}

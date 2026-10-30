import { useState } from "react";
import {
  Box, Button, Card, CardContent, Chip, Divider, LinearProgress, ListItemText, Menu, MenuItem, Stack, Typography,
} from "@mui/material";
import CheckIcon from "@mui/icons-material/Check";
import {
  KIND_LABEL, PHONE_CHIPS, atLeastNote, chipLabel, entryName, evidenceLine, percent, ruleLabel,
} from "./model";
import type { GoalEntry, GoalRequirement, GoalStatus } from "./types";

interface Props {
  req: GoalRequirement;
  status: GoalStatus;
  phone: boolean;
  now: Date;
  busy: boolean;
  /** Marks an entry worked by hand, or (false) back to needed. */
  onMark: (value: string, worked: boolean) => void;
}

/**
 * One requirement on the progress page: its rule and progress, the still-needed entries as chips
 * (a chip opens Mark as worked; phones show 12, then "Show all N needed"), and the worked entries
 * behind "Show N worked", each with how it got marked and Mark as needed.
 */
export function RequirementCard({ req, status, phone, now, busy, onMark }: Props) {
  const [showWorked, setShowWorked] = useState(false);
  const [allChips, setAllChips] = useState(false);
  const [menu, setMenu] = useState<{ el: HTMLElement; entry: GoalEntry } | null>(null);
  const needed = req.entries.filter((e) => e.worked_at === null);
  const worked = req.entries.filter((e) => e.worked_at !== null);
  const kind = KIND_LABEL[req.kind];
  const ended = status === "ended";
  const chips = phone && !allChips ? needed.slice(0, PHONE_CHIPS) : needed;

  const markWorked = () => {
    if (menu) onMark(menu.entry.value, true);
    setMenu(null);
  };

  return (
    <Card variant="outlined" component="section" aria-label={kind}>
      <CardContent>
        <Stack direction="row" spacing={1} useFlexGap sx={{ justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap" }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <Typography variant="h6" component="h2">{kind}</Typography>
            <Typography variant="body2" color="text.secondary">{`·  ${ruleLabel(req, phone)}`}</Typography>
            {req.complete && <Chip size="small" color="success" label="Done" />}
          </Stack>
          <Typography variant="body2">{phone ? `${req.worked} of ${req.target}` : `${req.worked} of ${req.target} worked`}</Typography>
        </Stack>
        <LinearProgress
          variant="determinate" value={percent(req.worked, req.target)} color={req.complete ? "success" : "primary"}
          aria-label={`${kind} progress`} sx={{ mt: 1 }}
        />

        {!req.complete && needed.length > 0 && (
          <Box sx={{ mt: 2.5 }}>
            <Typography variant="overline" color="text.secondary" component="h3">
              {`${ended ? "Not worked" : "Still needed"} · ${needed.length}`}
            </Typography>
            <Stack direction="row" useFlexGap spacing={1} sx={{ flexWrap: "wrap", mt: 1 }}>
              {chips.map((e) => (
                <Chip
                  key={e.value} label={chipLabel(req.kind, e)} variant="outlined" disabled={busy}
                  onClick={(ev) => setMenu({ el: ev.currentTarget, entry: e })}
                />
              ))}
            </Stack>
            {chips.length < needed.length && (
              <Button size="small" onClick={() => setAllChips(true)} sx={{ mt: 1.5 }}>
                {ended ? `Show all ${needed.length} not worked` : `Show all ${needed.length} needed`}
              </Button>
            )}
            {req.complete_when === "at_least" && !ended && (
              <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1.5 }}>{atLeastNote(req)}</Typography>
            )}
          </Box>
        )}

        {worked.length > 0 && (showWorked
          ? (
            <Box sx={{ mt: 3 }}>
              <Typography variant="overline" color="text.secondary" component="h3">{`Worked · ${worked.length}`}</Typography>
              <Stack divider={<Divider />}>
                {worked.map((e) => (
                  <Stack
                    key={e.value} direction="row" spacing={2} useFlexGap
                    sx={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", py: 1.5 }}
                  >
                    <Box sx={{ flex: "1 1 320px", minWidth: 0 }}>
                      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                        <CheckIcon color="success" fontSize="small" />
                        <Typography sx={{ overflowWrap: "anywhere" }}>{entryName(req.kind, e)}</Typography>
                      </Stack>
                      <Typography variant="body2" color="text.secondary">{evidenceLine(e, now, phone)}</Typography>
                    </Box>
                    <Button size="small" disabled={busy} onClick={() => onMark(e.value, false)} aria-label={`Mark ${entryName(req.kind, e)} as needed`}>
                      Mark as needed
                    </Button>
                  </Stack>
                ))}
              </Stack>
              <Button size="small" onClick={() => setShowWorked(false)} sx={{ mt: 0.5 }}>Hide worked</Button>
            </Box>
          )
          : <Button size="small" onClick={() => setShowWorked(true)} sx={{ mt: 1.5 }}>{`Show ${worked.length} worked`}</Button>)}

        <Menu anchorEl={menu?.el ?? null} open={menu !== null} onClose={() => setMenu(null)}>
          {menu && (
            <MenuItem onClick={markWorked}>
              <ListItemText primary="Mark as worked" secondary={entryName(req.kind, menu.entry)} />
            </MenuItem>
          )}
        </Menu>
      </CardContent>
    </Card>
  );
}

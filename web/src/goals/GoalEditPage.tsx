import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Alert, AlertTitle, AppBar, Box, Breadcrumbs, Button, Card, CardContent, Dialog, DialogContent, FormControlLabel, IconButton,
  LinearProgress, Link, ListItemText, Menu, MenuItem, Radio, RadioGroup, Stack, TextField, Toolbar, Typography, useMediaQuery,
  type Theme,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { Link as RouterLink, useNavigate } from "react-router";
import { PageTitle } from "../layout/PageTitle";
import { loadGoal, previewGoalWindow, saveGoal } from "../lib/api";
import { errorText, useNotify } from "../app/hooks";
import {
  KINDS, MARKINGS, MAX_REQUIREMENTS, NAME_ERRORS, REQUIREMENTS_HELP, WINDOWS, WINDOW_HELP, WINDOW_PREVIEW_DELAY_MS, dateWarning,
  draftOf, inputOf, knownSince, markingHelp, markingWarning, newRequirement, nextKind, parkNames, windowChange, yearWindow,
  type GoalDraft, type Notice, type RequirementDraft, type WindowKind,
} from "./editModel";
import { RequirementEditor, type ParkSearchCache } from "./RequirementEditor";
import type { GoalKind, GoalProgress, GoalMarking, GoalWindowLoss } from "./types";
import { useDeleteGoal } from "./useDeleteGoal";

/** /goals/new (id null) and /goals/:id/edit: the list's name, time window, marking and requirements. */
export function GoalEditPage({ id }: { id: string | null }) {
  const [progress, setProgress] = useState<GoalProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const load = useCallback(async (): Promise<GoalProgress | null> => {
    if (!id) return null;
    const request = ++latest.current;
    try {
      const next = await loadGoal(id);
      if (request === latest.current) {
        setProgress(next);
        setError(null);
      }
      return next;
    } catch (err) {
      if (request === latest.current) setError(errorText(err, "Couldn't load the goal."));
      return null;
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!id) return <Editor progress={null} reload={load} />;
  if (!progress) return error ? <Alert severity="error">{error}</Alert> : <LinearProgress />;
  return <Editor progress={progress} reload={load} />;
}

interface EditorProps {
  /** The list as loaded, or null for a new one. */
  progress: GoalProgress | null;
  reload: () => Promise<GoalProgress | null>;
}

function Editor({ progress, reload }: EditorProps) {
  const notify = useNotify();
  const navigate = useNavigate();
  const phone = useMediaQuery((t: Theme) => t.breakpoints.down("md"));
  // The clock for a new list's dates, set when the page opens.
  const [now] = useState(() => new Date());
  const [draft, setDraft] = useState<GoalDraft>(() => draftOf(progress, now));
  const [names, setNames] = useState<Record<string, string>>(() => parkNames(progress));
  const [cache] = useState<ParkSearchCache>(() => new Map());
  const [nameError, setNameError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [kindMenu, setKindMenu] = useState<HTMLElement | null>(null);
  const added = useRef(0);
  const isNew = progress === null;
  const back = progress ? `/goals/${progress.list.id}` : "/goals";
  const title = isNew ? "New goal" : "Edit goal";

  const update = (patch: Partial<GoalDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const setRequirement = (key: string, req: RequirementDraft) =>
    setDraft((d) => ({ ...d, requirements: d.requirements.map((r) => (r.key === key ? req : r)) }));
  const removeRequirement = (key: string) => setDraft((d) => ({ ...d, requirements: d.requirements.filter((r) => r.key !== key) }));
  const addRequirement = (kind: GoalKind) => {
    setKindMenu(null);
    added.current += 1;
    const req = newRequirement(kind, `new-${added.current}`);
    setDraft((d) => ({ ...d, requirements: [...d.requirements, req] }));
  };
  const setWindow = (window: WindowKind) =>
    setDraft((d) => (window === "dates" && (!d.startsOn || !d.endsOn) ? { ...d, window, ...yearWindow(now) } : { ...d, window }));

  const save = async () => {
    setBusy(true);
    setNameError(null);
    const input = inputOf(draft);
    try {
      const saved = await saveGoal(input);
      notify(isNew ? `Created ${input.name}` : "Saved changes");
      void navigate(`/goals/${saved}`);
    } catch (err) {
      const message = errorText(err, "Couldn't save the goal.");
      // The name's errors are the field's; everything else is a toast.
      if (NAME_ERRORS.includes(message)) setNameError(message);
      else notify(message);
      setBusy(false);
    }
  };
  const cancel = () => void navigate(back);
  const canSave = !busy && draft.name.trim() !== "";

  const losses = useWindowLosses(progress, draft);
  const datesWarning = dateWarning(progress, draft, losses);
  const handWarning = markingWarning(progress, draft, losses);
  const since = knownSince(progress, draft);
  const full = draft.requirements.length >= MAX_REQUIREMENTS;

  const name = (
    <TextField
      label="Name" required={!phone} value={draft.name} fullWidth
      onChange={(e) => {
        update({ name: e.target.value });
        setNameError(null);
      }}
      error={nameError !== null} helperText={nameError ?? undefined}
    />
  );
  const dates = draft.window === "dates" && (
    <Stack direction={phone ? "column" : "row"} spacing={2} sx={{ flex: phone ? undefined : "2 1 336px" }}>
      <TextField
        label={phone ? "Start" : "Starts"} type="date" value={draft.startsOn} onChange={(e) => update({ startsOn: e.target.value })}
        slotProps={{ inputLabel: { shrink: true } }} fullWidth
      />
      <TextField
        label={phone ? "End" : "Ends"} type="date" value={draft.endsOn} onChange={(e) => update({ endsOn: e.target.value })}
        slotProps={{ inputLabel: { shrink: true } }} fullWidth
      />
    </Stack>
  );
  const requirements = draft.requirements.map((r) => (
    <RequirementEditor
      key={r.key} req={r} phone={phone} names={names} cache={cache}
      onChange={(next) => setRequirement(r.key, next)} onRemove={() => removeRequirement(r.key)}
      onName={(reference, parkName) => setNames((n) => ({ ...n, [reference]: parkName }))}
    />
  ));
  const kindPicker = (
    <Menu anchorEl={kindMenu} open={kindMenu !== null} onClose={() => setKindMenu(null)}>
      {KINDS.map((k) => <MenuItem key={k.kind} onClick={() => addRequirement(k.kind)}>{k.label}</MenuItem>)}
    </Menu>
  );
  const remove = progress && <DeleteButton progress={progress} reload={reload} />;

  if (phone) {
    return (
      <Dialog open fullScreen onClose={cancel} aria-labelledby="goal-edit-title">
        <AppBar position="sticky" color="default" elevation={0}>
          <Toolbar>
            <IconButton edge="start" aria-label="Back" onClick={cancel}>
              <ArrowBackIcon />
            </IconButton>
            <Typography id="goal-edit-title" variant="h6" component="h1" noWrap sx={{ flex: 1, ml: 1 }}>{title}</Typography>
            <Button disabled={!canSave} onClick={() => void save()}>Save</Button>
          </Toolbar>
        </AppBar>
        <DialogContent>
          <Stack spacing={2.5} sx={{ pt: 1 }}>
            {name}
            <Stack component="section" aria-label="Time window" spacing={1.5}>
              <Typography variant="overline" color="text.secondary" component="h2">Time window</Typography>
              <RadioGroup value={draft.window} onChange={(e) => setWindow(e.target.value === "open" ? "open" : "dates")}>
                <FormControlLabel value="dates" control={<Radio />} label="Between dates" />
                {dates && <Box sx={{ pl: 4, py: 1 }}>{dates}</Box>}
                <FormControlLabel value="open" control={<Radio />} label="No end date" />
              </RadioGroup>
              <NoticeAlert notice={datesWarning} severity="warning" />
            </Stack>
            <NoticeAlert notice={since} severity="info" />
            <Stack component="section" aria-label="How entries get marked" spacing={1.5}>
              <Typography variant="overline" color="text.secondary" component="h2">How entries get marked</Typography>
              <RadioGroup value={draft.marking} onChange={(e) => update({ marking: e.target.value === "hand" ? "hand" : "relay" })}>
                {MARKINGS.map((m) => (
                  <FormControlLabel
                    key={m.value} value={m.value} control={<Radio />} sx={{ alignItems: "flex-start" }}
                    label={<ListItemText primary={m.label} secondary={m.caption} sx={{ my: 1 }} />}
                  />
                ))}
              </RadioGroup>
              <NoticeAlert notice={handWarning} severity="warning" />
            </Stack>
            <Typography variant="overline" color="text.secondary" component="h2">Requirements</Typography>
            {requirements}
            <Button variant="outlined" startIcon={<AddIcon />} disabled={full} onClick={(e) => setKindMenu(e.currentTarget)} fullWidth>
              Add requirement
            </Button>
            {kindPicker}
            {remove}
          </Stack>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Stack spacing={3}>
      <Breadcrumbs>
        <Link component={RouterLink} to="/goals" underline="hover" color="inherit">Goals</Link>
        {progress
          ? <Link component={RouterLink} to={back} underline="hover" color="inherit">{progress.list.name}</Link>
          : <Typography color="text.primary">{title}</Typography>}
      </Breadcrumbs>
      <Stack direction="row" spacing={2} useFlexGap sx={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
        <PageTitle>{title}</PageTitle>
        <Stack direction="row" spacing={1}>
          <Button onClick={cancel} disabled={busy}>Cancel</Button>
          <Button variant="contained" disabled={!canSave} onClick={() => void save()}>Save goal</Button>
        </Stack>
      </Stack>

      <Stack spacing={2} sx={{ maxWidth: 880 }}>
        {name}
        <Section title="Time window" subtitle="Which contacts count toward this goal.">
          <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: "wrap" }}>
            <TextField
              select label="Counts contacts" value={draft.window} sx={{ flex: "1 1 200px" }}
              onChange={(e) => setWindow(e.target.value === "open" ? "open" : "dates")}
              slotProps={{ select: { renderValue: (v) => WINDOWS.find((w) => w.value === v)?.label ?? "" } }}
            >
              {WINDOWS.map((w) => (
                <MenuItem key={w.value} value={w.value}>
                  <ListItemText primary={w.label} secondary={w.caption} />
                </MenuItem>
              ))}
            </TextField>
            {dates}
          </Stack>
          <Typography variant="caption" color="text.secondary" component="p">{WINDOW_HELP}</Typography>
          <NoticeAlert notice={datesWarning} severity="warning" />
        </Section>
        <NoticeAlert notice={since} severity="info" />
        <Section title="How entries get marked" subtitle="Pick what counts as proof that you worked an entry.">
          <TextField
            select label="Mark entries worked" value={draft.marking} fullWidth
            onChange={(e) => update({ marking: markingOf(e.target.value) })}
            slotProps={{ select: { renderValue: (v) => MARKINGS.find((m) => m.value === v)?.label ?? "" } }}
          >
            {MARKINGS.map((m) => (
              <MenuItem key={m.value} value={m.value}>
                <ListItemText primary={m.label} secondary={m.caption} />
              </MenuItem>
            ))}
          </TextField>
          <Typography variant="caption" color="text.secondary" component="p">{markingHelp(draft.marking, progress?.relay ?? null)}</Typography>
          <NoticeAlert notice={handWarning} severity="warning" />
        </Section>
        <Box sx={{ pt: 1 }}>
          <Typography variant="h6" component="h2">Requirements</Typography>
          <Typography variant="body2" color="text.secondary">{REQUIREMENTS_HELP}</Typography>
        </Box>
        {requirements}
        <Box>
          <Button startIcon={<AddIcon />} disabled={full} onClick={() => addRequirement(nextKind(draft.requirements))}>Add requirement</Button>
        </Box>
        {remove}
      </Stack>
    </Stack>
  );
}

/**
 * What a save would send back to needed, from preview_goal_window, asked once the window
 * or marking has stayed changed from the loaded list for WINDOW_PREVIEW_DELAY_MS. Empty while
 * nothing changed, for a new list, while the answer for the draft's window is pending, and when
 * the preview fails (Save then reports the error). An answer for an older window is never used.
 */
function useWindowLosses(progress: GoalProgress | null, draft: GoalDraft): readonly GoalWindowLoss[] {
  const change = windowChange(progress, draft);
  const id = progress?.list.id ?? null;
  const startsOn = change?.startsOn ?? null;
  const endsOn = change?.endsOn ?? null;
  const marking = change?.marking ?? null;
  const key = id && marking ? `${id}|${startsOn ?? ""}|${endsOn ?? ""}|${marking}` : null;
  const [answer, setAnswer] = useState<{ key: string; losses: GoalWindowLoss[] } | null>(null);

  useEffect(() => {
    if (!id || !marking || !key) return;
    let current = true;
    const timer = setTimeout(() => {
      previewGoalWindow(id, startsOn, endsOn, marking).then(
        (losses) => {
          if (current) setAnswer({ key, losses });
        },
        // Advisory only: without an answer the page shows no warning.
        () => {
          if (current) setAnswer({ key, losses: [] });
        },
      );
    }, WINDOW_PREVIEW_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [id, key, startsOn, endsOn, marking]);

  return answer !== null && answer.key === key ? answer.losses : [];
}

const markingOf = (value: string): GoalMarking => (value === "hand" ? "hand" : "relay");

function Section({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <Card variant="outlined" component="section" aria-label={title}>
      <CardContent>
        <Stack spacing={2}>
          <Box>
            <Typography variant="h6" component="h2">{title}</Typography>
            <Typography variant="body2" color="text.secondary">{subtitle}</Typography>
          </Box>
          {children}
        </Stack>
      </CardContent>
    </Card>
  );
}

function NoticeAlert({ notice, severity }: { notice: Notice | null; severity: "warning" | "info" }) {
  if (!notice) return null;
  return (
    <Alert severity={severity}>
      <AlertTitle>{notice.title}</AlertTitle>
      {notice.text}
    </Alert>
  );
}

/** "Delete goal": the blocked dialog while connections use it, else a confirmation (useDeleteGoal). */
function DeleteButton({ progress, reload }: { progress: GoalProgress; reload: () => Promise<GoalProgress | null> }) {
  const deleting = useDeleteGoal(progress, reload);
  return (
    <Box>
      <Button color="error" onClick={deleting.start}>Delete goal</Button>
      {deleting.dialog}
    </Box>
  );
}

import { memo, useState, type ReactNode } from "react";
import {
  Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Paper, Stack, Tab, Tabs, TextField, Typography,
  useMediaQuery, useTheme,
} from "@mui/material";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import { normalizeCallsigns, saveGroup } from "../lib/api";
import { errorText } from "../app/hooks";
import { plural } from "../profile/format";
import { useTour } from "../tour/hooks";
import { csvSummary, limitText, mergeCallsigns, rejectedText, wouldExceed } from "./model";
import { csvColumn, parseCsv, splitCallsigns } from "./parse";
import type { GroupInput, NormalizedCallsigns } from "./types";

interface Props {
  initial: GroupInput;
  onClose: () => void;
  onSaved: (name: string) => void;
}

type Feedback = { severity: "warning" | "error"; text: string } | null;
type Csv = { summary: string; result: NormalizedCallsigns } | null;

/**
 * New group / Edit group. Every tab sends its raw values through
 * normalize_group_callsigns, so the chips are exactly what will be stored;
 * nothing is written until Create group or Save changes saves the whole list.
 */
export function GroupDialog({ initial, onClose, onSaved }: Props) {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down("md"));
  const { active: tourActive } = useTour();
  const [name, setName] = useState(initial.name);
  const [calls, setCalls] = useState(initial.callsigns);
  const [tab, setTab] = useState(0);
  const [typed, setTyped] = useState("");
  const [pasted, setPasted] = useState("");
  const [csv, setCsv] = useState<Csv>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Merges normalised calls into the list unless that would pass the cap. True when the list took them. */
  const accept = (result: NormalizedCallsigns): boolean => {
    const merged = mergeCallsigns(calls, result.callsigns);
    if (wouldExceed(merged.length)) {
      setFeedback({ severity: "error", text: limitText(merged.length) });
      return false;
    }
    setCalls(merged);
    const rejected = rejectedText(result.rejected);
    setFeedback(rejected ? { severity: "warning", text: rejected } : null);
    return true;
  };

  const normalize = async (values: string[]): Promise<NormalizedCallsigns | null> => {
    setFeedback(null);
    setAdding(true);
    try {
      return await normalizeCallsigns(values);
    } catch (err) {
      setFeedback({ severity: "error", text: errorText(err, "Couldn't check those callsigns.") });
      return null;
    } finally {
      setAdding(false);
    }
  };

  /** Type and Paste: the field clears once something from it is in the list. */
  const addText = async (text: string, clear: () => void) => {
    const values = splitCallsigns(text);
    if (values.length === 0) return;
    const result = await normalize(values);
    if (result && accept(result) && result.callsigns.length > 0) clear();
  };

  const chooseFile = async (file: File) => {
    setCsv(null);
    setFeedback(null);
    let text: string;
    try {
      text = await file.text();
    } catch {
      setFeedback({ severity: "error", text: "Couldn't read that file." });
      return;
    }
    const { header, values } = csvColumn(parseCsv(text));
    if (values.length === 0) {
      setFeedback({ severity: "warning", text: `No callsigns found in ${file.name}.` });
      return;
    }
    const result = await normalize(values);
    if (result) setCsv({ summary: csvSummary(file.name, header, result.callsigns.length, result.rejected.length), result });
  };

  const addCsv = () => {
    if (csv && accept(csv.result)) setCsv(null);
  };

  const switchTab = (next: number) => {
    setTab(next);
    setFeedback(null);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const trimmed = name.trim();
      await saveGroup({ ...(initial.id ? { id: initial.id } : {}), name: trimmed, callsigns: calls });
      onSaved(trimmed);
    } catch (err) {
      setError(errorText(err, "Couldn't save the group."));
    } finally {
      setBusy(false);
    }
  };

  const rejectedCsv = csv && rejectedText(csv.result.rejected);

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md" fullScreen={mobile} disableEnforceFocus={tourActive}>
      <DialogTitle>{initial.id ? "Edit group" : "New group"}</DialogTitle>
      <DialogContent dividers>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        <Stack direction={mobile ? "column" : "row"} spacing={3} data-testid="group-panes">
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <TextField label="Group name" value={name} onChange={(e) => setName(e.target.value)} required fullWidth sx={{ mt: 1 }} />
            <Typography variant="subtitle2" sx={{ mt: 4 }}>Add callsigns</Typography>
            <Tabs value={tab} onChange={(_e, v: number) => switchTab(v)} variant="fullWidth" sx={{ mt: 1, mb: 2 }}>
              <Tab label="Type" />
              <Tab label="Paste" />
              <Tab label="Import CSV" />
            </Tabs>
            {tab === 0 && (
              <AddRow
                disabled={!typed.trim() || adding}
                onAdd={() => void addText(typed, () => setTyped(""))}
                field={
                  <TextField
                    label="Callsign" placeholder="KK4PWJ" value={typed} onChange={(e) => setTyped(e.target.value)} fullWidth
                    helperText="Press Enter to add. Spaces or commas add several at once."
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      if (!adding) void addText(typed, () => setTyped(""));
                    }}
                  />
                }
              />
            )}
            {tab === 1 && (
              <AddRow
                disabled={!pasted.trim() || adding}
                onAdd={() => void addText(pasted, () => setPasted(""))}
                field={
                  <TextField
                    label="Callsigns" placeholder="KK4PWJ, N4DXX, AB4RD" value={pasted} onChange={(e) => setPasted(e.target.value)}
                    multiline minRows={5} maxRows={10} fullWidth helperText="Separate them with commas, spaces or new lines."
                  />
                }
              />
            )}
            {tab === 2 && (
              <Stack spacing={1.5}>
                <Box>
                  <Button component="label" variant="outlined" startIcon={<UploadFileIcon />} disabled={adding}>
                    Choose file
                    <input
                      hidden type="file" accept=".csv,text/csv" data-testid="csv-input"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (file) void chooseFile(file);
                      }}
                    />
                  </Button>
                </Box>
                <Typography variant="caption" color="text.secondary">
                  One callsign per row. Long Lines uses the column headed Call or Callsign, or the first column if there isn't one.
                </Typography>
                {csv && (
                  <>
                    <Typography variant="body2">{csv.summary}</Typography>
                    {rejectedCsv && <Alert severity="warning">{rejectedCsv}</Alert>}
                    <Box>
                      <Button variant="outlined" onClick={addCsv} disabled={csv.result.callsigns.length === 0}>Add</Button>
                    </Box>
                  </>
                )}
              </Stack>
            )}
            {feedback && <Alert severity={feedback.severity} sx={{ mt: 2 }}>{feedback.text}</Alert>}
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <MemberPanel calls={calls} onChange={setCalls} />
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="contained" onClick={() => void save()} disabled={!name.trim() || busy || adding}>
          {initial.id ? "Save changes" : "Create group"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * The list being edited. Memoised so typing on the left doesn't re-render up
 * to 1,000 chips on every keystroke; onChange is the dialog's state setter.
 */
const MemberPanel = memo(function MemberPanel({ calls, onChange }: { calls: string[]; onChange: (calls: string[]) => void }) {
  return (
    <Paper variant="outlined">
      <Box sx={{ p: 2 }}>
        <Stack direction="row" spacing={1} sx={{ justifyContent: "space-between", alignItems: "center" }}>
          <Typography variant="subtitle1">{plural(calls.length, "callsign", "callsigns")}</Typography>
          <Button size="small" color="error" disabled={calls.length === 0} onClick={() => onChange([])}>Remove all</Button>
        </Stack>
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5 }}>
          Portable suffixes like /P are removed, so KK4PWJ also matches KK4PWJ/P. Up to 1,000 per group.
        </Typography>
      </Box>
      <Divider />
      <Box sx={{ p: 2, maxHeight: 360, overflowY: "auto" }}>
        {calls.length > 0
          ? (
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }} data-testid="group-members">
              {calls.map((c) => (
                <Chip key={c} size="small" label={c} onDelete={() => onChange(calls.filter((x) => x !== c))} />
              ))}
            </Stack>
          )
          : <Typography variant="body2" color="text.secondary">No callsigns yet. Type, paste, or import them on the left.</Typography>}
      </Box>
    </Paper>
  );
});

/** A Type or Paste field with its Add button beside it. */
function AddRow({ field, disabled, onAdd }: { field: ReactNode; disabled: boolean; onAdd: () => void }) {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
      {field}
      <Button variant="outlined" onClick={onAdd} disabled={disabled} sx={{ flexShrink: 0, minHeight: 56 }}>Add</Button>
    </Stack>
  );
}

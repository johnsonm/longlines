import { memo, useState, type ReactNode } from "react";
import { Alert, Box, Button, Chip, Divider, Stack, Tab, Tabs, TextField, Typography } from "@mui/material";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import { normalizeCallsigns } from "../lib/api";
import { errorText } from "../app/hooks";
import { csvSummary, limitText, mergeCallsigns, rejectedText, wouldExceed } from "./model";
import { csvColumn, parseCsv, splitCallsigns } from "./parse";
import type { NormalizedCallsigns } from "./types";

/** Member chips before "+N more"; searching shows every match. */
const CHIPS_SHOWN = 40;

type Feedback = { severity: "warning" | "error"; text: string } | null;
type Csv = { summary: string; result: NormalizedCallsigns } | null;

/**
 * The Settings tab's Members card body: Type, Paste and Import CSV, then the
 * list. Every tab sends its raw values through normalize_group_callsigns, so
 * the chips are exactly what will be stored; nothing is written until the tab's
 * Save changes saves the whole list.
 */
export function MemberEditor({ calls, onChange }: { calls: string[]; onChange: (calls: string[]) => void }) {
  const [tab, setTab] = useState(1);
  const [typed, setTyped] = useState("");
  const [pasted, setPasted] = useState("");
  const [csv, setCsv] = useState<Csv>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [adding, setAdding] = useState(false);

  /** Merges normalised calls into the list unless that would pass the cap. True when the list took them. */
  const accept = (result: NormalizedCallsigns): boolean => {
    const merged = mergeCallsigns(calls, result.callsigns);
    if (wouldExceed(merged.length)) {
      setFeedback({ severity: "error", text: limitText(merged.length) });
      return false;
    }
    onChange(merged);
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

  const rejectedCsv = csv && rejectedText(csv.result.rejected);

  return (
    <Stack spacing={2}>
      <Tabs value={tab} onChange={(_e, v: number) => switchTab(v)} variant="fullWidth">
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
        <Stack spacing={1.5}>
          <TextField
            label="Paste callsigns" value={pasted} onChange={(e) => setPasted(e.target.value)}
            multiline minRows={3} maxRows={10} fullWidth helperText="Separate with commas, spaces or new lines."
          />
          <Box>
            <Button variant="contained" onClick={() => void addText(pasted, () => setPasted(""))} disabled={!pasted.trim() || adding}>
              Add callsigns
            </Button>
          </Box>
        </Stack>
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
      {feedback && <Alert severity={feedback.severity}>{feedback.text}</Alert>}
      <Divider />
      <MemberList calls={calls} onChange={onChange} disabled={adding} />
    </Stack>
  );
}

/**
 * The list being edited. Memoised so typing above doesn't re-render up to
 * 1,000 chips on every keystroke. Disabled while an add is being checked: the
 * add merges into the list as it was when it started, so a removal in the
 * meantime would come back. Search filters what is shown, never what is saved.
 */
const MemberList = memo(function MemberList({ calls, onChange, disabled }: {
  calls: string[];
  onChange: (calls: string[]) => void;
  disabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(false);
  const q = query.trim().toUpperCase();
  const matching = q ? calls.filter((c) => c.includes(q)) : calls;
  const shown = all || q ? matching : matching.slice(0, CHIPS_SHOWN);
  const more = matching.length - shown.length;
  return (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={1} sx={{ justifyContent: "space-between", alignItems: "center" }}>
        <Typography variant="body2" color="text.secondary">Members</Typography>
        <Button size="small" color="error" disabled={disabled || calls.length === 0} onClick={() => onChange([])}>Remove all</Button>
      </Stack>
      <TextField size="small" label="Search members" value={query} onChange={(e) => setQuery(e.target.value)} />
      {calls.length > 0
        ? (
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }} data-testid="group-members">
            {shown.map((c) => (
              <Chip key={c} size="small" label={c} disabled={disabled} onDelete={() => onChange(calls.filter((x) => x !== c))} />
            ))}
            {more > 0 && <Chip size="small" variant="outlined" label={`+${more} more`} onClick={() => setAll(true)} />}
          </Stack>
        )
        : <Typography variant="body2" color="text.secondary">No callsigns yet. Type, paste, or import them above.</Typography>}
    </Stack>
  );
});

/** The Type field with its Add button beside it. */
function AddRow({ field, disabled, onAdd }: { field: ReactNode; disabled: boolean; onAdd: () => void }) {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
      {field}
      <Button variant="outlined" onClick={onAdd} disabled={disabled} sx={{ flexShrink: 0, minHeight: 56 }}>Add</Button>
    </Stack>
  );
}

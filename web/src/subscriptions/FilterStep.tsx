import type { ReactNode } from "react";
import {
  Alert, AlertTitle, Autocomplete, Box, Button, FormControl, IconButton, InputLabel, Link, MenuItem, Select, Stack, TextField, Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import { Link as RouterLink } from "react-router";
import type { SubscriptionInput } from "../lib/api";
import type { CallsignGroup } from "../groups/types";
import { BANDS, MODES, modeLabel, type SourceInfo } from "../sources/sources";
import {
  fieldInfo, fieldsFor, MAX_RULES, needsCallsign, newRow, opLabel, QUIET_OPTIONS, rowInvalid, rulesOf, withField,
  type Join, type RuleField, type RuleOp, type RuleRow,
} from "./model";

interface Props {
  sub: SubscriptionInput;
  setSub: (s: SubscriptionInput) => void;
  rows: RuleRow[];
  setRows: (r: RuleRow[]) => void;
  /** null while loading or when loading failed: the group rule is shown but can't be edited. */
  groups: CallsignGroup[] | null;
  /** The source's spots per day, for the high volume warning; null until the stats load. */
  perDay: string | null;
  source: SourceInfo | null;
  /** From the preview: distinct stations across the callsign and group rules. */
  stationCount: number | null;
  mobile: boolean;
}

export function FilterStep({ sub, setSub, rows, setRows, groups, perDay, source, stationCount, mobile }: Props) {
  const available = fieldsFor(sub.sources);
  const rules = rulesOf(rows);
  const missingCall = needsCallsign(sub.sources, rules);
  const joins = rows.slice(1).map((r) => r.join);
  const mixed = joins.includes("and") && joins.includes("or");
  const heading = mixed ? "Pass spots that match these rules"
    : joins.includes("or") ? "Pass spots that match any of these rules" : "Pass spots that match all of these rules";

  const update = (i: number, row: RuleRow) => setRows(rows.map((r, j) => (j === i ? row : r)));
  const removeRule = (i: number) => {
    // The new first row has nothing before it to join.
    setRows(rows.filter((_, j) => j !== i).map((r, j) => (j === 0 ? { ...r, join: "and" } : r)));
  };
  const addRule = () => setRows([...rows, newRow(available, rows, rows.at(-1)?.join ?? "and")]);

  const stations = stationCount ?? 0;
  const helper = (row: RuleRow): ReactNode => {
    switch (row.field) {
      case "callsign":
        if (missingCall) {
          return rules.length > 1
            ? "High volume source: each Or needs a callsign or group rule."
            : "High volume source: at least one callsign or group is required.";
        }
        return "Type a call and press Enter.";
      case "group":
        if (groups === null) return "Couldn't load your groups.";
        if (groups.length === 0) {
          return <>No callsign groups yet. <Link component={RouterLink} to="/groups">Create a group</Link> to watch a club roster or an award list.</>;
        }
        return stationCount === null ? "" : `Matches ${stations} ${stations === 1 ? "station" : "stations"} from your groups and callsigns.`;
      case "band":
        return "";
      case "mode":
        return "SOTAwatch reports every digital mode as DATA. Choose Any digital to include those spots.";
      case "reference":
        return "Matches POTA references and locations, SOTA summit codes and WWFF references.";
      case "frequency":
        return rowInvalid(row) ? "Enter a frequency in kHz, such as 14074." : "";
    }
  };

  const valuesInput = (row: RuleRow, i: number): ReactNode => {
    const label = "Values";
    const set = (values: string[]) => update(i, { ...row, values });
    switch (row.field) {
      case "callsign":
        return (
          <Autocomplete
            multiple freeSolo options={[] as string[]} value={row.values}
            onChange={(_e, v) => set(v.map((x) => x.toUpperCase().trim()).filter(Boolean))}
            renderInput={(p) => <TextField {...p} label={label} placeholder="Type a call" error={missingCall && row.op === "is"} />}
          />
        );
      case "group":
        return (
          <Autocomplete
            multiple disabled={groups === null} options={groups ?? []} getOptionLabel={(g) => g.name} isOptionEqualToValue={(a, b) => a.id === b.id}
            value={(groups ?? []).filter((g) => row.values.includes(g.id))}
            onChange={(_e, v) => set(v.map((g) => g.id))}
            renderInput={(p) => <TextField {...p} label={label} />}
          />
        );
      case "band":
        return (
          <Autocomplete
            multiple options={BANDS} value={row.values} onChange={(_e, v) => set(v)}
            renderInput={(p) => <TextField {...p} label={label} />}
          />
        );
      case "mode":
        return (
          <Autocomplete
            multiple options={MODES} value={row.values} onChange={(_e, v) => set(v)} getOptionLabel={modeLabel}
            renderInput={(p) => <TextField {...p} label={label} />}
          />
        );
      case "reference":
        return (
          <TextField
            label={label} value={row.values[0] ?? ""} onChange={(e) => set([e.target.value])}
            placeholder="US-NC, W4C/, US-0817" fullWidth
          />
        );
      case "frequency":
        return (
          <TextField
            label="kHz" value={row.values[0] ?? ""} onChange={(e) => set([e.target.value])}
            placeholder="14074" error={rowInvalid(row)} fullWidth slotProps={{ htmlInput: { inputMode: "decimal" } }}
          />
        );
    }
  };

  return (
    <Stack spacing={2}>
      {source?.volume === "high" && (
        <Alert severity="warning">
          <AlertTitle>{source.title} is a high volume source</AlertTitle>
          Add a callsign or callsign group rule to save this subscription.
          {perDay && ` Without one it would pass about ${perDay} spots a day.`}
        </Alert>
      )}
      {rows.length > 0 && (
        <Box>
          <Typography>{heading}</Typography>
          {mixed && (
            <Typography variant="caption" color="text.secondary">
              And comes before Or: a spot passes when it matches every rule between two Ors.
            </Typography>
          )}
        </Box>
      )}
      {rows.map((row, i) => {
        const f = fieldInfo(row.field);
        const join = i === 0 ? null : (
          <FormControl fullWidth>
            <InputLabel id={`join-${row.key}`}>Join</InputLabel>
            <Select labelId={`join-${row.key}`} label="Join" value={row.join} onChange={(e) => update(i, { ...row, join: e.target.value as Join })}>
              <MenuItem value="and">And</MenuItem>
              <MenuItem value="or">Or</MenuItem>
            </Select>
          </FormControl>
        );
        const fieldSelect = (
          <FormControl fullWidth>
            <InputLabel id={`field-${row.key}`}>Field</InputLabel>
            <Select labelId={`field-${row.key}`} label="Field" value={row.field} onChange={(e) => update(i, withField(row, e.target.value as RuleField))}>
              {available.map((a) => <MenuItem key={a} value={a}>{fieldInfo(a).label}</MenuItem>)}
            </Select>
          </FormControl>
        );
        const condition = (
          <FormControl fullWidth>
            <InputLabel id={`op-${row.key}`}>Condition</InputLabel>
            <Select labelId={`op-${row.key}`} label="Condition" value={row.op} onChange={(e) => update(i, { ...row, op: e.target.value as RuleOp })}>
              {f.ops.map((op) => <MenuItem key={op} value={op}>{opLabel(row.field, op)}</MenuItem>)}
            </Select>
          </FormControl>
        );
        const del = (
          <IconButton aria-label={`Delete ${f.label} rule`} onClick={() => removeRule(i)}><DeleteIcon /></IconButton>
        );
        const help = helper(row);
        const helpError = (row.field === "callsign" && missingCall) || rowInvalid(row);
        return (
          <Box key={row.key}>
            {mobile ? (
              <Stack spacing={1.5}>
                {join && <Box sx={{ width: 120 }}>{join}</Box>}
                <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                  {fieldSelect}
                  {del}
                </Stack>
                {condition}
                {valuesInput(row, i)}
              </Stack>
            ) : (
              <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
                <Box sx={{ flex: "0 0 96px" }}>{join}</Box>
                <Box sx={{ flex: "0 0 190px" }}>{fieldSelect}</Box>
                <Box sx={{ flex: "0 0 170px" }}>{condition}</Box>
                <Box sx={{ flexGrow: 1, minWidth: 0 }}>{valuesInput(row, i)}</Box>
                <Box sx={{ pt: 1 }}>{del}</Box>
              </Stack>
            )}
            {help && (
              <Typography variant="caption" color={helpError ? "error" : "text.secondary"} sx={{ display: "block", mt: 0.5, ml: mobile ? 0 : "480px" }}>
                {help}
              </Typography>
            )}
          </Box>
        );
      })}
      <Box>
        <Button size="small" startIcon={<AddIcon />} onClick={addRule} disabled={rows.length >= MAX_RULES}>Add rule</Button>
      </Box>
      <FormControl fullWidth>
        <InputLabel id="quiet">Repeat spots for the same station</InputLabel>
        <Select labelId="quiet" label="Repeat spots for the same station" value={sub.quiet_minutes} onChange={(e) => setSub({ ...sub, quiet_minutes: Number(e.target.value) })}>
          {QUIET_OPTIONS.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
        </Select>
      </FormControl>
    </Stack>
  );
}

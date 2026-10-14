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
import { clearField, fieldInfo, fieldsFor, needsCallsign, QUIET_OPTIONS, type RuleField } from "./model";

interface Props {
  sub: SubscriptionInput;
  setSub: (s: SubscriptionInput) => void;
  rules: RuleField[];
  setRules: (r: RuleField[]) => void;
  /** null while loading or when loading failed: the group rule is shown but can't be edited. */
  groups: CallsignGroup[] | null;
  /** The source's spots per day, for the high volume warning; null until the stats load. */
  perDay: string | null;
  source: SourceInfo | null;
  /** From the preview: distinct stations across the callsign and group rules. */
  stationCount: number | null;
  mobile: boolean;
}

export function FilterStep({ sub, setSub, rules, setRules, groups, perDay, source, stationCount, mobile }: Props) {
  const available = fieldsFor(sub.sources);
  const unused = available.filter((f) => !rules.includes(f));
  const missingCall = needsCallsign(sub);

  const changeField = (i: number, next: RuleField) => {
    const old = rules[i];
    if (old) setSub(clearField(sub, old));
    setRules(rules.map((r, j) => (j === i ? next : r)));
  };

  const removeRule = (i: number) => {
    const old = rules[i];
    if (old) setSub(clearField(sub, old));
    setRules(rules.filter((_, j) => j !== i));
  };

  const addRule = () => {
    const next = unused[0];
    if (next) setRules([...rules, next]);
  };

  const stations = stationCount ?? 0;
  const helper = (field: RuleField): ReactNode => {
    switch (field) {
      case "callsign":
        return missingCall ? "High volume source: at least one callsign or group is required." : "Type a call and press Enter.";
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
        return "Matches POTA references and locations, and SOTA summit codes.";
    }
  };

  const values = (field: RuleField): ReactNode => {
    const label = "Values";
    switch (field) {
      case "callsign":
        return (
          <Autocomplete
            multiple freeSolo options={[] as string[]} value={sub.callsigns}
            onChange={(_e, v) => setSub({ ...sub, callsigns: v.map((x) => x.toUpperCase().trim()).filter(Boolean) })}
            renderInput={(p) => <TextField {...p} label={label} placeholder="Type a call" error={missingCall} />}
          />
        );
      case "group":
        return (
          <Autocomplete
            multiple disabled={groups === null} options={groups ?? []} getOptionLabel={(g) => g.name} isOptionEqualToValue={(a, b) => a.id === b.id}
            value={(groups ?? []).filter((g) => sub.group_ids.includes(g.id))}
            onChange={(_e, v) => setSub({ ...sub, group_ids: v.map((g) => g.id) })}
            renderInput={(p) => <TextField {...p} label={label} />}
          />
        );
      case "band":
        return (
          <Autocomplete
            multiple options={BANDS} value={sub.bands} onChange={(_e, v) => setSub({ ...sub, bands: v })}
            renderInput={(p) => <TextField {...p} label={label} />}
          />
        );
      case "mode":
        return (
          <Autocomplete
            multiple options={MODES} value={sub.modes} onChange={(_e, v) => setSub({ ...sub, modes: v })} getOptionLabel={modeLabel}
            renderInput={(p) => <TextField {...p} label={label} />}
          />
        );
      case "reference":
        return (
          <TextField
            label={label} value={sub.reference} onChange={(e) => setSub({ ...sub, reference: e.target.value })}
            placeholder="US-NC, W4C/, US-0817" fullWidth
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
      {rules.length > 0 && <Typography>Pass spots that match all of these rules</Typography>}
      {rules.map((field, i) => {
        const f = fieldInfo(field);
        const fieldSelect = (
          <FormControl fullWidth>
            <InputLabel id={`field-${i}`}>Field</InputLabel>
            <Select labelId={`field-${i}`} label="Field" value={field} onChange={(e) => changeField(i, e.target.value as RuleField)}>
              {available.filter((a) => a === field || !rules.includes(a)).map((a) => (
                <MenuItem key={a} value={a}>{fieldInfo(a).label}</MenuItem>
              ))}
            </Select>
          </FormControl>
        );
        const condition = (
          <TextField label="Condition" value={f.condition} fullWidth slotProps={{ input: { readOnly: true } }} />
        );
        const del = (
          <IconButton aria-label={`Delete ${f.label} rule`} onClick={() => removeRule(i)}><DeleteIcon /></IconButton>
        );
        const help = helper(field);
        return (
          <Box key={field}>
            {mobile ? (
              <Stack spacing={1.5}>
                <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                  {fieldSelect}
                  {del}
                </Stack>
                {condition}
                {values(field)}
              </Stack>
            ) : (
              <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
                <Box sx={{ flex: "0 0 200px" }}>{fieldSelect}</Box>
                <Box sx={{ flex: "0 0 110px" }}>{condition}</Box>
                <Box sx={{ flexGrow: 1, minWidth: 0 }}>{values(field)}</Box>
                <Box sx={{ pt: 1 }}>{del}</Box>
              </Stack>
            )}
            {help && (
              <Typography variant="caption" color={field === "callsign" && missingCall ? "error" : "text.secondary"} sx={{ display: "block", mt: 0.5, ml: mobile ? 0 : "326px" }}>
                {help}
              </Typography>
            )}
          </Box>
        );
      })}
      <Box>
        <Button size="small" startIcon={<AddIcon />} onClick={addRule} disabled={unused.length === 0}>Add rule</Button>
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

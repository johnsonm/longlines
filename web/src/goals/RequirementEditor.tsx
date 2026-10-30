import { useEffect, useState } from "react";
import {
  Autocomplete, Box, Button, Card, CardContent, Chip, createFilterOptions, IconButton, MenuItem, Stack, TextField, Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import { searchReferences } from "../lib/api";
import { BANDS } from "../sources/sources";
import { stateName } from "../stats/stateShapes";
import type { ReferenceSearchResult } from "../references/types";
import { SEARCH_DEBOUNCE_MS, SEARCH_FAILED_TEXT, SEARCHING_TEXT } from "../subscriptions/ReferenceValuesField";
import { searchQuery } from "../subscriptions/model";
import {
  ADD_BUTTON, ADD_FIELD, ALL_STATES_LABEL, COMPLETE_WHEN, KINDS, PARK_NO_MATCH, PARK_NOT_LISTED, PHONE_PARK_CHIPS, US_STATES,
  addEntries, allStates, atLeastHint, parkReference, removeEntry, withCompleteWhen, withKind, type RequirementDraft,
} from "./editModel";
import { KIND_LABEL, PHONE_CHIPS, bandLabel } from "./model";
import type { GoalKind } from "./types";

/** POTA searches already answered, by query, for as long as the editor is open; shared by its park requirements. */
export type ParkSearchCache = Map<string, ReferenceSearchResult[]>;

interface Props {
  req: RequirementDraft;
  phone: boolean;
  /** Park names by reference, for chips: the loaded list's, plus parks picked from a search. */
  names: Record<string, string>;
  cache: ParkSearchCache;
  onChange: (req: RequirementDraft) => void;
  onRemove: () => void;
  /** A park picked from the search, so its chip shows the name. */
  onName: (reference: string, name: string) => void;
}

/**
 * One requirement on the edit page: its kind, "Complete when" (and How many), and its entries as
 * chips with a field to add more (states, a POTA search that takes any typed reference, bands).
 * Phones put the kind in the card's title, show fewer chips and open the add field from a button.
 */
export function RequirementEditor({ req, phone, names, cache, onChange, onRemove, onName }: Props) {
  const [adding, setAdding] = useState(false);
  const [allChips, setAllChips] = useState(false);
  const kind = KIND_LABEL[req.kind];
  const hint = atLeastHint(req);
  const add = (values: string[]) => onChange({ ...req, entries: addEntries(req.kind, req.entries, values) });

  const completeWhen = (
    <TextField
      select label={phone ? "Complete when" : "Complete when you've worked"} value={req.completeWhen}
      onChange={(e) => onChange(withCompleteWhen(req, e.target.value === "at_least" ? "at_least" : "all"))}
      sx={{ flex: "1 1 220px" }}
    >
      {COMPLETE_WHEN.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
    </TextField>
  );
  const howMany = req.completeWhen === "at_least" && (
    <TextField
      label="How many" type="number" value={req.atLeast} onChange={(e) => onChange({ ...req, atLeast: e.target.value })}
      slotProps={{ htmlInput: { min: 1, inputMode: "numeric" } }} sx={{ flex: "0 0 120px", width: 120 }}
    />
  );
  const adder = <EntryAdder req={req} cache={cache} onAdd={add} onName={onName} autoFocus={phone} />;

  if (phone) {
    return (
      <Card variant="outlined" component="section" aria-label={kind}>
        <CardContent>
          <Stack spacing={2}>
            <Stack direction="row" sx={{ alignItems: "center", justifyContent: "space-between" }}>
              <Typography variant="h6" component="h3">{kind}</Typography>
              <Button color="error" size="small" onClick={onRemove}>Remove</Button>
            </Stack>
            {completeWhen}
            {howMany}
            <Box>
              <Typography variant="overline" color="text.secondary" component="h4">Entries</Typography>
              <EntryChips
                req={req} names={names} limit={allChips ? null : req.kind === "park" ? PHONE_PARK_CHIPS : PHONE_CHIPS}
                onMore={() => setAllChips(true)} onChange={onChange}
              />
            </Box>
            {hint && <Typography variant="caption" color="text.secondary">{hint}</Typography>}
            {adding ? adder : (
              <Box>
                <Button variant="outlined" startIcon={<AddIcon />} onClick={() => setAdding(true)}>{ADD_BUTTON[req.kind]}</Button>
              </Box>
            )}
          </Stack>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card variant="outlined" component="section" aria-label={kind}>
      <CardContent>
        <Stack spacing={2}>
          <Stack direction="row" spacing={2} sx={{ alignItems: "flex-start" }}>
            <Stack direction="row" spacing={2} useFlexGap sx={{ flex: "1 1 0", minWidth: 0, flexWrap: "wrap" }}>
              <TextField
                select label="Kind" value={req.kind} sx={{ flex: "1 1 180px" }}
                onChange={(e) => onChange(withKind(req, KINDS.find((k) => k.kind === e.target.value)?.kind ?? req.kind))}
              >
                {KINDS.map((k) => <MenuItem key={k.kind} value={k.kind}>{k.label}</MenuItem>)}
              </TextField>
              {completeWhen}
              {howMany}
            </Stack>
            <IconButton aria-label="Delete requirement" onClick={onRemove} sx={{ mt: 1 }}>
              <DeleteIcon />
            </IconButton>
          </Stack>
          <EntryChips req={req} names={names} limit={null} onMore={() => setAllChips(true)} onChange={onChange} />
          {adder}
          {hint && <Typography variant="caption" color="text.secondary">{hint}</Typography>}
        </Stack>
      </CardContent>
    </Card>
  );
}

interface ChipsProps {
  req: RequirementDraft;
  names: Record<string, string>;
  /** How many chips to show before "+ N more", or null for all. */
  limit: number | null;
  onMore: () => void;
  onChange: (req: RequirementDraft) => void;
}

/** The entries as chips, each removable; every state at once is one "All 50 states" chip, which removes them all. */
function EntryChips({ req, names, limit, onMore, onChange }: ChipsProps) {
  if (req.kind === "state" && allStates(req.entries)) {
    return (
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
        <Chip label={ALL_STATES_LABEL} onDelete={() => onChange({ ...req, entries: [] })} />
      </Stack>
    );
  }
  const shown = limit === null ? req.entries : req.entries.slice(0, limit);
  const more = req.entries.length - shown.length;
  return (
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
      {shown.map((v) => {
        const label = entryLabel(req.kind, v, names);
        return (
          <Chip
            key={v} label={label} onDelete={() => onChange({ ...req, entries: removeEntry(req.entries, v) })}
            sx={{ maxWidth: "100%" }}
          />
        );
      })}
      {more > 0 && <Chip variant="outlined" label={`+ ${more} more`} onClick={onMore} />}
    </Stack>
  );
}

function entryLabel(kind: GoalKind, value: string, names: Record<string, string>): string {
  if (kind === "band") return bandLabel(value);
  if (kind === "park") return names[value] ?? value;
  return value;
}

interface AdderProps {
  req: RequirementDraft;
  cache: ParkSearchCache;
  onAdd: (values: string[]) => void;
  onName: (reference: string, name: string) => void;
  autoFocus: boolean;
}

function EntryAdder({ req, cache, onAdd, onName, autoFocus }: AdderProps) {
  if (req.kind === "park") return <ParkAdder chosen={req.entries} cache={cache} onAdd={onAdd} onName={onName} autoFocus={autoFocus} />;
  if (req.kind === "band") return <BandAdder chosen={req.entries} onAdd={onAdd} autoFocus={autoFocus} />;
  return <StateAdder chosen={req.entries} onAdd={onAdd} autoFocus={autoFocus} />;
}

/** The "All 50 states" option's value: never a state code. */
const ALL = "*";

const stateFilter = createFilterOptions<string>({ stringify: (o) => (o === ALL ? ALL_STATES_LABEL : `${stateName(o)} ${o}`) });

/** "Add a state": the states not on the list by name or code, led by "All 50 states". */
function StateAdder({ chosen, onAdd, autoFocus }: { chosen: string[]; onAdd: (values: string[]) => void; autoFocus: boolean }) {
  const [input, setInput] = useState("");
  const left = US_STATES.filter((s) => !chosen.includes(s));
  const options = left.length > 0 ? [ALL, ...left] : [];
  const field = ADD_FIELD.state;
  return (
    <Autocomplete<string>
      options={options} value={null} inputValue={input} filterOptions={stateFilter}
      onInputChange={(_e, v, reason) => setInput(reason === "input" ? v : "")}
      onChange={(_e, v) => {
        if (v) onAdd(v === ALL ? [...US_STATES] : [v]);
        setInput("");
      }}
      getOptionLabel={(o) => (o === ALL ? ALL_STATES_LABEL : stateName(o))}
      renderOption={({ key, ...props }, o) => (
        <Box component="li" key={key} {...props}>
          {o === ALL ? ALL_STATES_LABEL : (
            <Stack direction="row" spacing={1} sx={{ alignItems: "baseline" }}>
              <span>{stateName(o)}</span>
              <Typography variant="body2" color="text.secondary" component="span">{o}</Typography>
            </Stack>
          )}
        </Box>
      )}
      renderInput={(p) => <TextField {...p} label={field.label} placeholder={field.placeholder} autoFocus={autoFocus} />}
    />
  );
}

/** "Add a band": the bands not on the list. */
function BandAdder({ chosen, onAdd, autoFocus }: { chosen: string[]; onAdd: (values: string[]) => void; autoFocus: boolean }) {
  const [input, setInput] = useState("");
  return (
    <Autocomplete<string>
      options={BANDS.filter((b) => !chosen.includes(b))} value={null} inputValue={input}
      onInputChange={(_e, v, reason) => setInput(reason === "input" ? v : "")}
      onChange={(_e, v) => {
        if (v) onAdd([v]);
        setInput("");
      }}
      getOptionLabel={bandLabel}
      renderInput={(p) => <TextField {...p} label={ADD_FIELD.band.label} autoFocus={autoFocus} />}
    />
  );
}

/** A line in the park list that can't be chosen: searching found nothing, or the search failed. */
interface StatusOption {
  status: string;
}

type ParkOption = ReferenceSearchResult | StatusOption;

const isStatus = (o: ParkOption): o is StatusOption => "status" in o;

interface ParkProps {
  chosen: string[];
  cache: ParkSearchCache;
  onAdd: (values: string[]) => void;
  onName: (reference: string, name: string) => void;
  autoFocus: boolean;
}

/**
 * "Add a park": the POTA list through searchReferences, which only suggests. Enter adds any typed
 * POTA reference, in the list or not; text that isn't one stays in the field to pick from.
 */
function ParkAdder({ chosen, cache, onAdd, onName, autoFocus }: ParkProps) {
  const [input, setInput] = useState("");
  // Bumped when a search is answered, so the field reads the cache again.
  const [, setAnswered] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  const query = searchQuery(input);
  const key = query?.toUpperCase() ?? null;

  useEffect(() => {
    if (query === null || key === null || cache.has(key)) return;
    let active = true;
    const timer = setTimeout(() => {
      setFailed(null);
      searchReferences(query, "pota").then(
        (answer) => {
          cache.set(key, answer.results);
          if (active) setAnswered((n) => n + 1);
        },
        () => {
          if (active) setFailed(key);
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [cache, key, query]);

  const results = key === null ? undefined : cache.get(key);
  let options: ParkOption[] = [];
  let loading = false;
  if (key !== null) {
    const left = results?.filter((r) => !chosen.includes(r.reference));
    if (left) options = left.length > 0 ? left : [{ status: parkReference(input) ? PARK_NOT_LISTED : PARK_NO_MATCH }];
    else if (failed === key) options = [{ status: SEARCH_FAILED_TEXT }];
    else loading = true;
  }

  const pick = (o: ParkOption | string | null) => {
    if (o === null) return;
    if (typeof o === "string") {
      const ref = parkReference(o);
      if (!ref) return;
      onAdd([ref]);
    } else if (!isStatus(o)) {
      if (o.name) onName(o.reference, o.name);
      onAdd([o.reference]);
    }
    setInput("");
  };

  const field = ADD_FIELD.park;
  return (
    <Autocomplete<ParkOption, false, false, true>
      freeSolo options={options} value={null} inputValue={input} loading={loading} loadingText={SEARCHING_TEXT}
      // The server has filtered; a reference already on the list was left out above.
      filterOptions={(opts) => opts}
      onInputChange={(_e, v, reason) => {
        if (reason === "input") setInput(v);
      }}
      onChange={(_e, v) => pick(v)}
      getOptionLabel={(o) => (typeof o === "string" ? o : isStatus(o) ? o.status : o.reference)}
      getOptionDisabled={isStatus}
      renderOption={({ key: optionKey, ...props }, o) => (
        <Box component="li" key={optionKey} {...props}>
          {isStatus(o) ? (
            <Typography variant="body2" color="text.secondary">{o.status}</Typography>
          ) : (
            <Box sx={{ minWidth: 0 }}>
              <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
                <Typography variant="subtitle2" component="span">{o.reference}</Typography>
                {!o.active && <Chip size="small" variant="outlined" label="Retired" />}
              </Stack>
              {o.name && <Typography variant="body2" color="text.secondary">{o.name}</Typography>}
            </Box>
          )}
        </Box>
      )}
      renderInput={(p) => <TextField {...p} label={field.label} placeholder={field.placeholder} autoFocus={autoFocus} />}
    />
  );
}

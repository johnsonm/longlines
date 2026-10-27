// The values of an exact reference rule (`is`, `is not`): chips as typed, plus options from the
// POTA, SOTA and WWFF lists through searchReferences. The lists only suggest: Enter, a comma or a
// space still adds any value, references outside the lists included (decision 8), and the reference
// shape check stays the rule builder's (rowInvalid).

import { useEffect, useState } from "react";
import { Autocomplete, Box, Chip, Stack, TextField, Typography } from "@mui/material";
import { searchReferences } from "../lib/api";
import { PROGRAMS } from "../references/format";
import type { ReferenceProgram, ReferenceSearchResult } from "../references/types";
import { referenceValues, searchQuery, type ReferenceSearchCache } from "./model";

/** The wait after the last keystroke before a search is sent. */
export const SEARCH_DEBOUNCE_MS = 300;

export const SEARCHING_TEXT = "Searching the lists…";
export const NOT_LISTED_TEXT = "Not in the POTA, SOTA or WWFF lists. Press Enter to add it anyway.";
export const SEARCH_FAILED_TEXT = "Search is unavailable. Press Enter to add a reference.";

/** SQL matches words case-insensitively, so "mitchell" and "Mitchell" share an answer. */
const searchKey = (query: string, program: ReferenceProgram | null) => `${program ?? "all"} ${query.toUpperCase()}`;

/** A line in the list that can't be chosen: no matches, or the search failed. */
interface StatusOption {
  status: string;
}

type Option = ReferenceSearchResult | StatusOption;

const isStatus = (o: Option): o is StatusOption => "status" in o;

function optionLabel(o: Option | string): string {
  if (typeof o === "string") return o;
  return isStatus(o) ? o.status : o.reference;
}

interface Props {
  values: string[];
  onChange: (values: string[]) => void;
  /** The list to search, or null for all three. */
  program: ReferenceProgram | null;
  cache: ReferenceSearchCache;
  label: string;
  error: boolean;
}

export function ReferenceValuesField({ values, onChange, program, cache, label, error }: Props) {
  const [input, setInput] = useState("");
  // Bumped when a search is answered, so the field reads the cache again.
  const [, setAnswered] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);

  const query = searchQuery(input);
  const key = query === null ? null : searchKey(query, program);

  useEffect(() => {
    if (query === null || key === null || cache.results.has(key) || cache.pending.has(key)) return;
    const timer = setTimeout(() => {
      cache.pending.add(key);
      setFailed((f) => (f === key ? null : f));
      // Each answer goes in the cache under its own search; the field shows only the current one's,
      // so an answer that arrives late never replaces a newer search's.
      searchReferences(query, program).then(
        (search) => {
          cache.pending.delete(key);
          cache.results.set(key, search.results);
          setAnswered((n) => n + 1);
        },
        () => {
          // A network error, the rate limit or a 5xx: typing goes on, and Enter still adds the value.
          cache.pending.delete(key);
          setFailed(key);
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [cache, key, query, program]);

  const results = key === null ? undefined : cache.results.get(key);
  let options: Option[] = [];
  let loading = false;
  if (key !== null) {
    if (results) options = results.length ? results : [{ status: NOT_LISTED_TEXT }];
    else if (failed === key) options = [{ status: SEARCH_FAILED_TEXT }];
    else loading = true;
  }

  return (
    <Autocomplete<Option, true, false, true>
      // autoSelect commits a reference left in the field on blur, as for callsigns.
      multiple freeSolo autoSelect options={options} value={values} loading={loading} loadingText={SEARCHING_TEXT}
      inputValue={input} onInputChange={(_e, v) => setInput(v)}
      // The server has filtered; only references already chosen are left out.
      filterOptions={(opts) => opts.filter((o) => isStatus(o) || !values.includes(o.reference))}
      getOptionLabel={optionLabel} getOptionDisabled={isStatus}
      onChange={(_e, v) => onChange(referenceValues(v.map((o) => (typeof o === "string" ? o : optionLabel(o)))))}
      renderOption={({ key: optionKey, ...props }, o) => (
        <Box component="li" key={optionKey} {...props}>
          {isStatus(o) ? (
            <Typography variant="body2" color="text.secondary">{o.status}</Typography>
          ) : (
            <Box sx={{ minWidth: 0 }}>
              <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
                <Typography variant="subtitle2">{o.reference}</Typography>
                <Chip size="small" color={PROGRAMS[o.program].color} label={PROGRAMS[o.program].short} />
                {!o.active && <Chip size="small" variant="outlined" label="Retired" />}
              </Stack>
              {o.name && <Typography variant="body2" color="text.secondary">{o.name}</Typography>}
            </Box>
          )}
        </Box>
      )}
      renderInput={(p) => <TextField {...p} label={label} placeholder="US-2763 or Mount Mitchell" error={error} />}
    />
  );
}

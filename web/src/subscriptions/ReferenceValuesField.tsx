// The values of an exact reference rule (`is`, `is not`): chips as typed, plus options from the
// POTA, SOTA and WWFF lists through searchReferences. The lists only suggest: Enter, a comma or a
// space still adds any value, references outside the lists included (decision 8), and the reference
// shape check stays the rule builder's (rowInvalid). The one exception is a name of several words
// that the lists match: Enter then waits for an option rather than adding each word.

import { useEffect, useRef, useState } from "react";
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
  // Whether the list is open and the user has moved onto an option (MUI reports only user moves).
  const open = useRef(false);
  const highlighted = useRef(false);

  const query = searchQuery(input);
  const key = query === null ? null : searchKey(query, program);

  useEffect(() => {
    if (query === null || key === null || cache.results.has(key)) return;
    let active = true;
    // This field's view of a search, whichever field sent it: read the cache again once it answers,
    // or say it failed (a network error, the rate limit or a 5xx; typing goes on, and Enter still
    // adds the value). Only the current search's field state changes, so a late answer never
    // replaces a newer search's.
    const follow = (search: Promise<ReferenceSearchResult[]>) => search.then(
      () => {
        if (active) setAnswered((n) => n + 1);
      },
      () => {
        if (active) setFailed(key);
      },
    );
    const out = cache.pending.get(key);
    if (out) {
      follow(out);
      return () => {
        active = false;
      };
    }
    const timer = setTimeout(() => {
      setFailed((f) => (f === key ? null : f));
      // The answer goes in the cache under its own search, whether or not a field still shows it.
      const search = searchReferences(query, program)
        .then((answer) => {
          cache.results.set(key, answer.results);
          return answer.results;
        })
        .finally(() => cache.pending.delete(key));
      cache.pending.set(key, search);
      follow(search);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [cache, key, query, program]);

  const results = key === null ? undefined : cache.results.get(key);
  let options: Option[] = [];
  let loading = false;
  if (key !== null) {
    if (results) options = results.length ? results : [{ status: NOT_LISTED_TEXT }];
    else if (failed === key) options = [{ status: SEARCH_FAILED_TEXT }];
    else loading = true;
  }

  // A name of several words is never a reference. With the lists' matches showing for it, Enter
  // waits for one to be chosen rather than adding each word as a chip (MOUNT, MITCHELL). Text with
  // no matches, a single word, or a list of references still goes in as typed.
  const choose = /[\s,;]/.test(input.trim()) && options.some((o) => !isStatus(o) && !values.includes(o.reference));

  return (
    <Autocomplete<Option, true, false, true>
      // autoSelect commits a reference left in the field on blur, as for callsigns.
      multiple freeSolo autoSelect options={options} value={values} loading={loading} loadingText={SEARCHING_TEXT}
      inputValue={input}
      onInputChange={(_e, v) => {
        setInput(v);
        highlighted.current = false;
      }}
      onOpen={() => {
        open.current = true;
      }}
      onClose={() => {
        open.current = false;
        highlighted.current = false;
      }}
      onHighlightChange={(_e, o) => {
        highlighted.current = o !== null;
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && choose && open.current && !highlighted.current) {
          e.defaultMuiPrevented = true;
          e.preventDefault();
        }
      }}
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
                <Typography variant="subtitle2" component="span">{o.reference}</Typography>
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

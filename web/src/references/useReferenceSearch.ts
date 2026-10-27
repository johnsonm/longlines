import { useEffect, useState } from "react";
import { searchReferences } from "../lib/api";
import { keyedCached, type KeyedCached } from "../stats/cache";
import { referenceProgram } from "./paths";
import type { ReferenceProgram, ReferenceSearch } from "./types";

// As long as the function lets a browser cache it (Cache-Control max-age=300),
// counted from when it arrived, as for reference pages.
const SEARCH_CACHE_MS = 5 * 60 * 1000;

const ALL = "all";
const keyOf = (query: string, program: ReferenceProgram | null) => `${program ?? ALL} ${query}`;

// Back to an earlier search, or the same search submitted again, renders at once
// without another request against the rate limit.
const searches: KeyedCached<ReferenceSearch> = keyedCached(
  (key) => {
    const space = key.indexOf(" ");
    return searchReferences(key.slice(space + 1), referenceProgram(key.slice(0, space)));
  },
  () => Date.now() + SEARCH_CACHE_MS,
  // Read the clock when asked, not the Date.now this module saw at load, so expiry and freshness agree.
  () => Date.now(),
);

interface Result {
  key: string;
  search?: ReferenceSearch;
  error?: unknown;
}

export interface ReferenceSearchState {
  search: ReferenceSearch | null;
  error: unknown;
  loading: boolean;
}

/**
 * One request per search: the page passes the submitted query (trimmed and
 * within search_references' bounds) and the program, or null for no search.
 */
export function useReferenceSearch(query: string | null, program: ReferenceProgram | null): ReferenceSearchState {
  const key = query === null ? null : keyOf(query, program);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    if (key === null) return;
    let active = true;
    searches.get(key).then(
      (search) => {
        if (active) setResult({ key, search });
      },
      (error: unknown) => {
        if (active) setResult({ key, error });
      },
    );
    return () => {
      active = false;
    };
  }, [key]);

  if (key === null) return { search: null, error: null, loading: false };
  // A result for another search is stale; a cached one renders without a loading flash.
  const current: Result = result?.key === key ? result : { key };
  const search = current.search ?? searches.peek(key) ?? null;
  const error = search ? null : current.error ?? null;
  return { search, error, loading: !search && !error };
}

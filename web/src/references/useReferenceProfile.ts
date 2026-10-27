import { useEffect, useState } from "react";
import { loadReferenceProfile } from "../lib/api";
import { keyedCached, type KeyedCached } from "../stats/cache";
import type { ReferenceProfile } from "./types";

// As long as the function lets a browser cache it (Cache-Control max-age=300),
// counted from when it arrived, as for callsign profiles.
const PROFILE_CACHE_MS = 5 * 60 * 1000;

// Going back to a reference renders it at once without another request
// against the rate limit. "No such page" is kept too, as null.
const profiles: KeyedCached<ReferenceProfile | null> = keyedCached(
  (key) => {
    const slash = key.indexOf("/");
    return loadReferenceProfile(key.slice(0, slash), key.slice(slash + 1));
  },
  () => Date.now() + PROFILE_CACHE_MS,
);

interface Result {
  key: string;
  profile?: ReferenceProfile | null;
  error?: unknown;
}

export interface ReferenceProfileState {
  profile: ReferenceProfile | null;
  /** The function found no such page: the Not found state. */
  notFound: boolean;
  error: unknown;
  loading: boolean;
}

/** One request per visit, never polled: a reference page is a snapshot, as a callsign profile is. */
export function useReferenceProfile(program: string, reference: string): ReferenceProfileState {
  const key = `${program}/${reference}`;
  const [result, setResult] = useState<Result>({ key });

  // Runs for a cached profile too (get resolves it without a request), so the
  // result outlives the cache entry while the page stays open.
  useEffect(() => {
    let active = true;
    profiles.get(key).then(
      (profile) => {
        if (active) setResult({ key, profile });
      },
      (error: unknown) => {
        if (active) setResult({ key, error });
      },
    );
    return () => {
      active = false;
    };
  }, [key]);

  // A result for another reference is stale; a cached one renders without a loading flash.
  const current: Result = result.key === key ? result : { key };
  const profile = current.profile !== undefined ? current.profile : profiles.peek(key);
  const error = profile === undefined ? current.error ?? null : null;
  return { profile: profile ?? null, notFound: profile === null, error, loading: profile === undefined && !error };
}

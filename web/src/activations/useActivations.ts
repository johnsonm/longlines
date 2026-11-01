import { useEffect, useState } from "react";
import { loadCallsignActivations, loadSpottedActivation } from "../lib/api";
import { keyedCached, type KeyedCached } from "../stats/cache";
import type { CallsignActivations, SpottedActivation } from "./types";

// As long as the function lets a browser cache it (Cache-Control max-age=300), counted from when
// it arrived, as for callsign and reference profiles.
const CACHE_MS = 5 * 60 * 1000;
const freshUntil = () => Date.now() + CACHE_MS;

// Going back to a page renders it at once without another request against the rate limit.
// "No such page" is kept too, as null.
const activations: KeyedCached<SpottedActivation | null> = keyedCached((id) => loadSpottedActivation(id), freshUntil);
const lists: KeyedCached<CallsignActivations | null> = keyedCached((call) => loadCallsignActivations(call), freshUntil);

export interface LoadState<T> {
  data: T | null;
  /** The function found no such page: the Not found state. */
  notFound: boolean;
  error: unknown;
  loading: boolean;
}

interface Result<T> {
  key: string;
  data?: T | null;
  error?: unknown;
}

/** One request per key per visit, never polled: closed activations never change. */
function useKeyed<T>(cache: KeyedCached<T | null>, key: string): LoadState<T> {
  const [result, setResult] = useState<Result<T>>({ key });

  // Runs for a cached entry too (get resolves it without a request), so the result outlives the
  // cache entry while the page stays open.
  useEffect(() => {
    let active = true;
    cache.get(key).then(
      (data) => {
        if (active) setResult({ key, data });
      },
      (error: unknown) => {
        if (active) setResult({ key, error });
      },
    );
    return () => {
      active = false;
    };
  }, [cache, key]);

  // A result for another key is stale; a cached one renders without a loading flash.
  const current: Result<T> = result.key === key ? result : { key };
  const data = current.data !== undefined ? current.data : cache.peek(key);
  const error = data === undefined ? current.error ?? null : null;
  return { data: data ?? null, notFound: data === null, error, loading: data === undefined && !error };
}

/** One activation's page, by the id in the URL. */
export function useSpottedActivation(id: string): LoadState<SpottedActivation> {
  return useKeyed(activations, id);
}

/** A callsign's Spotted activations tab, by its base call. */
export function useCallsignActivations(base: string): LoadState<CallsignActivations> {
  return useKeyed(lists, base);
}

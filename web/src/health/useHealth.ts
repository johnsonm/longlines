import { useCallback, useEffect, useRef, useState } from "react";
import { errorText } from "../app/hooks";
import { loadHealth } from "../lib/api";
import { useVisibleInterval } from "../sources/useVisibleInterval";
import type { HealthPayload, HealthRange } from "./types";

/** The sampler writes once a minute and the server caches for 30 seconds, so a minute is often enough. */
export const REFRESH_MS = 60_000;

/**
 * The health payload for `range`, loaded at once on mount, on a range change and
 * on refresh(), and every minute while the tab is visible. A failed refresh
 * keeps the last payload on screen and reports the error; a response for a
 * range no longer shown is dropped.
 */
export function useHealth(range: HealthRange): {
  payload: HealthPayload | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [payload, setPayload] = useState<HealthPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<HealthRange | null>(range);

  const load = useCallback(() => {
    setLoading(true);
    loadHealth(range)
      .then((p) => {
        if (current.current !== range) return;
        setPayload(p);
        setError(null);
      })
      .catch((err: unknown) => {
        if (current.current === range) setError(errorText(err, "Couldn't load the health checks."));
      })
      .finally(() => {
        if (current.current === range) setLoading(false);
      });
  }, [range]);

  useEffect(() => {
    current.current = range;
    load();
    return () => {
      current.current = null;
    };
  }, [range, load]);

  useVisibleInterval(load, REFRESH_MS);
  return { payload, loading, error, refresh: load };
}

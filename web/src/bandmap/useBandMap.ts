import { useCallback, useEffect, useRef, useState } from "react";
import { errorText } from "../app/hooks";
import { loadBandMap } from "../lib/api";
import { useVisibleInterval } from "../sources/useVisibleInterval";
import type { BandMapPayload } from "./types";

/** The server rebuilds its shared cache every 30 seconds, so asking more often only gets the same payload. */
export const REFRESH_MS = 30_000;

/**
 * The band map, loaded on mount and again every 30 seconds while the tab is
 * visible (and at once when it comes back). A failed refresh keeps the last
 * payload on screen and reports the error.
 */
export function useBandMap(): { payload: BandMapPayload | null; loading: boolean; error: string | null } {
  const [payload, setPayload] = useState<BandMapPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);

  const load = useCallback(() => {
    loadBandMap()
      .then((p) => {
        if (!active.current) return;
        setPayload(p);
        setError(null);
      })
      .catch((err: unknown) => {
        if (active.current) setError(errorText(err, "Couldn't load the band map."));
      })
      .finally(() => {
        if (active.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    active.current = true;
    load();
    return () => {
      active.current = false;
    };
  }, [load]);

  useVisibleInterval(load, REFRESH_MS);
  return { payload, loading, error };
}

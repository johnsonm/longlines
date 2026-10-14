import { useCallback, useEffect, useRef, useState } from "react";
import { errorText } from "../app/hooks";
import { loadIngestHealth, type IngestHealth } from "../lib/api";
import { useVisibleInterval } from "./useVisibleInterval";

/** Ingest health, loaded on mount and, with pollMs, refreshed while the tab is visible. */
export function useIngestHealth(pollMs: number | null): { health: IngestHealth[] | null; error: string | null } {
  const [health, setHealth] = useState<IngestHealth[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const rows = await loadIngestHealth();
      if (!mounted.current) return;
      setHealth(rows);
      setError(null);
    } catch (err) {
      if (mounted.current) setError(errorText(err, "Couldn't load sources."));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  useVisibleInterval(() => void refresh(), pollMs);
  return { health, error };
}

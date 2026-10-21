import { useEffect, useState } from "react";
import { errorText } from "../app/hooks";
import { loadLatestStats } from "../lib/api";
import { cached } from "./cache";
import type { LatestStats } from "./types";

const HOUR = 60 * 60 * 1000;
const MIN_FRESH = 60 * 1000;

/**
 * When a snapshot that arrived at `now` stops being fresh: an hour after the server wrote it, clamped to
 * between a minute and an hour after arrival, so a browser clock that is off can neither refetch on every
 * mount (fast clock) nor keep a snapshot past the next refresh by more than an hour (slow clock).
 */
export function freshUntil(generatedAt: string, now: number): number {
  const due = Date.parse(generatedAt) + HOUR;
  return Math.min(now + HOUR, Math.max(now + MIN_FRESH, Number.isNaN(due) ? now : due));
}

// One request per hour of page use, never polled (see cache.ts). A snapshot
// stays fresh until the next hourly refresh is due; "no snapshot yet" (null)
// is not kept, so the first visit after the first refresh picks it up.
const snapshot = cached(loadLatestStats, (s) => (s ? freshUntil(s.generatedAt, Date.now()) : null));

export function useStats(): { stats: LatestStats | null; loading: boolean; error: string | null } {
  // Seed from the cache so returning to /stats renders the dashboard at once instead of flashing a progress bar.
  const [stats, setStats] = useState<LatestStats | null>(() => snapshot.peek() ?? null);
  const [loading, setLoading] = useState(() => snapshot.peek() === undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (snapshot.peek() !== undefined) return;
    let active = true;
    snapshot
      .get()
      .then((s) => {
        if (active) setStats(s);
      })
      .catch((err: unknown) => {
        if (active) setError(errorText(err, "Couldn't load stats."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return { stats, loading, error };
}

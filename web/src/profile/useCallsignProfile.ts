import { useEffect, useState } from "react";
import { loadCallsignProfile } from "../lib/api";
import { keyedCached, type KeyedCached } from "../stats/cache";
import type { CallsignProfile } from "./types";

const PROFILE_CACHE_MS = 15 * 60 * 1000;

// Kept until the database cache that served it expires, so going back to a
// profile renders it at once without another lookup against the rate limit.
// A lookup of KK4PWJ/P is also kept under the base call it returned, which the
// page redirects to next.
const profiles: KeyedCached<CallsignProfile> = keyedCached(
  async (callsign) => {
    const profile = await loadCallsignProfile(callsign);
    if (profile.callsign !== callsign) profiles.put(profile.callsign, profile);
    return profile;
  },
  (p) => Date.parse(p.generatedAt) + PROFILE_CACHE_MS,
);

interface Result {
  callsign: string;
  profile?: CallsignProfile;
  error?: unknown;
}

export function useCallsignProfile(callsign: string): { profile: CallsignProfile | null; error: unknown; loading: boolean } {
  const [result, setResult] = useState<Result>({ callsign });

  // Runs for a cached profile too (get resolves it without a request), so the
  // result outlives the cache entry while the page stays open.
  useEffect(() => {
    let active = true;
    profiles.get(callsign).then(
      (profile) => {
        if (active) setResult({ callsign, profile });
      },
      (error: unknown) => {
        if (active) setResult({ callsign, error });
      },
    );
    return () => {
      active = false;
    };
  }, [callsign]);

  // A result for another callsign is stale; a cached profile renders without a loading flash.
  const current: Result = result.callsign === callsign ? result : { callsign };
  const profile = current.profile ?? profiles.peek(callsign) ?? null;
  const error = profile ? null : current.error ?? null;
  return { profile, error, loading: !profile && !error };
}

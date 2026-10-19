// The preview cards' spot picker: the last few spots the preview RPCs can
// read, newest first, and the one chosen (null for the sample spot). Shared
// by the push, Discord and webhook editors.

import { useEffect, useState } from "react";
import { loadRecentSpots, type RecentSpot } from "../lib/api";

/** The picker's option label, kept in pushModel.ts so that pure module stays free of the API client. */
export { spotLabel } from "./pushModel";

export const PICKER_SIZE = 10;
/** Sources whose spots are raw_spots rows, which the preview RPCs read by id. RBN's recent list is its own table. */
export const PICKER_SOURCES = ["pota", "sotawatch", "dxcluster", "wwff"];
/** push_sample_spot() (the sample both previews use) is a POTA spot. */
export const SAMPLE_SOURCE = "pota";

export interface RecentSpotPicker {
  /** Up to PICKER_SIZE spots across PICKER_SOURCES, newest first; empty until they load. */
  spots: RecentSpot[];
  /** The chosen raw_spots id, or null for the sample spot. */
  spotId: number | null;
  setSpotId: (id: number | null) => void;
  /** The chosen spot, or null for the sample. */
  chosen: RecentSpot | null;
}

export function useRecentSpotPicker(): RecentSpotPicker {
  const [spots, setSpots] = useState<RecentSpot[]>([]);
  const [spotId, setSpotId] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all(PICKER_SOURCES.map((s) => loadRecentSpots(s, PICKER_SIZE).catch(() => [] as RecentSpot[])))
      .then((lists) => {
        if (!active) return;
        const all = lists.flat().filter((s) => s.id !== null && s.spot_time !== null);
        all.sort((a, b) => (b.spot_time ?? "").localeCompare(a.spot_time ?? ""));
        setSpots(all.slice(0, PICKER_SIZE));
      });
    return () => {
      active = false;
    };
  }, []);

  const chosen = spots.find((s) => s.id === spotId) ?? null;
  return { spots, spotId, setSpotId, chosen };
}

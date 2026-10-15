// The HF and 6m band plan the band map draws, in kHz. Segment edges are
// approximate and for display only: a spot's mode comes from its source or
// from _shared/modes.ts, never from here. 10m and 6m stop short of the band
// edge on purpose, since activity above is rare and would squash the useful part.

export type SegmentLabel = "CW" | "Digital" | "Phone";

export interface BandPlan {
  band: string;
  from: number;
  to: number;
  /** Segment starts, low to high; the first starts at `from`. */
  segments: { start: number; label: SegmentLabel }[];
}

export const BAND_PLAN: readonly BandPlan[] = [
  { band: "160m", from: 1800, to: 2000, segments: [{ start: 1800, label: "CW" }, { start: 1840, label: "Digital" }, { start: 1843, label: "Phone" }] },
  { band: "80m", from: 3500, to: 4000, segments: [{ start: 3500, label: "CW" }, { start: 3570, label: "Digital" }, { start: 3600, label: "Phone" }] },
  { band: "40m", from: 7000, to: 7300, segments: [{ start: 7000, label: "CW" }, { start: 7040, label: "Digital" }, { start: 7125, label: "Phone" }] },
  { band: "30m", from: 10100, to: 10150, segments: [{ start: 10100, label: "CW" }, { start: 10130, label: "Digital" }] },
  { band: "20m", from: 14000, to: 14350, segments: [{ start: 14000, label: "CW" }, { start: 14070, label: "Digital" }, { start: 14150, label: "Phone" }] },
  { band: "17m", from: 18068, to: 18168, segments: [{ start: 18068, label: "CW" }, { start: 18095, label: "Digital" }, { start: 18110, label: "Phone" }] },
  { band: "15m", from: 21000, to: 21450, segments: [{ start: 21000, label: "CW" }, { start: 21070, label: "Digital" }, { start: 21200, label: "Phone" }] },
  { band: "12m", from: 24890, to: 24990, segments: [{ start: 24890, label: "CW" }, { start: 24910, label: "Digital" }, { start: 24930, label: "Phone" }] },
  { band: "10m", from: 28000, to: 28600, segments: [{ start: 28000, label: "CW" }, { start: 28070, label: "Digital" }, { start: 28300, label: "Phone" }] },
  { band: "6m", from: 50000, to: 50350, segments: [{ start: 50000, label: "CW" }, { start: 50100, label: "Phone" }, { start: 50300, label: "Digital" }] },
];

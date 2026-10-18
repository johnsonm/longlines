// Pure band map logic: lanes, which stations a strip shows, the crowd around a
// click, segment labels and the text in tooltips and menus. BandStrip and
// BandMapPage render what these return.

import type { BandPlan } from "../lib/bandplan";
import type { BandMapPayload, BandMapSource, BandMapSpot } from "./types";

export interface SourceInfo {
  id: BandMapSource;
  label: string;
  /** The palette color, the same everywhere in the app. */
  color: "success" | "primary" | "secondary";
  /** y on the strip: DX Cluster at the bottom, SOTA at the top. */
  lane: number;
}

/** In lane order, bottom to top; also the order of the filter chips. */
export const SOURCES: readonly SourceInfo[] = [
  { id: "dxcluster", label: "DX Cluster", color: "success", lane: 0 },
  { id: "pota", label: "POTA", color: "primary", lane: 1 },
  { id: "sotawatch", label: "SOTA", color: "secondary", lane: 2 },
];

export function sourceInfo(source: BandMapSource): SourceInfo {
  return SOURCES.find((s) => s.id === source) ?? SOURCES[0]!;
}

/**
 * The stations a band's strip shows: its spots inside the plan's range, from
 * the sources switched on, one per base call (the latest, should the payload
 * ever hold two), low to high.
 */
export function bandStations(payload: BandMapPayload | null, plan: BandPlan, shown: ReadonlySet<BandMapSource>): BandMapSpot[] {
  const spots = payload?.bands.find((b) => b.band === plan.band)?.spots ?? [];
  const latest = new Map<string, BandMapSpot>();
  for (const s of spots) {
    if (s.frequency_khz < plan.from || s.frequency_khz > plan.to) continue;
    const kept = latest.get(s.base_callsign);
    if (!kept || Date.parse(s.spot_time) > Date.parse(kept.spot_time)) latest.set(s.base_callsign, s);
  }
  return [...latest.values()]
    .filter((s) => shown.has(s.source))
    .sort((a, b) => a.frequency_khz - b.frequency_khz || a.callsign.localeCompare(b.callsign));
}

/**
 * How many crowd tolerances fit across a band: a click gathers every station
 * within width / divisor of the clicked one. Phones get the wider net, since a
 * fingertip covers far more of a 375px strip than a pointer does of a wide one.
 */
export const CROWD_DIVISOR = { mobile: 45, desktop: 140 } as const;

export function crowdTolerance(plan: BandPlan, mobile: boolean): number {
  return (plan.to - plan.from) / (mobile ? CROWD_DIVISOR.mobile : CROWD_DIVISOR.desktop);
}

/** The stations within `tolerance` kHz of `station`, itself included, low to high. */
export function crowdAround(stations: readonly BandMapSpot[], station: BandMapSpot, tolerance: number): BandMapSpot[] {
  return stations
    .filter((s) => Math.abs(s.frequency_khz - station.frequency_khz) <= tolerance)
    .sort((a, b) => a.frequency_khz - b.frequency_khz || a.callsign.localeCompare(b.callsign));
}

/** A segment label closer than this share of the band to the one before would overlap it. */
export const MIN_LABEL_GAP = 0.09;

export interface SegmentMark {
  x: number;
  /** Undefined when the segment is too narrow to label. */
  label: string | undefined;
  /** The first segment starts at the band edge, so only its label shows. */
  line: boolean;
}

export function segmentMarks(plan: BandPlan): SegmentMark[] {
  const width = plan.to - plan.from;
  return plan.segments.map((seg, i) => {
    const previous = plan.segments[i - 1];
    const crowded = previous !== undefined && seg.start - previous.start < MIN_LABEL_GAP * width;
    return { x: seg.start, label: crowded ? undefined : seg.label, line: i > 0 };
  });
}

/** "14.050": axis ticks and crowd titles read in MHz. */
export function mhz(khz: number): string {
  return (khz / 1000).toFixed(3);
}

/** "now" under a minute, then "2m ago". */
export function spotAge(spotTime: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - Date.parse(spotTime)) / 60000);
  return minutes < 1 ? "now" : `${minutes}m ago`;
}

/** "14062.0 kHz CW", or just the frequency when the mode is unknown. */
function frequencyAndMode(spot: BandMapSpot): string {
  const freq = `${spot.frequency_khz.toFixed(1)} kHz`;
  return spot.mode ? `${freq} ${spot.mode.toUpperCase()}` : freq;
}

/** The tooltip: "KK4PWJ  14062.0 kHz CW · 2m ago". */
export function tooltipText(spot: BandMapSpot, now: Date): string {
  return `${spot.callsign}  ${frequencyAndMode(spot)} · ${spotAge(spot.spot_time, now)}`;
}

/** A crowd menu row's second line: "14075.0 kHz FT8 · POTA US-0817 · 2m ago". */
export function crowdDetail(spot: BandMapSpot, now: Date): string {
  const source = sourceInfo(spot.source).label;
  const where = spot.reference ? `${source} ${spot.reference}` : source;
  return `${frequencyAndMode(spot)} · ${where} · ${spotAge(spot.spot_time, now)}`;
}

/** "26 stations near 14.082". */
export function crowdTitle(count: number, khz: number): string {
  return `${count} stations near ${mhz(khz)}`;
}

/** "20m · 71 heard". */
export function heardLabel(band: string, count: number): string {
  return `${band} · ${count} heard`;
}

/** "Updated 30 seconds ago", in minutes past a minute. */
export function updatedLabel(generatedAt: string, now: Date): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - Date.parse(generatedAt)) / 1000));
  if (seconds < 60) return `Updated ${seconds} second${seconds === 1 ? "" : "s"} ago`;
  const minutes = Math.floor(seconds / 60);
  return `Updated ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
}

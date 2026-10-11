export interface SourceInfo {
  id: string;
  name: string;
  full: string;
  status: "live" | "planned";
  interval: string;
  pollSeconds: number | null;
  desc: string;
}

export const SOURCES: SourceInfo[] = [
  { id: "pota", name: "POTA", full: "Parks on the Air", status: "live", interval: "every 60s", pollSeconds: 60, desc: "Activator spots from api.pota.app" },
  { id: "sotawatch", name: "SOTAwatch", full: "Summits on the Air", status: "live", interval: "every 30s", pollSeconds: 30, desc: "Summit activation spots from SOTAwatch" },
  { id: "rbn", name: "RBN", full: "Reverse Beacon Network", status: "live", interval: "streaming", pollSeconds: 60, desc: "CW and digital skimmer spots" },
  { id: "dxcluster", name: "DX Cluster", full: "DXSpider network", status: "planned", interval: "streaming", pollSeconds: null, desc: "Human-entered DX spots" },
  { id: "pskreporter", name: "PSK Reporter", full: "PSK Reporter", status: "planned", interval: "streaming", pollSeconds: null, desc: "FT8, FT4 and other digital mode reports" },
  { id: "wwff", name: "WWFF", full: "World Wide Flora & Fauna", status: "planned", interval: "streaming", pollSeconds: null, desc: "WWFF reference activations" },
];

export const LIVE_SOURCES = SOURCES.filter((s) => s.status === "live");

export function sourceName(id: string): string {
  return SOURCES.find((s) => s.id === id)?.name ?? id;
}

export const BANDS = ["160m", "80m", "60m", "40m", "30m", "20m", "17m", "15m", "12m", "10m", "6m", "2m", "70cm"];
export const MODES = ["digital", "cw", "ssb", "fm", "am", "ft8", "ft4", "rtty", "psk"];

/** "digital" is a mode family (see _shared/modes.ts); everything else is a specific mode. */
export function modeLabel(m: string): string {
  return m === "digital" ? "Any digital" : m.toUpperCase();
}

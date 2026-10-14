export interface SourceInfo {
  id: string;
  name: string;
  full: string;
  status: "live" | "planned";
  interval: string;
  pollSeconds: number | null;
  desc: string;
  /** False for a feed that is stored but never matched (APRS-IS): no subscription option, no recent-spots tab. */
  alerts: boolean;
}

export const SOURCES: SourceInfo[] = [
  { id: "pota", name: "POTA", full: "Parks on the Air", status: "live", interval: "every 60s", pollSeconds: 60, desc: "Activator spots from api.pota.app", alerts: true },
  { id: "sotawatch", name: "SOTAwatch", full: "Summits on the Air", status: "live", interval: "every 30s", pollSeconds: 30, desc: "Summit activation spots from SOTAwatch", alerts: true },
  { id: "rbn", name: "RBN", full: "Reverse Beacon Network", status: "live", interval: "streaming", pollSeconds: 60, desc: "CW and digital skimmer spots", alerts: true },
  { id: "dxcluster", name: "DX Cluster", full: "DXSpider network", status: "live", interval: "streaming", pollSeconds: 60, desc: "Human-entered DX spots", alerts: true },
  { id: "aprs", name: "APRS-IS", full: "Automatic Packet Reporting System", status: "live", interval: "streaming", pollSeconds: 60, desc: "Every packet on the worldwide APRS-IS feed", alerts: false },
  { id: "pskreporter", name: "PSK Reporter", full: "PSK Reporter", status: "planned", interval: "streaming", pollSeconds: null, desc: "FT8, FT4 and other digital mode reports", alerts: true },
  { id: "wwff", name: "WWFF", full: "World Wide Flora & Fauna", status: "planned", interval: "streaming", pollSeconds: null, desc: "WWFF reference activations", alerts: true },
];

/** Sources a subscription can pick and the recent-spots tabs show: live and alerting. */
export const LIVE_SOURCES = SOURCES.filter((s) => s.status === "live" && s.alerts);

export function sourceName(id: string): string {
  return SOURCES.find((s) => s.id === id)?.name ?? id;
}

export const BANDS = ["160m", "80m", "60m", "40m", "30m", "20m", "17m", "15m", "12m", "10m", "6m", "2m", "70cm"];
export const MODES = ["digital", "cw", "ssb", "fm", "am", "ft8", "ft4", "rtty", "psk"];

/** "digital" is a mode family (see _shared/modes.ts); everything else is a specific mode. */
export function modeLabel(m: string): string {
  return m === "digital" ? "Any digital" : m.toUpperCase();
}

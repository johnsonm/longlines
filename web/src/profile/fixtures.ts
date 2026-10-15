// A full profile and a not-heard one for the profile page tests.

import type { CallsignProfile, HeardProfile } from "./types";

const days = Array.from({ length: 30 }, (_, i) => new Date(Date.UTC(2026, 8, 13) + i * 86_400_000).toISOString().slice(0, 10));

export const HEARD: HeardProfile = {
  firstHeard: "2026-10-05T13:02:00Z",
  lastHeard: { time: "2026-10-12T14:32:00Z", frequencyKhz: 14062, mode: "cw" },
  spots: 1234,
  daysOnAir: 6,
  countries: 12,
  continents: 3,
  sources: [{ source: "rbn", spots: 1100 }, { source: "pota", spots: 120 }, { source: "sotawatch", spots: 14 }],
  monthly: [{ month: "2026-10", spots: 1234, sources: { rbn: 1100, pota: 120, sotawatch: 14 } }],
  daily: days.map((day, i) => ({ day, spots: i > 22 ? 100 : 0, sources: i > 22 ? { rbn: 90, pota: 10 } : ({} as Record<string, number>) })),
  hours: Array.from({ length: 24 }, (_, h) => (h >= 12 && h < 20 ? 150 : 0)),
  bands: [{ band: "40m", spots: 400 }, { band: "20m", spots: 834 }],
  modes: [
    { label: "CW", spots: 1200, percent: 97 }, { label: "SSB", spots: 34, percent: 3 }, { label: "FT8/FT4", spots: 0, percent: 0 },
    { label: "FM", spots: 0, percent: 0 }, { label: "Other", spots: 0, percent: 0 },
  ],
  activations: [
    { program: "POTA", references: 3, activations: 5 }, { program: "SOTA", references: 2, activations: 2 },
    { program: "WWFF", references: 1, activations: 1 },
  ],
  references: [
    { reference: "US-0817", name: "Pisgah National Forest", program: "POTA", location: "US-NC", activations: 3, spots: 80, lastDay: "2026-10-12" },
    { reference: "W4C/CM-001", name: "Mount Mitchell", program: "SOTA", location: null, activations: 1, spots: 9, lastDay: "2026-10-10" },
    { reference: "KFF-5268", name: "T.M. Goodwin", program: "WWFF", location: null, activations: 1, spots: 6, lastDay: "2026-10-08" },
  ],
  activationsByLocation: { "US-NC": 4, "US-VA": 1 },
  reach: [{ country: "United States", continent: "NA", spots: 900 }, { country: "Germany", continent: "EU", spots: 200 }],
  variants: [{ callsign: "KK4PWJ", spots: 1100 }, { callsign: "KK4PWJ/P", spots: 134 }],
  hunting: { spots: 42, sources: [{ source: "pota", spots: 40 }, { source: "sotawatch", spots: 2 }] },
  heardBy: [{ spotter: "W3LPL", spots: 88, bestSnr: 31, topBand: "20m" }, { spotter: "DL8LAS", spots: 12, bestSnr: null, topBand: null }],
  recentSpots: [
    { time: "2026-10-12T14:32:00Z", callsign: "KK4PWJ/P", frequencyKhz: 14062, band: "20m", mode: "cw", reference: "US-0817", source: "pota", spotter: "N4XYZ" },
  ],
};

export const FULL: CallsignProfile = {
  callsign: "KK4PWJ",
  generatedAt: "2026-10-12T14:40:00Z",
  usPrefix: true,
  country: { name: "United States", continent: "NA" },
  license: {
    authority: "FCC", name: "Alex R Example", operatorClass: "Amateur Extra", status: "Active",
    grantedOn: "2016-03-01", expiresOn: "2036-03-01", state: "NC",
  },
  heard: HEARD,
};

export const NOT_HEARD: CallsignProfile = {
  callsign: "G4ABC",
  generatedAt: "2026-10-12T14:40:00Z",
  usPrefix: false,
  country: { name: "England", continent: "EU" },
  license: null,
  heard: null,
};

// Reference profiles for the page tests: the canvas's park, a summit, a WWFF
// reference, and the retired, not-in-the-list and never-activated states.
// "Today" is 2026-10-26 (UTC), as drawn.

import type { ReferenceCatalog, ReferenceProfile } from "./types";

const POTA_CATALOG: ReferenceCatalog = {
  name: "Mount Mitchell State Park", active: true, location: "US-NC", association: null, region: null, country: null,
  latitude: 35.765, longitude: -82.2652, grid: "EM85", altitudeM: null, points: null, validFrom: null, validTo: null,
};

export const PARK: ReferenceProfile = {
  program: "pota",
  reference: "US-2763",
  sourceUrl: "https://pota.app/#/park/US-2763",
  catalog: POTA_CATALOG,
  totals: { activations: 148, activators: 61, spots: 3412 },
  firstActivation: { day: "2025-11-02", callsign: "KJ4ABS", base: "KJ4ABS" },
  last: {
    callsign: "N4MTS/P", base: "N4MTS", time: "2026-10-26T18:51:00Z", frequencyKhz: 14062, mode: "cw", band: "20m", source: "pota",
    today: { spots: 18, bands: ["20m", "40m"] },
  },
  calendar: {
    days: [
      { day: "2025-11-02", activators: ["KJ4ABS"] },
      { day: "2026-06-14", activators: ["AE4QS", "K4LRS", "KJ4ABS", "N4MTS", "W4HKS"] },
      { day: "2026-10-25", activators: ["KD2RVS", "KJ4ABS"] },
      { day: "2026-10-26", activators: ["N4MTS"] },
    ],
    periods: [
      {
        period: "past", from: "2025-10-27", to: "2026-10-26", days: 365, activations: 9, daysActivated: 4, longestStreak: 2,
        busiest: { day: "2026-06-14", activators: 5 },
      },
      {
        period: "2026", from: "2026-01-01", to: "2026-12-31", days: 299, activations: 8, daysActivated: 3, longestStreak: 2,
        busiest: { day: "2026-06-14", activators: 5 },
      },
      {
        period: "2025", from: "2025-01-01", to: "2025-12-31", days: 365, activations: 1, daysActivated: 1, longestStreak: 1,
        busiest: { day: "2025-11-02", activators: 1 },
      },
    ],
  },
  monthly: [
    { month: "2025-11", activations: 1 }, { month: "2025-12", activations: 0 }, { month: "2026-01", activations: 0 },
    { month: "2026-02", activations: 0 }, { month: "2026-03", activations: 0 }, { month: "2026-04", activations: 0 },
    { month: "2026-05", activations: 0 }, { month: "2026-06", activations: 5 }, { month: "2026-07", activations: 0 },
    { month: "2026-08", activations: 0 }, { month: "2026-09", activations: 0 }, { month: "2026-10", activations: 3 },
  ],
  bands: [{ band: "40m", spots: 1310 }, { band: "20m", spots: 1650 }, { band: "17m", spots: 452 }],
  modes: [
    { label: "CW", spots: 1570, percent: 46 }, { label: "SSB", spots: 1297, percent: 38 }, { label: "FT8/FT4", spots: 409, percent: 12 },
    { label: "FM", spots: 0, percent: 0 }, { label: "Other", spots: 136, percent: 4 },
  ],
  topActivators: [
    { callsign: "N4MTS/P", base: "N4MTS", activations: 22, lastDay: "2026-10-26" },
    { callsign: "KJ4ABS", base: "KJ4ABS", activations: 14, lastDay: "2025-10-25" },
  ],
  recentActivations: [
    { day: "2026-10-26", callsign: "N4MTS/P", base: "N4MTS", spots: 18, bands: ["20m", "40m"], modes: ["cw"] },
    { day: "2026-10-25", callsign: "KJ4ABS", base: "KJ4ABS", spots: 1, bands: ["40m"], modes: ["usb", "ssb"] },
  ],
  recentSpots: [
    {
      time: "2026-10-26T18:51:00Z", callsign: "N4MTS/P", base: "N4MTS", frequencyKhz: 14062, mode: "cw", band: "20m", spotter: "KX4FBS",
      comment: "Strong in TN", source: "pota",
    },
    {
      time: "2026-10-26T18:20:00Z", callsign: "N4MTS/P", base: "N4MTS", frequencyKhz: 7035.5, mode: "cw", band: "40m", spotter: "N4MTS",
      comment: "QRT 1900z", source: "pota",
    },
    {
      time: "2026-10-25T21:04:00Z", callsign: "KJ4ABS", base: "KJ4ABS", frequencyKhz: 7230, mode: "ssb", band: "40m", spotter: "W3PLS",
      comment: null, source: "pota",
    },
  ],
};

export const SUMMIT: ReferenceProfile = {
  ...PARK,
  program: "sota",
  reference: "W4C/CM-001",
  sourceUrl: "https://summits.sota.org.uk/summit/W4C/CM-001",
  catalog: {
    name: "Mount Mitchell", active: true, location: null, association: "W4C", region: "NC-Central Mountains", country: null,
    latitude: 35.7648, longitude: -82.2652, grid: "EM85", altitudeM: 2037, points: 10, validFrom: "2011-02-01", validTo: "2099-12-31",
  },
  last: {
    callsign: "AE4QS", base: "AE4QS", time: "2026-10-12T15:02:00Z", frequencyKhz: 146520, mode: "fm", band: "2m", source: "sotawatch", today: null,
  },
};

export const WWFF_REF: ReferenceProfile = {
  ...PARK,
  program: "wwff",
  reference: "KFF-6101",
  sourceUrl: "https://wwff.co/directory/?showRef=KFF-6101",
  catalog: {
    name: "Pisgah National Forest", active: true, location: null, association: null, region: "K-NC", country: "United States",
    latitude: 35.5, longitude: -82.7, grid: "EM85", altitudeM: null, points: null, validFrom: null, validTo: null,
  },
  last: null,
};

export const RETIRED: ReferenceProfile = {
  ...SUMMIT,
  reference: "W4C/EM-031",
  sourceUrl: "https://summits.sota.org.uk/summit/W4C/EM-031",
  catalog: {
    name: "Pine Mountain", active: false, location: null, association: "W4C", region: "NC-Eastern Mountains", country: null,
    latitude: 36.434, longitude: -81.7212, grid: "EM96", altitudeM: 1412, points: 1, validFrom: "2011-02-01", validTo: "2019-12-31",
  },
};

export const NOT_IN_LIST: ReferenceProfile = {
  ...PARK,
  reference: "US-12940",
  sourceUrl: null,
  catalog: null,
  totals: { activations: 1, activators: 1, spots: 3 },
};

export const NEVER_ACTIVATED: ReferenceProfile = {
  program: "pota",
  reference: "US-4471",
  sourceUrl: "https://pota.app/#/park/US-4471",
  catalog: { ...POTA_CATALOG, name: "Lake James State Park", grid: "EM85", latitude: null, longitude: null },
  totals: { activations: 0, activators: 0, spots: 0 },
  firstActivation: null,
  last: null,
  calendar: {
    days: [],
    periods: [{ period: "past", from: "2025-10-27", to: "2026-10-26", days: 365, activations: 0, daysActivated: 0, longestStreak: 0, busiest: null }],
  },
  monthly: [],
  bands: [],
  modes: [
    { label: "CW", spots: 0, percent: 0 }, { label: "SSB", spots: 0, percent: 0 }, { label: "FT8/FT4", spots: 0, percent: 0 },
    { label: "FM", spots: 0, percent: 0 }, { label: "Other", spots: 0, percent: 0 },
  ],
  topActivators: [],
  recentActivations: [],
  recentSpots: [],
};

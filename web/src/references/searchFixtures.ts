// Reference searches for the lookup page tests, in search_references' shape:
// the canvas's "mitchell" results (values from the real lists where the canvas
// draws a real place), plus a retired summit and a reference never activated.
// "Today" is 2026-10-26 (UTC), as drawn.

import type { ReferenceSearch, ReferenceSearchResult } from "./types";

const NONE = {
  validTo: null, location: null, association: null, region: null, country: null, grid: null, altitudeM: null, points: null,
} satisfies Partial<ReferenceSearchResult>;

export const MITCHELL_PARK: ReferenceSearchResult = {
  ...NONE, program: "pota", reference: "US-2763", name: "Mount Mitchell State Park", active: true, location: "US-NC", grid: "EM85",
  activations: 148, lastDay: "2026-10-26",
};

export const MITCHELL_SUMMIT: ReferenceSearchResult = {
  ...NONE, program: "sota", reference: "W4C/CM-001", name: "Mount Mitchell", active: true, association: "W4C", region: "NC-Central Mountains",
  grid: "EM85", altitudeM: 2037, points: 10, activations: 23, lastDay: "2026-10-12",
};

export const MITCHELL_WWFF: ReferenceSearchResult = {
  ...NONE, program: "wwff", reference: "KFF-2747", name: "Mount Mitchell", active: true, country: "United States",
  region: "North Carolina", grid: "EM85", activations: 9, lastDay: "2026-09-28",
};

/** A park in two states, one activation, last year. */
export const TWO_STATE_PARK: ReferenceSearchResult = {
  ...NONE, program: "pota", reference: "US-4561", name: "Mitchell Lake Trail", active: true, location: "US-NC,US-VA", grid: null,
  activations: 1, lastDay: "2025-07-04",
};

/** Never activated, without a region. */
export const QUIET_SUMMIT: ReferenceSearchResult = {
  ...NONE, program: "sota", reference: "VK3/VE-123", name: "Mitchell Hill", active: true, association: "VK3", altitudeM: 812, points: 1,
  activations: 0, lastDay: null,
};

/** Retired, with the date the program gives. */
export const RETIRED_SUMMIT: ReferenceSearchResult = {
  ...NONE, program: "sota", reference: "W7O/CN-099", name: "Mitchell Point", active: false, validTo: "2019-12-31", association: "W7O",
  region: "OR-Coast Range North", activations: 0, lastDay: null,
};

/** The canvas's search, most activated first. */
export const MITCHELL: ReferenceSearch = {
  results: [MITCHELL_PARK, MITCHELL_SUMMIT, MITCHELL_WWFF, TWO_STATE_PARK, QUIET_SUMMIT, RETIRED_SUMMIT],
  more: false,
};

/** One result, without a name. */
export const ONE: ReferenceSearch = {
  results: [{ ...NONE, program: "pota", reference: "US-9999", name: null, active: true, activations: 2, lastDay: "2026-10-01" }],
  more: false,
};

export const EMPTY: ReferenceSearch = { results: [], more: false };

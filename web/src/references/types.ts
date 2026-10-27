// Shape of a reference profile, as the reference-profile Edge Function returns
// it. It is built by reference_profile() in SQL, read by the function with
// referenceProfileSchema (supabase/functions/_shared/handlers/reference_profile.ts)
// and pinned by supabase/tests/reference_profile.test.sql; change all four together.
//
// Times are ISO UTC ("2026-10-26T18:51:00Z"), days YYYY-MM-DD, months YYYY-MM.
// An activation is one activator (base call) at the reference on one UTC day.
// History is reference_days plus a live read of the days not rolled up yet;
// calls in hidden_callsigns count nowhere.

import type { ModeLabel } from "../stats/types";

export type ReferenceProgram = "pota" | "sota" | "wwff";

export type ReferenceProfile = {
  program: ReferenceProgram;
  reference: string; // upper case, as stored
  sourceUrl: string | null; // the program's page for it (spot_source_url's form); null outside the list
  catalog: ReferenceCatalog | null; // null outside the program's list
  totals: { activations: number; activators: number; spots: number }; // all time, hidden calls excluded
  firstActivation: { day: string; callsign: string; base: string } | null;
  last: ReferenceLast | null; // the newest spot of the live read (last 14 days); null when none
  calendar: ReferenceCalendar;
  monthly: { month: string; activations: number }[]; // first activation's month through the current month, zero-filled; [] without activations
  bands: { band: string; spots: number }[]; // only bands with spots, in band order (the Stats band order)
  modes: { label: ModeLabel; spots: number; percent: number }[]; // the callsign profile's modes rules
  topActivators: { callsign: string; base: string; activations: number; lastDay: string }[]; // 10, most activations, then most recent, then base
  recentActivations: ReferenceActivation[]; // 10, newest first
  recentSpots: ReferenceSpot[]; // newest 25 of the last 7 days
};

export type ReferenceCatalog = {
  name: string | null;
  active: boolean;
  location: string | null; // POTA "US-NC,US-VA"
  association: string | null; // SOTA only: the code before "/" ("W4C")
  region: string | null; // SOTA RegionName ("NC-Central Mountains"); WWFF state or region
  country: string | null; // WWFF
  latitude: number | null;
  longitude: number | null;
  grid: string | null;
  altitudeM: number | null; // SOTA
  points: number | null; // SOTA
  validFrom: string | null; // YYYY-MM-DD
  validTo: string | null;
};

export type ReferenceLast = {
  callsign: string; // as most recently spotted
  base: string;
  time: string;
  frequencyKhz: number | null;
  mode: string | null; // lowercase as stored
  band: string | null;
  source: string;
  today: { spots: number; bands: string[] } | null; // that activator's spots here this UTC day, only when `time` is today (UTC)
};

export type ReferenceCalendar = {
  days: { day: string; activators: string[] }[]; // every UTC day with an activation, oldest first; base calls, alphabetical
  periods: ReferenceCalendarPeriod[]; // "past" first, then each year since the first activation, newest first
};

export type ReferenceCalendarPeriod = {
  period: string; // "past" (the 365 days ending today) or a year, "2026"
  from: string;
  to: string;
  days: number; // days from `from` through today or `to`, whichever is first
  activations: number;
  daysActivated: number;
  longestStreak: number;
  busiest: { day: string; activators: number } | null;
};

export type ReferenceActivation = {
  day: string;
  callsign: string;
  base: string;
  spots: number;
  bands: string[];
  modes: string[];
};

export type ReferenceSpot = {
  time: string;
  callsign: string;
  base: string;
  frequencyKhz: number | null;
  mode: string | null;
  band: string | null;
  spotter: string;
  comment: string | null;
  source: string;
};

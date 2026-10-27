// Shape of a callsign profile, as the callsign-profile Edge Function returns
// it. It is built by callsign_profile() in
// supabase/migrations/20261012000060_callsign_profile.sql and pinned by
// supabase/tests/callsign_profile.test.sql; change all three together.
//
// Times are ISO UTC ("2026-10-12T14:32:00Z"), days YYYY-MM-DD, months YYYY-MM.
// Sources are source ids as stored ("pota", "sotawatch", "wwff", "rbn", "dxcluster",
// and any added later). All-time figures come from the rollups plus a live
// read of the days not rolled up yet.

import type { ModeLabel } from "../stats/types";

export type CallsignProfile = {
  callsign: string; // the base call: a lookup of KK4PWJ/P returns KK4PWJ
  generatedAt: string; // profiles are cached for up to 15 minutes
  usPrefix: boolean; // K, N, W or AA-AL: picks the no-license message
  country: { name: string; continent: string } | null; // cty.dat entity of the call
  license: License | null; // null: no record, or the call is hidden
  heard: HeardProfile | null; // null: never spotted and never spotted anyone, or hidden
};

export type License = {
  authority: string; // "FCC"
  name: string | null;
  operatorClass: string | null; // "Amateur Extra", ...; null for clubs
  status: string | null; // "Active", "Expired", ...
  grantedOn: string | null; // YYYY-MM-DD
  expiresOn: string | null;
  state: string | null;
};

export type ProfileSpot = {
  time: string;
  callsign: string; // as spotted: KK4PWJ/P
  frequencyKhz: number;
  band: string | null;
  mode: string | null; // lowercase as stored: "cw", "usb"
  reference: string | null; // park or summit
  source: string;
  spotter: string | null;
};

export type HeardProfile = {
  // The station as spotted (role "heard"); self-spots count, as on the Stats page.
  firstHeard: string | null; // null when it has only spotted others
  lastHeard: { time: string; frequencyKhz: number; mode: string | null } | null;
  spots: number; // all time
  daysOnAir: number; // distinct UTC days with a spot
  countries: number; // distinct countries of the spotters that heard it, self-spots excluded
  continents: number;
  sources: { source: string; spots: number }[]; // most spots first
  monthly: { month: string; spots: number; sources: Record<string, number> }[]; // first month heard through this month, zero-filled
  daily: { day: string; spots: number; sources: Record<string, number> }[]; // exactly 30, ending today, zero-filled
  hours: number[]; // exactly 24; index is the UTC hour
  bands: { band: string; spots: number }[]; // the Stats bands, 160m … 2m, zero-filled
  modes: { label: ModeLabel; spots: number; percent: number }[]; // the five labels in order; integer percents sum to 100 (all 0 with no spots)
  // Activations: one per reference per UTC day.
  activations: { program: string; references: number; activations: number }[]; // per program ("POTA", "SOTA", "WWFF", "WWBOTA", "IOTA"), by name
  references: {
    reference: string;
    name: string | null;
    program: string;
    location: string | null; // "US-NC,US-VA" for a park in two states
    activations: number; // the page's "Times"
    spots: number;
    lastDay: string;
  }[]; // up to 100, most recent first
  activationsByLocation: Record<string, number>; // "US-NC" -> activations; a reference in two locations counts in each
  reach: { country: string; continent: string; spots: number }[]; // every country, most spots first
  variants: { callsign: string; spots: number }[]; // how it was spotted ("Also heard as"), up to 20, most spots first
  hunting: { spots: number; sources: { source: string; spots: number }[] }; // spots it posted for others, self-spots excluded, through the last rolled-up day
  heardBy: { spotter: string; spots: number; bestSnr: number | null; topBand: string | null }[]; // top 10 over the last 7 days, self-spots excluded
  recentSpots: ProfileSpot[]; // newest 25 from the last 7 days
  calendar?: Calendar; // the year heat map; absent from profiles cached before 20261019000300
};

// The year heat map, from callsign_days plus the live days: every source but APRS-IS.
export type Calendar = {
  days: { day: string; spots: number; sources: Record<string, number> }[]; // every UTC day with a spot, oldest first; days without one are absent
  periods: CalendarPeriod[]; // "past" first, then each year since first heard, newest first
};

export type CalendarPeriod = {
  period: string; // "past" (the 365 days ending today) or a year, "2026"
  from: string; // the grid's first day, YYYY-MM-DD
  to: string; // its last: today for "past", 31 December for a year
  days: number; // days from `from` through today or `to`, whichever is first: "179 of 365"
  spots: number;
  daysOnAir: number;
  longestStreak: number; // most consecutive days with a spot
  busiest: { day: string; spots: number } | null; // the later day on a tie; null without spots
};

// A GroupStatistics payload shaped exactly like group_statistics_at's output
// (supabase/tests/group_statistics.test.sql pins the shape), for component tests.

import type { GroupMember, GroupStatistics, OwnerGroupStatistics } from "./types";

const DAY_MS = 86_400_000;
export const GENERATED_AT = "2026-10-19T14:48:00Z";
const day = (offset: number) => new Date(Date.parse("2026-10-19T00:00:00Z") + offset * DAY_MS).toISOString().slice(0, 10);

const MEMBERS: GroupMember[] = [
  { callsign: "KK4PWJ", spots: 2591, days: 17, mainMode: "CW", lastHeard: "2026-10-19T14:46:00Z" },
  { callsign: "W4ABC", spots: 1204, days: 13, mainMode: "CW", lastHeard: "2026-10-19T14:46:00Z" },
  { callsign: "N4GHI", spots: 988, days: 12, mainMode: "CW", lastHeard: "2026-10-19T14:39:00Z" },
  { callsign: "K4DEF", spots: 812, days: 10, mainMode: "SSB", lastHeard: "2026-10-10T14:48:00Z" },
  { callsign: "W4JKL", spots: 640, days: 9, mainMode: "CW", lastHeard: "2026-10-19T14:46:00Z" },
  { callsign: "AC4MN", spots: 577, days: 9, mainMode: "FT8/FT4", lastHeard: "2026-10-13T14:48:00Z" },
  { callsign: "N4DXX", spots: 498, days: 8, mainMode: "CW", lastHeard: "2026-10-19T11:48:00Z" },
  { callsign: "K4OPQ", spots: 451, days: 8, mainMode: "SSB", lastHeard: "2026-10-19T14:46:00Z" },
  { callsign: "W4RST", spots: 402, days: 7, mainMode: "CW", lastHeard: "2026-10-19T13:48:00Z" },
  { callsign: "KD4UVW", spots: 366, days: 7, mainMode: "FT8/FT4", lastHeard: "2026-10-19T14:39:00Z" },
  { callsign: "N4XYZ", spots: 120, days: 3, mainMode: "CW", lastHeard: "2026-10-01T14:48:00Z" },
  { callsign: "K4ZZZ", spots: 0, days: 0, mainMode: null, lastHeard: null },
];

export const STATS: GroupStatistics = {
  period: "30d",
  generatedAt: GENERATED_AT,
  memberCount: 12,
  kpis: {
    spots: 10082,
    previousSpots: 9002,
    membersHeard: 11,
    activations: { pota: 26, sota: 5, wwff: 0, wwbota: 0, iota: 0 },
    places: { parks: 19, summits: 3, bunkers: 0, islands: 0 },
  },
  daily: Array.from({ length: 30 }, (_, i) => ({ day: day(i - 29), spots: i * 10 })),
  calendar: [
    { day: day(-300), spots: 45, members: 2 },
    { day: day(-7), spots: 150, members: 3 },
    { day: day(-1), spots: 250, members: 4 },
    { day: day(0), spots: 900, members: 8 },
  ],
  top: {
    spots: [{ callsign: "KK4PWJ", value: 2591 }, { callsign: "W4ABC", value: 1204 }, { callsign: "N4GHI", value: 988 }],
    days: [{ callsign: "KK4PWJ", value: 17 }, { callsign: "W4ABC", value: 13 }, { callsign: "N4GHI", value: 12 }],
    cw: [{ callsign: "KK4PWJ", value: 2591 }],
    ssb: [{ callsign: "K4DEF", value: 812 }, { callsign: "K4OPQ", value: 451 }],
    digital: [{ callsign: "AC4MN", value: 577 }],
    parks: [],
  },
  members: MEMBERS,
  bands: ["160m", "80m", "60m", "40m", "30m", "20m", "17m", "15m", "12m", "10m", "6m", "2m"].map((band, i) => ({ band, spots: i * 100 })),
  modes: [{ label: "CW", spots: 7158 }, { label: "SSB", spots: 1814 }, { label: "FT8/FT4", spots: 1110 }],
  places: [
    { reference: "US-2763", name: "Falls Lake SRA", program: "POTA", times: 4, by: ["KK4PWJ", "W4ABC"] },
    { reference: "W4C/CM-001", name: null, program: "SOTA", times: 2, by: ["K4DEF", "KK4PWJ"] },
  ],
};

export const OWNER: OwnerGroupStatistics = {
  ...STATS,
  group: {
    id: "g1", name: "Piedmont ARC", public: true, show_callsigns: true, public_slug: "7f3kq9xm2a", member_count: 12,
    subscription_count: 2,
  },
};

/** A public page whose owner hides callsigns: what group_stats_redact leaves. */
export function redacted(stats: GroupStatistics): GroupStatistics {
  const { top: _top, members: _members, ...rest } = stats;
  return { ...rest, places: stats.places.map(({ by: _by, ...p }) => p) };
}

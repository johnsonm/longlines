// Goal payloads for tests: the canvas's "2026 chase" (states, ten parks, bands at least 4 of
// 6), seen on 2026-10-29 at noon UTC. Override what a test is about.

import type { GoalEntry, GoalCard, GoalProgress, GoalRequirement } from "../goals/types";

export const NOW = new Date("2026-10-29T12:00:00Z");

const STATES = ["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY"];
const STATES_WORKED = new Set(["AL", "FL", "IL", "IN", "KY", "MD", "NY", "OH", "PA", "TN", "VA", "WV"]);

const PARKS: Array<[string, string]> = [
  ["US-0001", "Great Smoky Mountains National Park"],
  ["US-0002", "Cape Lookout National Seashore"],
  ["US-0003", "Blue Ridge Parkway"],
  ["US-2763", "Hanging Rock State Park"],
  ["US-2764", "Pilot Mountain State Park"],
  ["US-2765", "Jordan Lake State Recreation Area"],
  ["US-2766", "Fort Macon State Park"],
  ["US-0004", "Kennesaw Mountain National Battlefield Park"],
  ["US-0005", "Stone Mountain Park"],
  ["US-0006", "Chattahoochee River National Recreation Area"],
];

const needed = (value: string, position: number, label: string | null = null): GoalEntry => ({
  value, label, position, worked_at: null, worked_how: null, evidence: null,
});
const byHand = (value: string, position: number, at: string, label: string | null = null): GoalEntry => ({
  value, label, position, worked_at: at, worked_how: "hand", evidence: null,
});

export function card(over: Partial<GoalCard> = {}): GoalCard {
  return {
    id: "n1", name: "2026 chase", starts_on: "2026-01-01", ends_on: "2026-12-31", marking: "relay", status: "active",
    completed_at: null, requirement_count: 3, worked: 18, total: 64, needed_by_kind: { state: 38, park: 7, band: 1 },
    connection_count: 2, updated_at: "2026-10-28T00:00:00Z", ...over,
  };
}

export function states(over: Partial<GoalRequirement> = {}): GoalRequirement {
  return {
    id: "r-states", kind: "state", complete_when: "all", at_least: null, position: 1, complete: false, worked: 12, target: 50,
    entries: STATES.map((s, i) => (STATES_WORKED.has(s) ? byHand(s, i + 1, "2026-10-20T15:00:00Z") : needed(s, i + 1))),
    ...over,
  };
}

export function parks(over: Partial<GoalRequirement> = {}): GoalRequirement {
  const entries = PARKS.map(([ref, name], i) => needed(ref, i + 1, name));
  entries[0] = {
    ...entries[0]!, worked_at: "2026-10-03T21:14:00Z", worked_how: "contact",
    evidence: { worked_call: "K4ABC", contact_time: "2026-10-03T21:14:00Z", logger_app: "N1MM", matched_spot_time: "2026-10-03T21:09:00Z" },
  };
  entries[1] = {
    ...entries[1]!, worked_at: "2026-10-12T14:02:00Z", worked_how: "contact",
    evidence: { worked_call: "N4DEF", contact_time: "2026-10-12T14:02:00Z", logger_app: "N1MM", matched_spot_time: "2026-10-12T13:58:00Z" },
  };
  entries[2] = byHand("US-0003", 3, "2026-10-20T15:00:00Z", "Blue Ridge Parkway");
  return { id: "r-parks", kind: "park", complete_when: "all", at_least: null, position: 2, complete: false, worked: 3, target: 10, entries, ...over };
}

export function bands(over: Partial<GoalRequirement> = {}): GoalRequirement {
  const entries = ["80m", "40m", "20m", "15m", "10m", "6m"].map((b, i) => needed(b, i + 1));
  for (const i of [1, 2, 3]) entries[i] = byHand(entries[i]!.value, i + 1, "2026-10-21T00:00:00Z");
  return { id: "r-bands", kind: "band", complete_when: "at_least", at_least: 4, position: 3, complete: false, worked: 3, target: 4, entries, ...over };
}

export function progress(over: Partial<GoalProgress> = {}): GoalProgress {
  return {
    list: card(),
    requirements: [states(), parks(), bands()],
    reviews: [],
    relay: { status: "recent", last_contact_at: "2026-10-29T11:48:00Z", logger_app: "N1MM", relay_count: 1 },
    used_by: [
      { id: "s1", name: "POTA states, CW", sources: ["pota"], destination_count: 1 },
      { id: "s2", name: "DX states", sources: ["dxcluster"], destination_count: 2 },
    ],
    first_contact_at: "2026-10-16T00:00:00Z",
    ...over,
  };
}

/** Every entry of a requirement worked by hand, and the requirement complete. */
export function allWorked(req: GoalRequirement): GoalRequirement {
  return {
    ...req, complete: true, worked: req.target,
    entries: req.entries.map((e) => (e.worked_at ? e : { ...e, worked_at: "2026-11-18T10:00:00Z", worked_how: "hand" as const })),
  };
}

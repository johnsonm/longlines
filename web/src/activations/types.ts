// Shapes of the spotted-activations Edge Function's two replies. They are built in SQL by
// spotted_activation() and callsign_spotted_activations(), read by the function with
// spottedActivationSchema and callsignActivationsSchema
// (supabase/functions/_shared/handlers/spotted_activations.ts) and pinned by
// supabase/tests/spotted_activations.test.sql; change all four together.
//
// Times are ISO UTC with whole seconds ("2026-10-26T18:12:00Z"), days YYYY-MM-DD (the UTC day).
// An activation is a run of one activator's spots at one reference with no gap longer than
// activation_gap() (45 minutes); only closed activations are shown. Every figure is SQL's: the
// web words them and never counts, ranks or resolves a place itself.
//
// DOM-free and imported with .ts extensions, so the link previews (web/api) can read it from Node.

/** The programs an activation can be at (spotted_activations.program). */
export type ActivationProgram = "pota" | "sota" | "wwff" | "wwbota" | "iota";

/** The reference's catalog coordinates and its own US states; null without coordinates (WWBOTA, IOTA). */
export interface ActivationLocation {
  latitude: number;
  longitude: number;
  states: string[];
}

/** The midnight split: the activation this one continues, and the one that continues it. */
export interface ActivationSplit {
  continuedFrom: string | null;
  continuedBy: string | null;
}

/** Spots per source; a source with no spot has no key. */
export interface ActivationSources {
  pota?: number;
  sotawatch?: number;
  wwff?: number;
  wwbota?: number;
  dxcluster?: number;
  rbn?: number;
}

/** A US state (license state) or a country (cty.dat entity) the activation was heard in. */
export interface ActivationPlace {
  kind: "state" | "country";
  code: string;
  name: string | null;
  latitude: number | null;
  longitude: number | null;
  spots: number;
}

/** The place heard farthest from the reference, in whole kilometres. */
export interface ActivationFarthest {
  kind: "state" | "country";
  code: string;
  name: string | null;
  km: number;
}

export interface ActivationSpot {
  time: string;
  source: string;
  spotter: string | null;
  spotterBase: string | null;
  selfSpot: boolean;
  /** The spotter's state name, else its country (cty.dat entity name); null when unknown. */
  place: string | null;
  frequencyKhz: number | null;
  mode: string | null;
  /** Null for RBN and DX Cluster rows, which name no reference. */
  references: string[] | null;
}

/** One activation's page: spotted_activation(id). `id` is always the canonical id. */
export interface SpottedActivation {
  id: string;
  /** The activator's base call. */
  callsign: string;
  program: ActivationProgram;
  /** Feed order, upper case. */
  references: string[];
  /** Index-aligned with `references`; null where neither the feed nor the reference list names one. */
  referenceNames: (string | null)[];
  day: string;
  startedAt: string;
  lastSpotAt: string;
  durationSeconds: number;
  split: ActivationSplit;
  location: ActivationLocation | null;
  spotCount: number;
  sources: ActivationSources;
  /** Most spots first. */
  bands: string[];
  /** Canonical modes, most spots first; readers fold USB and LSB. */
  modes: string[];
  /** Most spots first; self-spots and hidden spotters left out. */
  heard: ActivationPlace[];
  farthest: ActivationFarthest | null;
  /** Every spot, time ascending. */
  spots: ActivationSpot[];
}

/** One row of a callsign's list. */
export interface ActivationCard {
  id: string;
  program: ActivationProgram;
  references: string[];
  referenceNames: (string | null)[];
  day: string;
  startedAt: string;
  lastSpotAt: string;
  durationSeconds: number;
  spotCount: number;
  bands: string[];
  modes: string[];
  /** How many states and countries it was heard in. */
  states: number;
  countries: number;
  continuedFrom: string | null;
  continuedBy: string | null;
}

/** Distinct references activated in the past 12 months, per program. */
export interface ActivationReferenceCounts {
  total: number;
  pota: number;
  sota: number;
  wwff: number;
  wwbota: number;
  iota: number;
}

export interface MostActivated {
  program: ActivationProgram;
  reference: string;
  name: string | null;
  times: number;
}

export interface ActivationSummary {
  /** Activations started in the past 12 months. */
  activations: number;
  references: ActivationReferenceCounts;
  /** The sum of first spot to last spot, past 12 months. */
  onAirSeconds: number;
  mostActivated: MostActivated | null;
}

/** A callsign's Spotted activations tab: callsign_spotted_activations(call, now). */
export interface CallsignActivations {
  /** The base call. */
  callsign: string;
  summary: ActivationSummary;
  /** Closed activations, newest first, at most 200. */
  recent: ActivationCard[];
  /** More than `recent` holds. */
  more: boolean;
}

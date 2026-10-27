// The reference-profile function: a public read of one park, summit or WWFF
// reference's page (/ref/<program>/<reference>), for signed-out browsers too,
// so it is deployed with verify_jwt = false and checks nothing about the
// caller beyond the callsign profile's per-client rate limit (lookupLimit: one
// budget per client for profiles, group pages and reference pages).
//
// GET ?program=pota&reference=US-2763. The profile is built by
// reference_profile() in SQL and cached there for 15 minutes
// (cached_reference_profile); its shape is ReferenceProfile in
// web/src/references/types.ts, read here with referenceProfileSchema. SQL
// returns null for a program it has no list for, a malformed reference, or a
// reference in neither the program's list nor any spot; all of those are the
// same 404, and a malformed pair is refused before any database call.
//
// The reference is never logged: a failure names the function only.

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { DEFAULT_METHODS, json, preflightResponse } from "../cors.ts";
import { ValidationError } from "../errors.ts";
import { parseWith } from "../validate.ts";
import { lookupLimit, PROFILE_CACHE_CONTROL } from "./callsign_profile.ts";

export const REFERENCE_NOT_FOUND = "Reference not found.";
export const REFERENCE_UNAVAILABLE = "Reference pages are unavailable right now.";
/** The programs with a list (reference_catalog.program). */
export const REFERENCE_PROGRAMS = ["pota", "sota", "wwff"] as const;
/** Letters, digits, "/" and "-", at most 64 characters: reference_profile's own rule. */
const REFERENCE = /^[A-Z0-9/-]{1,64}$/;

export type ReferenceProgram = (typeof REFERENCE_PROGRAMS)[number];

/** The program's list entry for the reference (reference_catalog); null outside the list. */
export interface ReferenceCatalog {
  name: string | null;
  active: boolean;
  location: string | null;
  association: string | null;
  region: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  grid: string | null;
  altitudeM: number | null;
  points: number | null;
  validFrom: string | null;
  validTo: string | null;
}

export interface ReferenceTotals {
  activations: number;
  activators: number;
  spots: number;
}

export interface ReferenceActivator {
  day: string;
  callsign: string;
  base: string;
}

export interface ReferenceToday {
  spots: number;
  bands: string[];
}

/** The newest spot of the live read, with that activator's spots here today when it is today's. */
export interface ReferenceLast {
  callsign: string;
  base: string;
  time: string;
  frequencyKhz: number | null;
  mode: string | null;
  band: string | null;
  source: string;
  today: ReferenceToday | null;
}

export interface ReferenceCalendarDay {
  day: string;
  activators: string[];
}

export interface ReferenceBusiest {
  day: string;
  activators: number;
}

export interface ReferenceCalendarPeriod {
  period: string;
  from: string;
  to: string;
  days: number;
  activations: number;
  daysActivated: number;
  longestStreak: number;
  busiest: ReferenceBusiest | null;
}

export interface ReferenceCalendar {
  days: ReferenceCalendarDay[];
  periods: ReferenceCalendarPeriod[];
}

export interface ReferenceMonth {
  month: string;
  activations: number;
}

export interface ReferenceBand {
  band: string;
  spots: number;
}

export interface ReferenceMode {
  label: string;
  spots: number;
  percent: number;
}

export interface ReferenceTopActivator {
  callsign: string;
  base: string;
  activations: number;
  lastDay: string;
}

export interface ReferenceActivation {
  day: string;
  callsign: string;
  base: string;
  spots: number;
  bands: string[];
  modes: string[];
}

export interface ReferenceSpot {
  time: string;
  callsign: string;
  base: string;
  frequencyKhz: number | null;
  mode: string | null;
  band: string | null;
  spotter: string;
  comment: string | null;
  source: string;
}

/** What reference_profile builds (ReferenceProfile in web/src/references/types.ts). */
export interface ReferenceProfile {
  program: ReferenceProgram;
  reference: string;
  sourceUrl: string | null;
  catalog: ReferenceCatalog | null;
  totals: ReferenceTotals;
  firstActivation: ReferenceActivator | null;
  last: ReferenceLast | null;
  calendar: ReferenceCalendar;
  monthly: ReferenceMonth[];
  bands: ReferenceBand[];
  modes: ReferenceMode[];
  topActivators: ReferenceTopActivator[];
  recentActivations: ReferenceActivation[];
  recentSpots: ReferenceSpot[];
}

// RPC jsonb can gain keys across deploys, so every object is loose.

const programSchema: z.ZodType<ReferenceProgram> = z.enum(REFERENCE_PROGRAMS);

const catalogSchema: z.ZodType<ReferenceCatalog> = z.looseObject({
  name: z.string().nullable(),
  active: z.boolean(),
  location: z.string().nullable(),
  association: z.string().nullable(),
  region: z.string().nullable(),
  country: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  grid: z.string().nullable(),
  altitudeM: z.number().nullable(),
  points: z.number().nullable(),
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
});

const totalsSchema: z.ZodType<ReferenceTotals> = z.looseObject({
  activations: z.number(),
  activators: z.number(),
  spots: z.number(),
});

const activatorSchema: z.ZodType<ReferenceActivator> = z.looseObject({
  day: z.string(),
  callsign: z.string(),
  base: z.string(),
});

const todaySchema: z.ZodType<ReferenceToday> = z.looseObject({
  spots: z.number(),
  bands: z.array(z.string()),
});

const lastSchema: z.ZodType<ReferenceLast> = z.looseObject({
  callsign: z.string(),
  base: z.string(),
  time: z.string(),
  frequencyKhz: z.number().nullable(),
  mode: z.string().nullable(),
  band: z.string().nullable(),
  source: z.string(),
  today: todaySchema.nullable(),
});

const calendarDaySchema: z.ZodType<ReferenceCalendarDay> = z.looseObject({
  day: z.string(),
  activators: z.array(z.string()),
});

const busiestSchema: z.ZodType<ReferenceBusiest> = z.looseObject({
  day: z.string(),
  activators: z.number(),
});

const periodSchema: z.ZodType<ReferenceCalendarPeriod> = z.looseObject({
  period: z.string(),
  from: z.string(),
  to: z.string(),
  days: z.number(),
  activations: z.number(),
  daysActivated: z.number(),
  longestStreak: z.number(),
  busiest: busiestSchema.nullable(),
});

const calendarSchema: z.ZodType<ReferenceCalendar> = z.looseObject({
  days: z.array(calendarDaySchema),
  periods: z.array(periodSchema),
});

const monthSchema: z.ZodType<ReferenceMonth> = z.looseObject({
  month: z.string(),
  activations: z.number(),
});

const bandSchema: z.ZodType<ReferenceBand> = z.looseObject({
  band: z.string(),
  spots: z.number(),
});

const modeSchema: z.ZodType<ReferenceMode> = z.looseObject({
  label: z.string(),
  spots: z.number(),
  percent: z.number(),
});

const topActivatorSchema: z.ZodType<ReferenceTopActivator> = z.looseObject({
  callsign: z.string(),
  base: z.string(),
  activations: z.number(),
  lastDay: z.string(),
});

const activationSchema: z.ZodType<ReferenceActivation> = z.looseObject({
  day: z.string(),
  callsign: z.string(),
  base: z.string(),
  spots: z.number(),
  bands: z.array(z.string()),
  modes: z.array(z.string()),
});

const spotSchema: z.ZodType<ReferenceSpot> = z.looseObject({
  time: z.string(),
  callsign: z.string(),
  base: z.string(),
  frequencyKhz: z.number().nullable(),
  mode: z.string().nullable(),
  band: z.string().nullable(),
  spotter: z.string(),
  comment: z.string().nullable(),
  source: z.string(),
});

/** One reference_profile payload, as cached_reference_profile returns it. */
export const referenceProfileSchema: z.ZodType<ReferenceProfile> = z.looseObject({
  program: programSchema,
  reference: z.string(),
  sourceUrl: z.string().nullable(),
  catalog: catalogSchema.nullable(),
  totals: totalsSchema,
  firstActivation: activatorSchema.nullable(),
  last: lastSchema.nullable(),
  calendar: calendarSchema,
  monthly: z.array(monthSchema),
  bands: z.array(bandSchema),
  modes: z.array(modeSchema),
  topActivators: z.array(topActivatorSchema),
  recentActivations: z.array(activationSchema),
  recentSpots: z.array(spotSchema),
});

/** cached_reference_profile's reply: the payload, or null when there is no page. */
const cachedReferenceProfileSchema: z.ZodType<ReferenceProfile | null> = referenceProfileSchema
  .nullable();

export interface ReferenceProfileDeps {
  /** Service-role client for the rate-limit and profile RPCs. */
  db: () => SupabaseClient;
  /** The header the edge proxy sets to the client's address; the profile's default when unset. */
  clientIpHeader: string | undefined;
  /** HMAC key for the rate-limit key, imported once per isolate; undefined when the secret is unset. */
  key: CryptoKey | undefined;
}

/** The program lower-cased and trimmed, or null when it is not one with a list. */
export function parseProgram(raw: string | null): ReferenceProgram | null {
  if (raw === null) {
    return null;
  }
  const program = programSchema.safeParse(raw.trim().toLowerCase());
  if (program.success) {
    return program.data;
  }
  return null;
}

/**
 * The reference upper-cased and trimmed, or null when it cannot be one: letters, digits, "/" and
 * "-", at most 64 characters. Whether it exists is SQL's question.
 */
export function parseReference(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  const reference = raw.trim().toUpperCase();
  if (REFERENCE.test(reference)) {
    return reference;
  }
  return null;
}

export async function handleReferenceProfile(
  req: Request,
  deps: ReferenceProfileDeps,
): Promise<Response> {
  const preflight = preflightResponse(req, DEFAULT_METHODS);
  if (preflight !== null) {
    return preflight;
  }
  if (req.method !== "GET") {
    return json({ error: "Method not allowed." }, 405, {});
  }

  const params = new URL(req.url).searchParams;
  const program = parseProgram(params.get("program"));
  const reference = parseReference(params.get("reference"));
  if (program === null || reference === null) {
    return json({ error: REFERENCE_NOT_FOUND }, 404, {});
  }

  const db = deps.db();
  const limited = await lookupLimit(
    req,
    db,
    deps,
    "reference-profile",
    REFERENCE_UNAVAILABLE,
    {},
  );
  if (limited !== null) {
    return limited;
  }

  const found = await db.rpc("cached_reference_profile", {
    p_program: program,
    p_reference: reference,
  });
  if (found.error !== null) {
    console.error(`reference-profile: ${found.error.message}`);
    return json({ error: REFERENCE_UNAVAILABLE }, 500, {});
  }
  let profile: ReferenceProfile | null;
  try {
    profile = parseWith(
      cachedReferenceProfileSchema,
      found.data,
      "handleReferenceProfile: cached_reference_profile result",
    );
  } catch (error) {
    if (!(error instanceof ValidationError)) {
      throw error;
    }
    // The message names the reader and the fields, never the reference.
    console.error(`reference-profile: ${error.message}`);
    return json({ error: REFERENCE_UNAVAILABLE }, 500, {});
  }
  // Null: neither in the program's list nor in any spot.
  if (profile === null) {
    return json({ error: REFERENCE_NOT_FOUND }, 404, {});
  }
  return json(profile, 200, { "Cache-Control": PROFILE_CACHE_CONTROL });
}

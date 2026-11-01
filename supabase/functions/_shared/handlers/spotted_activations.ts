// The spotted-activations function: a public read of a callsign's spotted activations (the
// profile's Spotted activations tab) and of one spotted activation's page (/activations/<id>),
// for signed-out browsers too, so it is deployed with verify_jwt = false and checks nothing about
// the caller beyond the callsign profile's per-client rate limit (lookupLimit: one budget per
// client for profiles, group pages, reference pages, searches and activations).
//
// GET ?id=<12 characters of a-z and 2-7> reads one activation with spotted_activation(), and
// GET ?callsign=KK4PWJ/P a callsign's list with callsign_spotted_activations(). Both are built in
// SQL from closed activations, which never change, so there is no SQL cache; their shapes are
// SpottedActivation and CallsignActivations in web/src/activations/types.ts, read here with
// spottedActivationSchema and callsignActivationsSchema. SQL returns null for an unknown, open or
// hidden activation and for a malformed or hidden call; all of those are the same 404, as is a
// malformed id or a request that names neither, refused before any database call. A callsign that
// cannot be one is a 400, as on the profile.
//
// The id and the callsign are never logged: a failure names the function only.

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { DEFAULT_METHODS, json, preflightResponse } from "../cors.ts";
import { ValidationError } from "../errors.ts";
import { parseWith } from "../validate.ts";
import {
  INVALID_CALLSIGN,
  lookupLimit,
  parseCallsign,
  PROFILE_CACHE_CONTROL,
} from "./callsign_profile.ts";
import { logError } from "../sentry.ts";

export const ACTIVATION_NOT_FOUND = "Spotted activation not found.";
export const ACTIVATIONS_UNAVAILABLE = "Spotted activations are unavailable right now.";
/** The programs an activation can be at (spotted_activations.program). */
export const ACTIVATION_PROGRAMS = ["pota", "sota", "wwff", "wwbota", "iota"] as const;
/** new_activation_id()'s alphabet and length, as the table's check constraint. */
const ACTIVATION_ID = /^[a-z2-7]{12}$/;

export type ActivationProgram = (typeof ACTIVATION_PROGRAMS)[number];

/** The reference's catalog coordinates and its own US states; null without coordinates. */
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
  place: string | null;
  frequencyKhz: number | null;
  mode: string | null;
  references: string[] | null;
}

/** What spotted_activation builds (SpottedActivation in web/src/activations/types.ts). */
export interface SpottedActivation {
  id: string;
  callsign: string;
  program: ActivationProgram;
  references: string[];
  referenceNames: (string | null)[];
  day: string;
  startedAt: string;
  lastSpotAt: string;
  durationSeconds: number;
  split: ActivationSplit;
  location: ActivationLocation | null;
  spotCount: number;
  sources: ActivationSources;
  bands: string[];
  modes: string[];
  heard: ActivationPlace[];
  farthest: ActivationFarthest | null;
  spots: ActivationSpot[];
}

/** One row of a callsign's list (ActivationCard in web/src/activations/types.ts). */
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
  activations: number;
  references: ActivationReferenceCounts;
  onAirSeconds: number;
  mostActivated: MostActivated | null;
}

/** What callsign_spotted_activations builds (CallsignActivations in web/src/activations/types.ts). */
export interface CallsignActivations {
  callsign: string;
  summary: ActivationSummary;
  recent: ActivationCard[];
  more: boolean;
}

// RPC jsonb can gain keys across deploys, so every object is loose.

const programSchema: z.ZodType<ActivationProgram> = z.enum(ACTIVATION_PROGRAMS);

const placeKindSchema: z.ZodType<"state" | "country"> = z.enum(["state", "country"]);

const locationSchema: z.ZodType<ActivationLocation> = z.looseObject({
  latitude: z.number(),
  longitude: z.number(),
  states: z.array(z.string()),
});

const splitSchema: z.ZodType<ActivationSplit> = z.looseObject({
  continuedFrom: z.string().nullable(),
  continuedBy: z.string().nullable(),
});

const sourcesSchema: z.ZodType<ActivationSources> = z.looseObject({
  pota: z.number().optional(),
  sotawatch: z.number().optional(),
  wwff: z.number().optional(),
  wwbota: z.number().optional(),
  dxcluster: z.number().optional(),
  rbn: z.number().optional(),
});

const placeSchema: z.ZodType<ActivationPlace> = z.looseObject({
  kind: placeKindSchema,
  code: z.string(),
  name: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  spots: z.number(),
});

const farthestSchema: z.ZodType<ActivationFarthest> = z.looseObject({
  kind: placeKindSchema,
  code: z.string(),
  name: z.string().nullable(),
  km: z.number(),
});

const spotSchema: z.ZodType<ActivationSpot> = z.looseObject({
  time: z.string(),
  source: z.string(),
  spotter: z.string().nullable(),
  spotterBase: z.string().nullable(),
  selfSpot: z.boolean(),
  place: z.string().nullable(),
  frequencyKhz: z.number().nullable(),
  mode: z.string().nullable(),
  references: z.array(z.string()).nullable(),
});

/** One spotted_activation payload. */
export const spottedActivationSchema: z.ZodType<SpottedActivation> = z.looseObject({
  id: z.string(),
  callsign: z.string(),
  program: programSchema,
  references: z.array(z.string()),
  referenceNames: z.array(z.string().nullable()),
  day: z.string(),
  startedAt: z.string(),
  lastSpotAt: z.string(),
  durationSeconds: z.number(),
  split: splitSchema,
  location: locationSchema.nullable(),
  spotCount: z.number(),
  sources: sourcesSchema,
  bands: z.array(z.string()),
  modes: z.array(z.string()),
  heard: z.array(placeSchema),
  farthest: farthestSchema.nullable(),
  spots: z.array(spotSchema),
});

const cardSchema: z.ZodType<ActivationCard> = z.looseObject({
  id: z.string(),
  program: programSchema,
  references: z.array(z.string()),
  referenceNames: z.array(z.string().nullable()),
  day: z.string(),
  startedAt: z.string(),
  lastSpotAt: z.string(),
  durationSeconds: z.number(),
  spotCount: z.number(),
  bands: z.array(z.string()),
  modes: z.array(z.string()),
  states: z.number(),
  countries: z.number(),
  continuedFrom: z.string().nullable(),
  continuedBy: z.string().nullable(),
});

const referenceCountsSchema: z.ZodType<ActivationReferenceCounts> = z.looseObject({
  total: z.number(),
  pota: z.number(),
  sota: z.number(),
  wwff: z.number(),
  wwbota: z.number(),
  iota: z.number(),
});

const mostActivatedSchema: z.ZodType<MostActivated> = z.looseObject({
  program: programSchema,
  reference: z.string(),
  name: z.string().nullable(),
  times: z.number(),
});

const summarySchema: z.ZodType<ActivationSummary> = z.looseObject({
  activations: z.number(),
  references: referenceCountsSchema,
  onAirSeconds: z.number(),
  mostActivated: mostActivatedSchema.nullable(),
});

/** One callsign_spotted_activations payload. */
export const callsignActivationsSchema: z.ZodType<CallsignActivations> = z.looseObject({
  callsign: z.string(),
  summary: summarySchema,
  recent: z.array(cardSchema),
  more: z.boolean(),
});

/** spotted_activation's reply: the payload, or null when there is no page. */
const spottedActivationReplySchema: z.ZodType<SpottedActivation | null> = spottedActivationSchema
  .nullable();

/** callsign_spotted_activations' reply: the payload, or null for a malformed or hidden call. */
const callsignActivationsReplySchema: z.ZodType<CallsignActivations | null> =
  callsignActivationsSchema.nullable();

export interface SpottedActivationsDeps {
  /** Service-role client for the rate-limit and activation RPCs. */
  db: () => SupabaseClient;
  /** The header the edge proxy sets to the client's address; the profile's default when unset. */
  clientIpHeader: string | undefined;
  /** HMAC key for the rate-limit key, imported once per isolate; undefined when the secret is unset. */
  key: CryptoKey | undefined;
}

/** The id when it has new_activation_id()'s shape (12 of a-z and 2-7), else null. */
export function parseActivationId(raw: string | null): string | null {
  if (raw !== null && ACTIVATION_ID.test(raw)) {
    return raw;
  }
  return null;
}

/** What the request asks for, decided before any database call. */
type Route =
  | { kind: "activation"; id: string }
  | { kind: "list"; callsign: string }
  | { kind: "refused"; response: Response };

function routeOf(params: URLSearchParams): Route {
  const id = params.get("id");
  const callsign = params.get("callsign");
  if (id !== null && callsign === null) {
    const parsed = parseActivationId(id);
    if (parsed === null) {
      return { kind: "refused", response: json({ error: ACTIVATION_NOT_FOUND }, 404, {}) };
    }
    return { kind: "activation", id: parsed };
  }
  if (callsign !== null && id === null) {
    const parsed = parseCallsign(callsign);
    if (parsed === null) {
      return { kind: "refused", response: json({ error: INVALID_CALLSIGN }, 400, {}) };
    }
    return { kind: "list", callsign: parsed };
  }
  // Neither, or both: no page.
  return { kind: "refused", response: json({ error: ACTIVATION_NOT_FOUND }, 404, {}) };
}

/**
 * Parses an RPC's reply, or logs the failure (naming the reader and the fields, never the id or
 * the callsign) and returns undefined.
 */
function readReply<T>(
  schema: z.ZodType<T | null>,
  reply: { data: unknown; error: { message: string } | null },
  where: string,
): T | null | undefined {
  if (reply.error !== null) {
    logError(`spotted-activations: ${reply.error.message}`, reply.error);
    return undefined;
  }
  try {
    return parseWith(schema, reply.data, where);
  } catch (error) {
    if (!(error instanceof ValidationError)) {
      throw error;
    }
    logError(`spotted-activations: ${error.message}`, error);
    return undefined;
  }
}

export async function handleSpottedActivations(
  req: Request,
  deps: SpottedActivationsDeps,
  now: Date,
): Promise<Response> {
  const preflight = preflightResponse(req, DEFAULT_METHODS);
  if (preflight !== null) {
    return preflight;
  }
  if (req.method !== "GET") {
    return json({ error: "Method not allowed." }, 405, {});
  }

  const route = routeOf(new URL(req.url).searchParams);
  if (route.kind === "refused") {
    return route.response;
  }

  const db = deps.db();
  const limited = await lookupLimit(
    req,
    db,
    deps,
    "spotted-activations",
    ACTIVATIONS_UNAVAILABLE,
    {},
  );
  if (limited !== null) {
    return limited;
  }

  let payload: SpottedActivation | CallsignActivations | null | undefined;
  if (route.kind === "activation") {
    payload = readReply(
      spottedActivationReplySchema,
      await db.rpc("spotted_activation", { p_id: route.id }),
      "handleSpottedActivations: spotted_activation result",
    );
  } else {
    payload = readReply(
      callsignActivationsReplySchema,
      await db.rpc("callsign_spotted_activations", {
        p_callsign: route.callsign,
        p_now: now.toISOString(),
      }),
      "handleSpottedActivations: callsign_spotted_activations result",
    );
  }
  if (payload === undefined) {
    return json({ error: ACTIVATIONS_UNAVAILABLE }, 500, {});
  }
  // Null: an unknown, open or hidden activation, or a call with no base or a hidden one.
  if (payload === null) {
    return json({ error: ACTIVATION_NOT_FOUND }, 404, {});
  }
  return json(payload, 200, { "Cache-Control": PROFILE_CACHE_CONTROL });
}

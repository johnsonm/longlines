// The reference-search function: a public search of the POTA, SOTA and WWFF
// lists by reference or name (the Reference lookup page, /ref, and the
// reference rule's picker), for signed-out browsers too, so it is deployed
// with verify_jwt = false and checks nothing about the caller beyond the
// callsign profile's per-client rate limit (lookupLimit: one budget per client
// for profiles, group pages, reference pages and searches).
//
// GET ?q=mitchell&program=sota. program is optional (absent or empty searches
// every program). The search is search_references() in SQL (spec
// docs/superpowers/specs/2026-10-26-reference-profiles-design.md, decision 11);
// its shape is ReferenceSearch in web/src/references/types.ts, read here with
// referenceSearchSchema. A query that is not 2 to 64 characters after trimming,
// or has more than 6 words, and a program without a list are a 400 before any
// database call.
//
// The query is never logged: a failure names the function only.

import { z } from "zod";
import { DEFAULT_METHODS, json, preflightResponse } from "../cors.ts";
import { ValidationError } from "../errors.ts";
import { parseWith } from "../validate.ts";
import { lookupLimit, PROFILE_CACHE_CONTROL } from "./callsign_profile.ts";
import {
  parseProgram,
  type ReferenceProfileDeps,
  type ReferenceProgram,
  referenceProgramSchema,
} from "./reference_profile.ts";
import { logError } from "../sentry.ts";

/** Fewest characters in a trimmed query, as search_references counts them. */
export const MIN_QUERY_LENGTH = 2;
/** Most characters in a trimmed query. */
export const MAX_QUERY_LENGTH = 64;
/** Most whitespace-separated words in a query. */
export const MAX_QUERY_WORDS = 6;
export const SEARCH_INVALID = "A search is 2 to 64 characters, at most 6 words.";
export const PROGRAM_INVALID = "The program must be pota, sota or wwff.";
export const SEARCH_UNAVAILABLE = "Reference search is unavailable right now.";

/** One reference a search found: its list entry plus its activations (reference_days). */
export interface ReferenceSearchResult {
  program: ReferenceProgram;
  reference: string;
  name: string | null;
  active: boolean;
  validTo: string | null;
  location: string | null;
  association: string | null;
  region: string | null;
  country: string | null;
  grid: string | null;
  altitudeM: number | null;
  points: number | null;
  activations: number;
  lastDay: string | null;
}

/** What search_references builds (ReferenceSearch in web/src/references/types.ts). */
export interface ReferenceSearch {
  results: ReferenceSearchResult[];
  more: boolean;
}

// RPC jsonb can gain keys across deploys, so every object is loose.

const resultSchema: z.ZodType<ReferenceSearchResult> = z.looseObject({
  program: referenceProgramSchema,
  reference: z.string(),
  name: z.string().nullable(),
  active: z.boolean(),
  validTo: z.string().nullable(),
  location: z.string().nullable(),
  association: z.string().nullable(),
  region: z.string().nullable(),
  country: z.string().nullable(),
  grid: z.string().nullable(),
  altitudeM: z.number().nullable(),
  points: z.number().nullable(),
  activations: z.number(),
  lastDay: z.string().nullable(),
});

/** One search_references payload. */
export const referenceSearchSchema: z.ZodType<ReferenceSearch> = z.looseObject({
  results: z.array(resultSchema),
  more: z.boolean(),
});

/** search_references' reply: the payload, or null for a query or program it refuses. */
const searchReplySchema: z.ZodType<ReferenceSearch | null> = referenceSearchSchema.nullable();

/** Same clients, header and key as reference-profile. */
export type ReferenceSearchDeps = ReferenceProfileDeps;

/**
 * The query trimmed, or null when it cannot be a search: 2 to 64 characters (code points, as
 * Postgres counts them), at most 6 whitespace-separated words, no NUL (text cannot hold one).
 * Matching (upper case, strpos) is SQL's.
 */
export function parseQuery(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  const query = raw.trim();
  const length = Array.from(query).length;
  if (length < MIN_QUERY_LENGTH || length > MAX_QUERY_LENGTH || query.includes("\u0000")) {
    return null;
  }
  if (query.split(/\s+/).length > MAX_QUERY_WORDS) {
    return null;
  }
  return query;
}

/** The program parameter: null for every program (absent or empty), undefined when it has no list. */
export function parseSearchProgram(raw: string | null): ReferenceProgram | null | undefined {
  if (raw === null || raw.trim() === "") {
    return null;
  }
  const program = parseProgram(raw);
  if (program === null) {
    return undefined;
  }
  return program;
}

export async function handleReferenceSearch(
  req: Request,
  deps: ReferenceSearchDeps,
): Promise<Response> {
  const preflight = preflightResponse(req, DEFAULT_METHODS);
  if (preflight !== null) {
    return preflight;
  }
  if (req.method !== "GET") {
    return json({ error: "Method not allowed." }, 405, {});
  }

  const params = new URL(req.url).searchParams;
  const query = parseQuery(params.get("q"));
  if (query === null) {
    return json({ error: SEARCH_INVALID }, 400, {});
  }
  const program = parseSearchProgram(params.get("program"));
  if (program === undefined) {
    return json({ error: PROGRAM_INVALID }, 400, {});
  }

  const db = deps.db();
  const limited = await lookupLimit(req, db, deps, "reference-search", SEARCH_UNAVAILABLE, {});
  if (limited !== null) {
    return limited;
  }

  const found = await db.rpc("search_references", { p_query: query, p_program: program });
  if (found.error !== null) {
    logError(`reference-search: ${found.error.message}`, found.error);
    return json({ error: SEARCH_UNAVAILABLE }, 500, {});
  }
  let search: ReferenceSearch | null;
  try {
    search = parseWith(
      searchReplySchema,
      found.data,
      "handleReferenceSearch: search_references result",
    );
  } catch (error) {
    if (!(error instanceof ValidationError)) {
      throw error;
    }
    // The message names the reader and the fields, never the query.
    logError(`reference-search: ${error.message}`, error);
    return json({ error: SEARCH_UNAVAILABLE }, 500, {});
  }
  // Null: SQL refused the query after all (its word split differs on some whitespace).
  if (search === null) {
    return json({ error: SEARCH_INVALID }, 400, {});
  }
  return json(search, 200, { "Cache-Control": PROFILE_CACHE_CONTROL });
}

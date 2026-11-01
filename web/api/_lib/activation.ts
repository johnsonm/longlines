// What both link-preview functions share: the environment they read, the id check, and the one
// request each makes, to the public spotted-activations Edge Function, as the web app's
// loadSpottedActivation does (the anon key as `apikey`, nothing else). Files under api/_lib are
// not functions: Vercel skips paths that start with an underscore.
//
// Every figure and place comes from that function (SQL's); the previews only word and draw it,
// with the same modules the activation page uses.

import type { ActivationLocation, ActivationPlace, ActivationProgram, SpottedActivation } from "../../src/activations/types.ts";

/** The part of an activation the previews use. */
export type PreviewActivation = Pick<
  SpottedActivation,
  | "id"
  | "callsign"
  | "program"
  | "references"
  | "referenceNames"
  | "day"
  | "startedAt"
  | "lastSpotAt"
  | "durationSeconds"
  | "location"
  | "heard"
>;

/** The function's base URL and the public key it takes. */
export interface PreviewEnv {
  supabaseUrl: string;
  anonKey: string;
}

/** The environment as Vercel hands it to a function (process.env). */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * The Supabase URL and anon key, from the names the Supabase Vercel integration sets (the same
 * list web/vite.config.ts maps for the browser build); null when either is missing.
 */
export function previewEnv(env: EnvSource): PreviewEnv | null {
  const supabaseUrl = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const anonKey = env.SUPABASE_ANON_KEY ?? env.VITE_SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    env.SUPABASE_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
  if (!supabaseUrl || !anonKey) return null;
  return { supabaseUrl: supabaseUrl.replace(/\/+$/, ""), anonKey };
}

/** An activation id as new_activation_id() makes it: 12 characters of [a-z2-7]. */
const ACTIVATION_ID = /^[a-z2-7]{12}$/;

/** The id a request asks for, or null when it cannot be one (answered 404 before any request). */
export function requestedId(request: Request): string | null {
  const id = new URL(request.url).searchParams.get("id");
  return id !== null && ACTIVATION_ID.test(id) ? id : null;
}

/** The function's 404 for an unknown, open or hidden activation; any other 404 is an outage. */
export const NOT_FOUND = "Spotted activation not found.";

/** How long a preview may sit in Vercel's CDN: a closed activation never changes, but a call can be hidden. */
export const CACHE_CONTROL = "public, s-maxage=900";

/** How long the one request to the function may take; crawlers give up soon after. */
const FETCH_TIMEOUT_MS = 5_000;

/** The function answered with something the previews cannot use. */
export class UpstreamError extends Error {
  constructor(message: string, options: ErrorOptions | undefined) {
    super(message, options);
    this.name = "UpstreamError";
  }
}

/** The fetch the functions are given: the global one, or a test's. */
export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * The activation, or null when the function says it is not found. Throws UpstreamError for an
 * outage: another status, a 404 with another message, a timeout or a body that is not one.
 */
export async function loadActivation(id: string, env: PreviewEnv, fetchFn: Fetch): Promise<PreviewActivation | null> {
  const url = `${env.supabaseUrl}/functions/v1/spotted-activations?${new URLSearchParams({ id }).toString()}`;
  let response: Response;
  try {
    response = await fetchFn(url, { headers: { apikey: env.anonKey }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error) {
    throw new UpstreamError("spotted-activations request failed", { cause: error });
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new UpstreamError(`spotted-activations answered ${response.status} without JSON`, { cause: error });
  }
  if (response.status === 404 && isRecord(body) && body.error === NOT_FOUND) return null;
  if (!response.ok) throw new UpstreamError(`spotted-activations answered ${response.status}`, undefined);
  return parseActivation(body);
}

// ---- The payload ----------------------------------------------------------------------------
// The function already checks its reply with spottedActivationSchema; this reads only the keys
// the previews use and refuses anything else, without a type assertion.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(key: string): UpstreamError {
  return new UpstreamError(`spotted-activations reply has a malformed ${key}`, undefined);
}

function record(value: unknown, key: string): Record<string, unknown> {
  if (!isRecord(value)) throw malformed(key);
  return value;
}

function text(value: unknown, key: string): string {
  if (typeof value !== "string") throw malformed(key);
  return value;
}

function textOrNull(value: unknown, key: string): string | null {
  return value === null ? null : text(value, key);
}

function num(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw malformed(key);
  return value;
}

function numOrNull(value: unknown, key: string): number | null {
  return value === null ? null : num(value, key);
}

function list(value: unknown, key: string): unknown[] {
  if (!Array.isArray(value)) throw malformed(key);
  return value;
}

const PROGRAMS: readonly ActivationProgram[] = ["pota", "sota", "wwff", "wwbota", "iota"];

function program(value: unknown): ActivationProgram {
  const found = PROGRAMS.find((p) => p === value);
  if (found === undefined) throw malformed("program");
  return found;
}

function place(value: unknown): ActivationPlace {
  const p = record(value, "heard");
  const kind = p.kind === "state" || p.kind === "country" ? p.kind : null;
  if (kind === null) throw malformed("heard kind");
  return {
    kind,
    code: text(p.code, "heard code"),
    name: textOrNull(p.name, "heard name"),
    latitude: numOrNull(p.latitude, "heard latitude"),
    longitude: numOrNull(p.longitude, "heard longitude"),
    spots: num(p.spots, "heard spots"),
  };
}

function location(value: unknown): ActivationLocation | null {
  if (value === null) return null;
  const l = record(value, "location");
  return {
    latitude: num(l.latitude, "location latitude"),
    longitude: num(l.longitude, "location longitude"),
    states: list(l.states, "location states").map((s) => text(s, "location state")),
  };
}

/** The keys the previews use, read from the function's reply; throws UpstreamError on anything else. */
export function parseActivation(body: unknown): PreviewActivation {
  const a = record(body, "reply");
  return {
    id: text(a.id, "id"),
    callsign: text(a.callsign, "callsign"),
    program: program(a.program),
    references: list(a.references, "references").map((r) => text(r, "reference")),
    referenceNames: list(a.referenceNames, "referenceNames").map((n) => textOrNull(n, "reference name")),
    day: text(a.day, "day"),
    startedAt: text(a.startedAt, "startedAt"),
    lastSpotAt: text(a.lastSpotAt, "lastSpotAt"),
    durationSeconds: num(a.durationSeconds, "durationSeconds"),
    location: location(a.location),
    heard: list(a.heard, "heard").map(place),
  };
}

// ---- Replies --------------------------------------------------------------------------------

/** A short plain-text reply for everything that is not a preview. Never cached. */
export function plainResponse(status: number, message: string, headers: Record<string, string>): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

/** A request the previews will answer: the environment and a well-formed id. */
export interface Admitted {
  env: PreviewEnv;
  id: string;
}

/**
 * Either the request may go on, or its reply: 405 for a method other than GET and HEAD, 404 for an
 * id that cannot be one (before any request), 500 without the environment.
 */
export function admit(request: Request, source: EnvSource): Admitted | { refused: Response } {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return { refused: plainResponse(405, "Method not allowed.", { Allow: "GET, HEAD" }) };
  }
  const id = requestedId(request);
  if (id === null) return { refused: plainResponse(404, NOT_FOUND, {}) };
  const env = previewEnv(source);
  if (env === null) return { refused: plainResponse(500, "Link previews are not configured.", {}) };
  return { env, id };
}

/**
 * Loads the admitted activation and hands it to `render`: 404 when the function does not know
 * it, 502 when the function is out.
 */
export async function withActivation(
  admitted: Admitted,
  fetchFn: Fetch,
  render: (activation: PreviewActivation) => Response | Promise<Response>,
): Promise<Response> {
  let activation: PreviewActivation | null;
  try {
    activation = await loadActivation(admitted.id, admitted.env, fetchFn);
  } catch (error) {
    if (!(error instanceof UpstreamError)) throw error;
    console.error(`activation preview: ${error.message}`);
    return plainResponse(502, "Spotted activations are unavailable right now.", {});
  }
  if (activation === null) return plainResponse(404, NOT_FOUND, {});
  return render(activation);
}

// The management API (docs/openapi.yaml): scripts manage a user's destinations,
// subscriptions and callsign groups with a personal API token instead of a
// browser session. Deployed with verify_jwt = false, because the token is not
// a JWT; this handler checks it itself.
//
// Each request: hash the bearer token, authenticate_api_request (token lookup
// plus the per-minute count, one round trip), check the route's scope, then
// api_call, which runs the operation in SQL as the token's owner. Behavior
// lives in SQL; this module only routes, checks shapes and maps errors.

import type { SupabaseClient } from "@supabase/supabase-js";
import { errorStatus } from "../api/errors.ts";
import {
  apiPath,
  checkBody,
  type JsonObject,
  matchRoute,
  parseBody,
  routeArgs,
} from "../api/routes.ts";
import { apiToken, hashApiToken } from "../api/token.ts";
import { json, preflightResponse } from "../cors.ts";
import { type SendTestDeps, sendTestTo } from "./test_delivery.ts";

export const MAX_REQUESTS_PER_MINUTE = 60;
/** Large enough for 2,000 callsigns with room to spare. */
export const MAX_BODY_BYTES = 256 * 1024;

export const BAD_TOKEN = "Missing or invalid API token.";
export const READ_ONLY = "This token is read only.";
export const TOO_MANY_REQUESTS = "Too many requests. Try again in a minute.";
export const NOT_FOUND = "Not found.";
export const BAD_BODY = "Send a JSON object.";
export const BODY_TOO_LARGE = "Request body is too large.";
export const SERVER_ERROR = "Something went wrong. Try again.";

/** Every method a route takes, for the CORS preflight; the shared headers list only GET and POST. */
const API_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";

export interface ApiDeps {
  /** Service-role client for authenticate_api_request, api_call and the send-test lookup. */
  db: () => SupabaseClient;
  send: SendTestDeps["send"];
}

interface TokenRow {
  token_id: string;
  user_id: string;
  scope: "read" | "write";
  requests: number;
}

export async function handleApi(
  req: Request,
  deps: ApiDeps,
  now: Date = new Date(),
): Promise<Response> {
  // A browser sends a preflight before any request with an Authorization header; it carries no token.
  const preflight = preflightResponse(req, API_METHODS);
  if (preflight) return preflight;
  const url = new URL(req.url);
  const path = apiPath(url.pathname);
  const match = path === null ? { kind: "not_found" as const } : matchRoute(req.method, path);
  if (match.kind === "not_found") return json({ error: NOT_FOUND }, 404);
  if (match.kind === "method_not_allowed") {
    return json({ error: "Method not allowed." }, 405, { Allow: match.allow.join(", ") });
  }
  const { route, id } = match;

  const token = apiToken(req);
  if (!token) return json({ error: BAD_TOKEN }, 401);

  const db = deps.db();
  const auth = await db.rpc("authenticate_api_request", {
    p_token_hash: await hashApiToken(token),
  });
  if (auth.error) return serverError("authenticate_api_request", auth.error.message);
  const caller = (auth.data as TokenRow[] | null)?.[0];
  if (!caller) return json({ error: BAD_TOKEN }, 401);
  if (caller.requests > MAX_REQUESTS_PER_MINUTE) {
    const retryAfter = String(60 - now.getUTCSeconds());
    return json({ error: TOO_MANY_REQUESTS }, 429, { "Retry-After": retryAfter });
  }
  if (route.scope === "write" && caller.scope !== "write") {
    return json({ error: READ_ONLY }, 403);
  }

  let body: JsonObject = {};
  if (route.input === "fields" || route.input === "body") {
    const text = await readBody(req, MAX_BODY_BYTES);
    if (text === null) return json({ error: BODY_TOO_LARGE }, 413);
    const parsed = parseBody(text);
    if (!parsed) return json({ error: BAD_BODY }, 400);
    body = parsed;
    const shape = checkBody(route, body);
    if (shape) return json({ error: shape }, 400);
  }

  if (route.op === "send_test") {
    return await sendTestTo(db, caller.user_id, id ?? "", deps.send, now);
  }

  const result = await db.rpc("api_call", {
    p_token_id: caller.token_id,
    p_op: route.op,
    p_args: routeArgs(route, id, body),
  });
  if (result.error) {
    const status = errorStatus(result.error);
    if (status === 500) return serverError(route.op, result.error.message);
    return json({ error: result.error.message }, status);
  }
  return json(result.data, route.status);
}

/**
 * The body as text, or null when it is over `limit` bytes. A declared length over the limit is
 * refused before reading; a chunked body is read only until it passes the limit.
 */
export async function readBody(req: Request, limit: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!req.body) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

function serverError(step: string, message: string): Response {
  console.error(`api: ${step} failed: ${message}`);
  return json({ error: SERVER_ERROR }, 500);
}

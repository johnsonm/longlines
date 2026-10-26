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
import { z } from "zod";
import { errorStatus } from "../api/errors.ts";
import {
  apiPath,
  checkBody,
  type JsonObject,
  matchRoute,
  parseBody,
  routeArgs,
  type RouteMatch,
} from "../api/routes.ts";
import { apiToken, hashApiToken } from "../api/token.ts";
import { json, preflightResponse } from "../cors.ts";
import { ValidationError } from "../errors.ts";
import { parseWith } from "../validate.ts";
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

/** A row of authenticate_api_request: the token, its owner, its scope and this minute's count. */
interface TokenRow {
  token_id: string;
  user_id: string;
  scope: "read" | "write";
  requests: number;
}

// authenticate_api_request returns a table (20261013000300): no row for an unknown or revoked
// token; null reads the same. RPC rows can gain columns across deploys, so loose.
const tokenRowsSchema: z.ZodType<TokenRow[] | null> = z.array(z.looseObject({
  token_id: z.string(),
  user_id: z.string(),
  scope: z.enum(["read", "write"]),
  requests: z.number(),
})).nullable();

export async function handleApi(
  req: Request,
  deps: ApiDeps,
  now: Date,
): Promise<Response> {
  // A browser sends a preflight before any request with an Authorization header; it carries no token.
  const preflight = preflightResponse(req, API_METHODS);
  if (preflight !== null) {
    return preflight;
  }
  const url = new URL(req.url);
  const path = apiPath(url.pathname);
  let match: RouteMatch;
  if (path === null) {
    match = { kind: "not_found" };
  } else {
    match = matchRoute(req.method, path);
  }
  if (match.kind === "not_found") {
    return json({ error: NOT_FOUND }, 404, {});
  }
  if (match.kind === "method_not_allowed") {
    return json({ error: "Method not allowed." }, 405, { Allow: match.allow.join(", ") });
  }
  const route = match.route;
  const id = match.id;

  const token = apiToken(req);
  if (token === null || token === "") {
    return json({ error: BAD_TOKEN }, 401, {});
  }

  const db = deps.db();
  const auth = await db.rpc("authenticate_api_request", {
    p_token_hash: await hashApiToken(token),
  });
  if (auth.error !== null) {
    return serverError("authenticate_api_request", auth.error.message);
  }
  let rows: TokenRow[] | null;
  try {
    rows = parseWith(tokenRowsSchema, auth.data, "handleApi: authenticate_api_request result");
  } catch (error) {
    if (error instanceof ValidationError) {
      return serverError("authenticate_api_request", error.message);
    }
    throw error;
  }
  let caller: TokenRow | undefined;
  if (rows !== null) {
    caller = rows[0];
  }
  if (caller === undefined) {
    return json({ error: BAD_TOKEN }, 401, {});
  }
  if (caller.requests > MAX_REQUESTS_PER_MINUTE) {
    const retryAfter = String(60 - now.getUTCSeconds());
    return json({ error: TOO_MANY_REQUESTS }, 429, { "Retry-After": retryAfter });
  }
  if (route.scope === "write" && caller.scope !== "write") {
    return json({ error: READ_ONLY }, 403, {});
  }

  let body: JsonObject = {};
  if (route.input === "fields" || route.input === "body") {
    const text = await readBody(req, MAX_BODY_BYTES);
    if (text === null) {
      return json({ error: BODY_TOO_LARGE }, 413, {});
    }
    const parsed = parseBody(text);
    if (parsed === null) {
      return json({ error: BAD_BODY }, 400, {});
    }
    body = parsed;
    const shape = checkBody(route, body);
    if (shape !== null && shape !== "") {
      return json({ error: shape }, 400, {});
    }
  }

  if (route.op === "send_test") {
    let destinationId = "";
    if (id !== undefined) {
      destinationId = id;
    }
    return await sendTestTo(db, caller.user_id, destinationId, deps.send, now, null);
  }

  const result = await db.rpc("api_call", {
    p_token_id: caller.token_id,
    p_op: route.op,
    p_args: routeArgs(route, id, body),
  });
  if (result.error !== null) {
    const status = errorStatus(result.error);
    if (status === 500) {
      return serverError(route.op, result.error.message);
    }
    return json({ error: result.error.message }, status, {});
  }
  return json(result.data, route.status, {});
}

/**
 * The body as text, or null when it is over `limit` bytes. A declared length over the limit is
 * refused before reading; a chunked body is read only until it passes the limit.
 */
export async function readBody(req: Request, limit: number): Promise<string | null> {
  let length = "";
  const header = req.headers.get("content-length");
  if (header !== null) {
    length = header;
  }
  const declared = Number(length);
  if (Number.isFinite(declared) && declared > limit) {
    return null;
  }
  if (req.body === null) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body.getReader();
  for (;;) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    const value = result.value;
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
  return json({ error: SERVER_ERROR }, 500, {});
}

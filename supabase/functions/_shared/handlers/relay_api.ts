// The relay-api function: the API Long Lines Relay (the desktop app) calls. The wire contract is
// docs/contract.md in sonyccd/longlines-relay; every path, body, status and error code here is
// that file's, version v1. Production reaches it at https://api.longlines.io/relay/v1/<path>
// through a Vercel rewrite (web/vercel.json); locally at /functions/v1/relay-api/v1/<path>.
//
// Deployed with verify_jwt = false: pairing has no credentials, and the other routes carry a
// relay token (ll_relay_...), not a JWT, which this handler checks itself. It never imports
// isServiceRole.
//
//   POST /v1/device/start  start_relay_pairing (RFC 8628 style pairing, contract 4.1)
//   POST /v1/device/token  poll_relay_pairing; the token once, on an approved pairing (4.2)
//   GET  /v1/me            relay_account: the token owner's callsign and email (5)
//   POST /v1/contacts      apply_logged_contacts, then the matcher (6)
//
// The pairing routes are limited per client address (countClientRequest, keyed like the profile's
// limit but in relay-api's own buckets); me and contacts per token, once the token is known
// (countRequest), and POST /contacts also per contact (record_relay_contacts). The authenticated
// routes are not keyed by address: production reaches this function through a Vercel rewrite, so
// every relay can arrive from the same few proxy addresses and would share one budget. Pairing
// and token policy live in SQL (20261028000400_relay_pairing.sql); checking and shaping a contact
// is _shared/logged.ts. Device codes, tokens and contacts are never logged.

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { errorStatus } from "../api/errors.ts";
import { hashApiToken } from "../api/token.ts";
import { json } from "../cors.ts";
import { createIngestDb } from "../db.ts";
import { FunctionCallError, ValidationError } from "../errors.ts";
import {
  loggedApplyItems,
  type LoggedOutcome,
  type LoggedRequest,
  loggedRequestSchema,
  type LoggedResult,
  loggedResultsSchema,
  mergeLoggedResults,
  normalizeLoggedContact,
  storableText,
} from "../logged.ts";
import { type JsonObject, jsonObjectSchema } from "../types.ts";
import { parseWith } from "../validate.ts";
import { relayToken, type RelayTokenRow, relayTokenRowsSchema } from "../relay_token.ts";
import { hmacSha256Hex } from "../hmac.ts";
import { readBody } from "./api.ts";
import { countClientRequest, countRequest } from "./callsign_profile.ts";

/** Contract section 1: bodies over 256 KiB are refused with 400 invalid_request. */
export const MAX_BODY_BYTES = 256 * 1024;
/** device/start per client address per minute: the tightest, as the contract asks. */
export const MAX_STARTS_PER_MINUTE = 5;
/** device/token per client address per minute: a relay polls every 5 s, so room for five. */
export const MAX_POLLS_PER_MINUTE = 60;
/** me and contacts per relay token per minute, on top of the per-token contact limit. */
export const MAX_REQUESTS_PER_MINUTE = 120;
/** The client_name every device/start must carry (contract 4.1). */
export const CLIENT_NAME = "Long Lines Relay";
/** The scope POST /contacts needs (contract 3). */
export const CONTACTS_WRITE = "contacts:write";

/** The contract's error codes (section 8 and 4.2). */
export type RelayErrorCode =
  | "invalid_request"
  | "authorization_pending"
  | "slow_down"
  | "access_denied"
  | "expired_token"
  | "bad_token"
  | "insufficient_scope"
  | "not_found"
  | "rate_limited"
  | "server_error";

export interface RelayApiDeps {
  /** Service-role client for every RPC. */
  db: () => SupabaseClient;
  /** The header the edge proxy sets to the client's address (LONGLINES_CLIENT_IP_HEADER). */
  clientIpHeader: string | undefined;
  /** HMAC key for the per-client limit's key, imported once per isolate; undefined when unset. */
  key: CryptoKey | undefined;
}

/** A POST /device/start body (contract 4.1). */
export interface DeviceStartRequest {
  client_name: string;
  client_version: string;
  device_name: string;
}

/** A POST /device/token body (contract 4.2). */
export interface DeviceTokenRequest {
  device_code: string;
}

/** start_relay_pairing's reply: the device/start response body. */
export interface DeviceStartReply {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/** poll_relay_pairing's reply. */
export interface PollReply {
  status: "authorization_pending" | "slow_down" | "access_denied" | "expired_token" | "ok";
  access_token?: string;
  scopes?: string[];
}

/** relay_account's reply: GET /me's body. */
export interface RelayAccount {
  callsign: string;
  email: string;
}

// Request bodies are ours, but the contract has the server ignore fields it does not know
// (section 2) because deployed relays lag the server, so they are loose.
const deviceStartSchema: z.ZodType<DeviceStartRequest> = z.looseObject({
  client_name: z.literal(CLIENT_NAME),
  client_version: z.string().min(1).max(32).refine(storableText),
  device_name: z.string().trim().min(1).max(64).refine(storableText),
});

const deviceTokenSchema: z.ZodType<DeviceTokenRequest> = z.looseObject({
  device_code: z.string().min(1).max(128),
});

// RPC replies can gain keys across deploys, so loose.
const deviceStartReplySchema: z.ZodType<DeviceStartReply> = z.looseObject({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string(),
  expires_in: z.number(),
  interval: z.number(),
});

const pollReplySchema: z.ZodType<PollReply> = z.looseObject({
  status: z.enum(["authorization_pending", "slow_down", "access_denied", "expired_token", "ok"]),
  access_token: z.string().optional(),
  scopes: z.array(z.string()).optional(),
});

const accountSchema: z.ZodType<RelayAccount | null> = z.looseObject({
  callsign: z.string().min(1),
  email: z.string(),
}).nullable();

/** A POST /contacts body's items as sent: objects, otherwise unchecked. */
interface ContactItems {
  contacts: JsonObject[];
}

const contactItemsSchema: z.ZodType<ContactItems> = z.looseObject({
  contacts: z.array(jsonObjectSchema),
});

/** One item's id, which the request-level check already required. */
interface ItemId {
  external_id: string;
}

const itemIdSchema: z.ZodType<ItemId> = z.looseObject({ external_id: z.string() });

// record_relay_contacts returns int: 0, or the seconds until the window ends.
const retryAfterSchema: z.ZodType<number> = z.number().int().min(0);

/** A route of the contract, or null for anything else. */
type Route = "device/start" | "device/token" | "me" | "contacts";

const ROUTES: ReadonlyArray<readonly [string, string, Route]> = [
  ["POST", "/v1/device/start", "device/start"],
  ["POST", "/v1/device/token", "device/token"],
  ["GET", "/v1/me", "me"],
  ["POST", "/v1/contacts", "contacts"],
];

/**
 * The path after the function's name, without a trailing slash, or null when the request is not
 * for this function: /functions/v1/relay-api/v1/me (local) and /relay-api/v1/me (hosted) are both
 * /v1/me.
 */
export function relayPath(pathname: string): string | null {
  const match = /^(?:\/functions\/v1)?\/relay-api(\/.*)?$/.exec(pathname);
  if (match === null) {
    return null;
  }
  let rest = "";
  if (match[1] !== undefined) {
    rest = match[1];
  }
  return rest.replace(/\/+$/, "");
}

/** The route for a method and path; null for an unknown path or method (contract: 404). */
export function relayRoute(method: string, path: string): Route | null {
  for (const entry of ROUTES) {
    if (entry[0] === method && entry[1] === path) {
      return entry[2];
    }
  }
  return null;
}

/** `{error, message?}` with the status; never cached, since a body can hold a secret. */
function relayError(
  status: number,
  error: RelayErrorCode,
  message: string | null,
  headers: Record<string, string>,
): Response {
  const body: Record<string, string> = { error };
  if (message !== null) {
    body["message"] = message;
  }
  return reply(body, status, headers);
}

function reply(body: unknown, status: number, headers: Record<string, string>): Response {
  const merged: Record<string, string> = { "Cache-Control": "no-store" };
  for (const entry of Object.entries(headers)) {
    merged[entry[0]] = entry[1];
  }
  return json(body, status, merged);
}

function serverError(step: string, message: string): Response {
  console.error(`relay-api: ${step} failed: ${message}`);
  return relayError(500, "server_error", null, {});
}

/** Seconds until the next whole UTC minute, when per-minute windows reset. */
function secondsToNextMinute(now: Date): string {
  return String(60 - now.getUTCSeconds());
}

/** The response to send for a window's count past `limit`, else null to go on. */
function overLimit(count: number | null, limit: number, now: Date): Response | null {
  if (count === null) {
    return relayError(500, "server_error", null, {});
  }
  if (count > limit) {
    return relayError(429, "rate_limited", "Too many requests. Try again in a minute.", {
      "Retry-After": secondsToNextMinute(now),
    });
  }
  return null;
}

/** A pairing route's per-client limit: null to go on, else the response to send. */
async function clientLimit(
  req: Request,
  db: SupabaseClient,
  clientIpHeader: string | undefined,
  key: CryptoKey,
  route: "device/start" | "device/token",
  now: Date,
): Promise<Response | null> {
  let bucket = "relay-start";
  let limit = MAX_STARTS_PER_MINUTE;
  if (route === "device/token") {
    bucket = "relay-poll";
    limit = MAX_POLLS_PER_MINUTE;
  }
  const count = await countClientRequest(req, db, clientIpHeader, key, "relay-api", bucket);
  return overLimit(count, limit, now);
}

/**
 * me and contacts per relay token (bucket relay-token, keyed by an HMAC of the token's id): null to
 * go on, else the response to send.
 */
async function tokenLimit(
  db: SupabaseClient,
  key: CryptoKey,
  caller: RelayTokenRow,
  now: Date,
): Promise<Response | null> {
  const client = `relay-token:${await hmacSha256Hex(key, caller.token_id)}`;
  const count = await countRequest(db, client, "relay-api");
  return overLimit(count, MAX_REQUESTS_PER_MINUTE, now);
}

/** A request body that parsed as JSON; `value` is still unchecked. */
interface JsonBody {
  value: unknown;
}

/** The request's JSON body, or the 400 to send: over the size limit or not JSON. */
async function jsonBody(req: Request): Promise<JsonBody | Response> {
  const text = await readBody(req, MAX_BODY_BYTES);
  if (text === null) {
    return relayError(400, "invalid_request", "The request body is over 256 KiB.", {});
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    return relayError(400, "invalid_request", "The body is not JSON.", {});
  }
  return { value: parsed };
}

/** Parses a body with its schema, or answers 400 invalid_request naming the fields. */
function parseRequest<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  where: string,
): T | Response {
  try {
    return parseWith(schema, raw, where);
  } catch (error) {
    if (!(error instanceof ValidationError)) {
      throw error;
    }
    return relayError(400, "invalid_request", error.message, {});
  }
}

export async function handleRelayApi(
  req: Request,
  deps: RelayApiDeps,
  now: Date,
): Promise<Response> {
  const path = relayPath(new URL(req.url).pathname);
  let route: Route | null = null;
  if (path !== null) {
    route = relayRoute(req.method, path);
  }
  if (route === null) {
    return relayError(404, "not_found", null, {});
  }

  if (deps.key === undefined) {
    console.error("relay-api: missing environment variable SUPABASE_SERVICE_ROLE_KEY");
    return relayError(500, "server_error", null, {});
  }
  const db = deps.db();

  if (route === "device/start" || route === "device/token") {
    const limited = await clientLimit(req, db, deps.clientIpHeader, deps.key, route, now);
    if (limited !== null) {
      return limited;
    }
    if (route === "device/start") {
      return await deviceStart(req, db);
    }
    return await deviceToken(req, db);
  }

  const caller = await authenticate(req, db);
  if (caller instanceof Response) {
    return caller;
  }
  const limited = await tokenLimit(db, deps.key, caller, now);
  if (limited !== null) {
    return limited;
  }
  if (route === "me") {
    return await me(db, caller);
  }
  if (!caller.scopes.includes(CONTACTS_WRITE)) {
    return relayError(403, "insufficient_scope", null, {});
  }
  return await contacts(req, db, caller, now);
}

async function deviceStart(req: Request, db: SupabaseClient): Promise<Response> {
  const raw = await jsonBody(req);
  if (raw instanceof Response) {
    return raw;
  }
  const body = parseRequest(deviceStartSchema, raw.value, "device/start: body");
  if (body instanceof Response) {
    return body;
  }
  const started = await db.rpc("start_relay_pairing", {
    p_device_name: body.device_name,
    p_client_version: body.client_version,
  });
  if (started.error !== null) {
    return serverError("start_relay_pairing", started.error.message);
  }
  let pairing: DeviceStartReply;
  try {
    pairing = parseWith(
      deviceStartReplySchema,
      started.data,
      "device/start: start_relay_pairing result",
    );
  } catch (error) {
    if (!(error instanceof ValidationError)) {
      throw error;
    }
    return serverError("start_relay_pairing", error.message);
  }
  return reply(
    {
      device_code: pairing.device_code,
      user_code: pairing.user_code,
      verification_uri: pairing.verification_uri,
      verification_uri_complete: pairing.verification_uri_complete,
      expires_in: pairing.expires_in,
      interval: pairing.interval,
    },
    200,
    {},
  );
}

async function deviceToken(req: Request, db: SupabaseClient): Promise<Response> {
  const raw = await jsonBody(req);
  if (raw instanceof Response) {
    return raw;
  }
  const body = parseRequest(deviceTokenSchema, raw.value, "device/token: body");
  if (body instanceof Response) {
    return body;
  }
  const polled = await db.rpc("poll_relay_pairing", {
    p_device_code_hash: await hashApiToken(body.device_code),
  });
  if (polled.error !== null) {
    return serverError("poll_relay_pairing", polled.error.message);
  }
  let poll: PollReply;
  try {
    poll = parseWith(pollReplySchema, polled.data, "device/token: poll_relay_pairing result");
  } catch (error) {
    if (!(error instanceof ValidationError)) {
      throw error;
    }
    return serverError("poll_relay_pairing", error.message);
  }
  if (poll.status !== "ok") {
    return relayError(400, poll.status, null, {});
  }
  if (poll.access_token === undefined || poll.scopes === undefined) {
    return serverError("poll_relay_pairing", "an approved pairing came back without a token");
  }
  return reply(
    { access_token: poll.access_token, token_type: "bearer", scopes: poll.scopes },
    200,
    {},
  );
}

/** The relay token's row, or the 401 (or 500) to send. */
async function authenticate(req: Request, db: SupabaseClient): Promise<RelayTokenRow | Response> {
  const token = relayToken(req);
  if (token === null) {
    return relayError(401, "bad_token", null, {});
  }
  const auth = await db.rpc("authenticate_relay_token", {
    p_token_hash: await hashApiToken(token),
  });
  if (auth.error !== null) {
    return serverError("authenticate_relay_token", auth.error.message);
  }
  let rows: RelayTokenRow[] | null;
  try {
    rows = parseWith(relayTokenRowsSchema, auth.data, "relay-api: authenticate_relay_token result");
  } catch (error) {
    if (!(error instanceof ValidationError)) {
      throw error;
    }
    return serverError("authenticate_relay_token", error.message);
  }
  let caller: RelayTokenRow | undefined;
  if (rows !== null) {
    caller = rows[0];
  }
  if (caller === undefined) {
    return relayError(401, "bad_token", null, {});
  }
  return caller;
}

async function me(db: SupabaseClient, caller: RelayTokenRow): Promise<Response> {
  const result = await db.rpc("relay_account", { p_user_id: caller.user_id });
  if (result.error !== null) {
    return serverError("relay_account", result.error.message);
  }
  let account: RelayAccount | null;
  try {
    account = parseWith(accountSchema, result.data, "me: relay_account result");
  } catch (error) {
    if (!(error instanceof ValidationError)) {
      throw error;
    }
    return serverError("relay_account", error.message);
  }
  // A relay is paired only for an account with a callsign (answer_relay_pairing).
  if (account === null) {
    return serverError("relay_account", "the token's account has no profile");
  }
  return reply({ callsign: account.callsign, email: account.email }, 200, {});
}

async function contacts(
  req: Request,
  db: SupabaseClient,
  caller: RelayTokenRow,
  now: Date,
): Promise<Response> {
  const raw = await jsonBody(req);
  if (raw instanceof Response) {
    return raw;
  }
  const body = parseRequest<LoggedRequest>(loggedRequestSchema, raw.value, "contacts: body");
  if (body instanceof Response) {
    return body;
  }
  // The items as sent: the request-level check passed, so each has its external_id.
  const items = parseWith(contactItemsSchema, raw.value, "contacts: items").contacts;

  const counted = await db.rpc("record_relay_contacts", {
    p_token_id: caller.token_id,
    p_count: items.length,
  });
  if (counted.error !== null) {
    return serverError("record_relay_contacts", counted.error.message);
  }
  let retryAfter: number;
  try {
    retryAfter = parseWith(
      retryAfterSchema,
      counted.data,
      "contacts: record_relay_contacts result",
    );
  } catch (error) {
    if (!(error instanceof ValidationError)) {
      throw error;
    }
    return serverError("record_relay_contacts", error.message);
  }
  if (retryAfter > 0) {
    return relayError(429, "rate_limited", "Over 120 contacts this minute.", {
      "Retry-After": String(retryAfter),
    });
  }

  const account = { userId: caller.user_id };
  const outcomes: LoggedOutcome[] = [];
  for (const item of items) {
    outcomes.push(await normalizeItem(item, account, body.relay_version, now));
  }

  let results: LoggedResult[];
  const apply = loggedApplyItems(outcomes);
  if (apply.length === 0) {
    results = mergeLoggedResults(outcomes, []);
  } else {
    const applied = await db.rpc("apply_logged_contacts", {
      p_user_id: caller.user_id,
      p_items: apply,
    });
    if (applied.error !== null) {
      if (errorStatus(applied.error) === 400) {
        console.error(`relay-api: apply_logged_contacts refused a batch: ${applied.error.message}`);
        return relayError(400, "invalid_request", "A contact could not be stored.", {});
      }
      return serverError("apply_logged_contacts", applied.error.message);
    }
    try {
      results = mergeLoggedResults(
        outcomes,
        parseWith(loggedResultsSchema, applied.data, "contacts: apply_logged_contacts result"),
      );
    } catch (error) {
      if (!(error instanceof ValidationError)) {
        throw error;
      }
      return serverError("apply_logged_contacts", error.message);
    }
  }

  // New spots are queued; run the matcher now rather than waiting for the minute's cron, as
  // runIngest does. A matcher problem is logged and does not undo a good batch.
  if (results.some((r) => r.status === "created" || r.status === "updated")) {
    try {
      await createIngestDb(db).matchPendingSpots();
    } catch (error) {
      if (!(error instanceof FunctionCallError) && !(error instanceof ValidationError)) {
        throw error;
      }
      console.error(`relay-api: matcher failed: ${error.message}`);
    }
  }
  return reply({ results }, 200, {});
}

/**
 * One item's outcome. An item normalizeLoggedContact cannot store (assertStorableSpot refusing
 * it) is that item's rejected / invalid result, never the batch's failure.
 */
async function normalizeItem(
  item: unknown,
  account: { userId: string },
  relayVersion: string,
  now: Date,
): Promise<LoggedOutcome> {
  try {
    return await normalizeLoggedContact(item, account, relayVersion, now);
  } catch (error) {
    if (!(error instanceof ValidationError)) {
      throw error;
    }
    const id = parseWith(itemIdSchema, item, "contacts: item").external_id;
    return { kind: "result", result: { external_id: id, status: "rejected", reason: "invalid" } };
  }
}

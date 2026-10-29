// Sign in with an email. Accounts may share a callsign, so a callsign is refused
// (SIGN_IN_WITH_EMAIL) before anything is looked up or counted; nothing here
// reveals whether an account exists.
//
// Failed attempts are limited per (email, client) and, more loosely, per email,
// in SQL (begin_sign_in_attempt). The client is the same HMAC of the caller's
// address that callsign-profile rate limits on (rateLimitKey), so a stranger
// guessing at someone's email does not lock its owner out. An
// attempt is logged before the password check and forgotten again unless the
// password was wrong, so a right password (verifyPassword in the web app
// re-checks it) never counts. A wrong password is answered no sooner than
// FAILED_SIGN_IN_FLOOR_MS after the request arrived, so the time Auth takes
// (which may differ for an email with no account) does not show.

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { DEFAULT_METHODS, json, preflightResponse } from "../cors.ts";
import { ValidationError } from "../errors.ts";
import {
  GENERIC_SIGN_IN_ERROR,
  isEmailIdentifier,
  normalizeIdentifier,
  parseSignInBody,
  SIGN_IN_WITH_EMAIL,
  type SignInBody,
  TOO_MANY_ATTEMPTS,
} from "../signin.ts";
import { parseWith } from "../validate.ts";
import { rateLimitKey } from "./callsign_profile.ts";

export const EMAIL_NOT_CONFIRMED = "Check your email to confirm your account first.";
export const SIGN_IN_UNAVAILABLE = "Sign-in is unavailable right now.";
/** The least time a 401 takes, from the start of the request. */
export const FAILED_SIGN_IN_FLOOR_MS = 300;

export interface SignInDeps {
  /** Service-role client for the attempt log. */
  admin: () => SupabaseClient;
  /** Anon-key client that checks the password. */
  anon: () => SupabaseClient;
  /** The header the edge proxy sets to the client's address; cf-connecting-ip when unset. */
  clientIpHeader: string | undefined;
  /** HMAC key for the client key, imported once per isolate; undefined when the secret is unset. */
  key: CryptoKey | undefined;
  /** Milliseconds on a monotonic clock; tests pass a fake with `sleep`. */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

// begin_sign_in_attempt returns bigint: the attempt's id, or null past the limit.
const attemptIdSchema: z.ZodType<number | null> = z.number().nullable();

function monotonicNow(): number {
  return performance.now();
}

function sleepMs(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

export async function handleSignIn(req: Request, deps: SignInDeps): Promise<Response> {
  let clock = monotonicNow;
  if (deps.clock !== undefined) {
    clock = deps.clock;
  }
  let sleep = sleepMs;
  if (deps.sleep !== undefined) {
    sleep = deps.sleep;
  }
  const started = clock();
  const preflight = preflightResponse(req, DEFAULT_METHODS);
  if (preflight !== null) {
    return preflight;
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed." }, 405, {});
  }

  let body: SignInBody;
  try {
    const raw: unknown = await req.json();
    body = parseSignInBody(raw);
  } catch (error) {
    // Not JSON, or not the body sign-in takes: the client's fault. Anything else is ours.
    if (error instanceof SyntaxError || error instanceof ValidationError) {
      return json({ error: "Send an identifier and a password." }, 400, {});
    }
    console.error(`sign-in: reading the request body failed: ${errorText(error)}`);
    return json({ error: SIGN_IN_UNAVAILABLE }, 500, {});
  }
  const email = normalizeIdentifier(body.identifier);
  if (!isEmailIdentifier(email)) {
    return json({ error: SIGN_IN_WITH_EMAIL }, 400, {});
  }

  if (deps.key === undefined) {
    console.error("sign-in: missing environment variable SUPABASE_SERVICE_ROLE_KEY");
    return json({ error: SIGN_IN_UNAVAILABLE }, 500, {});
  }
  const client = await rateLimitKey(req, deps.clientIpHeader, deps.key, "sign-in");

  const admin = deps.admin();
  const attempt = await admin.rpc("begin_sign_in_attempt", {
    p_identifier: email,
    p_client: client,
  });
  if (attempt.error !== null) {
    console.error(`sign-in: attempt log failed: ${attempt.error.message}`);
    return json({ error: SIGN_IN_UNAVAILABLE }, 500, {});
  }
  let attempted: number | null;
  try {
    attempted = parseWith(
      attemptIdSchema,
      attempt.data,
      "handleSignIn: begin_sign_in_attempt result",
    );
  } catch (error) {
    return unavailable(error);
  }
  if (attempted === null) {
    return json({ error: TOO_MANY_ATTEMPTS }, 429, {});
  }
  const attemptId = attempted;

  // Anything but a wrong password leaves the attempt uncounted.
  async function forget(): Promise<void> {
    const result = await admin.rpc("forget_sign_in_attempt", { p_attempt_id: attemptId });
    if (result.error !== null) {
      console.error(`sign-in: forgetting an attempt failed: ${result.error.message}`);
    }
  }

  // Every wrong password waits out the floor, so the response does not reveal
  // whether the account exists.
  const auth = await deps.anon().auth.signInWithPassword({
    email,
    password: body.password,
  });
  const data = auth.data;
  const error = auth.error;
  // The error's code and status, undefined when there is no error.
  let errorCode: string | undefined;
  let errorStatus: number | undefined;
  if (error !== null) {
    errorCode = error.code;
    errorStatus = error.status;
  }
  if (errorCode === "invalid_credentials") {
    const wait = FAILED_SIGN_IN_FLOOR_MS - (clock() - started);
    if (wait > 0) {
      await sleep(wait);
    }
    return json({ error: GENERIC_SIGN_IN_ERROR }, 401, {});
  }
  await forget();
  if (errorCode === "email_not_confirmed") {
    return json({ error: EMAIL_NOT_CONFIRMED }, 403, {});
  }
  if (errorStatus === 429 || errorCode === "over_request_rate_limit") {
    return json({ error: TOO_MANY_ATTEMPTS }, 429, {});
  }
  if (error !== null || data.session === null) {
    let why = "no session";
    if (error !== null) {
      let code = error.name;
      if (error.code !== undefined) {
        code = error.code;
      }
      why = `${code}: ${error.message}`;
    }
    console.error(`sign-in: auth failed: ${why}`);
    return json({ error: SIGN_IN_UNAVAILABLE }, 500, {});
  }

  return json(
    {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in: data.session.expires_in,
    },
    200,
    {},
  );
}

/** An error's message, or the value as text when it is not an Error. */
function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** The 500 for an RPC result of the wrong shape; anything else is rethrown. */
function unavailable(error: unknown): Response {
  if (!(error instanceof ValidationError)) {
    throw error;
  }
  console.error(`sign-in: ${error.message}`);
  return json({ error: SIGN_IN_UNAVAILABLE }, 500, {});
}

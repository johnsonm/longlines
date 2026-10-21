// Sign in with a callsign or an email. Supabase Auth only knows emails, so the
// callsign is resolved server side with the service role; nothing here reveals
// whether an identifier exists.
//
// Failed attempts are limited per (identifier, client) and, more loosely, per
// identifier, in SQL (begin_sign_in_attempt). The identifier is the account's
// email once email_for_identifier resolves it, so a user's email and callsign
// share one budget; an unknown callsign is counted as typed. The client is the same HMAC of
// the caller's address that callsign-profile rate limits on (rateLimitKey), so
// a stranger guessing at a public callsign does not lock its owner out. An
// attempt is logged before the password check and forgotten again unless the
// password was wrong, so a right password (verifyPassword in the web app
// re-checks it) never counts. A wrong password is answered no sooner than
// FAILED_SIGN_IN_FLOOR_MS after the request arrived, so the time Auth takes
// (which may differ for an email with no account) does not show.

import type { SupabaseClient } from "@supabase/supabase-js";
import { json, preflightResponse } from "../cors.ts";
import {
  GENERIC_SIGN_IN_ERROR,
  normalizeIdentifier,
  parseSignInBody,
  type SignInBody,
  TOO_MANY_ATTEMPTS,
} from "../signin.ts";
import { rateLimitKey } from "./callsign_profile.ts";

export const EMAIL_NOT_CONFIRMED = "Check your email to confirm your account first.";
export const SIGN_IN_UNAVAILABLE = "Sign-in is unavailable right now.";
/** The least time a 401 takes, from the start of the request. */
export const FAILED_SIGN_IN_FLOOR_MS = 300;

export interface SignInDeps {
  /** Service-role client for the attempt log and the identifier lookup. */
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

export async function handleSignIn(req: Request, deps: SignInDeps): Promise<Response> {
  const clock = deps.clock ?? (() => performance.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = clock();
  const preflight = preflightResponse(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  let body: SignInBody;
  try {
    body = parseSignInBody(await req.json());
  } catch {
    return json({ error: "Send an identifier and a password." }, 400);
  }
  const identifier = normalizeIdentifier(body.identifier);

  if (!deps.key) {
    console.error("sign-in: missing environment variable SUPABASE_SERVICE_ROLE_KEY");
    return json({ error: SIGN_IN_UNAVAILABLE }, 500);
  }
  const client = await rateLimitKey(req, deps.clientIpHeader, deps.key, "sign-in");

  const admin = deps.admin();
  const lookup = await admin.rpc("email_for_identifier", { p_identifier: identifier });
  if (lookup.error) {
    console.error(`sign-in: lookup failed: ${lookup.error.message}`);
    return json({ error: SIGN_IN_UNAVAILABLE }, 500);
  }
  const resolved = typeof lookup.data === "string" ? lookup.data.toLowerCase() : null;

  // One budget per account: the resolved email whether the user typed it or
  // their callsign. An unknown callsign keeps its own, as typed.
  const attempt = await admin.rpc("begin_sign_in_attempt", {
    p_identifier: resolved ?? identifier,
    p_client: client,
  });
  if (attempt.error) {
    console.error(`sign-in: attempt log failed: ${attempt.error.message}`);
    return json({ error: SIGN_IN_UNAVAILABLE }, 500);
  }
  if (typeof attempt.data !== "number") return json({ error: TOO_MANY_ATTEMPTS }, 429);
  const attemptId = attempt.data;

  // Anything but a wrong password leaves the attempt uncounted.
  const forget = async () => {
    const { error } = await admin.rpc("forget_sign_in_attempt", { p_attempt_id: attemptId });
    if (error) console.error(`sign-in: forgetting an attempt failed: ${error.message}`);
  };

  // Unknown callsigns still go through a password check, and every wrong
  // password waits out the floor, so the response does not reveal whether
  // the account exists.
  const email = resolved ?? `unknown-${crypto.randomUUID()}@invalid`;

  const { data, error } = await deps.anon().auth.signInWithPassword({
    email,
    password: body.password,
  });
  if (error?.code === "invalid_credentials") {
    const wait = FAILED_SIGN_IN_FLOOR_MS - (clock() - started);
    if (wait > 0) await sleep(wait);
    return json({ error: GENERIC_SIGN_IN_ERROR }, 401);
  }
  await forget();
  if (error?.code === "email_not_confirmed") return json({ error: EMAIL_NOT_CONFIRMED }, 403);
  if (error?.status === 429 || error?.code === "over_request_rate_limit") {
    return json({ error: TOO_MANY_ATTEMPTS }, 429);
  }
  if (error || !data.session) {
    const why = error ? `${error.code ?? error.name}: ${error.message}` : "no session";
    console.error(`sign-in: auth failed: ${why}`);
    return json({ error: SIGN_IN_UNAVAILABLE }, 500);
  }

  return json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_in: data.session.expires_in,
  });
}

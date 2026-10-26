import type { SupabaseClient, User } from "@supabase/supabase-js";
import { z } from "zod";

/** The bearer token from the Authorization header, or null. */
export function bearerToken(req: Request): string | null {
  let header = req.headers.get("authorization");
  if (header === null) {
    header = "";
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (match === null) {
    return null;
  }
  const token = match[1];
  if (token === undefined) {
    return null;
  }
  return token;
}

/**
 * True when the request comes from the service role: the bearer is the runtime's
 * SUPABASE_SERVICE_ROLE_KEY, or a JWT whose role claim is service_role.
 *
 * Hosted projects now set SUPABASE_SERVICE_ROLE_KEY to the new sb_secret_ key,
 * which is not a JWT, while pg_cron has to send the legacy service-role JWT (from
 * Vault) to get past verify_jwt. The JWT's signature is not checked here, so call
 * this only from functions deployed with verify_jwt = true, where the gateway has
 * already verified it.
 */
export async function isServiceRole(
  req: Request,
  serviceRoleKey: string | undefined,
): Promise<boolean> {
  const token = bearerToken(req);
  if (token === null || token === "") {
    return false;
  }
  // Constant time, like the relay secret: the key is a long-lived credential.
  if (
    serviceRoleKey !== undefined && serviceRoleKey !== "" &&
    await secretsMatch(token, serviceRoleKey)
  ) {
    return true;
  }
  return jwtRole(token) === "service_role";
}

/** The claims of a JWT payload this module reads. */
interface JwtClaims {
  role: string;
}

// A JWT payload is third-party JSON with any number of other claims.
const jwtClaimsSchema: z.ZodType<JwtClaims> = z.looseObject({ role: z.string() });

// base64url, padding allowed at the end only.
const BASE64URL = /^[A-Za-z0-9_-]*=*$/;

/** The role claim of a JWT-shaped token, or null when it is not one. */
function jwtRole(token: string): string | null {
  const parts = token.split(".");
  const encoded = parts[1];
  if (parts.length !== 3 || encoded === undefined || encoded === "") {
    return null;
  }
  // Checked first so that atob, which throws on anything else, cannot: only base64url characters,
  // and without its padding not a length of 1 mod 4, which no padding makes decodable.
  if (!BASE64URL.test(encoded)) {
    return null;
  }
  const unpadded = encoded.replace(/=+$/, "");
  if (unpadded.length % 4 === 1) {
    return null;
  }
  const b64 = unpadded.replace(/-/g, "+").replace(/_/g, "/");
  const text = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  const claims = jwtClaimsSchema.safeParse(parseJsonOrNull(text));
  if (!claims.success) {
    return null;
  }
  return claims.data.role;
}

/**
 * JSON.parse, with null for text that is not JSON. JSON has no non-throwing parse, so this
 * keeps one catch, for SyntaxError only: a payload that is not JSON is simply not a JWT.
 */
function parseJsonOrNull(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

/** The user behind the request's bearer token, verified with the Auth server, or null. */
export async function userFromRequest(req: Request, admin: SupabaseClient): Promise<User | null> {
  const token = bearerToken(req);
  if (token === null || token === "") {
    return null;
  }
  const result = await admin.auth.getUser(token);
  if (result.error !== null) {
    return null;
  }
  return result.data.user;
}

/** Compare two secrets in time independent of where they differ. */
export async function secretsMatch(provided: string, expected: string): Promise<boolean> {
  async function digest(s: string): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  }
  const digests = await Promise.all([digest(provided), digest(expected)]);
  const a = digests[0];
  const b = digests[1];
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    let left = a[i];
    if (left === undefined) {
      left = 0;
    }
    let right = b[i];
    if (right === undefined) {
      right = 0;
    }
    diff |= left ^ right;
  }
  return diff === 0;
}

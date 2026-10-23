import type { SupabaseClient, User } from "@supabase/supabase-js";

/** The bearer token from the Authorization header, or null. */
export function bearerToken(req: Request): string | null {
  let header = req.headers.get("authorization");
  if (header === null || header === undefined) {
    header = "";
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (match === null || match === undefined) {
    return null;
  }
  const token = match[1];
  if (token === null || token === undefined) {
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

/** The role claim of a JWT-shaped token, or null when it is not one. */
function jwtRole(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1] === undefined || parts[1] === "") {
    return null;
  }
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  try {
    const payload = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="))) as {
      role?: unknown;
    };
    if (typeof payload.role === "string") {
      return payload.role;
    }
    return null;
  } catch {
    return null;
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
    if (left === null || left === undefined) {
      left = 0;
    }
    let right = b[i];
    if (right === null || right === undefined) {
      right = 0;
    }
    diff |= left ^ right;
  }
  return diff === 0;
}

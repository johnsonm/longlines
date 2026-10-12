import type { SupabaseClient, User } from "@supabase/supabase-js";

/** The bearer token from the Authorization header, or null. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? null;
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
export function isServiceRole(req: Request, serviceRoleKey: string | undefined): boolean {
  const token = bearerToken(req);
  if (!token) return false;
  if (serviceRoleKey && token === serviceRoleKey) return true;
  return jwtRole(token) === "service_role";
}

/** The role claim of a JWT-shaped token, or null when it is not one. */
function jwtRole(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  try {
    const payload = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="))) as {
      role?: unknown;
    };
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

/** The user behind the request's bearer token, verified with the Auth server, or null. */
export async function userFromRequest(req: Request, admin: SupabaseClient): Promise<User | null> {
  const token = bearerToken(req);
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  return error ? null : data.user;
}

/** Compare two secrets in time independent of where they differ. */
export async function secretsMatch(provided: string, expected: string): Promise<boolean> {
  const digest = async (s: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(provided), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

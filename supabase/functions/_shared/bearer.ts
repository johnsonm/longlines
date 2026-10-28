// The bearer token of a request, with no dependency, so the sender (whose image maps only zod and
// postgres) can read a relay token the same way the Edge Functions read theirs. auth.ts re-exports
// it.

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

// API tokens: "ll_live_" plus 52 base32 characters (a-z, 2-7), created and rotated in
// SQL (create_api_token, rotate_api_token). Only the SHA-256 is stored, so a
// request is matched by hashing the token it presents. Relay tokens (relay_token.ts)
// are hashed the same way.

import { bearerToken } from "../bearer.ts";
import { hex } from "../hmac.ts";

const TOKEN_PATTERN = /^ll_live_[a-z2-7]{52}$/;

/** The API token from the Authorization header, or null when there is none of the right shape. */
export function apiToken(req: Request): string | null {
  const token = bearerToken(req);
  if (token !== null && token !== "" && TOKEN_PATTERN.test(token)) {
    return token;
  }
  return null;
}

/** Lowercase hex SHA-256 of a token, as stored in api_tokens.token_hash and relay_tokens.token_hash. */
export async function hashApiToken(token: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
}

// Long Lines Relay's tokens: "ll_relay_" plus 52 base32 characters (a-z, 2-7), contract section 3,
// handed out once by poll_relay_pairing and stored only as the SHA-256 (hashApiToken in
// api/token.ts). relay-api (_shared/handlers/relay_api.ts) and the sender's spots stream
// (sender/cluster_stream.ts) both read a token and its authenticate_relay_token row here. No
// dependency but zod, so the sender's image (zod and postgres only) can load it.

import { z } from "zod";
import { bearerToken } from "./bearer.ts";

/** A relay token's shape (contract section 3). */
export const RELAY_TOKEN_PATTERN = /^ll_relay_[a-z2-7]{52}$/;
/** The scope the spots stream needs (contract 3.1). */
export const SPOTS_READ = "spots:read";

/** The relay token from the Authorization header, or null when there is none of the right shape. */
export function relayToken(req: Request): string | null {
  const token = bearerToken(req);
  if (token !== null && RELAY_TOKEN_PATTERN.test(token)) {
    return token;
  }
  return null;
}

/** A row of authenticate_relay_token (20261028000400_relay_pairing.sql). */
export interface RelayTokenRow {
  token_id: string;
  user_id: string;
  scopes: string[];
}

/** authenticate_relay_token's rows: none for an unknown or revoked token. Our RPC: loose. */
export const relayTokenRowsSchema: z.ZodType<RelayTokenRow[] | null> = z.array(z.looseObject({
  token_id: z.string(),
  user_id: z.string(),
  scopes: z.array(z.string()),
})).nullable();

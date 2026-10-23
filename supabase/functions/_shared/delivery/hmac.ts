// Webhook request signing: HMAC-SHA256 over "{timestamp}.{body}".

import { hmacKey, hmacSha256Hex } from "../hmac.ts";

export async function signWebhookBody(
  secret: string,
  timestamp: number,
  body: string,
): Promise<string> {
  return `sha256=${await hmacSha256Hex(await hmacKey(secret), `${String(timestamp)}.${body}`)}`;
}

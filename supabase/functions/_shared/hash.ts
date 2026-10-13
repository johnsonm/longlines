import { hex } from "./hmac.ts";

/**
 * sha256 hex of the given fields joined by "\n", in order.
 *
 * Used as raw_spots.content_hash: the fields are the upstream values that can
 * change after a spot is first published, so an edited spot gets a new hash
 * and is stored as a new row. Values are stringified exactly as upstream sent
 * them; null and undefined become "".
 */
export async function contentHash(fields: ReadonlyArray<unknown>): Promise<string> {
  const text = fields.map((v) => (v === null || v === undefined ? "" : String(v))).join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return hex(digest);
}

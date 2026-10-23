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
  const parts: string[] = [];
  for (const v of fields) {
    if (v === null || v === undefined) {
      parts.push("");
    } else {
      parts.push(upstreamText(v));
    }
  }
  const text = parts.join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return hex(digest);
}

// String() of a field as upstream sent it. The parameter is unknown on purpose:
// fields are unvalidated feed values, and narrowing them is Part 2's job.
function upstreamText(value: unknown): string {
  return String(value);
}

// Postgres text and jsonb reject U+0000, so one NUL anywhere in a batch fails the
// whole ingest_spots (or record_spot_failures) call with 22P05. Every item an
// ingest run stores goes through withoutNul first.

import type { JsonObject } from "./types.ts";

/**
 * The item with every U+0000 removed from its string values and keys, at any
 * depth. It works on values, not on serialized JSON, so the six typed
 * characters `\u0000` are ordinary text and survive unchanged.
 */
export function withoutNul(raw: JsonObject): JsonObject {
  return stripNul(raw) as JsonObject;
}

function stripNul(value: unknown): unknown {
  if (typeof value === "string") return value.replaceAll("\u0000", "");
  if (Array.isArray(value)) return value.map(stripNul);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key.replaceAll("\u0000", ""), stripNul(v)]),
    );
  }
  return value;
}

// Postgres text and jsonb reject U+0000 and a lone UTF-16 surrogate, so one of
// either anywhere in a batch fails the whole ingest_spots (or
// record_spot_failures) call. Every item an ingest run stores goes through
// withoutNul first.

import type { JsonObject } from "./types.ts";

/**
 * The item with every U+0000 removed from its string values and keys, at any
 * depth, and every lone surrogate replaced with U+FFFD (toWellFormed), so
 * Postgres can store it. A well-formed string without NUL comes back
 * unchanged, so the content hashes of storable items do not change. It works
 * on values, not on serialized JSON, so the six typed characters `\u0000` are
 * ordinary text and survive unchanged.
 */
export function withoutNul(raw: JsonObject): JsonObject {
  return stripObject(raw);
}

function storable(text: string): string {
  return text.replaceAll("\u0000", "").toWellFormed();
}

function stripNul(value: unknown): unknown {
  if (typeof value === "string") {
    return storable(value);
  }
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return items.map(stripNul);
  }
  if (typeof value === "object" && value !== null) {
    return stripObject(value);
  }
  return value;
}

function stripObject(value: object): JsonObject {
  // fromEntries, not assignment, so a "__proto__" key stays an own property.
  const entries: Array<[string, unknown]> = [];
  for (const entry of Object.entries(value)) {
    entries.push([storable(entry[0]), stripNul(entry[1])]);
  }
  return Object.fromEntries(entries);
}

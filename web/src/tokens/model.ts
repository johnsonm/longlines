import { formatDate } from "../lib/time";

/** Served by a Vercel rewrite to the `api` Edge Function (web/vercel.json). */
export const API_BASE_URL = "https://api.longlines.io/v1";
export const API_DOCS_URL = "https://github.com/sonyccd/longlines/blob/main/docs/API.md";

export const EXPIRY: Array<{ value: string; label: string; days: number | null }> = [
  { value: "never", label: "Never", days: null },
  { value: "30", label: "In 30 days", days: 30 },
  { value: "90", label: "In 90 days", days: 90 },
  { value: "365", label: "In a year", days: 365 },
];

export const EXAMPLE = `# Add callsigns to a group
curl -X POST ${API_BASE_URL}/groups/{group_id}/members \\
  -H "Authorization: Bearer ll_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{"callsigns": ["KK4PWJ", "N4DXX"]}'`;

export function scopeLabel(scope: string): string {
  return scope === "write" ? "Read and write" : "Read only";
}

export function expiresLabel(expiresAt: string | null, now: Date = new Date()): string {
  if (!expiresAt) return "Never";
  return new Date(expiresAt) <= now ? "Expired" : formatDate(expiresAt);
}

import type { RecentSpot } from "../lib/api";

export function spotReference(s: RecentSpot): string {
  return s.pota_reference ?? s.sota_summit_ref ?? s.wwff_reference ?? s.wwbota_references?.[0] ?? s.iota_reference ?? "";
}

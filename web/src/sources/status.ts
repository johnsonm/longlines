import type { IngestHealth } from "../lib/api";
import type { SourceInfo } from "./sources";

export type SourceStatus = "connected" | "delayed" | "planned";

export const STATUS_LABEL: Record<SourceStatus, string> = {
  connected: "Connected",
  delayed: "Delayed",
  planned: "Not yet available",
};

/**
 * A live source is delayed when its last success is missing or older than
 * three poll intervals. Unknown health (null: not loaded, or failed) shows
 * a live source as connected rather than alarming on our own error.
 */
export function sourceStatus(source: SourceInfo, health: IngestHealth[] | null): SourceStatus {
  if (source.status !== "live") return "planned";
  if (health === null || source.pollSeconds === null) return "connected";
  const age = health.find((h) => h.source === source.id)?.seconds_since_last_success ?? null;
  return age === null || age > 3 * source.pollSeconds ? "delayed" : "connected";
}

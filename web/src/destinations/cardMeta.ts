import type { Destination } from "../lib/api";
import { timeAgo } from "../lib/time";

/** "used by 2 subscriptions · Last delivery 3 minutes ago", per the page 5 copy. */
export function cardMeta(dest: Destination, usedBy: number, now: Date = new Date()): string {
  const usage = usedBy > 0 ? `used by ${usedBy} subscription${usedBy === 1 ? "" : "s"}` : "not used by any subscription";
  const failedLast = dest.last_error_at !== null && (dest.last_success_at === null || dest.last_error_at > dest.last_success_at);
  const last = failedLast
    ? `Last delivery failed ${timeAgo(dest.last_error_at!, now)}`
    : dest.last_success_at
    ? `Last delivery ${timeAgo(dest.last_success_at, now)}`
    : "Never used";
  return `${usage} · ${last}`;
}

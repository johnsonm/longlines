import type { Destination, PushDevice } from "../lib/api";
import { timeAgo } from "../lib/time";

/**
 * "Used by 2 connections · Last delivery 3 minutes ago" for every type, as the
 * webhook spec's decision 17 capitalizes it (CLAUDE.md: a subscription is a
 * connection to users), then " · 140 waiting" while spots wait to be sent
 * (list_destination_queues; outbound sender Phase 2 spec, Copy).
 */
export function cardMeta(dest: Destination, usedBy: number, waiting: number, now: Date = new Date()): string {
  const usage = usedBy > 0 ? `Used by ${usedBy} connection${usedBy === 1 ? "" : "s"}` : "Not used by any connection";
  const failedLast = dest.last_error_at !== null && (dest.last_success_at === null || dest.last_error_at > dest.last_success_at);
  const last = failedLast
    ? `Last delivery failed ${timeAgo(dest.last_error_at!, now)}`
    : dest.last_success_at
    ? `Last delivery ${timeAgo(dest.last_success_at, now)}`
    : "Never used";
  return waiting > 0 ? `${usage} · ${last} · ${waiting} waiting` : `${usage} · ${last}`;
}

/** A device row's caption: "{agent}[, installed app] · last delivery {age} ago" and its two variants, per page 5. */
export function deviceCaption(device: PushDevice, now: Date = new Date()): string {
  const agent = `${device.agent}${device.standalone ? ", installed app" : ""}`;
  if (device.blocked_at !== null) return `${agent} · notifications blocked in this browser`;
  if (device.last_success_at === null) return `${agent} · no deliveries yet`;
  return `${agent} · last delivery ${timeAgo(device.last_success_at, now)}`;
}

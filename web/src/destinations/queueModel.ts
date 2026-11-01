import type { DestinationQueue } from "../lib/api";
import { durationWords } from "../lib/time";

// Words for the backed-up banner, the Clear queue dialog and its toast (outbound sender Phase 2
// spec, Copy). Every figure and the backed-up call come from list_destination_queues and
// clear_destination_queue; this only words them.

function spots(n: number): string {
  return `${n} spot${n === 1 ? "" : "s"}`;
}

/** "{name} is backed up". */
export function backedUpTitle(name: string): string {
  return `${name} is backed up`;
}

/** "140 spots are waiting to be sent, the oldest for 14 minutes. Narrow the connections ...". */
export function backedUpBody(queue: DestinationQueue): string {
  const advice = "Narrow the connections that send to it, or clear the queue.";
  const age = queue.oldest_waiting_seconds === null ? null : durationWords(queue.oldest_waiting_seconds);
  if (queue.waiting === 1) {
    return age === null
      ? `1 spot is waiting to be sent. ${advice}`
      : `1 spot has been waiting to be sent for ${age}. ${advice}`;
  }
  const head = `${spots(queue.waiting)} are waiting to be sent`;
  return age === null ? `${head}. ${advice}` : `${head}, the oldest for ${age}. ${advice}`;
}

/** "Clear the queue for {name}?". */
export function clearTitle(name: string): string {
  return `Clear the queue for ${name}?`;
}

/** The dialog's first line: how many spots go. */
export function clearBody(waiting: number): string {
  return `${spots(waiting)} waiting to be sent will be dropped.`;
}

/** The dialog's second line: what stays. */
export const CLEAR_KEEPS = "Spots already being sent, or waiting to be retried, are not affected. New spots keep coming.";

/** "Cleared 140 spots from {name}", or "Nothing to clear". */
export function clearedToast(cleared: number, name: string): string {
  return cleared === 0 ? "Nothing to clear" : `Cleared ${spots(cleared)} from ${name}`;
}

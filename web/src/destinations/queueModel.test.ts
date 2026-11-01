import { describe, expect, it } from "vitest";
import type { DestinationQueue } from "../lib/api";
import { backedUpBody, backedUpTitle, clearBody, clearedToast, clearTitle } from "./queueModel";

function queue(waiting: number, oldest: number | null): DestinationQueue {
  return { destination_id: "d1", waiting, oldest_waiting_seconds: oldest, dropped_24h: 0, backed_up: true };
}

const ADVICE = "Narrow the connections that send to it, or clear the queue.";

describe("queueModel", () => {
  it("words the backed-up banner", () => {
    expect(backedUpTitle("Club hook")).toBe("Club hook is backed up");
    expect(backedUpBody(queue(140, 840))).toBe(`140 spots are waiting to be sent, the oldest for 14 minutes. ${ADVICE}`);
    expect(backedUpBody(queue(1, 660))).toBe(`1 spot has been waiting to be sent for 11 minutes. ${ADVICE}`);
    expect(backedUpBody(queue(1, null))).toBe(`1 spot is waiting to be sent. ${ADVICE}`);
    expect(backedUpBody(queue(100, null))).toBe(`100 spots are waiting to be sent. ${ADVICE}`);
  });

  it("words the dialog and the toast", () => {
    expect(clearTitle("Club hook")).toBe("Clear the queue for Club hook?");
    expect(clearBody(140)).toBe("140 spots waiting to be sent will be dropped.");
    expect(clearBody(1)).toBe("1 spot waiting to be sent will be dropped.");
    expect(clearedToast(140, "Club hook")).toBe("Cleared 140 spots from Club hook");
    expect(clearedToast(1, "Club hook")).toBe("Cleared 1 spot from Club hook");
    expect(clearedToast(0, "Club hook")).toBe("Nothing to clear");
  });
});

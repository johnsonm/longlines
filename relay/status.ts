// The relay's heartbeat for the Health page: every STATUS_MS (first at start),
// POST relay-status with the process start time, its RSS, its reconnects since
// start and each feed's connection. The feeds' own pushes already say when each
// last delivered; this says the process is alive, how big it is and how often
// it has had to reconnect. Best effort: a failed post is logged and the next
// one goes out on time.

import type { SessionStatus } from "./telnet.ts";

export const STATUS_MS = 60_000;

export interface StatusFeed {
  id: string;
  status: SessionStatus;
}

/** One feed's connection in the heartbeat. */
export interface RelayStatusFeed {
  id: string;
  connected: boolean;
}

/** The relay-status request body (the handler's strict schema in handlers/relay_status.ts). */
export interface RelayStatusBody {
  started_at: string;
  rss_bytes: number;
  reconnects: number;
  feeds: RelayStatusFeed[];
}

/** Every connect after a feed's first is a reconnect. */
export function statusBody(
  feeds: readonly StatusFeed[],
  startedAt: Date,
  rss: number,
): RelayStatusBody {
  let reconnects = 0;
  for (const f of feeds) {
    reconnects = reconnects + Math.max(f.status.connects - 1, 0);
  }
  return {
    started_at: startedAt.toISOString(),
    rss_bytes: rss,
    reconnects,
    feeds: feeds.map((f) => ({ id: f.id, connected: f.status.connected })),
  };
}

export interface StatusLoop {
  feeds: readonly StatusFeed[];
  startedAt: Date;
  post: (body: unknown, signal: AbortSignal | undefined) => Promise<unknown>;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  log: (message: string) => void;
  intervalMs?: number;
  /** Resident set size in bytes (tests pass a constant). */
  rss?: () => number;
}

// TypeScript keeps `signal.aborted` narrowed across awaits after a check; this reads it afresh.
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function processRss(): number {
  return Deno.memoryUsage().rss;
}

export async function runStatusLoop(loop: StatusLoop): Promise<void> {
  let rss = processRss;
  if (loop.rss !== undefined) {
    rss = loop.rss;
  }
  let intervalMs = STATUS_MS;
  if (loop.intervalMs !== undefined) {
    intervalMs = loop.intervalMs;
  }
  while (!loop.signal.aborted) {
    try {
      await loop.post(statusBody(loop.feeds, loop.startedAt, rss()), loop.signal);
    } catch (error) {
      // The heartbeat boundary: a failed post is logged, never retried; the next one goes out on
      // time. Anything that is not an Error is thrown.
      if (!(error instanceof Error)) {
        throw error;
      }
      if (!isAborted(loop.signal)) {
        loop.log(`[status] ${error.message}`);
      }
    }
    await loop.sleep(intervalMs, loop.signal);
  }
}

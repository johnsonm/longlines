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

export interface RelayStatusBody {
  started_at: string;
  rss_bytes: number;
  reconnects: number;
  feeds: Array<{ id: string; connected: boolean }>;
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
  post: (body: unknown, signal?: AbortSignal) => Promise<unknown>;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  log: (message: string) => void;
  intervalMs?: number;
  /** Resident set size in bytes (tests pass a constant). */
  rss?: () => number;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function processRss(): number {
  return Deno.memoryUsage().rss;
}

export async function runStatusLoop(loop: StatusLoop): Promise<void> {
  let rss = processRss;
  if (loop.rss !== undefined && loop.rss !== null) {
    rss = loop.rss;
  }
  let intervalMs = STATUS_MS;
  if (loop.intervalMs !== undefined && loop.intervalMs !== null) {
    intervalMs = loop.intervalMs;
  }
  while (!loop.signal.aborted) {
    try {
      await loop.post(statusBody(loop.feeds, loop.startedAt, rss()), loop.signal);
    } catch (error) {
      if (!loop.signal.aborted) {
        loop.log(`[status] ${errorMessage(error)}`);
      }
    }
    await loop.sleep(intervalMs, loop.signal);
  }
}

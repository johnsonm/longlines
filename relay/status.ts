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
  return {
    started_at: startedAt.toISOString(),
    rss_bytes: rss,
    reconnects: feeds.reduce((n, f) => n + Math.max(f.status.connects - 1, 0), 0),
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

export async function runStatusLoop(loop: StatusLoop): Promise<void> {
  const rss = loop.rss ?? (() => Deno.memoryUsage().rss);
  while (!loop.signal.aborted) {
    try {
      await loop.post(statusBody(loop.feeds, loop.startedAt, rss()), loop.signal);
    } catch (error) {
      if (!loop.signal.aborted) {
        loop.log(`[status] ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await loop.sleep(loop.intervalMs ?? STATUS_MS, loop.signal);
  }
}

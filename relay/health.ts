// GET /healthz for Fly's health check: 200 while every feed has received data
// recently (or is still inside its startup grace period), 503 otherwise. The
// body is a small status report for `fly checks list` and manual curl.

import type { SessionStatus } from "./telnet.ts";

export interface FeedHealth {
  id: string;
  status: SessionStatus;
  dropped: () => number;
  buffered: () => number;
  pushed: () => number;
  /** Overrides the handler's staleMs for this feed. */
  staleMs?: number;
}

/** One feed in the /healthz body. */
interface FeedReport {
  id: string;
  healthy: boolean;
  connected: boolean;
  connects: number;
  last_data_at: string | null;
  dropped: number;
  buffered: number;
  pushed: number;
}

/** The /healthz body. */
interface HealthReport {
  healthy: boolean;
  feeds: FeedReport[];
}

export function healthHandler(
  feeds: readonly FeedHealth[],
  startedAt: Date,
  staleMs: number,
  now: () => Date,
): (req: Request) => Response {
  function feedReport(f: FeedHealth, t: number): FeedReport {
    let last = startedAt;
    let lastDataAt: string | null = null;
    if (f.status.lastDataAt !== null) {
      last = f.status.lastDataAt;
      lastDataAt = f.status.lastDataAt.toISOString();
    }
    let feedStaleMs = staleMs;
    if (f.staleMs !== undefined) {
      feedStaleMs = f.staleMs;
    }
    return {
      id: f.id,
      healthy: t - last.getTime() < feedStaleMs,
      connected: f.status.connected,
      connects: f.status.connects,
      last_data_at: lastDataAt,
      dropped: f.dropped(),
      buffered: f.buffered(),
      pushed: f.pushed(),
    };
  }

  function handler(req: Request): Response {
    if (new URL(req.url).pathname !== "/healthz") {
      return new Response("not found", { status: 404 });
    }
    const t = now().getTime();
    const report = feeds.map((f) => feedReport(f, t));
    const healthy = report.every((r) => r.healthy);
    let status = 503;
    if (healthy) {
      status = 200;
    }
    const body: HealthReport = { healthy, feeds: report };
    return Response.json(body, { status });
  }
  return handler;
}

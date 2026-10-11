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
}

export function healthHandler(
  feeds: readonly FeedHealth[],
  startedAt: Date,
  staleMs: number,
  now: () => Date = () => new Date(),
): (req: Request) => Response {
  return (req: Request): Response => {
    if (new URL(req.url).pathname !== "/healthz") return new Response("not found", { status: 404 });
    const t = now().getTime();
    const report = feeds.map((f) => {
      const last = f.status.lastDataAt ?? startedAt;
      return {
        id: f.id,
        healthy: t - last.getTime() < staleMs,
        connected: f.status.connected,
        connects: f.status.connects,
        last_data_at: f.status.lastDataAt?.toISOString() ?? null,
        dropped: f.dropped(),
        buffered: f.buffered(),
        pushed: f.pushed(),
      };
    });
    const healthy = report.every((r) => r.healthy);
    return Response.json({ healthy, feeds: report }, { status: healthy ? 200 : 503 });
  };
}

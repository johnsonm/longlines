// GET /healthz for Fly's health check: 200 while the cycle's last progress (a
// successful claim, a finished send or a successful bookkeeping RPC; the start
// before any) is under staleMs old, 503 otherwise. A 503 restarts nothing; the
// watchdog in sender.ts exits the process on the same threshold. The body is
// the operator's status report for `fly checks list` and manual curl: what the
// loop has done and, from SQL, the queue depth and the spots expired
// undelivered in the last hour.

export interface SenderTotals {
  cycles: number;
  claimed: number;
  sent: number;
  failed: number;
  throttled: number;
  skipped_paused: number;
  /** Bookkeeping RPCs that failed inside a cycle. */
  errors: number;
}

export interface QueueStats {
  depth: number;
  expired_last_hour: number;
}

export interface SenderStatus {
  startedAt: Date;
  lastClaimAt: Date | null;
  /** The last claim, finished send or successful bookkeeping RPC; what staleMs is measured from. */
  lastProgressAt: Date | null;
  lastError: string | null;
  /** A cycle is between claim and the last mark. */
  inFlight: boolean;
  totals: SenderTotals;
  /** Null until the first delivery_queue_stats() call succeeds. */
  queue: QueueStats | null;
}

export function healthHandler(
  status: () => SenderStatus,
  staleMs: number,
  now: () => Date = () => new Date(),
): (req: Request) => Response {
  return (req: Request): Response => {
    if (new URL(req.url).pathname !== "/healthz") return new Response("not found", { status: 404 });
    const s = status();
    const last = s.lastProgressAt ?? s.startedAt;
    const healthy = now().getTime() - last.getTime() < staleMs;
    return Response.json({
      healthy,
      last_claim_at: s.lastClaimAt?.toISOString() ?? null,
      last_progress_at: s.lastProgressAt?.toISOString() ?? null,
      last_error: s.lastError,
      in_flight: s.inFlight,
      totals: s.totals,
      queue: s.queue,
    }, { status: healthy ? 200 : 503 });
  };
}

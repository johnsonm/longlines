// A health payload for tests: everything Healthy, 48 half-hour buckets ending
// at 2026-10-21 12:00Z. Override what a test is about.

import type { HealthChecks, HealthPayload } from "../health/types";

const N = 48;
const flat = (v: number | null) => Array.from({ length: N }, () => v);

export function healthChecks(over: Partial<HealthChecks> = {}): HealthChecks {
  return {
    pulled: {
      status: "healthy",
      sources: [{ source: "pota", seconds: 12 }, { source: "sotawatch", seconds: 22 }, { source: "wwbota", seconds: 9 }, { source: "wwff", seconds: 5 }],
    },
    relay: { status: "healthy", feeds: [{ source: "dxcluster", seconds: 41 }, { source: "rbn", seconds: 3 }], reconnects_24h: 0 },
    match_queue: { status: "healthy", waiting: 9, oldest_seconds: 3 },
    delivery_queue: { status: "healthy", waiting: 12, oldest_ready_seconds: 4, throttled: 0 },
    sender: { status: "healthy", progress_seconds: 6, restarts_24h: 0, memory_bytes: 92 * 1024 * 1024 },
    database: { status: "healthy", connections: 38, max_connections: 60, bytes: 0.61 * 8 * 1024 ** 3, disk_limit_bytes: 8 * 1024 ** 3 },
    jobs: { status: "healthy", count: 10, failed_1h: 0 },
    archive: { status: "healthy", seconds: 360 },
    ...over,
  };
}

export function healthPayload(over: Partial<HealthPayload> = {}): HealthPayload {
  return {
    range: "24h",
    start: "2026-10-20T12:30:00Z",
    bucket_seconds: 1800,
    generated_at: "2026-10-21T11:57:08Z",
    checks: healthChecks(),
    limits: { match_batch: 500, oldest_ready_seconds: 120, max_connections: 60, worker_memory_bytes: 256 * 1024 * 1024 },
    series: {
      match_waiting: flat(9),
      delivery_waiting: flat(12),
      oldest_ready_seconds: flat(4),
      connections: flat(38),
      db_bytes: flat(0.61 * 8 * 1024 ** 3),
      failed: flat(0),
      expired: flat(0),
      latency_p50: flat(8),
      latency_p95: flat(36),
      spots: { pota: flat(80), sotawatch: flat(20), wwff: flat(10), wwbota: flat(0), dxcluster: flat(0) },
      sender_memory: flat(92 * 1024 * 1024),
      relay_memory: flat(20 * 1024 * 1024),
    },
    jobs: [
      {
        name: "ingest-sotawatch", schedule: "30 seconds", last_run_at: "2026-10-21T11:57:04Z",
        result: { ok: true, http_status: 200, timed_out: false, seconds: 0.4 }, status: "healthy", failed_24h: 0, failed_1h: 0,
        timing: { runs: 2880, failed: 1, average: 0.42, sd: 0.11, p95: 0.61 }, unusual: null,
      },
      {
        name: "refresh-stats-snapshot", schedule: "5 * * * *", last_run_at: "2026-10-21T11:05:00Z",
        result: { ok: true, http_status: null, timed_out: false, seconds: 0.6 }, status: "healthy", failed_24h: 0, failed_1h: 0,
      },
    ],
    ...over,
  };
}

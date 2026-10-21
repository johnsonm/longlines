// The health function's payload: cached_health(range) / health_snapshot(range)
// in 20261021000100_health.sql (job timings 20261021000400), pinned by supabase/tests/health_snapshot.test.sql.
// Change the SQL, this type and the test together.

export type HealthRange = "1h" | "24h" | "7d";

/** Every status is decided in SQL; `unknown` means nothing has reported yet. */
export type HealthStatus = "healthy" | "delayed" | "failing" | "unknown";

/** Seconds since a source last succeeded (pulled) or the relay last pushed it; null if never. */
export interface SourceAge {
  source: string;
  seconds: number | null;
}

export interface HealthChecks {
  pulled: { status: HealthStatus; sources: SourceAge[] };
  relay: { status: HealthStatus; feeds: SourceAge[]; reconnects_24h: number | null };
  match_queue: { status: HealthStatus; waiting: number; oldest_seconds: number | null };
  delivery_queue: { status: HealthStatus; waiting: number; oldest_ready_seconds: number | null; throttled: number };
  sender: { status: HealthStatus; progress_seconds: number | null; restarts_24h: number | null; memory_bytes: number | null };
  database: { status: HealthStatus; connections: number; max_connections: number; bytes: number; disk_limit_bytes: number };
  /** delayed while any job is unusual; `unusual` (the count) is absent before 20261021000400. */
  jobs: { status: HealthStatus; count: number; failed_1h: number; unusual?: number };
  archive: { status: HealthStatus; seconds: number | null };
}

export type CheckId = keyof HealthChecks;

/** Over the range shown. Times are successful runs' seconds; null without two (sd) or one. */
export interface JobTiming {
  runs: number;
  failed: number;
  average: number | null;
  sd: number | null;
  p95: number | null;
}

/**
 * The last hour against the 7 days before it: `failures` is 3 or more failed
 * runs, far above the usual rate; `slow` is an average 3 sd and a second over.
 */
export type JobUnusual = "failures" | "slow";

export interface HealthJob {
  name: string;
  /** pg_cron's schedule as written: a cron expression or "N seconds". */
  schedule: string;
  last_run_at: string | null;
  /** The latest finished run; null when none in the last 8 days. Seconds are a function's own run time. */
  result: { ok: boolean; http_status: number | null; timed_out: boolean; seconds: number | null } | null;
  /** delayed: the last run failed; failing: the last 3 did. */
  status: HealthStatus;
  failed_24h: number;
  failed_1h: number;
  /** Absent before 20261021000400 is applied. */
  timing?: JobTiming;
  unusual?: JobUnusual | null;
}

/** One value per bucket, oldest first; null where nothing was recorded. */
export type Series = (number | null)[];

export interface HealthPayload {
  range: HealthRange;
  /** The first bucket's start; bucket i starts bucket_seconds * i later. */
  start: string;
  bucket_seconds: number;
  generated_at: string;
  checks: HealthChecks;
  limits: { match_batch: number; oldest_ready_seconds: number; max_connections: number; worker_memory_bytes: number };
  series: {
    match_waiting: Series;
    delivery_waiting: Series;
    oldest_ready_seconds: Series;
    connections: Series;
    /** pg_database_size, each bucket's largest sample. */
    db_bytes: Series;
    failed: Series;
    expired: Series;
    latency_p50: Series;
    latency_p95: Series;
    spots: { pota: Series; sotawatch: Series; wwff: Series; dxcluster: Series };
    sender_memory: Series;
    relay_memory: Series;
  };
  jobs: HealthJob[];
}

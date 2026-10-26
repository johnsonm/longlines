// Words for the Health page. Every status and figure is SQL's (health_snapshot);
// this module only says them, in the copy of the spec's Copy section.

import type { CheckId, HealthChecks, HealthJob, HealthPayload, HealthRange, HealthStatus, JobUnusual, Series, SourceAge } from "./types";

export const RANGES: { id: HealthRange; label: string }[] = [
  { id: "1h", label: "1 hour" },
  { id: "24h", label: "24 hours" },
  { id: "7d", label: "7 days" },
];

/** Table order, which is also the banner's. */
export const CHECKS: { id: CheckId; name: string; caption?: string; rule: string; title: string; delayedTitle?: string }[] = [
  { id: "pulled", name: "Pulled sources", caption: "POTA, SOTAwatch, WWFF, WWBOTA", rule: "Delayed after 3 min without a success", title: "Pulled sources are behind" },
  { id: "relay", name: "Relay feeds", caption: "RBN, DX Cluster, APRS-IS", rule: "Delayed after 3 min without a push", title: "A relay feed is behind" },
  { id: "match_queue", name: "Match queue", caption: "spot_events", rule: "Delayed when the oldest waits over 2 min", title: "Matching is behind" },
  { id: "delivery_queue", name: "Delivery queue", caption: "deliveries_queue", rule: "Delayed when the oldest ready waits over 2 min", title: "Outbound is slower than usual" },
  { id: "sender", name: "Sender", caption: "Fly.io, longlines-sender", rule: "Failing after 2 min without progress", title: "The sender has stopped" },
  { id: "database", name: "Database", rule: "Delayed over 80% of either", title: "The database is nearly full" },
  {
    id: "jobs", name: "Scheduled jobs",
    rule: "Failing when a job fails 3 runs in a row; delayed when one is slower or fails more than usual",
    title: "A scheduled job keeps failing", delayedTitle: "A scheduled job is not running as usual",
  },
  { id: "archive", name: "Archive", rule: "Delayed after 2 hours", title: "The archive is behind" },
];

/** The count charts' captions start with the bucket, which follows the range. */
export const BUCKET_TEXT: Record<HealthRange, string> = {
  "1h": "Per minute.",
  "24h": "Per 30 minutes.",
  "7d": "Per 3 hours.",
};

export const STATUS_LABEL: Record<HealthStatus, string> = {
  healthy: "Healthy",
  delayed: "Delayed",
  failing: "Failing",
  unknown: "No data",
};

/** A job's chip: its "delayed" is one failed run, not a delay. */
export const JOB_STATUS_LABEL: Record<HealthStatus, string> = { ...STATUS_LABEL, delayed: "Last run failed" };

/** A job's second chip, from SQL's comparison of the last hour with the 7 days before it. */
export const JOB_UNUSUAL_LABEL: Record<JobUnusual, string> = {
  slow: "Slower than usual",
  failures: "Failing more than usual",
};

const SOURCE_NAMES: Record<string, string> = {
  pota: "POTA",
  sotawatch: "SOTAwatch",
  wwff: "WWFF",
  wwbota: "WWBOTA",
  rbn: "RBN",
  dxcluster: "DX Cluster",
  aprs: "APRS-IS",
};

export const sourceName = (source: string): string => SOURCE_NAMES[source] ?? source;

const plural = (n: number, one: string, many: string = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** "22 s", "4 min", "13 h", "3 d": the largest whole unit. */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 2 * 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

/** The oldest age, or which sources never reported. */
function oldest(ages: SourceAge[], verb: string): string {
  const never = ages.filter((a) => a.seconds === null).map((a) => sourceName(a.source));
  if (never.length > 0) return `No ${verb} yet from ${never.join(", ")}`;
  const worst = Math.max(...ages.map((a) => a.seconds ?? 0));
  return `Last ${verb} ${duration(worst)} ago`;
}

export const mb = (bytes: number): number => Math.round(bytes / (1024 * 1024));

/** Gigabytes to two places, for the storage chart. */
export const gb = (bytes: number): number => Math.round((bytes / 1024 ** 3) * 100) / 100;

/** The Now column. */
export function checkNow(id: CheckId, checks: HealthChecks): string {
  switch (id) {
    case "pulled":
      return oldest(checks.pulled.sources, "success");
    case "relay": {
      const { feeds, reconnects_24h } = checks.relay;
      if (feeds.length === 0) return "No data";
      const last = oldest(feeds, "push");
      return reconnects_24h === null ? last : `${last} · ${plural(reconnects_24h, "reconnect")} in 24 h`;
    }
    case "match_queue": {
      const { waiting, oldest_seconds } = checks.match_queue;
      const head = `${waiting.toLocaleString("en-US")} waiting`;
      return oldest_seconds === null ? head : `${head} · oldest ${duration(oldest_seconds)}`;
    }
    case "delivery_queue": {
      const { waiting, oldest_ready_seconds, throttled } = checks.delivery_queue;
      const parts = [`${waiting.toLocaleString("en-US")} waiting`];
      if (oldest_ready_seconds !== null) parts.push(`oldest ready ${duration(oldest_ready_seconds)}`);
      if (throttled > 0) parts.push(`${plural(throttled, "destination")} throttled`);
      return parts.join(" · ");
    }
    case "sender": {
      const { progress_seconds, restarts_24h } = checks.sender;
      if (progress_seconds === null) return "No data";
      const last = `Last progress ${duration(progress_seconds)} ago`;
      return restarts_24h === null ? last : `${last} · ${plural(restarts_24h, "restart")} in 24 h`;
    }
    case "database": {
      const { connections, max_connections, bytes, disk_limit_bytes } = checks.database;
      return `${connections} of ${max_connections} connections · disk ${Math.round((100 * bytes) / disk_limit_bytes)}% full`;
    }
    case "jobs": {
      const head = `${plural(checks.jobs.count, "job")} · ${plural(checks.jobs.failed_1h, "failed run")} in the last hour`;
      const unusual = checks.jobs.unusual ?? 0;
      return unusual > 0 ? `${head} · ${plural(unusual, "job")} not running as usual` : head;
    }
    case "archive":
      return checks.archive.seconds === null ? "Nothing written yet" : `Last slice written ${duration(checks.archive.seconds)} ago`;
  }
}

export interface Banner {
  severity: "warning" | "error";
  title: string;
  body: string;
  /** "N checks need attention." when more than one does. */
  more: string | null;
}

/** The first check in table order that is Delayed or Failing; null when none is. */
export function banner(checks: HealthChecks): Banner | null {
  const bad = CHECKS.filter((c) => checks[c.id].status === "delayed" || checks[c.id].status === "failing");
  const first = bad[0];
  if (!first) return null;
  return {
    severity: bad.some((c) => checks[c.id].status === "failing") ? "error" : "warning",
    title: checks[first.id].status === "delayed" ? first.delayedTitle ?? first.title : first.title,
    body: checkNow(first.id, checks),
    more: bad.length > 1 ? `${bad.length} checks need attention.` : null,
  };
}

const WEEKDAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const two = (n: string) => n.padStart(2, "0");

/** pg_cron's schedule in words; anything unusual is shown as written. */
export function scheduleText(schedule: string): string {
  const seconds = /^(\d+) seconds?$/.exec(schedule);
  if (seconds) return `Every ${seconds[1]} s`;
  const f = schedule.trim().split(/\s+/);
  if (f.length !== 5) return schedule;
  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];
  if (dom !== "*" || mon !== "*") return schedule;
  if (hour === "*" && dow === "*") {
    if (min === "*") return "Every minute";
    const step = /^(?:\*|\d+-59)\/(\d+)$/.exec(min);
    if (step) return `Every ${step[1]} min`;
    if (/^\d+$/.test(min)) return `Hourly at :${two(min)}`;
    return schedule;
  }
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour)) return schedule;
  const at = `${two(hour)}:${two(min)} UTC`;
  if (dow === "*") return `Daily at ${at}`;
  const day = /^[0-6]$/.test(dow) ? WEEKDAYS[Number(dow)] : undefined;
  return day ? `${day} at ${at}` : schedule;
}

/** A statistics cell: two places under 10 s, so sub-second jobs still differ, then one; a dash when none. */
export function runSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "–";
  return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`;
}

/** The Last result caption. */
export function resultText(result: HealthJob["result"]): string {
  if (!result) return "No runs yet";
  if (result.timed_out) return "Timed out";
  if (result.http_status !== null) {
    return result.seconds === null ? `HTTP ${result.http_status}` : `HTTP ${result.http_status} in ${result.seconds.toFixed(1)} s`;
  }
  if (!result.ok) return "Failed";
  return `Done in ${(result.seconds ?? 0).toFixed(1)} s`;
}

export function lastRunText(lastRunAt: string | null, now: Date): string {
  if (lastRunAt === null) return "Never";
  return `${duration((now.getTime() - Date.parse(lastRunAt)) / 1000)} ago`;
}

/** Each bucket's start, oldest first. */
export function bucketTimes(payload: Pick<HealthPayload, "start" | "bucket_seconds">, count: number): Date[] {
  const start = Date.parse(payload.start);
  return Array.from({ length: count }, (_, i) => new Date(start + i * payload.bucket_seconds * 1000));
}

const TIME = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const DAY = new Intl.DateTimeFormat("en-US", { weekday: "short", day: "numeric" });
const STAMP = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

/** Axis ticks in local time: hours and minutes, or the day for 7 days. */
export function tickLabel(range: HealthRange, d: Date): string {
  return range === "7d" ? DAY.format(d) : TIME.format(d);
}

/** Tooltip time: the bucket's local start, with the day for 7 days. */
export function bucketLabel(range: HealthRange, d: Date): string {
  return range === "7d" ? `${DAY.format(d)}, ${TIME.format(d)}` : TIME.format(d);
}

export const updatedText = (generatedAt: string): string => `Updated ${STAMP.format(new Date(generatedAt))}`;

/** The last bucket with a value, or null. */
export function latest(series: Series): number | null {
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const v = series[i];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

/** An axis top that keeps a limit line in view with room above it. */
export function axisMax(series: Series, limit: number): number {
  const top = Math.max(0, ...series.map((v) => v ?? 0));
  return Math.max(top, limit) * 1.2;
}

/** Sources with spots in any of the last three buckets (the newest is still filling). */
export function sourcesReporting(spots: HealthPayload["series"]["spots"]): number {
  return Object.values(spots).filter((s) => s.slice(-3).some((v) => (v ?? 0) > 0)).length;
}

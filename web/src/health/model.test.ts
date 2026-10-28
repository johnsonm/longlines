import { describe, expect, it } from "vitest";
import { healthChecks, healthPayload } from "../test/health";
import {
  axisMax, banner, bucketLabel, bucketTimes, CHECKS, checkNow, duration, gb, lastRunText, latest, mb, resultText, runSeconds, scheduleText,
  sourceName, sourcesReporting, tickLabel, updatedText,
} from "./model";

describe("duration", () => {
  it("uses the largest whole unit", () => {
    expect([0, 22.7, 59, 60, 240, 3599, 3600, 13 * 3600, 2 * 86400 - 1, 2 * 86400, -5].map(duration)).toEqual([
      "0 s", "22 s", "59 s", "1 min", "4 min", "59 min", "1 h", "13 h", "47 h", "2 d", "0 s",
    ]);
  });
});

describe("checkNow", () => {
  const now = (over = {}) => {
    const checks = healthChecks(over);
    return Object.fromEntries(CHECKS.map((c) => [c.id, checkNow(c.id, checks)]));
  };

  it("words every check as the canvas does", () => {
    expect(now()).toEqual({
      pulled: "Last success 22 s ago",
      inbound: "Last push 41 s ago · 0 reconnects in 24 h",
      match_queue: "9 waiting · oldest 3 s",
      delivery_queue: "12 waiting · oldest ready 4 s",
      sender: "Last progress 6 s ago · 0 restarts in 24 h",
      database: "38 of 60 connections · disk 61% full",
      jobs: "10 jobs · 0 failed runs in the last hour",
      archive: "Last slice written 6 min ago",
    });
  });

  it("names sources that never reported, and leaves out what is unknown", () => {
    expect(now({
      pulled: { status: "delayed", sources: [{ source: "pota", seconds: 1 }, { source: "wwff", seconds: null }] },
      inbound: { status: "healthy", feeds: [{ source: "aprs", seconds: null }], reconnects_24h: null },
      match_queue: { status: "healthy", waiting: 0, oldest_seconds: null },
      delivery_queue: { status: "delayed", waiting: 1234, oldest_ready_seconds: null, throttled: 1 },
      sender: { status: "unknown", progress_seconds: null, restarts_24h: null, memory_bytes: null },
      jobs: { status: "failing", count: 1, failed_1h: 1 },
      archive: { status: "delayed", seconds: null },
    })).toMatchObject({
      pulled: "No success yet from WWFF",
      inbound: "No push yet from APRS-IS",
      match_queue: "0 waiting",
      delivery_queue: "1,234 waiting · 1 destination throttled",
      sender: "No data",
      jobs: "1 job · 1 failed run in the last hour",
      archive: "Nothing written yet",
    });
  });

  it("says No data when the inbound worker has no feeds, and drops unknown restarts and reconnects", () => {
    expect(now({
      inbound: { status: "unknown", feeds: [], reconnects_24h: null },
      sender: { status: "healthy", progress_seconds: 5, restarts_24h: null, memory_bytes: 1 },
    })).toMatchObject({ inbound: "No data", sender: "Last progress 5 s ago" });
    expect(now({ inbound: { status: "healthy", feeds: [{ source: "rbn", seconds: 200 }], reconnects_24h: null } }).inbound)
      .toBe("Last push 3 min ago");
    expect(now({ inbound: { status: "healthy", feeds: [{ source: "rbn", seconds: 1 }], reconnects_24h: 1 } }).inbound)
      .toBe("Last push 1 s ago · 1 reconnect in 24 h");
  });
});

describe("banner", () => {
  it("is null while every check is Healthy or has no data", () => {
    expect(banner(healthChecks({ sender: { status: "unknown", progress_seconds: null, restarts_24h: null, memory_bytes: null } })))
      .toBeNull();
  });

  it("names the first check in table order, and counts the rest", () => {
    const checks = healthChecks({
      delivery_queue: { status: "delayed", waiting: 184, oldest_ready_seconds: 240, throttled: 3 },
      archive: { status: "delayed", seconds: 9000 },
    });
    expect(banner(checks)).toEqual({
      severity: "warning",
      title: "Outbound is slower than usual",
      body: "184 waiting · oldest ready 4 min · 3 destinations throttled",
      more: "2 checks need attention.",
    });
  });

  it("says a job is not running as usual while the jobs check is only Delayed", () => {
    const checks = healthChecks({ jobs: { status: "delayed", count: 15, failed_1h: 3, unusual: 1 } });
    expect(banner(checks)).toEqual({
      severity: "warning",
      title: "A scheduled job is not running as usual",
      body: "15 jobs · 3 failed runs in the last hour · 1 job not running as usual",
      more: null,
    });
    expect(banner(healthChecks({ jobs: { status: "failing", count: 15, failed_1h: 3, unusual: 1 } }))?.title)
      .toBe("A scheduled job keeps failing");
  });

  it("is an error when anything is Failing", () => {
    const checks = healthChecks({ sender: { status: "failing", progress_seconds: 600, restarts_24h: 2, memory_bytes: 1 } });
    expect(banner(checks)).toEqual({
      severity: "error",
      title: "The sender has stopped",
      body: "Last progress 10 min ago · 2 restarts in 24 h",
      more: null,
    });
  });
});

describe("runSeconds", () => {
  it("shows two places under 10 s, then one, and a dash without a figure", () => {
    expect([0.05, 1.234, 9.996, 12.34, 125, null, undefined].map(runSeconds))
      .toEqual(["0.05 s", "1.23 s", "10.00 s", "12.3 s", "125.0 s", "–", "–"]);
  });
});

describe("scheduleText", () => {
  it("words the schedules pg_cron runs here, and shows anything else as written", () => {
    expect([
      "30 seconds", "1 second", "* * * * *", "*/10 * * * *", "2-59/5 * * * *", "5 * * * *", "35 3 * * *", "20 4 * * 1",
      "0 0 1 * *", "*/5 1 * * *", "@daily", "1,31 * * * *", "0 4 * * 1-5", "0 */2 * * *",
    ].map(scheduleText)).toEqual([
      "Every 30 s", "Every 1 s", "Every minute", "Every 10 min", "Every 5 min", "Hourly at :05", "Daily at 03:35 UTC",
      "Mondays at 04:20 UTC", "0 0 1 * *", "*/5 1 * * *", "@daily", "1,31 * * * *", "0 4 * * 1-5", "0 */2 * * *",
    ]);
  });
});

describe("resultText and lastRunText", () => {
  it("prefers a time-out, then the HTTP status, then the run time", () => {
    expect(resultText(null)).toBe("No runs yet");
    expect(resultText({ ok: false, http_status: 200, timed_out: true, seconds: 30 })).toBe("Timed out");
    expect(resultText({ ok: true, http_status: 200, timed_out: false, seconds: 0.44 })).toBe("HTTP 200 in 0.4 s");
    expect(resultText({ ok: true, http_status: 200, timed_out: false, seconds: null })).toBe("HTTP 200");
    expect(resultText({ ok: true, http_status: null, timed_out: false, seconds: 0.25 })).toBe("Done in 0.3 s");
    expect(resultText({ ok: true, http_status: null, timed_out: false, seconds: null })).toBe("Done in 0.0 s");
    expect(resultText({ ok: false, http_status: null, timed_out: false, seconds: 0 })).toBe("Failed");
  });

  it("dates a run from the payload's time", () => {
    const now = new Date("2026-10-21T12:00:00Z");
    expect(lastRunText(null, now)).toBe("Never");
    expect(lastRunText("2026-10-21T11:59:56Z", now)).toBe("4 s ago");
    expect(lastRunText("2026-10-20T23:00:00Z", now)).toBe("13 h ago");
  });
});

describe("series helpers", () => {
  it("places buckets from the start", () => {
    expect(bucketTimes({ start: "2026-10-21T00:00:00Z", bucket_seconds: 1800 }, 3).map((d) => d.toISOString())).toEqual([
      "2026-10-21T00:00:00.000Z", "2026-10-21T00:30:00.000Z", "2026-10-21T01:00:00.000Z",
    ]);
  });

  it("labels ticks with the time, or the day over 7 days", () => {
    const d = new Date(2026, 9, 21, 6, 30);
    expect(tickLabel("24h", d)).toBe("06:30");
    expect(tickLabel("7d", d)).toBe("21 Wed");
    expect(bucketLabel("1h", d)).toBe("06:30");
    expect(bucketLabel("7d", d)).toBe("21 Wed, 06:30");
  });

  it("finds the latest value and keeps a limit in view", () => {
    expect(latest([1, 2, null])).toBe(2);
    expect(latest([null, null])).toBeNull();
    expect(axisMax([10, null, 20], 100)).toBe(120);
    expect(axisMax([300], 100)).toBe(360);
  });

  it("counts sources with spots in the last three buckets", () => {
    const spots = healthPayload().series.spots;
    expect(sourcesReporting(spots)).toBe(3);
    expect(sourcesReporting({ ...spots, pota: [5, 0, 0, null] })).toBe(2);
  });

  it("converts bytes, names sources and words the update time", () => {
    expect(mb(92 * 1024 * 1024)).toBe(92);
    expect(gb(6_739_351_219)).toBe(6.28);
    expect(sourceName("dxcluster")).toBe("DX Cluster");
    expect(sourceName("other")).toBe("other");
    expect(updatedText(new Date(2026, 9, 21, 11, 57, 8).toISOString())).toBe("Updated 11:57:08");
  });
});

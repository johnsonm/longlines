import { assertEquals } from "@std/assert";
import { runStatusLoop, STATUS_MS, statusBody } from "../status.ts";
import type { SessionStatus } from "../telnet.ts";

const T0 = new Date("2026-10-21T12:00:00Z");
const session = (connected: boolean, connects: number): SessionStatus => ({
  connected,
  connects,
  lastDataAt: null,
});

Deno.test("statusBody counts every connect after a feed's first as a reconnect", () => {
  assertEquals(
    statusBody(
      [
        { id: "rbn", status: session(true, 3) },
        { id: "dxcluster", status: session(false, 0) },
        { id: "aprs", status: session(true, 1) },
      ],
      T0,
      21_000_000,
    ),
    {
      started_at: "2026-10-21T12:00:00.000Z",
      rss_bytes: 21_000_000,
      reconnects: 2,
      feeds: [
        { id: "rbn", connected: true },
        { id: "dxcluster", connected: false },
        { id: "aprs", connected: true },
      ],
    },
  );
});

Deno.test("runStatusLoop posts every interval, logs a failure and stops on abort", async () => {
  const controller = new AbortController();
  const posted: unknown[] = [];
  const logs: string[] = [];
  const slept: number[] = [];
  let calls = 0;
  await runStatusLoop({
    feeds: [{ id: "rbn", status: session(true, 1) }],
    startedAt: T0,
    post: (body) => {
      calls += 1;
      if (calls === 2) return Promise.reject(new Error("POST relay-status: HTTP 404 not found"));
      posted.push(body);
      return Promise.resolve({ ok: true });
    },
    sleep: (ms) => {
      slept.push(ms);
      if (slept.length === 3) controller.abort();
      return Promise.resolve();
    },
    signal: controller.signal,
    log: (m) => logs.push(m),
    rss: () => 5,
  });
  assertEquals(calls, 3);
  assertEquals(posted.length, 2);
  assertEquals(slept, [STATUS_MS, STATUS_MS, STATUS_MS]);
  assertEquals(logs, ["[status] POST relay-status: HTTP 404 not found"]);
});

Deno.test("runStatusLoop stays quiet about a post cut short by shutdown, and measures RSS by default", async () => {
  const controller = new AbortController();
  const logs: string[] = [];
  let rss = 0;
  await runStatusLoop({
    feeds: [],
    startedAt: T0,
    post: (body) => {
      rss = (body as { rss_bytes: number }).rss_bytes;
      controller.abort();
      return Promise.reject(new Error("aborted"));
    },
    sleep: () => Promise.resolve(),
    signal: controller.signal,
    log: (m) => logs.push(m),
  });
  assertEquals(logs, []);
  assertEquals(rss > 0, true);
});

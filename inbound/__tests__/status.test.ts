import { assertEquals, assertRejects } from "@std/assert";
import { runStatusLoop, STATUS_MS, statusBody } from "../status.ts";
import type { SessionStatus } from "../telnet.ts";

const T0 = new Date("2026-10-21T12:00:00Z");
function session(connected: boolean, connects: number): SessionStatus {
  return {
    connected,
    connects,
    lastDataAt: null,
  };
}

Deno.test("statusBody counts every connect after a feed's first as a reconnect", function (): void {
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

Deno.test(
  "runStatusLoop posts every interval, logs a failure and stops on abort",
  async function (): Promise<void> {
    const controller = new AbortController();
    const posted: unknown[] = [];
    const logs: string[] = [];
    const slept: number[] = [];
    let calls = 0;
    function post(body: unknown): Promise<unknown> {
      calls += 1;
      if (calls === 2) {
        return Promise.reject(new Error("POST inbound-status: HTTP 404 not found"));
      }
      posted.push(body);
      return Promise.resolve({ ok: true });
    }
    function sleep(ms: number): Promise<void> {
      slept.push(ms);
      if (slept.length === 3) {
        controller.abort();
      }
      return Promise.resolve();
    }
    await runStatusLoop({
      feeds: [{ id: "rbn", status: session(true, 1) }],
      startedAt: T0,
      post,
      sleep,
      signal: controller.signal,
      log: (m) => logs.push(m),
      rss: () => 5,
    });
    assertEquals(calls, 3);
    assertEquals(posted.length, 2);
    assertEquals(slept, [STATUS_MS, STATUS_MS, STATUS_MS]);
    assertEquals(logs, ["[status] POST inbound-status: HTTP 404 not found"]);
  },
);

Deno.test(
  "runStatusLoop stays quiet about a post cut short by shutdown, and measures RSS by default",
  async function (): Promise<void> {
    const controller = new AbortController();
    const logs: string[] = [];
    let rss = 0;
    function post(body: unknown): Promise<unknown> {
      rss = (body as { rss_bytes: number }).rss_bytes;
      controller.abort();
      return Promise.reject(new Error("aborted"));
    }
    await runStatusLoop({
      feeds: [],
      startedAt: T0,
      post,
      sleep: () => Promise.resolve(),
      signal: controller.signal,
      log: (m) => logs.push(m),
    });
    assertEquals(logs, []);
    assertEquals(rss > 0, true);
  },
);

// Rejects with whatever it is given, so a test can reject with a non-Error.
async function rejectWith(reason: unknown): Promise<never> {
  await Promise.resolve();
  throw reason;
}

Deno.test("runStatusLoop throws a failure that is not an Error", async function (): Promise<void> {
  const logs: string[] = [];
  await assertRejects(() =>
    runStatusLoop({
      feeds: [],
      startedAt: T0,
      post: () => rejectWith("socket hang up"),
      sleep: () => Promise.resolve(),
      signal: new AbortController().signal,
      log: (m) => logs.push(m),
      rss: () => 5,
    })
  );
  assertEquals(logs, []);
});

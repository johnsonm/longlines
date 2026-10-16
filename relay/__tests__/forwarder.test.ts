import { assertEquals } from "@std/assert";
import { Forwarder } from "../forwarder.ts";
import type { RelayLine } from "../functions.ts";

function setup(options: { fail?: () => boolean; maxBuffer?: number } = {}) {
  let t = 1_000_000;
  const pushes: RelayLine[][] = [];
  const logs: string[] = [];
  let release: (() => void) | null = null;
  let hold = false;
  const f = new Forwarder({
    now: () => t,
    maxBatch: 3,
    maxBuffer: options.maxBuffer ?? 100,
    log: (m) => logs.push(m),
    push: async (lines) => {
      if (hold) await new Promise<void>((r) => release = r);
      if (options.fail?.()) throw new Error("HTTP 503");
      pushes.push(lines);
    },
  });
  return {
    f,
    pushes,
    logs,
    advance: (ms: number) => t += ms,
    hold: () => hold = true,
    release: () => {
      hold = false;
      release?.();
    },
  };
}

const line = (n: number): RelayLine => ({ line: `L${n}`, received_at: "2026-10-11T00:00:00Z" });

Deno.test("Forwarder sends a heartbeat at start and then once a minute when idle", async () => {
  const s = setup();
  await s.f.tick();
  assertEquals(s.pushes, [[]]);
  s.advance(59_000);
  await s.f.tick();
  assertEquals(s.pushes.length, 1);
  s.advance(1_000);
  await s.f.tick();
  assertEquals(s.pushes, [[], []]);
});

Deno.test("Forwarder flushes lines after ten seconds or at the batch size", async () => {
  const s = setup();
  await s.f.tick(); // heartbeat
  s.f.add(line(1));
  s.advance(9_000);
  await s.f.tick();
  assertEquals(s.pushes.length, 1);
  s.advance(1_000);
  await s.f.tick();
  assertEquals(s.pushes[1], [line(1)]);

  for (let i = 2; i <= 5; i++) s.f.add(line(i));
  await s.f.tick();
  assertEquals(s.pushes[2], [line(2), line(3), line(4)]);
  assertEquals(s.f.buffered, 1);
  assertEquals(s.f.pushed, 4);
});

Deno.test("Forwarder keeps lines after a failed push and retries with backoff", async () => {
  let failing = true;
  const s = setup({ fail: () => failing });
  s.f.add(line(1));
  await s.f.tick();
  assertEquals(s.f.buffered, 1);
  assertEquals(s.logs.length, 1);
  s.advance(4_000);
  await s.f.tick(); // still inside the 5 s retry window
  assertEquals(s.logs.length, 1);
  s.advance(1_000);
  await s.f.tick(); // second failure, next retry in 10 s
  assertEquals(s.logs[1]!.includes("retry in 10 s"), true);
  failing = false;
  s.advance(10_000);
  await s.f.tick();
  assertEquals(s.pushes, [[line(1)]]);
  assertEquals(s.f.buffered, 0);
});

Deno.test("Forwarder drops the oldest lines past maxBuffer", () => {
  const s = setup({ maxBuffer: 2 });
  for (let i = 1; i <= 4; i++) s.f.add(line(i));
  assertEquals(s.f.buffered, 2);
  assertEquals(s.f.dropped, 2);
});

Deno.test("Forwarder does not lose unsent lines when the buffer overflows during a push", async () => {
  const s = setup({ maxBuffer: 4 });
  for (let i = 1; i <= 3; i++) s.f.add(line(i));
  s.hold();
  const pushing = s.f.tick(); // sends L1..L3
  await Promise.resolve();
  for (let i = 4; i <= 6; i++) s.f.add(line(i)); // overflow drops L1 and L2 from the buffer
  s.release();
  await pushing;
  assertEquals(s.pushes, [[line(1), line(2), line(3)]]);
  assertEquals(s.f.buffered, 3);
  await s.f.flush();
  assertEquals(s.pushes[1], [line(4), line(5), line(6)]);
});

Deno.test("Forwarder defaults: batches of 1,000 and a 50,000-line buffer", async () => {
  const pushes: RelayLine[][] = [];
  const f = new Forwarder({
    now: () => 0,
    log: () => {},
    push: (lines) => {
      pushes.push(lines);
      return Promise.resolve();
    },
  });
  for (let i = 0; i < 50_001; i++) f.add(line(i));
  assertEquals([f.buffered, f.dropped], [50_000, 1]);
  await f.tick();
  assertEquals(pushes[0]!.length, 1_000);
  assertEquals(pushes[0]![0], line(1)); // line 0 was the one dropped
});

Deno.test("Forwarder.flush is a no-op while a push is in flight", async () => {
  const s = setup();
  s.f.add(line(1));
  s.hold();
  const first = s.f.flush();
  await Promise.resolve();
  await s.f.flush(); // returns at once; L1 is already on its way
  s.release();
  await first;
  assertEquals(s.pushes, [[line(1)]]);
});

Deno.test("Forwarder logs a non-Error rejection as text", async () => {
  const logs: string[] = [];
  const f = new Forwarder({
    now: () => 0,
    log: (m) => logs.push(m),
    push: () => Promise.reject("socket hang up"),
  });
  await f.flush();
  assertEquals(logs, ["push failed (0 lines, retry in 5 s): socket hang up"]);
});

Deno.test("Forwarder.drain waits for the push in flight, then pushes what arrived during it", async () => {
  const s = setup();
  s.f.add(line(1));
  s.hold();
  const first = s.f.flush();
  await Promise.resolve();
  s.f.add(line(2));
  const draining = s.f.drain(5_000);
  await Promise.resolve();
  s.release();
  await Promise.all([first, draining]);
  assertEquals(s.pushes, [[line(1)], [line(2)]]);
  assertEquals(s.f.buffered, 0);
  assertEquals(s.logs, []);
});

Deno.test("Forwarder.drain empties a buffer larger than one batch", async () => {
  const pushes: RelayLine[][] = [];
  const f = new Forwarder({
    now: () => 0,
    log: () => {},
    push: (lines) => {
      pushes.push(lines);
      return Promise.resolve();
    },
  });
  for (let i = 0; i < 2_500; i++) f.add(line(i));
  await f.drain(5_000);
  assertEquals(pushes.map((p) => p.length), [1_000, 1_000, 500]);
  assertEquals(pushes[2]![499], line(2_499));
  assertEquals([f.buffered, f.pushed], [0, 2_500]);
});

Deno.test("Forwarder.drain with nothing buffered pushes nothing", async () => {
  const s = setup();
  await s.f.drain(5_000);
  assertEquals(s.pushes, []);
});

Deno.test("Forwarder.drain stops at the deadline and aborts the push in flight", async () => {
  const signals: AbortSignal[] = [];
  const logs: string[] = [];
  const f = new Forwarder({
    now: () => 0,
    maxBatch: 2,
    log: (m) => logs.push(m),
    // Never settles on its own, as if the function hung; it does not watch the signal either.
    push: (_lines, signal) => {
      signals.push(signal);
      return new Promise(() => {});
    },
  });
  for (let i = 0; i < 5; i++) f.add(line(i));
  const started = Date.now();
  await f.drain(50);
  assertEquals(Date.now() - started < 1_000, true);
  assertEquals(signals.length, 1);
  assertEquals(signals[0]!.aborted, true);
  assertEquals(f.buffered, 5);
  assertEquals(logs, ["drain stopped with 5 lines unsent"]);
});

Deno.test("Forwarder.drain stops after a failed push and keeps the lines", async () => {
  let calls = 0;
  const logs: string[] = [];
  const f = new Forwarder({
    now: () => 0,
    maxBatch: 2,
    log: (m) => logs.push(m),
    push: () => {
      calls += 1;
      return Promise.reject(new Error("HTTP 503"));
    },
  });
  for (let i = 0; i < 5; i++) f.add(line(i));
  await f.drain(5_000);
  assertEquals(calls, 1);
  assertEquals(f.buffered, 5);
  assertEquals(logs, [
    "push failed (2 lines, retry in 5 s): HTTP 503",
    "drain stopped with 5 lines unsent",
  ]);
});

Deno.test("Forwarder.drain keeps overflow accounting during the push it waits for", async () => {
  const s = setup({ maxBuffer: 4 });
  for (let i = 1; i <= 3; i++) s.f.add(line(i));
  s.hold();
  const pushing = s.f.flush(); // sends L1..L3
  await Promise.resolve();
  for (let i = 4; i <= 6; i++) s.f.add(line(i)); // overflow drops L1 and L2 from the buffer
  const draining = s.f.drain(5_000);
  s.release();
  await Promise.all([pushing, draining]);
  assertEquals(s.pushes, [[line(1), line(2), line(3)], [line(4), line(5), line(6)]]);
  assertEquals([s.f.buffered, s.f.dropped], [0, 2]);
});

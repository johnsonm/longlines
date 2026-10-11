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

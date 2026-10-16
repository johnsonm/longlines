import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { sendToDestination } from "../../supabase/functions/_shared/delivery/send.ts";
import type {
  DeliveryDestination,
  PendingDelivery,
} from "../../supabase/functions/_shared/delivery/types.ts";
import type { SenderConfig } from "../config.ts";
import type { SenderDb } from "../db.ts";
import { healthHandler, type SenderStatus } from "../health.ts";
import { abortableSleep, RETRY_MIN_MS, type SenderDeps, startSender } from "../sender.ts";

const T0 = new Date("2026-10-15T12:00:00Z");

function config(overrides: Partial<SenderConfig> = {}): SenderConfig {
  return {
    databaseUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    databaseSsl: false,
    healthPort: 0,
    pollMs: 5_000,
    concurrency: 4,
    staleMs: 120_000,
    statsMs: 60_000,
    vapid: undefined,
    allowInsecure: true,
    ...overrides,
  };
}

/**
 * A clock the tests move by hand. sleep() resolves when advance() passes its
 * deadline (or on abort); advance() wakes the sleepers in order and yields
 * between them so each loop can schedule its next sleep.
 */
function fakeClock(start: Date) {
  let t = start.getTime();
  const waiters: Array<{ at: number; wake: () => void }> = [];
  const yieldToLoops = () => new Promise((r) => setTimeout(r, 2));
  return {
    now: () => new Date(t),
    sleep(ms: number, signal: AbortSignal): Promise<void> {
      return new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const waiter = { at: t + ms, wake: done };
        waiters.push(waiter);
        signal.addEventListener("abort", done, { once: true });
        function done() {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          signal.removeEventListener("abort", done);
          resolve();
        }
      });
    },
    async advance(ms: number): Promise<void> {
      // Let a loop that just finished a call register its next sleep first.
      await yieldToLoops();
      const target = t + ms;
      for (;;) {
        const due = waiters.filter((w) => w.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        t = Math.max(t, due.at);
        due.wake();
        await yieldToLoops();
      }
      t = target;
      await yieldToLoops();
    },
  };
}

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}
type Answer = { data?: unknown; error?: string } | Promise<{ data?: unknown; error?: string }>;

/** A SenderDb that records every call; `answer` overrides the default empty answers. */
function fakeDb(answer: (call: RpcCall) => Answer | undefined = () => undefined) {
  const calls: RpcCall[] = [];
  let closed = 0;
  const db: SenderDb = {
    async rpc(fn, args) {
      const call = { fn, args };
      calls.push(call);
      const a = await answer(call);
      if (fn === "delivery_queue_stats" && a === undefined) {
        return { data: [{ depth: 3, expired_last_hour: 1 }], error: null };
      }
      return { data: a?.data ?? (fn === "claim_deliveries" ? [] : null), error: a?.error ?? null };
    },
    close() {
      closed += 1;
      return Promise.resolve();
    },
  };
  return { db, calls, closed: () => closed, of: (fn: string) => calls.filter((c) => c.fn === fn) };
}

function dest(id: string, overrides: Partial<DeliveryDestination> = {}): DeliveryDestination {
  return {
    id,
    type: "webhook",
    name: `Hook ${id}`,
    url: "http://127.0.0.1:1/hook",
    signing_secret: "whsec_test",
    health: "ok",
    consecutive_failures: 0,
    ...overrides,
  };
}

function row(id: number, destination: DeliveryDestination): PendingDelivery {
  return {
    msg_id: id * 10,
    delivery_id: id,
    subscription_id: "11111111-1111-1111-1111-111111111111",
    attempts: 0,
    created_at: T0.toISOString(),
    destination,
    spot: {
      id,
      source: "pota",
      spot_time: T0.toISOString(),
      callsign: "W1AW",
      base_callsign: "W1AW",
      spotter: null,
      frequency_khz: 14062,
      band: "20m",
      mode: "cw",
      mode_family: "cw",
      comment: "",
      pota_reference: "US-0001",
      pota_park_name: "A Park",
      pota_location: "US-CT",
      sota_summit_ref: null,
      wwff_reference: null,
      wwff_reference_name: null,
    },
  };
}

/** A local webhook receiver; `status` is what it answers. */
function receiver(status = 200, headers: Record<string, string> = {}) {
  const requests: Array<{ headers: Headers; body: unknown }> = [];
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (req) => {
    requests.push({ headers: req.headers, body: await req.json() });
    return new Response(status === 200 ? "{}" : "", { status, headers });
  });
  return { url: `http://127.0.0.1:${server.addr.port}/hook`, requests, server };
}

const allSent: SenderDeps["send"] = (_d, b) => Promise.resolve({ ok: true, sent: b.length });

async function waitFor(what: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function health(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  return { status: res.status, body: await res.json() };
}

Deno.test("startSender claims, sends to a local webhook, acks in one call and reports on /healthz", async () => {
  const hook = receiver();
  const d = dest("d1", { url: hook.url });
  const claims = [[row(1, d), row(2, d)]];
  const db = fakeDb(({ fn }) =>
    fn === "claim_deliveries" ? { data: claims.shift() ?? [] } : undefined
  );
  const clock = fakeClock(T0);
  const logs: string[] = [];
  const sender = startSender(config(), {
    db: db.db,
    send: (destination, deliveries, now) =>
      sendToDestination(destination, deliveries, { allowInsecure: true, now }),
  }, { hostname: "127.0.0.1", log: (m) => logs.push(m), now: clock.now, sleep: clock.sleep });

  await waitFor("the ack", () => db.of("mark_deliveries_sent").length === 1);
  assertEquals(db.of("claim_deliveries")[0]!.args, { p_limit: 200, p_vt: 60 });
  assertEquals(db.of("mark_deliveries_sent")[0]!.args, {
    p_delivery_ids: [1, 2],
    p_msg_ids: [10, 20],
  });
  assertEquals(hook.requests.length, 1);
  assertEquals(
    (hook.requests[0]!.body as { deliveries: { delivery_id: number }[] }).deliveries.map((x) =>
      x.delivery_id
    ),
    [1, 2],
  );
  assertEquals(hook.requests[0]!.headers.get("x-longlines-signature")?.startsWith("sha256="), true);

  await waitFor("the stats", () => db.of("delivery_queue_stats").length === 1);
  const h = await health(sender.addr.port);
  assertEquals(h.status, 200);
  assertEquals(h.body, {
    healthy: true,
    last_claim_at: T0.toISOString(),
    last_progress_at: T0.toISOString(),
    last_error: null,
    in_flight: false,
    totals: {
      cycles: 1,
      claimed: 2,
      sent: 2,
      failed: 0,
      throttled: 0,
      skipped_paused: 0,
      errors: 0,
    },
    queue: { depth: 3, expired_last_hour: 1 },
  });

  // Less than a full batch: the next claim waits pollMs.
  await clock.advance(4_999);
  assertEquals(db.of("claim_deliveries").length, 1);
  await clock.advance(1);
  await waitFor("the second claim", () => db.of("claim_deliveries").length === 2);
  assertEquals(sender.status().totals.cycles, 2);

  await Promise.all([sender.shutdown(), sender.shutdown()]);
  await sender.done;
  await hook.server.shutdown();
  assertEquals(db.closed(), 1);
  assertStringIncludes(logs[0]!, "sender started: poll 5000 ms, concurrency 4, stale 120000 ms");
  assertEquals(logs.filter((m) => m === "shutting down").length, 1);
  // The per-cycle line is the batch result as JSON, only for cycles that did something.
  const cycles = logs.filter((m) => m.startsWith("{"));
  assertEquals(cycles.length, 1);
  assertEquals(JSON.parse(cycles[0]!).sent, 2);
  assertEquals(logs.some((m) => m.startsWith("queue depth 3, expired in the last hour 1;")), true);
});

Deno.test("startSender claims again at once after a full batch", async () => {
  const d = dest("d1");
  const claims = [[row(1, d)], [row(2, d)], [row(3, d)]];
  const db = fakeDb(({ fn }) =>
    fn === "claim_deliveries" ? { data: claims.shift() ?? [] } : undefined
  );
  const clock = fakeClock(T0);
  const sender = startSender(config(), { db: db.db, send: allSent }, {
    hostname: "127.0.0.1",
    log: () => {},
    now: clock.now,
    sleep: clock.sleep,
    claimLimit: 1,
  });
  // Three full batches and the empty claim after them, without the clock moving.
  await waitFor("four claims", () => db.of("claim_deliveries").length === 4);
  assertEquals(db.of("claim_deliveries")[0]!.args, { p_limit: 1, p_vt: 60 });
  assertEquals(db.of("mark_deliveries_sent").map((c) => c.args.p_delivery_ids), [[1], [2], [3]]);
  assertEquals(sender.status().totals, {
    cycles: 4,
    claimed: 3,
    sent: 3,
    failed: 0,
    throttled: 0,
    skipped_paused: 0,
    errors: 0,
  });
  await sender.shutdown();
  await sender.done;
});

Deno.test("startSender retries a failed claim with doubling delays and the watchdog ends it after staleMs", async () => {
  const db = fakeDb(({ fn }) =>
    fn === "claim_deliveries" ? { error: "connection reset" } : undefined
  );
  const clock = fakeClock(T0);
  const logs: string[] = [];
  const sender = startSender(config({ staleMs: 120_000 }), { db: db.db, send: allSent }, {
    hostname: "127.0.0.1",
    log: (m) => logs.push(m),
    now: clock.now,
    sleep: clock.sleep,
  });
  const failing = assertRejects(() => sender.done, Error, "no progress for 120 s");

  await waitFor("the first claim", () => db.of("claim_deliveries").length === 1);
  // Retries at 5, 15, 35 and 75 s (5 s doubling), the next would be 135 s.
  await clock.advance(60_000);
  assertEquals(db.of("claim_deliveries").length, 4);
  let h = await health(sender.addr.port);
  assertEquals(h.status, 200); // the start counts as the last claim until staleMs
  assertEquals(h.body.last_error, "claim_deliveries: connection reset");
  assertEquals(h.body.last_claim_at, null);
  assertEquals(h.body.last_progress_at, null);

  await clock.advance(60_000);
  await failing;
  assertEquals(db.of("claim_deliveries").length, 5);
  h = await health(sender.addr.port);
  assertEquals(h.status, 503);
  assertEquals(h.body.healthy, false);
  assertEquals(logs.includes("watchdog: no progress for 120 s"), true);
  assertEquals(logs.filter((m) => m.startsWith("claim failed: connection reset")).length, 5);
  assertStringIncludes(
    logs.find((m) => m.startsWith("claim failed"))!,
    `retrying in ${RETRY_MIN_MS} ms`,
  );

  await sender.shutdown();
  assertEquals(db.closed(), 1);
});

Deno.test("startSender shutdown does not wait for a cycle the watchdog gave up on", async () => {
  // The claim never answers: what a wedged pooler connection looks like.
  const db = fakeDb(({ fn }) => fn === "claim_deliveries" ? new Promise(() => {}) : undefined);
  const clock = fakeClock(T0);
  const sender = startSender(config({ staleMs: 10_000 }), { db: db.db, send: allSent }, {
    hostname: "127.0.0.1",
    log: () => {},
    now: clock.now,
    sleep: clock.sleep,
  });
  const failing = assertRejects(() => sender.done, Error, "watchdog");
  await waitFor("the claim", () => db.of("claim_deliveries").length === 1);
  await clock.advance(10_000);
  await failing;
  assertEquals(sender.status().inFlight, true);
  await sender.shutdown();
  assertEquals(db.closed(), 1);
});

Deno.test("startSender lets a cycle outlast staleMs while each send makes progress, and acks it", async () => {
  // Three destinations, one at a time, each send taking 1 s of a 1.5 s
  // staleMs: the cycle takes 3 s, longer than staleMs, but never stalls.
  const ds = [dest("d1"), dest("d2"), dest("d3")];
  const claims = [ds.map((d, i) => row(i + 1, d))];
  const db = fakeDb(({ fn }) =>
    fn === "claim_deliveries" ? { data: claims.shift() ?? [] } : undefined
  );
  const clock = fakeClock(T0);
  const logs: string[] = [];
  const sender = startSender(config({ staleMs: 1_500, concurrency: 1 }), {
    db: db.db,
    send: async (_d, b) => {
      await clock.advance(1_000);
      return { ok: true, sent: b.length };
    },
  }, {
    hostname: "127.0.0.1",
    log: (m) => logs.push(m),
    now: clock.now,
    sleep: clock.sleep,
  });
  let failed = false;
  sender.done.catch(() => {
    failed = true;
  });

  await waitFor("the ack", () => db.of("mark_deliveries_sent").length === 1);
  assertEquals(db.of("mark_deliveries_sent")[0]!.args.p_delivery_ids, [1, 2, 3]);
  assertEquals(failed, false);
  assertEquals(logs.some((m) => m.startsWith("watchdog")), false);
  const status = sender.status();
  assertEquals(status.lastClaimAt, T0);
  assertEquals(status.lastProgressAt, new Date(T0.getTime() + 3_000));
  assertEquals((await health(sender.addr.port)).status, 200);
  await sender.shutdown();
  await sender.done;
});

Deno.test("startSender's watchdog still ends a cycle whose mark never answers", async () => {
  const d = dest("d1");
  const db = fakeDb(({ fn }) => {
    if (fn === "claim_deliveries") return { data: [row(1, d)] };
    if (fn === "mark_deliveries_sent") return new Promise(() => {});
    return undefined;
  });
  const clock = fakeClock(T0);
  const sender = startSender(config({ staleMs: 10_000 }), { db: db.db, send: allSent }, {
    hostname: "127.0.0.1",
    log: () => {},
    now: clock.now,
    sleep: clock.sleep,
  });
  const failing = assertRejects(() => sender.done, Error, "watchdog: no progress for 10 s");
  await waitFor("the mark", () => db.of("mark_deliveries_sent").length === 1);
  await clock.advance(10_000);
  await failing;
  assertEquals(sender.status().inFlight, true);
  await sender.shutdown();
  assertEquals(db.closed(), 1);
});

Deno.test("startSender reports a failed mark, waits the retry delay, and clears it after a clean cycle", async () => {
  const d = dest("d1");
  const claims = [[row(1, d)], [row(2, d)]];
  let failMark = true;
  const db = fakeDb(({ fn }) => {
    if (fn === "claim_deliveries") return { data: claims.shift() ?? [] };
    if (fn === "mark_deliveries_sent" && failMark) return { error: "deadlock detected" };
    return undefined;
  });
  const clock = fakeClock(T0);
  const sender = startSender(config({ pollMs: 1_000 }), { db: db.db, send: allSent }, {
    hostname: "127.0.0.1",
    log: () => {},
    now: clock.now,
    sleep: clock.sleep,
  });
  // runDeliveryBatch tries the mark three times, waiting on the sender's clock.
  await waitFor("the first mark", () => db.of("mark_deliveries_sent").length === 1);
  await clock.advance(500);
  await waitFor("the second mark", () => db.of("mark_deliveries_sent").length === 2);
  await clock.advance(1_000);
  await waitFor("the first cycle", () => sender.status().totals.cycles === 1);
  assertEquals(db.of("mark_deliveries_sent").length, 3);
  let h = await health(sender.addr.port);
  assertEquals(h.status, 200); // the claim worked; only the mark failed
  assertEquals(h.body.last_error, "mark_deliveries_sent: deadlock detected");
  assertEquals(h.body.totals.errors, 1);

  // The next claim waits the retry delay, not pollMs.
  failMark = false;
  await clock.advance(1_000);
  assertEquals(db.of("claim_deliveries").length, 1);
  await clock.advance(RETRY_MIN_MS - 1_000);
  await waitFor("the second cycle", () => sender.status().totals.cycles === 2);
  h = await health(sender.addr.port);
  assertEquals(h.body.last_error, null);
  assertEquals(h.body.totals.sent, 2);
  await sender.shutdown();
  await sender.done;
});

Deno.test("startSender shutdown waits for the cycle in flight before closing the pool", async () => {
  const d = dest("d1");
  const claims = [[row(1, d)]];
  const db = fakeDb(({ fn }) =>
    fn === "claim_deliveries" ? { data: claims.shift() ?? [] } : undefined
  );
  let release = () => {};
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  const clock = fakeClock(T0);
  const sender = startSender(config(), {
    db: db.db,
    send: async (_d, b) => {
      await blocked;
      return { ok: true, sent: b.length };
    },
  }, { hostname: "127.0.0.1", log: () => {}, now: clock.now, sleep: clock.sleep });
  await waitFor("the claim", () => db.of("claim_deliveries").length === 1);
  assertEquals((await health(sender.addr.port)).body.in_flight, true);

  let stopped = false;
  const stopping = sender.shutdown().then(() => {
    stopped = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(stopped, false);
  assertEquals(db.closed(), 0);
  release();
  await stopping;
  await sender.done;
  assertEquals(db.of("mark_deliveries_sent").length, 1);
  assertEquals(db.closed(), 1);
  // Shutdown stopped the loop: no claim after the one in flight.
  assertEquals(db.of("claim_deliveries").length, 1);
});

Deno.test("startSender ends with the error when a cycle throws anything but a ClaimError", async () => {
  const d = dest("d1");
  const db = fakeDb(({ fn }) => fn === "claim_deliveries" ? { data: [row(1, d)] } : undefined);
  const clock = fakeClock(T0);
  const sender = startSender(config(), {
    db: db.db,
    send: () => Promise.reject(new TypeError("boom")),
  }, { hostname: "127.0.0.1", log: () => {}, now: clock.now, sleep: clock.sleep });
  await assertRejects(() => sender.done, TypeError, "boom");
  await sender.shutdown();
  assertEquals(db.closed(), 1);
});

Deno.test("startSender logs a failed stats call and keeps the previous figures", async () => {
  let statsFail = false;
  const db = fakeDb(({ fn }) =>
    fn === "delivery_queue_stats" && statsFail ? { error: "timeout" } : undefined
  );
  const clock = fakeClock(T0);
  const logs: string[] = [];
  const sender = startSender(config({ statsMs: 10_000 }), { db: db.db, send: allSent }, {
    hostname: "127.0.0.1",
    log: (m) => logs.push(m),
    now: clock.now,
    sleep: clock.sleep,
  });
  await waitFor("the stats", () => db.of("delivery_queue_stats").length === 1);
  statsFail = true;
  await clock.advance(10_000);
  await waitFor("the second stats call", () => db.of("delivery_queue_stats").length === 2);
  assertEquals(logs.includes("delivery_queue_stats failed: timeout"), true);
  assertEquals(sender.status().queue, { depth: 3, expired_last_hour: 1 });
  await sender.shutdown();
  await sender.done;
});

Deno.test("abortableSleep ends on the timer or on abort", async () => {
  const controller = new AbortController();
  await abortableSleep(1, controller.signal);
  const pending = abortableSleep(60_000, controller.signal);
  controller.abort();
  await pending;
  await abortableSleep(60_000, controller.signal); // already aborted: at once
});

Deno.test("healthHandler answers 200 inside the grace and 503 once stale, and 404 elsewhere", async () => {
  let now = new Date("2026-10-15T12:00:00Z");
  const status: SenderStatus = {
    startedAt: new Date("2026-10-15T12:00:00Z"),
    lastClaimAt: null,
    lastProgressAt: null,
    lastError: null,
    inFlight: false,
    totals: {
      cycles: 0,
      claimed: 0,
      sent: 0,
      failed: 0,
      throttled: 0,
      skipped_paused: 0,
      errors: 0,
    },
    queue: null,
  };
  const handler = healthHandler(() => status, 120_000, () => now);
  const get = (path = "/healthz") => handler(new Request(`http://x${path}`));
  assertEquals(get("/").status, 404);
  assertEquals(get().status, 200);
  now = new Date("2026-10-15T12:02:00Z");
  assertEquals(get().status, 503);
  // Liveness is the last progress, not the last claim: a long cycle is healthy.
  status.lastClaimAt = new Date("2026-10-15T11:59:00Z");
  status.lastProgressAt = new Date("2026-10-15T12:01:30Z");
  const res = get();
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    healthy: true,
    last_claim_at: "2026-10-15T11:59:00.000Z",
    last_progress_at: "2026-10-15T12:01:30.000Z",
    last_error: null,
    in_flight: false,
    totals: status.totals,
    queue: null,
  });
});

import { assertEquals, assertRejects } from "@std/assert";
import { backoffSeconds } from "../delivery/format.ts";
import {
  BOOKKEEPING_RETRY_MS,
  CLAIM_LIMIT,
  ClaimError,
  DEFAULT_CONCURRENCY,
  type DeliveryRpc,
  type ProgressStep,
  runDeliveryBatch,
  VISIBILITY_SECONDS,
} from "../delivery/run.ts";
import { DISCORD_MESSAGES_PER_RUN, sendDiscord, type SendResult } from "../delivery/send.ts";
import type { DeliveryDestination, PendingDelivery } from "../delivery/types.ts";

const NOW = new Date("2026-10-05T14:00:00Z");

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

type Responder =
  | { data?: unknown; error?: string }
  | ((args: Record<string, unknown>) => { data?: unknown; error?: string });

/** A DeliveryRpc that records every call and answers from a table of responders. */
function fakeRpc(
  responders: Record<string, Responder> = {},
): { db: DeliveryRpc; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  const db: DeliveryRpc = {
    rpc(fn, args) {
      calls.push({ fn, args });
      const responder = responders[fn];
      const result = typeof responder === "function" ? responder(args) : responder;
      return Promise.resolve({ data: result?.data ?? null, error: result?.error ?? null });
    },
  };
  return { db, calls };
}

function dest(id: string, overrides: Partial<DeliveryDestination> = {}): DeliveryDestination {
  return {
    id,
    type: "webhook",
    name: `Dest ${id}`,
    url: "https://example.com/hook",
    signing_secret: "whsec_x",
    health: "ok",
    consecutive_failures: 0,
    ...overrides,
  };
}

function row(
  id: number,
  destination: DeliveryDestination,
  overrides: Partial<PendingDelivery> = {},
): PendingDelivery {
  return {
    msg_id: id * 10,
    delivery_id: id,
    subscription_id: "s1",
    attempts: 0,
    created_at: new Date(NOW.getTime() - 60_000).toISOString(),
    destination,
    spot: {
      id,
      source: "pota",
      spot_time: NOW.toISOString(),
      callsign: "W1AW",
      base_callsign: "W1AW",
      spotter: null,
      frequency_khz: 14062,
      band: "20m",
      mode: "cw",
      mode_family: "cw",
      comment: "",
      pota_reference: null,
      pota_park_name: null,
      pota_location: null,
      sota_summit_ref: null,
      wwff_reference: null,
      wwff_reference_name: null,
    },
    ...overrides,
  };
}

type Send = (d: DeliveryDestination, b: readonly PendingDelivery[]) => Promise<SendResult>;

const allSent: Send = (_d, b) => Promise.resolve({ ok: true, sent: b.length });

/** Records the bookkeeping waits instead of sleeping, so retries cost no time. */
function noSleep() {
  const waits: number[] = [];
  return { waits, sleep: (ms: number) => (waits.push(ms), Promise.resolve()) };
}

async function run(
  rows: PendingDelivery[],
  send: Send,
  responders: Record<string, Responder> = {},
  options: Parameters<typeof runDeliveryBatch>[3] = { concurrency: 1, sleep: noSleep().sleep },
) {
  const { db, calls } = fakeRpc({ claim_deliveries: { data: rows }, ...responders });
  const sent: Array<{ destination: string; ids: number[] }> = [];
  const result = await runDeliveryBatch(
    db,
    (d, b) => {
      sent.push({ destination: d.id, ids: b.map((r) => r.delivery_id) });
      return send(d, b);
    },
    NOW,
    options,
  );
  return { result, calls, sent };
}

Deno.test("runDeliveryBatch claims with the defaults, or the options given", async () => {
  const { calls, result } = await run([], allSent, {}, {});
  assertEquals(calls, [{
    fn: "claim_deliveries",
    args: { p_limit: CLAIM_LIMIT, p_vt: VISIBILITY_SECONDS },
  }]);
  assertEquals(result, {
    claimed: 0,
    sent: 0,
    failed: 0,
    throttled: 0,
    skipped_paused: 0,
    errors: [],
    destinations: [],
  });
  assertEquals(DEFAULT_CONCURRENCY, 4);

  const custom = await run([], allSent, {}, { claimLimit: 50, visibilitySeconds: 30 });
  assertEquals(custom.calls[0]?.args, { p_limit: 50, p_vt: 30 });
});

Deno.test("runDeliveryBatch throws ClaimError when the claim fails, before sending anything", async () => {
  const { db, calls } = fakeRpc({ claim_deliveries: { error: "boom" } });
  let sends = 0;
  await assertRejects(
    () =>
      runDeliveryBatch(db, () => {
        sends++;
        return allSent(dest("a"), []);
      }, NOW),
    ClaimError,
    "boom",
  );
  assertEquals(sends, 0);
  assertEquals(calls.length, 1);
});

Deno.test("runDeliveryBatch groups by destination in claim order and acks every success in one call", async () => {
  const a = dest("a");
  const b = dest("b", { type: "discord" });
  const { result, calls, sent } = await run([row(1, a), row(2, b), row(3, a)], allSent);

  assertEquals(sent, [{ destination: "a", ids: [1, 3] }, { destination: "b", ids: [2] }]);
  assertEquals(result.claimed, 3);
  assertEquals(result.sent, 3);
  assertEquals(calls.slice(1), [
    { fn: "mark_deliveries_sent", args: { p_delivery_ids: [1, 3, 2], p_msg_ids: [10, 30, 20] } },
  ]);
  assertEquals(result.destinations, [
    {
      id: "a",
      type: "webhook",
      name: "Dest a",
      claimed: 2,
      sent: 2,
      failed: 0,
      throttled: 0,
      skipped_paused: 0,
    },
    {
      id: "b",
      type: "discord",
      name: "Dest b",
      claimed: 1,
      sent: 1,
      failed: 0,
      throttled: 0,
      skipped_paused: 0,
    },
  ]);
});

Deno.test("runDeliveryBatch sends a day-old row like any other: expiry is SQL's job now", async () => {
  const a = dest("a");
  const old = row(1, a, {
    created_at: new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString(),
  });
  const { sent, calls } = await run([old], allSent);
  assertEquals(sent, [{ destination: "a", ids: [1] }]);
  assertEquals(calls.map((c) => c.fn), ["claim_deliveries", "mark_deliveries_sent"]);
});

Deno.test("runDeliveryBatch sends up to `concurrency` destinations at once, one send per destination", async () => {
  const rows = ["a", "b", "c", "d", "e"].flatMap((id) => {
    const d = dest(id);
    return [row(id.charCodeAt(0) * 2, d), row(id.charCodeAt(0) * 2 + 1, d)];
  });
  const { db } = fakeRpc({ claim_deliveries: { data: rows } });
  const pending: Array<{ id: string; resolve: () => void }> = [];
  let inFlight = 0;
  let peak = 0;
  const done = runDeliveryBatch(
    db,
    (d, b) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      assertEquals(b.length, 2, "every row of a destination goes in one send");
      return new Promise<SendResult>((resolve) => {
        pending.push({
          id: d.id,
          resolve: () => {
            inFlight--;
            resolve({ ok: true, sent: b.length });
          },
        });
      });
    },
    NOW,
    { concurrency: 2 },
  );

  await new Promise((r) => setTimeout(r, 0));
  assertEquals(pending.map((p) => p.id), ["a", "b"]);
  pending.shift()!.resolve();
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(pending.map((p) => p.id), ["b", "c"]);
  while (pending.length > 0) {
    pending.shift()!.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
  const result = await done;
  assertEquals(peak, 2);
  assertEquals(result.sent, 10);
  assertEquals(result.destinations.map((d) => d.id), ["a", "b", "c", "d", "e"]);
});

Deno.test("runDeliveryBatch with concurrency 1 sends destinations one after another", async () => {
  const events: string[] = [];
  const { result } = await run(
    [row(1, dest("a")), row(2, dest("b")), row(3, dest("c"))],
    async (d) => {
      events.push(`start ${d.id}`);
      await new Promise((r) => setTimeout(r, 1));
      events.push(`end ${d.id}`);
      return { ok: true, sent: 1 };
    },
    {},
    { concurrency: 1 },
  );
  assertEquals(events, ["start a", "end a", "start b", "end b", "start c", "end c"]);
  assertEquals(result.sent, 3);
});

Deno.test("runDeliveryBatch throttles the destination on a 429 with its Retry-After", async () => {
  const a = dest("a");
  const { result, calls } = await run(
    [row(1, a), row(2, a), row(3, a)],
    () => Promise.resolve({ ok: false, sent: 1, error: "HTTP 429", retryAfterSeconds: 7 }),
  );
  assertEquals(result.sent, 1);
  assertEquals(result.throttled, 2);
  assertEquals(result.failed, 0);
  // The ack first: mark_deliveries_sent clears throttled_until, so the other order
  // would lose the throttle.
  assertEquals(calls.slice(1), [
    { fn: "mark_deliveries_sent", args: { p_delivery_ids: [1], p_msg_ids: [10] } },
    {
      fn: "throttle_destination",
      args: { p_destination_id: "a", p_msg_ids: [20, 30], p_seconds: 7 },
    },
  ]);
  assertEquals(result.destinations[0]?.throttled, 2);
  assertEquals(result.destinations[0]?.error, undefined);
});

Deno.test("runDeliveryBatch throttles with null seconds when the 429 had no Retry-After", async () => {
  const a = dest("a");
  const { result, calls } = await run(
    [row(1, a)],
    () => Promise.resolve({ ok: false, sent: 0, error: "HTTP 429", retryAfterSeconds: null }),
  );
  assertEquals(result.throttled, 1);
  assertEquals(calls.slice(1), [{
    fn: "throttle_destination",
    args: { p_destination_id: "a", p_msg_ids: [10], p_seconds: null },
  }]);
  assertEquals(calls.some((c) => c.fn === "delay_deliveries"), false);
});

Deno.test("runDeliveryBatch never reaches the Discord cap under a budgeted claim", async () => {
  // SQL hands a Discord webhook at most 300 spots a minute: 30 messages, the cap exactly.
  let posts = 0;
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen() {} },
    () => {
      posts++;
      return new Response(null, { status: 204 });
    },
  );
  try {
    const d = dest("d", {
      type: "discord",
      url: `http://127.0.0.1:${server.addr.port}/api/webhooks/1/abc`,
    });
    const rows = Array.from({ length: 300 }, (_, i) => row(i + 1, d));
    const { db, calls } = fakeRpc({ claim_deliveries: { data: rows } });
    const result = await runDeliveryBatch(
      db,
      (destination, batch) => sendDiscord(destination, batch, { allowInsecure: true }),
      NOW,
    );
    assertEquals(posts, DISCORD_MESSAGES_PER_RUN);
    assertEquals(result.sent, 300);
    assertEquals(result.throttled, 0);
    assertEquals(calls.map((c) => c.fn), ["claim_deliveries", "mark_deliveries_sent"]);
    assertEquals((calls[1]?.args["p_delivery_ids"] as number[]).length, 300);
  } finally {
    ac.abort();
    await server.finished;
  }
});

Deno.test("runDeliveryBatch hands the Discord cap's overflow to throttle_destination", async () => {
  const d = dest("d", { type: "discord" });
  const { result, calls } = await run(
    [row(1, d), row(2, d)],
    () =>
      Promise.resolve({
        ok: false,
        sent: 1,
        error: "Discord per-run message cap reached",
        retryAfterSeconds: 60,
      }),
  );
  assertEquals(result.throttled, 1);
  assertEquals(calls[2], {
    fn: "throttle_destination",
    args: { p_destination_id: "d", p_msg_ids: [20], p_seconds: 60 },
  });
});

Deno.test("runDeliveryBatch marks failures per destination with backoff from the highest attempt", async () => {
  const a = dest("a");
  const b = dest("b");
  const { result, calls } = await run(
    [row(1, a, { attempts: 1 }), row(2, a, { attempts: 3 }), row(3, b)],
    (d) =>
      Promise.resolve(
        d.id === "a" ? { ok: false, sent: 0, error: "HTTP 500" } : { ok: false, sent: 0 },
      ),
  );
  assertEquals(result.failed, 3);
  assertEquals(result.sent, 0);
  assertEquals(calls.slice(1), [
    {
      fn: "mark_deliveries_failed",
      args: {
        p_delivery_ids: [1, 2],
        p_msg_ids: [10, 20],
        p_error: "HTTP 500",
        p_delay_seconds: backoffSeconds(4),
      },
    },
    {
      fn: "mark_deliveries_failed",
      args: {
        p_delivery_ids: [3],
        p_msg_ids: [30],
        p_error: "unknown error",
        p_delay_seconds: backoffSeconds(1),
      },
    },
  ]);
  assertEquals(result.destinations.map((d) => d.error), ["HTTP 500", "unknown error"]);
});

Deno.test("runDeliveryBatch acks the sent part and fails the rest of a partial batch", async () => {
  const a = dest("a");
  const { result, calls } = await run(
    [row(1, a), row(2, a)],
    () => Promise.resolve({ ok: false, sent: 1, error: "HTTP 502" }),
  );
  assertEquals([result.sent, result.failed], [1, 1]);
  assertEquals(calls.map((c) => c.fn), [
    "claim_deliveries",
    "mark_deliveries_sent",
    "mark_deliveries_failed",
  ]);
});

Deno.test("runDeliveryBatch skips paused destinations so their messages reappear later", async () => {
  const paused = dest("p", { health: "paused" });
  const { result, sent, calls } = await run([row(1, paused), row(2, paused)], allSent);
  assertEquals(result.skipped_paused, 2);
  assertEquals(sent, []);
  assertEquals(calls.length, 1);
  assertEquals(result.destinations[0]?.skipped_paused, 2);
});

Deno.test("runDeliveryBatch collects bookkeeping RPC errors instead of aborting", async () => {
  const { result } = await run([row(1, dest("a"))], allSent, {
    mark_deliveries_sent: { error: "db down" },
  });
  assertEquals(result.sent, 1);
  assertEquals(result.errors, ["mark_deliveries_sent: db down"]);
});

Deno.test("runDeliveryBatch retries a failed ack and records nothing once it lands", async () => {
  let failures = 1;
  const { waits, sleep } = noSleep();
  const { result, calls } = await run([row(1, dest("a")), row(2, dest("a"))], allSent, {
    mark_deliveries_sent: () => failures-- > 0 ? { error: "connection reset" } : {},
  }, { sleep });
  const marks = calls.filter((c) => c.fn === "mark_deliveries_sent");
  assertEquals(marks.length, 2);
  assertEquals(marks[1]?.args, { p_delivery_ids: [1, 2], p_msg_ids: [10, 20] });
  assertEquals(waits, [500]);
  assertEquals(result.errors, []);
  assertEquals(result.sent, 2);
});

Deno.test("runDeliveryBatch gives up on an ack after the bounded attempts and records the error", async () => {
  const { waits, sleep } = noSleep();
  const { result, calls } = await run([row(1, dest("a"))], allSent, {
    mark_deliveries_sent: { error: "db down" },
  }, { sleep });
  assertEquals(calls.filter((c) => c.fn === "mark_deliveries_sent").length, 3);
  assertEquals(waits, [...BOOKKEEPING_RETRY_MS]);
  assertEquals(BOOKKEEPING_RETRY_MS, [500, 1_000]);
  assertEquals(result.errors, ["mark_deliveries_sent: db down"]);
});

Deno.test("runDeliveryBatch retries the push bookkeeping, which is safe to repeat", async () => {
  const { waits, sleep } = noSleep();
  let pruneFailures = 1;
  let recordFailures = 2;
  const p = dest("p", { type: "push", url: null, signing_secret: null, devices: [] });
  const { result, calls } = await run([row(1, p)], () =>
    Promise.resolve({
      ok: true,
      sent: 1,
      expiredEndpoints: ["https://fcm.googleapis.com/gone"],
      deviceResults: { ok: ["https://fcm.googleapis.com/ok"], errors: {} },
    }), {
    prune_push_devices: () => pruneFailures-- > 0 ? { error: "timeout" } : {},
    record_push_results: () => recordFailures-- > 0 ? { error: "timeout" } : {},
  }, { sleep });
  assertEquals(calls.map((c) => c.fn), [
    "claim_deliveries",
    "prune_push_devices",
    "prune_push_devices",
    "record_push_results",
    "record_push_results",
    "record_push_results",
    "mark_deliveries_sent",
  ]);
  assertEquals(waits, [500, 500, 1_000]);
  assertEquals(result.errors, []);
});

Deno.test("runDeliveryBatch tries mark_deliveries_failed and throttle_destination once: they count", async () => {
  // Both increment counters, so a retry after a commit whose answer was lost
  // would count the failure or the throttle twice.
  const { waits, sleep } = noSleep();
  const { result, calls } = await run(
    [row(1, dest("a")), row(2, dest("b"))],
    (d) =>
      Promise.resolve(
        d.id === "a"
          ? { ok: false, sent: 0, error: "Webhook HTTP 500" }
          : { ok: false, sent: 0, error: "Webhook HTTP 429", retryAfterSeconds: 30 },
      ),
    {
      mark_deliveries_failed: { error: "db down" },
      throttle_destination: { error: "db down" },
    },
    { sleep },
  );
  assertEquals(calls.map((c) => c.fn), [
    "claim_deliveries",
    "mark_deliveries_failed",
    "throttle_destination",
  ]);
  assertEquals(waits, []);
  assertEquals(result.errors, ["mark_deliveries_failed: db down", "throttle_destination: db down"]);
});

Deno.test("runDeliveryBatch reports progress on the claim, each send and each RPC that lands", async () => {
  const steps: ProgressStep[] = [];
  let markFailures = 1;
  await run(
    [row(1, dest("a")), row(2, dest("b")), row(3, dest("c"))],
    (d) =>
      Promise.resolve(
        d.id === "c" ? { ok: false, sent: 0, error: "Webhook HTTP 500" } : { ok: true, sent: 1 },
      ),
    {
      mark_deliveries_sent: () => markFailures-- > 0 ? { error: "reset" } : {},
    },
    { concurrency: 1, sleep: noSleep().sleep, onProgress: (step) => steps.push(step) },
  );
  // The failed first ack attempt is not progress; its retry is.
  assertEquals(steps, ["claim", "send", "send", "send", "bookkeeping", "bookkeeping"]);

  const none: ProgressStep[] = [];
  await run([], allSent, {}, { onProgress: (step) => none.push(step) });
  assertEquals(none, ["claim"]);
});

Deno.test("runDeliveryBatch prunes gone push devices and records device status before the ack", async () => {
  const p = dest("p", { type: "push", url: null, signing_secret: null, devices: [] });
  const { result, calls } = await run([row(1, p), row(2, p)], (_d, b) =>
    Promise.resolve({
      ok: true,
      sent: b.length,
      expiredEndpoints: ["https://fcm.googleapis.com/gone"],
      deviceResults: {
        ok: ["https://fcm.googleapis.com/ok"],
        errors: { "https://fcm.googleapis.com/bad": "Push HTTP 500" },
      },
    }));
  assertEquals(result.sent, 2);
  assertEquals(calls.slice(1), [
    { fn: "prune_push_devices", args: { p_endpoints: ["https://fcm.googleapis.com/gone"] } },
    {
      fn: "record_push_results",
      args: {
        p_ok: ["https://fcm.googleapis.com/ok"],
        p_errors: { "https://fcm.googleapis.com/bad": "Push HTTP 500" },
      },
    },
    { fn: "mark_deliveries_sent", args: { p_delivery_ids: [1, 2], p_msg_ids: [10, 20] } },
  ]);
});

Deno.test("runDeliveryBatch acks a quiet-skipped push batch with the cycle's one mark_deliveries_sent and nothing else", async () => {
  // sendPush on a "Don't send" destination in quiet hours makes no request and
  // reports the whole batch sent, with no device results to record.
  const d = dest("p", {
    type: "push",
    url: null,
    signing_secret: null,
    devices: [],
    quiet_now: true,
  });
  const { result, calls } = await run(
    [row(1, d), row(2, d)],
    (_d, b) => Promise.resolve({ ok: true, sent: b.length }),
  );
  assertEquals(result.sent, 2);
  assertEquals(result.failed, 0);
  assertEquals(calls.map((c) => c.fn), ["claim_deliveries", "mark_deliveries_sent"]);
  assertEquals(calls[1]!.args, { p_delivery_ids: [1, 2], p_msg_ids: [10, 20] });
});

Deno.test("runDeliveryBatch skips the push bookkeeping when there is nothing to report", async () => {
  const p = dest("p", { type: "push", url: null, signing_secret: null, devices: [] });
  const { calls } = await run([row(1, p)], () =>
    Promise.resolve({
      ok: false,
      sent: 0,
      error: "Turn on notifications on a device first.",
      expiredEndpoints: [],
      deviceResults: { ok: [], errors: {} },
    }));
  assertEquals(calls.map((c) => c.fn), ["claim_deliveries", "mark_deliveries_failed"]);
  assertEquals(calls[1]?.args["p_error"], "Turn on notifications on a device first.");
});

Deno.test("runDeliveryBatch passes the cycle clock to the sender", async () => {
  const seen: Date[] = [];
  const { db } = fakeRpc({ claim_deliveries: { data: [row(1, dest("a"))] } });
  await runDeliveryBatch(db, (_d, b, now) => {
    seen.push(now);
    return Promise.resolve({ ok: true, sent: b.length });
  }, NOW);
  assertEquals(seen, [NOW]);
});

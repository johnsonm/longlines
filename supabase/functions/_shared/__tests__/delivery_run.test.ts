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

interface RpcAnswer {
  data?: unknown;
  error?: string;
}

type Responder = RpcAnswer | ((args: Record<string, unknown>) => RpcAnswer);

/** A DeliveryRpc that records every call and answers from a table of responders. */
function fakeRpc(
  responders: Record<string, Responder>,
): { db: DeliveryRpc; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  const db: DeliveryRpc = {
    rpc(fn, args) {
      calls.push({ fn, args });
      const responder = responders[fn];
      let answer: RpcAnswer | undefined;
      if (typeof responder === "function") {
        answer = responder(args);
      } else {
        answer = responder;
      }
      let data: unknown = null;
      let error: string | null = null;
      if (answer !== null && answer !== undefined) {
        if (answer.data !== null && answer.data !== undefined) {
          data = answer.data;
        }
        if (answer.error !== null && answer.error !== undefined) {
          error = answer.error;
        }
      }
      return Promise.resolve({ data, error });
    },
  };
  return { db, calls };
}

function dest(id: string, overrides: Partial<DeliveryDestination>): DeliveryDestination {
  return Object.assign({
    id,
    type: "webhook",
    name: `Dest ${id}`,
    url: "https://example.com/hook",
    signing_secret: "whsec_x",
    health: "ok",
    consecutive_failures: 0,
  }, overrides);
}

function row(
  id: number,
  destination: DeliveryDestination,
  overrides: Partial<PendingDelivery>,
): PendingDelivery {
  return Object.assign({
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
  }, overrides);
}

type Send = (d: DeliveryDestination, b: readonly PendingDelivery[]) => Promise<SendResult>;

function allSent(_d: DeliveryDestination, b: readonly PendingDelivery[]): Promise<SendResult> {
  return Promise.resolve({ ok: true, sent: b.length });
}

/** Records the bookkeeping waits instead of sleeping, so retries cost no time. */
function noSleep() {
  const waits: number[] = [];
  return { waits, sleep: (ms: number) => (waits.push(ms), Promise.resolve()) };
}

/** One destination at a time, without real sleeps. */
function serialOptions(): Parameters<typeof runDeliveryBatch>[3] {
  return { concurrency: 1, sleep: noSleep().sleep };
}

async function run(
  rows: PendingDelivery[],
  send: Send,
  responders: Record<string, Responder>,
  options: Parameters<typeof runDeliveryBatch>[3],
) {
  const fake = fakeRpc(Object.assign({ claim_deliveries: { data: rows } }, responders));
  const sent: Array<{ destination: string; ids: number[] }> = [];
  function recordingSend(
    d: DeliveryDestination,
    b: readonly PendingDelivery[],
  ): Promise<SendResult> {
    sent.push({ destination: d.id, ids: b.map((r) => r.delivery_id) });
    return send(d, b);
  }
  const result = await runDeliveryBatch(fake.db, recordingSend, NOW, options);
  return { result, calls: fake.calls, sent };
}

/** One turn of the event loop, so pending sends get to start. */
function tick(): Promise<unknown> {
  return new Promise((r) => setTimeout(r, 0));
}

Deno.test(
  "runDeliveryBatch claims with the defaults, or the options given",
  async function (): Promise<void> {
    const out = await run([], allSent, {}, {});
    assertEquals(out.calls, [{
      fn: "claim_deliveries",
      args: { p_limit: CLAIM_LIMIT, p_vt: VISIBILITY_SECONDS },
    }]);
    assertEquals(out.result, {
      claimed: 0,
      sent: 0,
      failed: 0,
      throttled: 0,
      skipped_paused: 0,
      unattempted: 0,
      errors: [],
      destinations: [],
    });
    assertEquals(DEFAULT_CONCURRENCY, 4);

    const custom = await run([], allSent, {}, { claimLimit: 50, visibilitySeconds: 30 });
    assertEquals(custom.calls[0]!.args, { p_limit: 50, p_vt: 30 });
  },
);

Deno.test(
  "runDeliveryBatch throws ClaimError when the claim fails, before sending anything",
  async function (): Promise<void> {
    const fake = fakeRpc({ claim_deliveries: { error: "boom" } });
    let sends = 0;
    function countingSend(): Promise<SendResult> {
      sends++;
      return allSent(dest("a", {}), []);
    }
    await assertRejects(
      () => runDeliveryBatch(fake.db, countingSend, NOW, {}),
      ClaimError,
      "boom",
    );
    assertEquals(sends, 0);
    assertEquals(fake.calls.length, 1);
  },
);

Deno.test(
  "runDeliveryBatch groups by destination in claim order and acks every success in one call",
  async function (): Promise<void> {
    const a = dest("a", {});
    const b = dest("b", { type: "discord" });
    const out = await run(
      [row(1, a, {}), row(2, b, {}), row(3, a, {})],
      allSent,
      {},
      serialOptions(),
    );

    assertEquals(out.sent, [{ destination: "a", ids: [1, 3] }, { destination: "b", ids: [2] }]);
    assertEquals(out.result.claimed, 3);
    assertEquals(out.result.sent, 3);
    assertEquals(out.calls.slice(1), [
      { fn: "mark_deliveries_sent", args: { p_delivery_ids: [1, 3, 2], p_msg_ids: [10, 30, 20] } },
    ]);
    assertEquals(out.result.destinations, [
      {
        id: "a",
        type: "webhook",
        name: "Dest a",
        claimed: 2,
        sent: 2,
        failed: 0,
        throttled: 0,
        skipped_paused: 0,
        unattempted: 0,
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
        unattempted: 0,
      },
    ]);
  },
);

Deno.test(
  "runDeliveryBatch sends a day-old row like any other: expiry is SQL's job now",
  async function (): Promise<void> {
    const a = dest("a", {});
    const old = row(1, a, {
      created_at: new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString(),
    });
    const out = await run([old], allSent, {}, serialOptions());
    assertEquals(out.sent, [{ destination: "a", ids: [1] }]);
    assertEquals(out.calls.map((c) => c.fn), ["claim_deliveries", "mark_deliveries_sent"]);
  },
);

Deno.test(
  "runDeliveryBatch sends up to `concurrency` destinations at once, one send per destination",
  async function (): Promise<void> {
    function twoRows(id: string): PendingDelivery[] {
      const d = dest(id, {});
      return [row(id.charCodeAt(0) * 2, d, {}), row(id.charCodeAt(0) * 2 + 1, d, {})];
    }
    const rows = ["a", "b", "c", "d", "e"].flatMap(twoRows);
    const fake = fakeRpc({ claim_deliveries: { data: rows } });
    const pending: Array<{ id: string; resolve: () => void }> = [];
    let inFlight = 0;
    let peak = 0;
    function heldSend(d: DeliveryDestination, b: readonly PendingDelivery[]): Promise<SendResult> {
      inFlight++;
      peak = Math.max(peak, inFlight);
      assertEquals(b.length, 2, "every row of a destination goes in one send");
      return new Promise<SendResult>(function (resolve) {
        pending.push({
          id: d.id,
          resolve: function () {
            inFlight--;
            resolve({ ok: true, sent: b.length });
          },
        });
      });
    }
    const done = runDeliveryBatch(fake.db, heldSend, NOW, { concurrency: 2 });

    await tick();
    assertEquals(pending.map((p) => p.id), ["a", "b"]);
    pending.shift()!.resolve();
    await tick();
    assertEquals(pending.map((p) => p.id), ["b", "c"]);
    while (pending.length > 0) {
      pending.shift()!.resolve();
      await tick();
    }
    const result = await done;
    assertEquals(peak, 2);
    assertEquals(result.sent, 10);
    assertEquals(result.destinations.map((d) => d.id), ["a", "b", "c", "d", "e"]);
  },
);

Deno.test(
  "runDeliveryBatch with concurrency 1 sends destinations one after another",
  async function (): Promise<void> {
    const events: string[] = [];
    async function slowSend(d: DeliveryDestination): Promise<SendResult> {
      events.push(`start ${d.id}`);
      await new Promise((r) => setTimeout(r, 1));
      events.push(`end ${d.id}`);
      return { ok: true, sent: 1 };
    }
    const out = await run(
      [row(1, dest("a", {}), {}), row(2, dest("b", {}), {}), row(3, dest("c", {}), {})],
      slowSend,
      {},
      { concurrency: 1 },
    );
    assertEquals(events, ["start a", "end a", "start b", "end b", "start c", "end c"]);
    assertEquals(out.result.sent, 3);
  },
);

Deno.test(
  "runDeliveryBatch throttles the destination on a 429 with its Retry-After",
  async function (): Promise<void> {
    const a = dest("a", {});
    const out = await run(
      [row(1, a, {}), row(2, a, {}), row(3, a, {})],
      () => Promise.resolve({ ok: false, sent: 1, error: "HTTP 429", retryAfterSeconds: 7 }),
      {},
      serialOptions(),
    );
    assertEquals(out.result.sent, 1);
    assertEquals(out.result.throttled, 2);
    assertEquals(out.result.failed, 0);
    // The ack first: mark_deliveries_sent clears throttled_until, so the other order
    // would lose the throttle.
    assertEquals(out.calls.slice(1), [
      { fn: "mark_deliveries_sent", args: { p_delivery_ids: [1], p_msg_ids: [10] } },
      {
        fn: "throttle_destination",
        args: { p_destination_id: "a", p_msg_ids: [20, 30], p_seconds: 7 },
      },
    ]);
    assertEquals(out.result.destinations[0]!.throttled, 2);
    assertEquals(out.result.destinations[0]!.error, undefined);
  },
);

Deno.test(
  "runDeliveryBatch throttles with null seconds when the 429 had no Retry-After",
  async function (): Promise<void> {
    const a = dest("a", {});
    const out = await run(
      [row(1, a, {})],
      () => Promise.resolve({ ok: false, sent: 0, error: "HTTP 429", retryAfterSeconds: null }),
      {},
      serialOptions(),
    );
    assertEquals(out.result.throttled, 1);
    assertEquals(out.calls.slice(1), [{
      fn: "throttle_destination",
      args: { p_destination_id: "a", p_msg_ids: [10], p_seconds: null },
    }]);
    assertEquals(out.calls.some((c) => c.fn === "delay_deliveries"), false);
  },
);

Deno.test(
  "runDeliveryBatch never reaches the Discord cap under a budgeted claim",
  async function (): Promise<void> {
    // SQL hands a Discord webhook at most 300 spots a minute: 30 messages, the cap exactly.
    let posts = 0;
    const ac = new AbortController();
    function receive(): Response {
      posts++;
      return new Response(null, { status: 204 });
    }
    const server = Deno.serve(
      { port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen() {} },
      receive,
    );
    try {
      const d = dest("d", {
        type: "discord",
        url: `http://127.0.0.1:${server.addr.port}/api/webhooks/1/abc`,
      });
      const rows = Array.from({ length: 300 }, (_, i) => row(i + 1, d, {}));
      const fake = fakeRpc({ claim_deliveries: { data: rows } });
      const result = await runDeliveryBatch(
        fake.db,
        (destination, batch) => sendDiscord(destination, batch, { allowInsecure: true }),
        NOW,
        {},
      );
      assertEquals(posts, DISCORD_MESSAGES_PER_RUN);
      assertEquals(result.sent, 300);
      assertEquals(result.throttled, 0);
      assertEquals(fake.calls.map((c) => c.fn), ["claim_deliveries", "mark_deliveries_sent"]);
      assertEquals((fake.calls[1]!.args["p_delivery_ids"] as number[]).length, 300);
    } finally {
      ac.abort();
      await server.finished;
    }
  },
);

Deno.test(
  "runDeliveryBatch hands the Discord cap's overflow to throttle_destination",
  async function (): Promise<void> {
    const d = dest("d", { type: "discord" });
    const out = await run(
      [row(1, d, {}), row(2, d, {})],
      () =>
        Promise.resolve({
          ok: false,
          sent: 1,
          error: "Discord per-run message cap reached",
          retryAfterSeconds: 60,
        }),
      {},
      serialOptions(),
    );
    assertEquals(out.result.throttled, 1);
    assertEquals(out.calls[2], {
      fn: "throttle_destination",
      args: { p_destination_id: "d", p_msg_ids: [20], p_seconds: 60 },
    });
  },
);

Deno.test(
  "runDeliveryBatch marks failures per destination with backoff from the highest attempt",
  async function (): Promise<void> {
    const a = dest("a", {});
    const b = dest("b", {});
    function failing(d: DeliveryDestination): Promise<SendResult> {
      if (d.id === "a") {
        return Promise.resolve({ ok: false, sent: 0, error: "HTTP 500" });
      }
      return Promise.resolve({ ok: false, sent: 0 });
    }
    const out = await run(
      [row(1, a, { attempts: 1 }), row(2, a, { attempts: 3 }), row(3, b, {})],
      failing,
      {},
      serialOptions(),
    );
    assertEquals(out.result.failed, 3);
    assertEquals(out.result.sent, 0);
    assertEquals(out.calls.slice(1), [
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
    assertEquals(out.result.destinations.map((d) => d.error), ["HTTP 500", "unknown error"]);
  },
);

Deno.test(
  "runDeliveryBatch acks the sent part and fails the rest of a partial batch",
  async function (): Promise<void> {
    const a = dest("a", {});
    const out = await run(
      [row(1, a, {}), row(2, a, {})],
      () => Promise.resolve({ ok: false, sent: 1, error: "HTTP 502" }),
      {},
      serialOptions(),
    );
    assertEquals([out.result.sent, out.result.failed], [1, 1]);
    assertEquals(out.calls.map((c) => c.fn), [
      "claim_deliveries",
      "mark_deliveries_sent",
      "mark_deliveries_failed",
    ]);
  },
);

Deno.test(
  "runDeliveryBatch marks only a webhook's attempted rows failed and leaves the rest",
  async function (): Promise<void> {
    const a = dest("a", {});
    const rows = [1, 2, 3, 4, 5].map((id) => row(id, a, {}));
    // One request per spot, a 500 on the first: only that row was in a request.
    const out = await run(
      rows,
      () =>
        Promise.resolve({
          ok: false,
          sent: 0,
          attempted: 1,
          status: 500,
          error: "Webhook HTTP 500",
        }),
      {},
      serialOptions(),
    );
    assertEquals(out.calls.slice(1), [{
      fn: "mark_deliveries_failed",
      args: {
        p_delivery_ids: [1],
        p_msg_ids: [10],
        p_error: "Webhook HTTP 500",
        p_delay_seconds: backoffSeconds(1),
      },
    }]);
    assertEquals([out.result.failed, out.result.unattempted, out.result.sent], [1, 4, 0]);
    assertEquals(out.result.destinations[0]!.unattempted, 4);
    assertEquals(out.result.destinations[0]!.failed, 1);
  },
);

Deno.test(
  "runDeliveryBatch acks a webhook's sent rows and fails only the failed request's",
  async function (): Promise<void> {
    const a = dest("a", {});
    const rows = [1, 2, 3, 4, 5].map((id) => row(id, a, {}));
    const out = await run(
      rows,
      () => Promise.resolve({ ok: false, sent: 2, attempted: 3, error: "Webhook HTTP 500" }),
      {},
      serialOptions(),
    );
    assertEquals(out.calls.slice(1).map((c) => [c.fn, c.args.p_delivery_ids]), [
      ["mark_deliveries_sent", [1, 2]],
      ["mark_deliveries_failed", [3]],
    ]);
    assertEquals([out.result.sent, out.result.failed, out.result.unattempted], [2, 1, 2]);
  },
);

Deno.test(
  "runDeliveryBatch makes no failure call when nothing was attempted",
  async function (): Promise<void> {
    const a = dest("a", {});
    const out = await run(
      [row(1, a, {}), row(2, a, {})],
      () => Promise.resolve({ ok: false, sent: 0, attempted: 0, error: "nothing" }),
      {},
      serialOptions(),
    );
    assertEquals(out.calls.map((c) => c.fn), ["claim_deliveries"]);
    assertEquals([out.result.failed, out.result.unattempted], [0, 2]);
    assertEquals(out.result.destinations[0]!.error, "nothing");
  },
);

Deno.test(
  "runDeliveryBatch still throttles every unsent row on a webhook 429",
  async function (): Promise<void> {
    const a = dest("a", {});
    const rows = [1, 2, 3].map((id) => row(id, a, {}));
    const out = await run(
      rows,
      () =>
        Promise.resolve({
          ok: false,
          sent: 1,
          attempted: 2,
          status: 429,
          error: "Webhook HTTP 429 (rate limited)",
          retryAfterSeconds: null,
        }),
      {},
      serialOptions(),
    );
    assertEquals(out.calls[2], {
      fn: "throttle_destination",
      args: { p_destination_id: "a", p_msg_ids: [20, 30], p_seconds: null },
    });
    assertEquals([out.result.throttled, out.result.unattempted], [2, 0]);
  },
);

Deno.test(
  "runDeliveryBatch skips paused destinations so their messages reappear later",
  async function (): Promise<void> {
    const paused = dest("p", { health: "paused" });
    const out = await run([row(1, paused, {}), row(2, paused, {})], allSent, {}, serialOptions());
    assertEquals(out.result.skipped_paused, 2);
    assertEquals(out.sent, []);
    assertEquals(out.calls.length, 1);
    assertEquals(out.result.destinations[0]!.skipped_paused, 2);
  },
);

Deno.test(
  "runDeliveryBatch collects bookkeeping RPC errors instead of aborting",
  async function (): Promise<void> {
    const out = await run([row(1, dest("a", {}), {})], allSent, {
      mark_deliveries_sent: { error: "db down" },
    }, serialOptions());
    assertEquals(out.result.sent, 1);
    assertEquals(out.result.errors, ["mark_deliveries_sent: db down"]);
  },
);

Deno.test(
  "runDeliveryBatch retries a failed ack and records nothing once it lands",
  async function (): Promise<void> {
    let failures = 1;
    function markSent(): RpcAnswer {
      if (failures-- > 0) {
        return { error: "connection reset" };
      }
      return {};
    }
    const waiter = noSleep();
    const out = await run([row(1, dest("a", {}), {}), row(2, dest("a", {}), {})], allSent, {
      mark_deliveries_sent: markSent,
    }, { sleep: waiter.sleep });
    const marks = out.calls.filter((c) => c.fn === "mark_deliveries_sent");
    assertEquals(marks.length, 2);
    assertEquals(marks[1]!.args, { p_delivery_ids: [1, 2], p_msg_ids: [10, 20] });
    assertEquals(waiter.waits, [500]);
    assertEquals(out.result.errors, []);
    assertEquals(out.result.sent, 2);
  },
);

Deno.test(
  "runDeliveryBatch gives up on an ack after the bounded attempts and records the error",
  async function (): Promise<void> {
    const waiter = noSleep();
    const out = await run([row(1, dest("a", {}), {})], allSent, {
      mark_deliveries_sent: { error: "db down" },
    }, { sleep: waiter.sleep });
    assertEquals(out.calls.filter((c) => c.fn === "mark_deliveries_sent").length, 3);
    assertEquals(waiter.waits, Array.from(BOOKKEEPING_RETRY_MS));
    assertEquals(BOOKKEEPING_RETRY_MS, [500, 1_000]);
    assertEquals(out.result.errors, ["mark_deliveries_sent: db down"]);
  },
);

Deno.test(
  "runDeliveryBatch retries the push bookkeeping, which is safe to repeat",
  async function (): Promise<void> {
    const waiter = noSleep();
    let pruneFailures = 1;
    let recordFailures = 2;
    function prune(): RpcAnswer {
      if (pruneFailures-- > 0) {
        return { error: "timeout" };
      }
      return {};
    }
    function record(): RpcAnswer {
      if (recordFailures-- > 0) {
        return { error: "timeout" };
      }
      return {};
    }
    const p = dest("p", { type: "push", url: null, signing_secret: null, devices: [] });
    const out = await run([row(1, p, {})], () =>
      Promise.resolve({
        ok: true,
        sent: 1,
        expiredEndpoints: ["https://fcm.googleapis.com/gone"],
        deviceResults: { ok: ["https://fcm.googleapis.com/ok"], errors: {} },
      }), {
      prune_push_devices: prune,
      record_push_results: record,
    }, { sleep: waiter.sleep });
    assertEquals(out.calls.map((c) => c.fn), [
      "claim_deliveries",
      "prune_push_devices",
      "prune_push_devices",
      "record_push_results",
      "record_push_results",
      "record_push_results",
      "mark_deliveries_sent",
    ]);
    assertEquals(waiter.waits, [500, 500, 1_000]);
    assertEquals(out.result.errors, []);
  },
);

Deno.test(
  "runDeliveryBatch tries mark_deliveries_failed and throttle_destination once: they count",
  async function (): Promise<void> {
    // Both increment counters, so a retry after a commit whose answer was lost
    // would count the failure or the throttle twice.
    const waiter = noSleep();
    function failOrThrottle(d: DeliveryDestination): Promise<SendResult> {
      if (d.id === "a") {
        return Promise.resolve({ ok: false, sent: 0, error: "Webhook HTTP 500" });
      }
      return Promise.resolve({
        ok: false,
        sent: 0,
        error: "Webhook HTTP 429",
        retryAfterSeconds: 30,
      });
    }
    const out = await run(
      [row(1, dest("a", {}), {}), row(2, dest("b", {}), {})],
      failOrThrottle,
      {
        mark_deliveries_failed: { error: "db down" },
        throttle_destination: { error: "db down" },
      },
      { sleep: waiter.sleep },
    );
    assertEquals(out.calls.map((c) => c.fn), [
      "claim_deliveries",
      "mark_deliveries_failed",
      "throttle_destination",
    ]);
    assertEquals(waiter.waits, []);
    assertEquals(out.result.errors, [
      "mark_deliveries_failed: db down",
      "throttle_destination: db down",
    ]);
  },
);

Deno.test(
  "runDeliveryBatch reports progress on the claim, each send and each RPC that lands",
  async function (): Promise<void> {
    const steps: ProgressStep[] = [];
    let markFailures = 1;
    function sendOrFail(d: DeliveryDestination): Promise<SendResult> {
      if (d.id === "c") {
        return Promise.resolve({ ok: false, sent: 0, error: "Webhook HTTP 500" });
      }
      return Promise.resolve({ ok: true, sent: 1 });
    }
    function markSent(): RpcAnswer {
      if (markFailures-- > 0) {
        return { error: "reset" };
      }
      return {};
    }
    await run(
      [row(1, dest("a", {}), {}), row(2, dest("b", {}), {}), row(3, dest("c", {}), {})],
      sendOrFail,
      {
        mark_deliveries_sent: markSent,
      },
      { concurrency: 1, sleep: noSleep().sleep, onProgress: (step) => steps.push(step) },
    );
    // The failed first ack attempt is not progress; its retry is.
    assertEquals(steps, ["claim", "send", "send", "send", "bookkeeping", "bookkeeping"]);

    const none: ProgressStep[] = [];
    await run([], allSent, {}, { onProgress: (step) => none.push(step) });
    assertEquals(none, ["claim"]);
  },
);

Deno.test(
  "runDeliveryBatch prunes gone push devices and records device status before the ack",
  async function (): Promise<void> {
    const p = dest("p", { type: "push", url: null, signing_secret: null, devices: [] });
    const out = await run(
      [row(1, p, {}), row(2, p, {})],
      (_d, b) =>
        Promise.resolve({
          ok: true,
          sent: b.length,
          expiredEndpoints: ["https://fcm.googleapis.com/gone"],
          deviceResults: {
            ok: ["https://fcm.googleapis.com/ok"],
            errors: { "https://fcm.googleapis.com/bad": "Push HTTP 500" },
          },
        }),
      {},
      serialOptions(),
    );
    assertEquals(out.result.sent, 2);
    assertEquals(out.calls.slice(1), [
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
  },
);

Deno.test(
  "runDeliveryBatch acks a quiet-skipped push batch with the cycle's one mark_deliveries_sent and nothing else",
  async function (): Promise<void> {
    // sendPush on a "Don't send" destination in quiet hours makes no request and
    // reports the whole batch sent, with no device results to record.
    const d = dest("p", {
      type: "push",
      url: null,
      signing_secret: null,
      devices: [],
      quiet_now: true,
    });
    const out = await run(
      [row(1, d, {}), row(2, d, {})],
      (_d, b) => Promise.resolve({ ok: true, sent: b.length }),
      {},
      serialOptions(),
    );
    assertEquals(out.result.sent, 2);
    assertEquals(out.result.failed, 0);
    assertEquals(out.calls.map((c) => c.fn), ["claim_deliveries", "mark_deliveries_sent"]);
    assertEquals(out.calls[1]!.args, { p_delivery_ids: [1, 2], p_msg_ids: [10, 20] });
  },
);

Deno.test(
  "runDeliveryBatch skips the push bookkeeping when there is nothing to report",
  async function (): Promise<void> {
    const p = dest("p", { type: "push", url: null, signing_secret: null, devices: [] });
    const out = await run(
      [row(1, p, {})],
      () =>
        Promise.resolve({
          ok: false,
          sent: 0,
          error: "Turn on notifications on a device first.",
          expiredEndpoints: [],
          deviceResults: { ok: [], errors: {} },
        }),
      {},
      serialOptions(),
    );
    assertEquals(out.calls.map((c) => c.fn), ["claim_deliveries", "mark_deliveries_failed"]);
    assertEquals(out.calls[1]!.args["p_error"], "Turn on notifications on a device first.");
  },
);

Deno.test(
  "runDeliveryBatch passes the cycle clock to the sender",
  async function (): Promise<void> {
    const seen: Date[] = [];
    const fake = fakeRpc({ claim_deliveries: { data: [row(1, dest("a", {}), {})] } });
    function clockSend(
      _d: DeliveryDestination,
      b: readonly PendingDelivery[],
      now: Date,
    ): Promise<SendResult> {
      seen.push(now);
      return Promise.resolve({ ok: true, sent: b.length });
    }
    await runDeliveryBatch(fake.db, clockSend, NOW, {});
    assertEquals(seen, [NOW]);
  },
);

Deno.test(
  "runDeliveryBatch fails a destination whose send throws and still acks the others",
  async function (): Promise<void> {
    const a = dest("a", {});
    const b = dest("b", {});
    const c = dest("c", {});
    function throwingSend(
      d: DeliveryDestination,
      batch: readonly PendingDelivery[],
    ): Promise<SendResult> {
      if (d.id === "b") {
        return Promise.reject(new TypeError("toFixed of null"));
      }
      // A send that throws before returning a promise is caught the same way.
      if (d.id === "c") {
        throw new Error("sync boom");
      }
      return Promise.resolve({ ok: true, sent: batch.length });
    }
    const out = await run(
      [row(1, a, {}), row(2, b, { attempts: 2 }), row(3, b, {}), row(4, c, {})],
      throwingSend,
      {},
      serialOptions(),
    );
    assertEquals([out.result.sent, out.result.failed, out.result.unattempted], [1, 3, 0]);
    assertEquals(out.calls.slice(1), [
      { fn: "mark_deliveries_sent", args: { p_delivery_ids: [1], p_msg_ids: [10] } },
      {
        fn: "mark_deliveries_failed",
        args: {
          p_delivery_ids: [2, 3],
          p_msg_ids: [20, 30],
          p_error: "send threw: toFixed of null",
          p_delay_seconds: backoffSeconds(3),
        },
      },
      {
        fn: "mark_deliveries_failed",
        args: {
          p_delivery_ids: [4],
          p_msg_ids: [40],
          p_error: "send threw: sync boom",
          p_delay_seconds: backoffSeconds(1),
        },
      },
    ]);
    assertEquals(out.result.destinations.map((d) => d.error), [
      undefined,
      "send threw: toFixed of null",
      "send threw: sync boom",
    ]);
  },
);

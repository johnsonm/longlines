import { assertEquals } from "@std/assert";
import { backoffSeconds } from "../delivery/format.ts";
import type { SendResult } from "../delivery/send.ts";
import type { DeliveryDestination, PendingDelivery } from "../delivery/types.ts";
import {
  CLAIM_LIMIT,
  type DeliverSummary,
  handleDeliver,
  MAX_AGE_MS,
  VISIBILITY_SECONDS,
} from "../handlers/deliver.ts";
import { fakeSupabase, type FakeSupabaseOptions } from "./fake_supabase.ts";

const NOW = new Date("2026-10-05T14:00:00Z");
const KEY = "service-role-key";

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
    },
    ...overrides,
  };
}

function authed(token = KEY): Request {
  return new Request("http://x/", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function run(
  rows: PendingDelivery[],
  send: (d: DeliveryDestination, b: readonly PendingDelivery[]) => Promise<SendResult>,
  rpc: FakeSupabaseOptions["rpc"] = {},
) {
  const { client, calls } = fakeSupabase({ rpc: { claim_deliveries: { data: rows }, ...rpc } });
  const sent: Array<{ destination: string; ids: number[] }> = [];
  const res = await handleDeliver(authed(), {
    serviceRoleKey: KEY,
    db: () => client,
    send: (d, b) => {
      sent.push({ destination: d.id, ids: b.map((r) => r.delivery_id) });
      return send(d, b);
    },
  }, NOW);
  return { res, summary: (await res.json()) as DeliverSummary, calls, sent };
}

const allSent = (_d: DeliveryDestination, b: readonly PendingDelivery[]) =>
  Promise.resolve({ ok: true, sent: b.length });

Deno.test("handleDeliver rejects callers without the service-role key", async () => {
  const { client, calls } = fakeSupabase();
  const deps = { serviceRoleKey: KEY, db: () => client, send: allSent };
  assertEquals((await handleDeliver(authed("wrong"), deps, NOW)).status, 403);
  assertEquals((await handleDeliver(new Request("http://x/"), deps, NOW)).status, 403);
  const unset = { ...deps, serviceRoleKey: undefined };
  assertEquals((await handleDeliver(new Request("http://x/"), unset, NOW)).status, 403);
  assertEquals(calls.rpc, []);
});

Deno.test("handleDeliver returns 500 when the claim fails", async () => {
  const { client } = fakeSupabase({ rpc: { claim_deliveries: { error: { message: "boom" } } } });
  const res = await handleDeliver(authed(), {
    serviceRoleKey: KEY,
    db: () => client,
    send: allSent,
  }, NOW);
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { error: "boom" });
});

Deno.test("handleDeliver claims with the configured limit and visibility timeout", async () => {
  const { calls, summary } = await run([], allSent);
  assertEquals(calls.rpc, [{
    fn: "claim_deliveries",
    args: { p_limit: CLAIM_LIMIT, p_vt: VISIBILITY_SECONDS },
  }]);
  assertEquals(summary.claimed, 0);
});

Deno.test("handleDeliver groups by destination and marks successful sends", async () => {
  const a = dest("a");
  const b = dest("b", { type: "discord" });
  const { summary, calls, sent } = await run([row(1, a), row(2, b), row(3, a)], allSent);

  assertEquals(sent, [{ destination: "a", ids: [1, 3] }, { destination: "b", ids: [2] }]);
  assertEquals(summary.sent, 3);
  assertEquals(summary.claimed, 3);
  assertEquals(calls.rpc.slice(1), [
    { fn: "mark_deliveries_sent", args: { p_delivery_ids: [1, 3], p_msg_ids: [10, 30] } },
    { fn: "mark_deliveries_sent", args: { p_delivery_ids: [2], p_msg_ids: [20] } },
  ]);
});

Deno.test("handleDeliver drops deliveries older than the max age without sending them", async () => {
  const a = dest("a");
  const old = row(1, a, { created_at: new Date(NOW.getTime() - MAX_AGE_MS - 1).toISOString() });
  const { summary, calls, sent } = await run([old, row(2, a)], allSent);

  assertEquals(summary.dropped, 1);
  assertEquals(sent, [{ destination: "a", ids: [2] }]);
  assertEquals(calls.rpc[1], {
    fn: "mark_deliveries_dropped",
    args: { p_delivery_ids: [1], p_msg_ids: [10] },
  });
});

Deno.test("handleDeliver skips paused destinations so their messages reappear later", async () => {
  const paused = dest("p", { health: "paused" });
  const { summary, sent, calls } = await run([row(1, paused), row(2, paused)], allSent);
  assertEquals(summary.skipped_paused, 2);
  assertEquals(sent, []);
  assertEquals(calls.rpc.length, 1);
});

Deno.test("handleDeliver delays the unsent rest on a rate limit without failing it", async () => {
  const a = dest("a");
  const { summary, calls } = await run(
    [row(1, a), row(2, a), row(3, a)],
    () => Promise.resolve({ ok: false, sent: 1, retryAfterSeconds: 7 }),
  );
  assertEquals(summary.sent, 1);
  assertEquals(summary.delayed, 2);
  assertEquals(summary.failed, 0);
  assertEquals(calls.rpc.slice(1), [
    { fn: "mark_deliveries_sent", args: { p_delivery_ids: [1], p_msg_ids: [10] } },
    { fn: "delay_deliveries", args: { p_msg_ids: [20, 30], p_delay_seconds: 7 } },
  ]);
});

Deno.test("handleDeliver marks failures with backoff from the highest attempt count", async () => {
  const a = dest("a");
  const { summary, calls } = await run(
    [row(1, a, { attempts: 1 }), row(2, a, { attempts: 3 })],
    () => Promise.resolve({ ok: false, sent: 0, error: "HTTP 500" }),
  );
  assertEquals(summary.failed, 2);
  assertEquals(calls.rpc[1], {
    fn: "mark_deliveries_failed",
    args: {
      p_delivery_ids: [1, 2],
      p_msg_ids: [10, 20],
      p_error: "HTTP 500",
      p_delay_seconds: backoffSeconds(4),
    },
  });
});

Deno.test("handleDeliver records a placeholder error when the sender gives none", async () => {
  const { calls } = await run([row(1, dest("a"))], () => Promise.resolve({ ok: false, sent: 0 }));
  assertEquals(calls.rpc[1]?.args?.["p_error"], "unknown error");
});

Deno.test("handleDeliver collects bookkeeping RPC errors instead of aborting", async () => {
  const { res, summary } = await run([row(1, dest("a"))], allSent, {
    mark_deliveries_sent: { error: { message: "db down" } },
  });
  assertEquals(res.status, 200);
  assertEquals(summary.sent, 1);
  assertEquals(summary.errors, ["mark_deliveries_sent: db down"]);
});

Deno.test("handleDeliver accepts the gateway-verified service-role JWT pg_cron sends", async () => {
  // The runtime's SUPABASE_SERVICE_ROLE_KEY is now the sb_secret_ key; cron sends the legacy JWT.
  const b64url = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const cronJwt = `${b64url({ alg: "HS256" })}.${b64url({ role: "service_role" })}.sig`;
  const { client } = fakeSupabase({ rpc: { claim_deliveries: { data: [] } } });
  const deps = { serviceRoleKey: "sb_secret_runtime", db: () => client, send: allSent };
  assertEquals((await handleDeliver(authed(cronJwt), deps, NOW)).status, 200);
});

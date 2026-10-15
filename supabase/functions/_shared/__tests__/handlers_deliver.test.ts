import { assertEquals } from "@std/assert";
import { CLAIM_LIMIT, VISIBILITY_SECONDS } from "../delivery/run.ts";
import type { DeliveryDestination, PendingDelivery } from "../delivery/types.ts";
import { type DeliverSummary, handleDeliver, supabaseDeliveryRpc } from "../handlers/deliver.ts";
import { fakeSupabase } from "./fake_supabase.ts";

// The loop itself is covered by delivery_run.test.ts; this file keeps the
// handler's own concerns: auth, the claim failure and the supabase-js adapter.

const NOW = new Date("2026-10-05T14:00:00Z");
const KEY = "service-role-key";

const DEST: DeliveryDestination = {
  id: "a",
  type: "webhook",
  name: "Dest a",
  url: "https://example.com/hook",
  signing_secret: "whsec_x",
  health: "ok",
  consecutive_failures: 0,
};

const ROW: PendingDelivery = {
  msg_id: 10,
  delivery_id: 1,
  subscription_id: "s1",
  attempts: 0,
  created_at: new Date(NOW.getTime() - 60_000).toISOString(),
  destination: DEST,
  spot: {
    id: 1,
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
  },
};

function authed(token = KEY): Request {
  return new Request("http://x/", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
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

Deno.test("handleDeliver accepts the gateway-verified service-role JWT pg_cron sends", async () => {
  // The runtime's SUPABASE_SERVICE_ROLE_KEY is now the sb_secret_ key; cron sends the legacy JWT.
  const b64url = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const cronJwt = `${b64url({ alg: "HS256" })}.${b64url({ role: "service_role" })}.sig`;
  const { client } = fakeSupabase({ rpc: { claim_deliveries: { data: [] } } });
  const deps = { serviceRoleKey: "sb_secret_runtime", db: () => client, send: allSent };
  assertEquals((await handleDeliver(authed(cronJwt), deps, NOW)).status, 200);
});

Deno.test("handleDeliver runs one cycle over supabase-js and answers with its summary", async () => {
  const { client, calls } = fakeSupabase({ rpc: { claim_deliveries: { data: [ROW] } } });
  const res = await handleDeliver(authed(), {
    serviceRoleKey: KEY,
    db: () => client,
    send: allSent,
  }, NOW);
  assertEquals(res.status, 200);
  const summary = (await res.json()) as DeliverSummary;
  assertEquals([summary.claimed, summary.sent, summary.failed], [1, 1, 0]);
  assertEquals(calls.rpc, [
    { fn: "claim_deliveries", args: { p_limit: CLAIM_LIMIT, p_vt: VISIBILITY_SECONDS } },
    { fn: "mark_deliveries_sent", args: { p_delivery_ids: [1], p_msg_ids: [10] } },
  ]);
});

Deno.test("supabaseDeliveryRpc flattens the client's error to its message", async () => {
  const { client } = fakeSupabase({
    rpc: { ok: { data: [1, 2] }, bad: { error: { message: "nope", code: "P0001" } } },
  });
  const db = supabaseDeliveryRpc(client);
  assertEquals(await db.rpc("ok", {}), { data: [1, 2], error: null });
  assertEquals(await db.rpc("bad", {}), { data: null, error: "nope" });
});

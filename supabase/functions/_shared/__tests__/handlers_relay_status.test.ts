import { assertEquals } from "@std/assert";
import { handleRelayStatus, parseRelayStatus } from "../handlers/relay_status.ts";
import { fakeSupabase, type FakeSupabaseOptions } from "./fake_supabase.ts";

const SECRET = "relay-secret";
const BODY = {
  started_at: "2026-10-21T12:00:00.000Z",
  rss_bytes: 21_000_000,
  reconnects: 2,
  feeds: [{ id: "rbn", connected: true }, { id: "dxcluster", connected: false }],
};

function post(body: unknown, secret = SECRET, method = "POST"): Request {
  return new Request("http://x/relay-status", {
    method,
    headers: { "x-relay-secret": secret, "Content-Type": "application/json" },
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
}

async function run(
  req: Request,
  options: FakeSupabaseOptions = {},
  secret: string | null = SECRET,
) {
  const fake = fakeSupabase(options);
  const res = await handleRelayStatus(req, { secret: secret ?? undefined, db: () => fake.client });
  return { res, calls: fake.calls };
}

Deno.test("records the heartbeat", async () => {
  const { res, calls } = await run(post(BODY), { rpc: { record_relay_heartbeat: { data: null } } });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
  assertEquals(calls.rpc, [{
    fn: "record_relay_heartbeat",
    args: {
      p_started_at: BODY.started_at,
      p_rss_bytes: 21_000_000,
      p_reconnects: 2,
      p_feeds: BODY.feeds,
    },
  }]);
});

Deno.test("checks the secret before anything else", async () => {
  const unset = await run(post(BODY), {}, null);
  assertEquals(unset.res.status, 500);
  const wrong = await run(post(BODY, "nope"));
  assertEquals(wrong.res.status, 401);
  assertEquals([...unset.calls.rpc, ...wrong.calls.rpc], []);
});

Deno.test("refuses anything but POST, and a body that is not JSON", async () => {
  assertEquals((await run(post(null, SECRET, "GET"))).res.status, 405);
  assertEquals((await run(post("{"))).res.status, 400);
});

Deno.test("a database error is a 500", async () => {
  const { res } = await run(post(BODY), {
    rpc: { record_relay_heartbeat: { error: { message: "boom" } } },
  });
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { error: "boom" });
});

Deno.test("parseRelayStatus refuses malformed heartbeats", () => {
  const bad: unknown[] = [
    null,
    [],
    { ...BODY, started_at: "yesterday" },
    { ...BODY, rss_bytes: -1 },
    { ...BODY, reconnects: 1.5 },
    { ...BODY, feeds: "rbn" },
    { ...BODY, feeds: Array.from({ length: 11 }, () => ({ id: "rbn", connected: true })) },
    { ...BODY, feeds: [{ id: "rbn" }] },
  ];
  for (const body of bad) {
    assertEquals(typeof parseRelayStatus(body), "string", JSON.stringify(body));
  }
  assertEquals(
    parseRelayStatus({ ...BODY, extra: 1, feeds: [{ id: "rbn", connected: true, x: 1 }] }),
    {
      ...BODY,
      feeds: [{ id: "rbn", connected: true }],
    },
  );
});

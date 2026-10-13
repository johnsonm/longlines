import { assertEquals } from "@std/assert";
import type { SendResult } from "../delivery/send.ts";
import type { DeliveryDestination } from "../delivery/types.ts";
import { hashApiToken } from "../api/token.ts";
import {
  BAD_BODY,
  BAD_TOKEN,
  BODY_TOO_LARGE,
  handleApi,
  MAX_REQUESTS_PER_MINUTE,
  NOT_FOUND,
  READ_ONLY,
  SERVER_ERROR,
  TOO_MANY_REQUESTS,
} from "../handlers/api.ts";
import { fakeSupabase, type FakeSupabaseOptions } from "./fake_supabase.ts";

const NOW = new Date("2026-10-13T14:00:45Z");
const TOKEN = `ll_live_${"abcdefghijklmnopqrstuvwxyz234567".repeat(2).slice(0, 52)}`;
const ID = "0e7db3d0-52fa-4690-8f4a-79e468d6cf67";
const WRITE = { token_id: "t1", user_id: "u1", scope: "write", requests: 1 };
const DEST: DeliveryDestination = {
  id: ID,
  type: "webhook",
  name: "Hook",
  url: "https://example.com/h",
  signing_secret: "whsec_x",
  health: "ok",
  consecutive_failures: 0,
};

function request(
  method: string,
  path: string,
  body?: unknown,
  token: string | null = TOKEN,
): Request {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  return new Request(`http://x${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function run(req: Request, options: FakeSupabaseOptions = {}) {
  const { client, calls } = fakeSupabase({
    ...options,
    rpc: { authenticate_api_request: { data: [WRITE] }, ...options.rpc },
  });
  const sent: DeliveryDestination[] = [];
  const result: SendResult = { ok: true, sent: 1 };
  const res = await handleApi(req, {
    db: () => client,
    send: (destination) => {
      sent.push(destination);
      return Promise.resolve(result);
    },
  }, NOW);
  return { res, body: await res.json(), calls, sent };
}

Deno.test("handleApi answers unknown paths and wrong methods before checking the token", async () => {
  const unknown = await run(request("GET", "/api/v1/nope", undefined, null));
  assertEquals([unknown.res.status, unknown.body], [404, { error: NOT_FOUND }]);
  assertEquals((await run(request("GET", "/elsewhere"))).res.status, 404);
  const wrong = await run(request("DELETE", "/api/v1/subscriptions", undefined, null));
  assertEquals(wrong.res.status, 405);
  assertEquals(wrong.res.headers.get("Allow"), "GET, POST");
  assertEquals(wrong.calls.rpc, []);
});

Deno.test("handleApi refuses missing, malformed and unknown tokens", async () => {
  for (const token of [null, "eyJ.a.b", "ll_live_short"]) {
    const { res, body, calls } = await run(request("GET", "/api/v1/groups", undefined, token));
    assertEquals([res.status, body], [401, { error: BAD_TOKEN }]);
    assertEquals(calls.rpc, []);
  }
  const unknown = await run(request("GET", "/api/v1/groups"), {
    rpc: { authenticate_api_request: { data: [] } },
  });
  assertEquals(unknown.res.status, 401);
  assertEquals(unknown.calls.rpc, [{
    fn: "authenticate_api_request",
    args: { p_token_hash: await hashApiToken(TOKEN) },
  }]);
});

Deno.test("handleApi rate limits per token with Retry-After to the next minute", async () => {
  const { res, body, calls } = await run(request("GET", "/api/v1/groups"), {
    rpc: {
      authenticate_api_request: { data: [{ ...WRITE, requests: MAX_REQUESTS_PER_MINUTE + 1 }] },
    },
  });
  assertEquals([res.status, body], [429, { error: TOO_MANY_REQUESTS }]);
  assertEquals(res.headers.get("Retry-After"), "15");
  assertEquals(calls.rpc.length, 1);
});

Deno.test("handleApi lets a read token read but not write", async () => {
  const rpc = {
    authenticate_api_request: { data: [{ ...WRITE, scope: "read" }] },
    api_call: { data: [] },
  };
  const read = await run(request("GET", "/api/v1/subscriptions"), { rpc });
  assertEquals([read.res.status, read.body], [200, []]);
  const write = await run(request("POST", "/api/v1/groups", { name: "Club" }), { rpc });
  assertEquals([write.res.status, write.body], [403, { error: READ_ONLY }]);
  assertEquals(write.calls.rpc.map((c) => c.fn), ["authenticate_api_request"]);
});

Deno.test("handleApi runs the route's op as the token and returns its result", async () => {
  const created = { id: ID, name: "Club", member_count: 0, subscription_count: 0 };
  const { res, body, calls } = await run(request("POST", "/api/v1/groups", { name: "Club" }), {
    rpc: { api_call: { data: created } },
  });
  assertEquals([res.status, body], [201, created]);
  assertEquals(calls.rpc[1], {
    fn: "api_call",
    args: { p_token_id: "t1", p_op: "create_group", p_args: { name: "Club" } },
  });
});

Deno.test("handleApi wants a JSON object body of the right shape", async () => {
  for (const body of ["not json", "[1]", "null"]) {
    const res = await run(request("POST", `/api/v1/subscriptions/${ID}/callsigns`, body));
    assertEquals([res.res.status, res.body], [400, { error: BAD_BODY }]);
  }
  const shape = await run(
    request("POST", `/api/v1/subscriptions/${ID}/callsigns`, { callsigns: "W1AW" }),
  );
  assertEquals([shape.res.status, shape.body], [400, {
    error: "callsigns must be a list of strings.",
  }]);
  const big = await run(request("POST", "/api/v1/groups", { name: "x".repeat(300 * 1024) }));
  assertEquals([big.res.status, big.body], [413, { error: BODY_TOO_LARGE }]);
});

Deno.test("handleApi passes SQL messages through with a matching status", async () => {
  const fail = (message: string, code = "P0001") =>
    run(request("DELETE", `/api/v1/destinations/${ID}`), {
      rpc: { api_call: { error: { message, code } } },
    });
  const inUse = await fail("Remove it from its subscriptions first.");
  assertEquals([inUse.res.status, inUse.body], [409, {
    error: "Remove it from its subscriptions first.",
  }]);
  assertEquals((await fail("Destination not found.")).res.status, 404);
  const broken = await fail("deadlock detected", "40P01");
  assertEquals([broken.res.status, broken.body], [500, { error: SERVER_ERROR }]);
});

Deno.test("handleApi reports a failed token lookup as a server error", async () => {
  const { res, body } = await run(request("GET", "/api/v1/groups"), {
    rpc: { authenticate_api_request: { error: { message: "connection refused" } } },
  });
  assertEquals([res.status, body], [500, { error: SERVER_ERROR }]);
});

Deno.test("handleApi sends a test to the token owner's destination", async () => {
  const { res, body, calls, sent } = await run(request("POST", `/api/v1/destinations/${ID}/test`), {
    from: { destinations: { data: DEST } },
  });
  assertEquals([res.status, body], [200, { ok: true }]);
  assertEquals(sent.map((d) => d.id), [ID]);
  assertEquals(calls.from[0]?.ops.filter(([op]) => op === "eq"), [
    ["eq", ["id", ID]],
    ["eq", ["user_id", "u1"]],
  ]);
  assertEquals(calls.rpc.map((c) => c.fn), ["authenticate_api_request"]);
});

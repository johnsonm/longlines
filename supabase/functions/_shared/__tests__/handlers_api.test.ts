import { assertEquals } from "@std/assert";
import type { SendResult } from "../delivery/send.ts";
import type { DeliveryDestination } from "../delivery/types.ts";
import { hashApiToken } from "../api/token.ts";
import {
  BAD_BODY,
  BAD_TOKEN,
  BODY_TOO_LARGE,
  handleApi,
  MAX_BODY_BYTES,
  MAX_REQUESTS_PER_MINUTE,
  NOT_FOUND,
  READ_ONLY,
  readBody,
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
  body: unknown,
  token: string | null,
): Request {
  const headers: Record<string, string> = {};
  if (token !== null && token !== "") {
    headers.Authorization = `Bearer ${token}`;
  }
  let text: string | undefined;
  if (body === undefined) {
    text = undefined;
  } else if (typeof body === "string") {
    text = body;
  } else {
    text = JSON.stringify(body);
  }
  return new Request(`http://x${path}`, {
    method,
    headers,
    body: text,
  });
}

const SENT_ONE: SendResult = { ok: true, sent: 1 };

async function run(
  req: Request,
  options: FakeSupabaseOptions,
  result: SendResult,
) {
  const rpc: NonNullable<FakeSupabaseOptions["rpc"]> = {
    authenticate_api_request: { data: [WRITE] },
  };
  if (options.rpc !== undefined) {
    for (const entry of Object.entries(options.rpc)) {
      rpc[entry[0]] = entry[1];
    }
  }
  const fake = fakeSupabase({
    rpc,
    from: options.from,
    getUser: options.getUser,
    deleteUser: options.deleteUser,
    signInWithPassword: options.signInWithPassword,
  });
  const sent: DeliveryDestination[] = [];
  function send(destination: DeliveryDestination): Promise<SendResult> {
    sent.push(destination);
    return Promise.resolve(result);
  }
  const res = await handleApi(req, {
    db: () => fake.client,
    send,
  }, NOW);
  return { res, body: await res.json(), calls: fake.calls, sent };
}

Deno.test(
  "handleApi answers unknown paths and wrong methods before checking the token",
  async function (): Promise<void> {
    const unknown = await run(request("GET", "/api/v1/nope", undefined, null), {}, SENT_ONE);
    assertEquals([unknown.res.status, unknown.body], [404, { error: NOT_FOUND }]);
    assertEquals(
      (await run(request("GET", "/elsewhere", undefined, TOKEN), {}, SENT_ONE)).res.status,
      404,
    );
    const wrong = await run(
      request("DELETE", "/api/v1/connections", undefined, null),
      {},
      SENT_ONE,
    );
    assertEquals(wrong.res.status, 405);
    assertEquals(wrong.res.headers.get("Allow"), "GET, POST");
    assertEquals(wrong.calls.rpc, []);
  },
);

Deno.test(
  "handleApi answers a CORS preflight for every method without a token",
  async function (): Promise<void> {
    const fake = fakeSupabase({});
    const res = await handleApi(request("OPTIONS", `/api/v1/connections/${ID}`, undefined, null), {
      db: () => fake.client,
      send: () => Promise.resolve({ ok: true, sent: 1 }),
    }, NOW);
    assertEquals(res.status, 204);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
    assertEquals(
      res.headers.get("Access-Control-Allow-Methods"),
      "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    );
    const allowHeaders = res.headers.get("Access-Control-Allow-Headers");
    assertEquals(allowHeaders !== null && allowHeaders.includes("authorization"), true);
    assertEquals(res.headers.get("Access-Control-Max-Age"), "600");
    assertEquals(fake.calls.rpc, []);
  },
);

Deno.test(
  "handleApi refuses missing, malformed and unknown tokens",
  async function (): Promise<void> {
    for (const token of [null, "eyJ.a.b", "ll_live_short"]) {
      const refused = await run(request("GET", "/api/v1/groups", undefined, token), {}, SENT_ONE);
      assertEquals([refused.res.status, refused.body], [401, { error: BAD_TOKEN }]);
      assertEquals(refused.calls.rpc, []);
    }
    const unknown = await run(request("GET", "/api/v1/groups", undefined, TOKEN), {
      rpc: { authenticate_api_request: { data: [] } },
    }, SENT_ONE);
    assertEquals(unknown.res.status, 401);
    assertEquals(unknown.calls.rpc, [{
      fn: "authenticate_api_request",
      args: { p_token_hash: await hashApiToken(TOKEN) },
    }]);
  },
);

Deno.test(
  "handleApi rate limits per token with Retry-After to the next minute",
  async function (): Promise<void> {
    const caller = {
      token_id: WRITE.token_id,
      user_id: WRITE.user_id,
      scope: WRITE.scope,
      requests: MAX_REQUESTS_PER_MINUTE + 1,
    };
    const limited = await run(request("GET", "/api/v1/groups", undefined, TOKEN), {
      rpc: { authenticate_api_request: { data: [caller] } },
    }, SENT_ONE);
    assertEquals([limited.res.status, limited.body], [429, { error: TOO_MANY_REQUESTS }]);
    assertEquals(limited.res.headers.get("Retry-After"), "15");
    assertEquals(limited.calls.rpc.length, 1);
  },
);

Deno.test("handleApi lets a read token read but not write", async function (): Promise<void> {
  const rpc = {
    authenticate_api_request: {
      data: [{
        token_id: WRITE.token_id,
        user_id: WRITE.user_id,
        scope: "read",
        requests: WRITE.requests,
      }],
    },
    api_call: { data: [] },
  };
  const read = await run(
    request("GET", "/api/v1/connections", undefined, TOKEN),
    { rpc },
    SENT_ONE,
  );
  assertEquals([read.res.status, read.body], [200, []]);
  const write = await run(
    request("POST", "/api/v1/groups", { name: "Club" }, TOKEN),
    { rpc },
    SENT_ONE,
  );
  assertEquals([write.res.status, write.body], [403, { error: READ_ONLY }]);
  assertEquals(write.calls.rpc.map((c) => c.fn), ["authenticate_api_request"]);
});

Deno.test(
  "handleApi runs the route's op as the token and returns its result",
  async function (): Promise<void> {
    const created = { id: ID, name: "Club", member_count: 0, subscription_count: 0 };
    const ran = await run(request("POST", "/api/v1/groups", { name: "Club" }, TOKEN), {
      rpc: { api_call: { data: created } },
    }, SENT_ONE);
    assertEquals([ran.res.status, ran.body], [201, created]);
    assertEquals(ran.calls.rpc[1], {
      fn: "api_call",
      args: { p_token_id: "t1", p_op: "create_group", p_args: { name: "Club" } },
    });
  },
);

Deno.test(
  "handleApi wants a JSON object body of the right shape",
  async function (): Promise<void> {
    for (const body of ["not json", "[1]", "null"]) {
      const res = await run(
        request("POST", `/api/v1/groups/${ID}/members`, body, TOKEN),
        {},
        SENT_ONE,
      );
      assertEquals([res.res.status, res.body], [400, { error: BAD_BODY }]);
    }
    const shape = await run(
      request("POST", `/api/v1/groups/${ID}/members`, { callsigns: "W1AW" }, TOKEN),
      {},
      SENT_ONE,
    );
    assertEquals([shape.res.status, shape.body], [400, {
      error: "callsigns must be a list of strings.",
    }]);
    const big = await run(
      request("POST", "/api/v1/groups", { name: "x".repeat(300 * 1024) }, TOKEN),
      {},
      SENT_ONE,
    );
    assertEquals([big.res.status, big.body], [413, { error: BODY_TOO_LARGE }]);
  },
);

Deno.test(
  "readBody refuses an oversized body without reading all of it",
  async function (): Promise<void> {
    const declared = new Request("http://x/", {
      method: "POST",
      body: "{}",
      headers: { "content-length": String(MAX_BODY_BYTES + 1) },
    });
    assertEquals(await readBody(declared, MAX_BODY_BYTES), null);
    if (declared.body !== null) {
      await declared.body.cancel();
    }

    let pulled = 0;
    const chunk = new Uint8Array(1024).fill(32);
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(chunk);
      },
    });
    const chunked = new Request("http://x/", { method: "POST", body: endless });
    assertEquals(await readBody(chunked, 4096), null);
    assertEquals(pulled <= 6, true, `pulled ${pulled} chunks`);

    const small = new Request("http://x/", { method: "POST", body: '{"a":"é"}' });
    assertEquals(await readBody(small, 4096), '{"a":"é"}');
    assertEquals(await readBody(new Request("http://x/"), 4096), "");
  },
);

Deno.test(
  "handleApi passes SQL messages through with a matching status",
  async function (): Promise<void> {
    function fail(message: string, code: string) {
      return run(request("DELETE", `/api/v1/destinations/${ID}`, undefined, TOKEN), {
        rpc: { api_call: { error: { message, code } } },
      }, SENT_ONE);
    }
    const inUse = await fail("Remove it from its connections first.", "LL409");
    assertEquals([inUse.res.status, inUse.body], [409, {
      error: "Remove it from its connections first.",
    }]);
    assertEquals((await fail("Destination not found.", "LL404")).res.status, 404);
    assertEquals((await fail("Destination not found.", "P0001")).res.status, 400);
    const broken = await fail("deadlock detected", "40P01");
    assertEquals([broken.res.status, broken.body], [500, { error: SERVER_ERROR }]);
  },
);

Deno.test(
  "handleApi reports a failed token lookup as a server error",
  async function (): Promise<void> {
    const failed = await run(request("GET", "/api/v1/groups", undefined, TOKEN), {
      rpc: { authenticate_api_request: { error: { message: "connection refused" } } },
    }, SENT_ONE);
    assertEquals([failed.res.status, failed.body], [500, { error: SERVER_ERROR }]);
  },
);

const WEBHOOK_TEST = {
  webhook: { batch_seconds: 0, headers: [] },
  spot: { id: 0, webhook_connection: "Test", webhook_fields: [{ key: "id", value: 0 }] },
};

Deno.test(
  "handleApi sends a test to the token owner's destination",
  async function (): Promise<void> {
    const tested = await run(
      request("POST", `/api/v1/destinations/${ID}/test`, undefined, TOKEN),
      {
        from: { destinations: { data: DEST } },
        rpc: { webhook_test_delivery: { data: WEBHOOK_TEST } },
      },
      { ok: true, sent: 1, attempted: 1, status: 204 },
    );
    const calls = tested.calls;
    assertEquals([tested.res.status, tested.body], [200, { ok: true, status: 204 }]);
    assertEquals(tested.sent.map((d) => d.id), [ID]);
    const lookup = calls.from[0];
    let eqs: Array<[string, unknown[]]> | undefined;
    if (lookup !== undefined) {
      eqs = lookup.ops.filter((o) => o[0] === "eq");
    }
    assertEquals(eqs, [
      ["eq", ["id", ID]],
      ["eq", ["user_id", "u1"]],
    ]);
    assertEquals(calls.rpc.map((c) => c.fn), ["authenticate_api_request", "webhook_test_delivery"]);
    // The API never picks a spot: the sample.
    const sample = calls.rpc[1];
    let sampleArgs: Record<string, unknown> | undefined;
    if (sample !== undefined) {
      sampleArgs = sample.args;
    }
    assertEquals(sampleArgs, { p_destination_id: ID, p_spot_id: null });
  },
);

Deno.test(
  "handleApi passes a failed test's receiver status through with 502",
  async function (): Promise<void> {
    const failed = await run(
      request("POST", `/api/v1/destinations/${ID}/test`, undefined, TOKEN),
      {
        from: { destinations: { data: DEST } },
        rpc: { webhook_test_delivery: { data: WEBHOOK_TEST } },
      },
      { ok: false, sent: 0, attempted: 1, status: 500, error: "Webhook HTTP 500" },
    );
    assertEquals([failed.res.status, failed.body], [502, {
      error: "Webhook HTTP 500",
      status: 500,
    }]);
  },
);

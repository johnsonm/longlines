import { assertEquals } from "@std/assert";
import { handleInboundStatus, parseInboundStatus } from "../handlers/inbound_status.ts";
import { fakeSupabase, type FakeSupabaseOptions } from "./fake_supabase.ts";

const SECRET = "inbound-secret";
const BODY = {
  started_at: "2026-10-21T12:00:00.000Z",
  rss_bytes: 21_000_000,
  reconnects: 2,
  feeds: [{ id: "rbn", connected: true }, { id: "dxcluster", connected: false }],
};

/** BODY with one field replaced, or added at the end. */
function bodyWith(key: string, value: unknown): Record<string, unknown> {
  const body: Record<string, unknown> = {
    started_at: BODY.started_at,
    rss_bytes: BODY.rss_bytes,
    reconnects: BODY.reconnects,
    feeds: BODY.feeds,
  };
  body[key] = value;
  return body;
}

function post(body: unknown, secret: string, method: string): Request {
  const init: RequestInit = {
    method,
    headers: { "x-inbound-secret": secret, "Content-Type": "application/json" },
  };
  if (method === "POST") {
    if (typeof body === "string") {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
    }
  }
  return new Request("http://x/inbound-status", init);
}

/** A POST whose body stream fails partway, for the read-failure paths. */
function brokenPost(secret: string): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.error(new Error("connection reset"));
    },
  });
  return new Request("http://x/", {
    method: "POST",
    headers: { "x-inbound-secret": secret },
    body,
  });
}

async function run(
  req: Request,
  options: FakeSupabaseOptions,
  secret: string | null,
) {
  const fake = fakeSupabase(options);
  let configured: string | undefined = undefined;
  if (secret !== null && secret !== undefined) {
    configured = secret;
  }
  const res = await handleInboundStatus(req, { secret: configured, db: () => fake.client });
  return { res, calls: fake.calls };
}

Deno.test("records the heartbeat", async function (): Promise<void> {
  const ran = await run(post(BODY, SECRET, "POST"), {
    rpc: { record_inbound_heartbeat: { data: null } },
  }, SECRET);
  const res = ran.res;
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
  assertEquals(ran.calls.rpc, [{
    fn: "record_inbound_heartbeat",
    args: {
      p_started_at: BODY.started_at,
      p_rss_bytes: 21_000_000,
      p_reconnects: 2,
      p_feeds: BODY.feeds,
    },
  }]);
});

Deno.test("checks the secret before anything else", async function (): Promise<void> {
  const unset = await run(post(BODY, SECRET, "POST"), {}, null);
  assertEquals(unset.res.status, 500);
  const wrong = await run(post(BODY, "nope", "POST"), {}, SECRET);
  assertEquals(wrong.res.status, 401);
  assertEquals(unset.calls.rpc.concat(wrong.calls.rpc), []);
});

Deno.test(
  "refuses anything but POST, and a body that is not JSON",
  async function (): Promise<void> {
    assertEquals((await run(post(null, SECRET, "GET"), {}, SECRET)).res.status, 405);
    assertEquals((await run(post("{", SECRET, "POST"), {}, SECRET)).res.status, 400);
  },
);

Deno.test("a database error is a 500", async function (): Promise<void> {
  const res = (await run(post(BODY, SECRET, "POST"), {
    rpc: { record_inbound_heartbeat: { error: { message: "boom" } } },
  }, SECRET)).res;
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { error: "boom" });
});

Deno.test("parseInboundStatus refuses malformed heartbeats", function (): void {
  const bad: unknown[] = [
    null,
    [],
    bodyWith("started_at", "yesterday"),
    bodyWith("rss_bytes", -1),
    bodyWith("reconnects", 1.5),
    bodyWith("feeds", "rbn"),
    bodyWith("feeds", Array.from({ length: 11 }, () => ({ id: "rbn", connected: true }))),
    bodyWith("feeds", [{ id: "rbn" }]),
  ];
  for (const body of bad) {
    assertEquals(typeof parseInboundStatus(body), "string", JSON.stringify(body));
  }
  // Strict: the inbound worker sends exactly these keys, so any other is refused.
  assertEquals(typeof parseInboundStatus(bodyWith("extra", 1)), "string");
  assertEquals(
    typeof parseInboundStatus(bodyWith("feeds", [{ id: "rbn", connected: true, x: 1 }])),
    "string",
  );
  assertEquals(parseInboundStatus(bodyWith("feeds", [{ id: "rbn", connected: true }])), {
    started_at: BODY.started_at,
    rss_bytes: BODY.rss_bytes,
    reconnects: BODY.reconnects,
    feeds: [{ id: "rbn", connected: true }],
  });
});

Deno.test("parseInboundStatus says what is wrong, as the handler answers it", function (): void {
  const shape = "body must be a JSON object with only started_at, rss_bytes, reconnects and feeds";
  assertEquals(parseInboundStatus(null), shape);
  assertEquals(parseInboundStatus(bodyWith("extra", 1)), shape);
  assertEquals(
    parseInboundStatus(bodyWith("started_at", "yesterday")),
    "started_at must be a time",
  );
  assertEquals(
    parseInboundStatus(bodyWith("rss_bytes", -1)),
    "rss_bytes and reconnects must be counts",
  );
  assertEquals(
    parseInboundStatus(bodyWith("reconnects", 1.5)),
    "rss_bytes and reconnects must be counts",
  );
  assertEquals(parseInboundStatus(bodyWith("feeds", "rbn")), "feeds must be at most 10 items");
  assertEquals(
    parseInboundStatus(bodyWith("feeds", [{ id: "rbn" }])),
    "every feed needs an id and connected",
  );
});

Deno.test("a body that cannot be read is a 500", async function (): Promise<void> {
  const res = await handleInboundStatus(brokenPost(SECRET), {
    secret: SECRET,
    db: () => fakeSupabase({}).client,
  });
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { error: "connection reset" });
});

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
    headers: { "x-relay-secret": secret, "Content-Type": "application/json" },
  };
  if (method === "POST") {
    if (typeof body === "string") {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
    }
  }
  return new Request("http://x/relay-status", init);
}

/** A POST whose body stream fails partway, for the read-failure paths. */
function brokenPost(secret: string): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.error(new Error("connection reset"));
    },
  });
  return new Request("http://x/", { method: "POST", headers: { "x-relay-secret": secret }, body });
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
  const res = await handleRelayStatus(req, { secret: configured, db: () => fake.client });
  return { res, calls: fake.calls };
}

Deno.test("records the heartbeat", async function (): Promise<void> {
  const ran = await run(post(BODY, SECRET, "POST"), {
    rpc: { record_relay_heartbeat: { data: null } },
  }, SECRET);
  const res = ran.res;
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
  assertEquals(ran.calls.rpc, [{
    fn: "record_relay_heartbeat",
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
    rpc: { record_relay_heartbeat: { error: { message: "boom" } } },
  }, SECRET)).res;
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { error: "boom" });
});

Deno.test("parseRelayStatus refuses malformed heartbeats", function (): void {
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
    assertEquals(typeof parseRelayStatus(body), "string", JSON.stringify(body));
  }
  // Strict: the relay sends exactly these keys, so any other is refused.
  assertEquals(typeof parseRelayStatus(bodyWith("extra", 1)), "string");
  assertEquals(
    typeof parseRelayStatus(bodyWith("feeds", [{ id: "rbn", connected: true, x: 1 }])),
    "string",
  );
  assertEquals(parseRelayStatus(bodyWith("feeds", [{ id: "rbn", connected: true }])), {
    started_at: BODY.started_at,
    rss_bytes: BODY.rss_bytes,
    reconnects: BODY.reconnects,
    feeds: [{ id: "rbn", connected: true }],
  });
});

Deno.test("parseRelayStatus says what is wrong, as the handler answers it", function (): void {
  const shape = "body must be a JSON object with only started_at, rss_bytes, reconnects and feeds";
  assertEquals(parseRelayStatus(null), shape);
  assertEquals(parseRelayStatus(bodyWith("extra", 1)), shape);
  assertEquals(parseRelayStatus(bodyWith("started_at", "yesterday")), "started_at must be a time");
  assertEquals(
    parseRelayStatus(bodyWith("rss_bytes", -1)),
    "rss_bytes and reconnects must be counts",
  );
  assertEquals(
    parseRelayStatus(bodyWith("reconnects", 1.5)),
    "rss_bytes and reconnects must be counts",
  );
  assertEquals(parseRelayStatus(bodyWith("feeds", "rbn")), "feeds must be at most 10 items");
  assertEquals(
    parseRelayStatus(bodyWith("feeds", [{ id: "rbn" }])),
    "every feed needs an id and connected",
  );
});

Deno.test("a body that cannot be read is a 500", async function (): Promise<void> {
  const res = await handleRelayStatus(brokenPost(SECRET), {
    secret: SECRET,
    db: () => fakeSupabase({}).client,
  });
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { error: "connection reset" });
});

// The spots stream against a local Deno.serve on port 0 and a fake database: who may connect,
// what the stream carries, presence, replacement, and shutdown.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { hashApiToken } from "../../supabase/functions/_shared/api/token.ts";
import type { DeliveryRpc } from "../../supabase/functions/_shared/delivery/run.ts";
import type { SendResult } from "../../supabase/functions/_shared/delivery/send.ts";
import type {
  DeliveryDestination,
  DeliverySpot,
  PendingDelivery,
} from "../../supabase/functions/_shared/delivery/types.ts";
import {
  clientAddress,
  type ClusterStream,
  type ClusterStreamConfig,
  createClusterStream,
  eventFrame,
  KEEPALIVE_FRAME,
  KEEPALIVE_MS,
  MAX_BUFFERED_BYTES,
  MAX_HANDSHAKES,
  MAX_HANDSHAKES_PER_ADDRESS,
  NOT_A_CLUSTER_SPOT,
  RELAY_NOT_CONNECTED,
  routeSend,
  SHUTDOWN_GRACE_MS,
  spotEvent,
  SPOTS_PATH,
} from "../cluster_stream.ts";

const TOKEN = `ll_relay_${"b".repeat(52)}`;
const RELAY = "aaaaaaaa-0000-0000-0000-000000000001";
const HELLO = { relay_id: RELAY, device_name: "SHACK-PC" };
const BOTH = ["contacts:write", "spots:read"];

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}
interface Answer {
  data: unknown;
  error: string | null;
}
type Responder = (args: Record<string, unknown>) => Answer | Promise<Answer>;
type Fake = ReturnType<typeof fakeDb>;

function knownToken(): Answer {
  return { data: [{ token_id: RELAY, user_id: "u1", scopes: BOTH }], error: null };
}

function marked(): Answer {
  return { data: [{ set_cluster_stream: HELLO }], error: null };
}

function resetNone(): Answer {
  return { data: [{ reset_cluster_streams: 0 }], error: null };
}

const DEFAULTS: Record<string, Responder> = {
  authenticate_relay_token: knownToken,
  set_cluster_stream: marked,
  reset_cluster_streams: resetNone,
};

/** A database that records each call as it starts; `responders` override the defaults. */
function fakeDb(responders: Record<string, Responder>) {
  const calls: RpcCall[] = [];
  const db: DeliveryRpc = {
    async rpc(fn, args) {
      calls.push({ fn, args });
      let responder = responders[fn];
      if (responder === undefined) {
        responder = DEFAULTS[fn];
      }
      if (responder === undefined) {
        return { data: null, error: `unexpected ${fn}` };
      }
      return await responder(args);
    },
  };
  return { db, calls };
}

/** The connected flag of every set_cluster_stream call, in the order they started. */
function presenceCalls(calls: RpcCall[]): boolean[] {
  return calls.filter((c) => c.fn === "set_cluster_stream").map((c) =>
    c.args.p_connected as boolean
  );
}

function streamConfig(db: DeliveryRpc, logs: string[]): ClusterStreamConfig {
  function log(line: string): void {
    logs.push(line);
  }
  return {
    db,
    hostname: "127.0.0.1",
    port: 0,
    keepaliveMs: 60_000,
    maxBufferedBytes: MAX_BUFFERED_BYTES,
    maxHandshakes: MAX_HANDSHAKES,
    // Every test client is 127.0.0.1; the per-address tests set their own.
    maxHandshakesPerAddress: MAX_HANDSHAKES,
    shutdownGraceMs: 1_000,
    log,
  };
}

async function withStream(
  responders: Record<string, Responder>,
  overrides: Partial<ClusterStreamConfig>,
  fn: (base: string, stream: ClusterStream, fake: Fake, logs: string[]) => Promise<void>,
): Promise<void> {
  const fake = fakeDb(responders);
  const logs: string[] = [];
  const stream = createClusterStream(Object.assign(streamConfig(fake.db, logs), overrides));
  const addr = await stream.serve();
  try {
    await fn(`http://127.0.0.1:${addr.port}`, stream, fake, logs);
  } finally {
    await stream.close();
  }
}

function request(base: string, token: string | null, path: string, method: string) {
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (token !== null) {
    headers.Authorization = `Bearer ${token}`;
  }
  return fetch(`${base}${path}`, { method, headers });
}

function connect(base: string, token: string | null) {
  return request(base, token, SPOTS_PATH, "GET");
}

/** A connect as Fly's proxy would forward it from `ip`. */
function connectFrom(base: string, token: string, ip: string) {
  return fetch(`${base}${SPOTS_PATH}`, {
    headers: {
      Accept: "text/event-stream",
      Authorization: `Bearer ${token}`,
      "Fly-Client-IP": ip,
    },
  });
}

/** Reads an event stream as text. */
function textReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let done = false;
  async function next(): Promise<void> {
    const chunk = await reader.read();
    if (chunk.done) {
      done = true;
    } else {
      text += decoder.decode(chunk.value);
    }
  }
  return {
    text: () => text,
    /** Reads until `needle` has arrived (returns everything so far), or the stream ends. */
    async until(needle: string): Promise<string> {
      while (!text.includes(needle) && !done) {
        await next();
      }
      return text;
    },
    /** Reads to the end; true when the stream ended. */
    async end(): Promise<boolean> {
      while (!done) {
        await next();
      }
      return done;
    },
    cancel: () => reader.cancel(),
  };
}

function pause(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Waits (up to two seconds) for `ok` to hold. */
async function eventually(ok: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (ok()) {
      return;
    }
    await pause(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const CLUSTER_SPOT: DeliverySpot = {
  id: 48213377,
  source: "pota",
  spot_time: "2026-10-28T21:14:07.123+00:00",
  callsign: "K4ABC",
  base_callsign: "K4ABC",
  spotter: "W4DOG",
  frequency_khz: 14062,
  band: "20m",
  mode: "cw",
  mode_family: "cw",
  comment: "Shining Rock Wilderness",
  pota_reference: "K-0039",
  pota_park_name: "Shining Rock Wilderness",
  pota_location: "US-NC",
  sota_summit_ref: null,
  wwff_reference: null,
  wwff_reference_name: null,
  cluster_spotter: "W4DOG",
  cluster_frequency_khz: 14062,
  cluster_callsign: "K4ABC",
  cluster_comment: "CW POTA K-0039",
  cluster_time: "2114",
  cluster_mode: "CW",
  cluster_reference: "POTA K-0039",
  cluster_source: "pota",
  cluster_source_label: "POTA",
  cluster_spot_time: "2026-10-28T21:14:07Z",
  cluster_connection: "POTA states",
};

/** The contract's example spot event (9.3), byte for byte. */
const EXAMPLE_FRAME = 'event: spot\ndata: {"id":48213377,"spotter":"W4DOG","frequency_khz":14062,' +
  '"callsign":"K4ABC","comment":"CW POTA K-0039","time_utc":"2114","mode":"CW",' +
  '"reference":"POTA K-0039","source":"pota","source_label":"POTA","connection":"POTA states",' +
  '"spot_time":"2026-10-28T21:14:07Z"}\n\n';

/** CLUSTER_SPOT without one key. */
function without(key: string): DeliverySpot {
  return Object.fromEntries(
    Object.entries(CLUSTER_SPOT).filter((entry) => entry[0] !== key),
  ) as unknown as DeliverySpot;
}

function relayDest(relayId: string | null): DeliveryDestination {
  return {
    id: "d1",
    type: "local_cluster",
    name: "Shack cluster",
    url: null,
    signing_secret: null,
    health: "ok",
    consecutive_failures: 0,
    local_cluster: { relay_id: relayId, device_name: "SHACK-PC" },
  };
}

function delivery(
  id: number,
  spot: DeliverySpot,
  destination: DeliveryDestination,
): PendingDelivery {
  return {
    msg_id: id * 10,
    delivery_id: id,
    subscription_id: "s1",
    attempts: 0,
    created_at: "2026-10-28T21:14:08Z",
    destination,
    spot: Object.assign({}, spot, { id }),
  };
}

function countOf(calls: RpcCall[], fn: string): number {
  return calls.filter((c) => c.fn === fn).length;
}

Deno.test(
  "spotEvent names SQL's cluster values as the contract's spot event",
  function (): void {
    assertEquals(eventFrame("spot", spotEvent(CLUSTER_SPOT)!), EXAMPLE_FRAME);
    assertEquals(eventFrame("hello", HELLO), `event: hello\ndata: ${JSON.stringify(HELLO)}\n\n`);
    assertEquals(KEEPALIVE_FRAME, ": keepalive\n\n");
    // A spot without a mode or a reference: null, as the contract's fields say.
    const bare = without("cluster_mode");
    delete bare.cluster_reference;
    assertEquals([spotEvent(bare)!.mode, spotEvent(bare)!.reference], [null, null]);
    // Without a value it needs, there is no event (a row claimed for another type).
    for (
      const key of [
        "cluster_spotter",
        "cluster_frequency_khz",
        "cluster_callsign",
        "cluster_comment",
        "cluster_time",
        "cluster_source",
        "cluster_source_label",
        "cluster_connection",
        "cluster_spot_time",
      ]
    ) {
      assertEquals(spotEvent(without(key)), null, key);
    }
    // A spot without a frequency (APRS-IS) is no event either; the claim never hands a relay one.
    assertEquals(
      spotEvent(Object.assign({}, CLUSTER_SPOT, { cluster_frequency_khz: null })),
      null,
    );
    assertEquals(
      [
        KEEPALIVE_MS,
        SHUTDOWN_GRACE_MS,
        MAX_BUFFERED_BYTES,
        MAX_HANDSHAKES,
        MAX_HANDSHAKES_PER_ADDRESS,
      ],
      [20_000, 5_000, 262_144, 4, 1],
    );
  },
);

Deno.test(
  "routeSend sends a Local DX cluster to the stream and every other type on",
  async function (): Promise<void> {
    const toStream: string[] = [];
    const toOthers: string[] = [];
    const now = new Date("2026-10-28T21:14:08Z");
    function streamSend(d: DeliveryDestination): Promise<SendResult> {
      toStream.push(d.id);
      return Promise.resolve({ ok: true, sent: 1 });
    }
    function others(
      d: DeliveryDestination,
      _b: readonly PendingDelivery[],
      at: Date,
    ): Promise<SendResult> {
      assertEquals(at, now);
      toOthers.push(d.id);
      return Promise.resolve({ ok: true, sent: 0 });
    }
    const stream: ClusterStream = {
      serve: () => Promise.reject(new Error("unused")),
      send: streamSend,
      connected: () => 0,
      close: () => Promise.resolve(),
    };
    const send = routeSend(stream, others);
    const webhook: DeliveryDestination = Object.assign(relayDest(RELAY), {
      id: "w",
      type: "webhook",
    });
    await send(relayDest(RELAY), [], now);
    await send(webhook, [], now);
    assertEquals([toStream, toOthers], [["d1"], ["w"]]);
  },
);

Deno.test(
  "the stream answers not_found off its path, or for any other method",
  async function (): Promise<void> {
    async function check(base: string, _stream: ClusterStream, fake: Fake): Promise<void> {
      for (const req of [["/v2/me", "GET"], ["/v1/spots", "GET"], [SPOTS_PATH, "POST"]]) {
        const res = await request(base, TOKEN, req[0]!, req[1]!);
        assertEquals(res.status, 404);
        assertEquals(await res.json(), { error: "not_found" });
        assertEquals(res.headers.get("cache-control"), "no-store");
      }
      // Only the start's reset reached the database.
      assertEquals(fake.calls.map((c) => c.fn), ["reset_cluster_streams"]);
    }
    await withStream({}, {}, check);
  },
);

Deno.test(
  "a missing, malformed or unknown token is bad_token, and nothing is marked",
  async function (): Promise<void> {
    function unknown(): Answer {
      return { data: [], error: null };
    }
    async function check(base: string, stream: ClusterStream, fake: Fake): Promise<void> {
      for (const token of [null, "ll_relay_short", `ll_live_${"a".repeat(52)}`, TOKEN]) {
        const res = await connect(base, token);
        assertEquals(res.status, 401, String(token));
        assertEquals(await res.json(), { error: "bad_token" });
      }
      // Only the well-formed token was looked up, by its hash.
      assertEquals(fake.calls.slice(1), [{
        fn: "authenticate_relay_token",
        args: { p_token_hash: await hashApiToken(TOKEN) },
      }]);
      assertEquals(stream.connected(), 0);
    }
    await withStream({ authenticate_relay_token: unknown }, {}, check);
  },
);

Deno.test(
  "a token without spots:read is insufficient_scope (a v1 pairing)",
  async function (): Promise<void> {
    function v1Token(): Answer {
      return {
        data: [{ token_id: RELAY, user_id: "u1", scopes: ["contacts:write"] }],
        error: null,
      };
    }
    async function check(base: string, _stream: ClusterStream, fake: Fake): Promise<void> {
      const res = await connect(base, TOKEN);
      assertEquals(res.status, 403);
      assertEquals(await res.json(), { error: "insufficient_scope" });
      assertEquals(presenceCalls(fake.calls), []);
    }
    await withStream({ authenticate_relay_token: v1Token }, {}, check);
  },
);

Deno.test("a failed or malformed token lookup is a 500", async function (): Promise<void> {
  async function check(
    base: string,
    _stream: ClusterStream,
    fake: Fake,
    logs: string[],
  ): Promise<void> {
    const res = await connect(base, TOKEN);
    assertEquals(res.status, 500);
    assertEquals(await res.json(), { error: "server_error" });
    assertEquals(presenceCalls(fake.calls), []);
    assertStringIncludes(logs.join("\n"), "authenticate_relay_token");
    // The token never reaches the log.
    assertEquals(logs.join("\n").includes(TOKEN), false);
  }
  for (
    const answer of [{ data: null, error: "boom" }, { data: [{ token_id: 1 }], error: null }]
  ) {
    await withStream({ authenticate_relay_token: () => answer }, {}, check);
  }
});

Deno.test(
  "a relay connects: hello, spots as events, keepalives, presence set",
  async function (): Promise<void> {
    async function check(
      base: string,
      stream: ClusterStream,
      fake: Fake,
      logs: string[],
    ): Promise<void> {
      const res = await connect(base, TOKEN);
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("content-type"), "text/event-stream");
      assertEquals(res.headers.get("cache-control"), "no-store");
      const reader = textReader(res);
      assertEquals(
        await reader.until("\n\n"),
        `event: hello\ndata: {"relay_id":"${RELAY}","device_name":"SHACK-PC"}\n\n`,
      );
      assertEquals(fake.calls.map((c) => c.fn), [
        "reset_cluster_streams",
        "authenticate_relay_token",
        "set_cluster_stream",
      ]);
      assertEquals(fake.calls[2]!.args, { p_token_id: RELAY, p_connected: true });
      assertEquals(stream.connected(), 1);

      const dest = relayDest(RELAY);
      const result = await stream.send(dest, [delivery(48213377, CLUSTER_SPOT, dest)]);
      assertEquals(result, { ok: true, sent: 1, attempted: 1 });
      await reader.until('Z"}\n\n');
      assertStringIncludes(reader.text(), EXAMPLE_FRAME);

      await reader.until(KEEPALIVE_FRAME);
      assertStringIncludes(reader.text(), KEEPALIVE_FRAME);
      assertStringIncludes(logs.join("\n"), `relay ${RELAY} connected (1 open)`);
      await reader.cancel();
    }
    await withStream({}, { keepaliveMs: 30 }, check);
  },
);

Deno.test(
  "a relay with no stream gets nothing attempted, never a failure",
  async function (): Promise<void> {
    async function check(_base: string, stream: ClusterStream): Promise<void> {
      const dest = relayDest(RELAY);
      const unattempted: SendResult = {
        ok: false,
        sent: 0,
        attempted: 0,
        error: RELAY_NOT_CONNECTED,
      };
      assertEquals(await stream.send(dest, [delivery(1, CLUSTER_SPOT, dest)]), unattempted);
      const noRelay = relayDest(null);
      assertEquals(await stream.send(noRelay, [delivery(1, CLUSTER_SPOT, noRelay)]), unattempted);
      const bare = relayDest(RELAY);
      delete bare.local_cluster;
      assertEquals(await stream.send(bare, [delivery(1, CLUSTER_SPOT, bare)]), unattempted);
    }
    await withStream({}, {}, check);
  },
);

Deno.test(
  "a row without the cluster values stops the batch there, unattempted",
  async function (): Promise<void> {
    async function check(base: string, stream: ClusterStream): Promise<void> {
      const reader = textReader(await connect(base, TOKEN));
      await reader.until("\n\n");
      const dest = relayDest(RELAY);
      const result = await stream.send(dest, [
        delivery(1, CLUSTER_SPOT, dest),
        delivery(2, without("cluster_comment"), dest),
        delivery(3, CLUSTER_SPOT, dest),
      ]);
      assertEquals(result, { ok: false, sent: 1, attempted: 1, error: NOT_A_CLUSTER_SPOT });
      await reader.cancel();
    }
    await withStream({}, {}, check);
  },
);

Deno.test(
  "a client that goes away clears presence and takes nothing more",
  async function (): Promise<void> {
    async function check(
      base: string,
      stream: ClusterStream,
      fake: Fake,
      logs: string[],
    ): Promise<void> {
      const reader = textReader(await connect(base, TOKEN));
      await reader.until("\n\n");
      await reader.cancel();
      await eventually(() => presenceCalls(fake.calls).length === 2, "the disconnect");
      assertEquals(presenceCalls(fake.calls), [true, false]);
      assertEquals(stream.connected(), 0);
      const dest = relayDest(RELAY);
      assertEquals((await stream.send(dest, [delivery(1, CLUSTER_SPOT, dest)])).attempted, 0);
      assertStringIncludes(logs.join("\n"), `relay ${RELAY} disconnected (0 open)`);
    }
    await withStream({}, {}, check);
  },
);

Deno.test(
  "a second stream for a token replaces the first without clearing presence",
  async function (): Promise<void> {
    async function check(
      base: string,
      stream: ClusterStream,
      fake: Fake,
      logs: string[],
    ): Promise<void> {
      const first = textReader(await connect(base, TOKEN));
      await first.until("\n\n");
      const second = textReader(await connect(base, TOKEN));
      await second.until("\n\n");
      // The older response ends without an event.
      assertEquals(await first.end(), true);
      assertEquals(first.text().split("event:").length, 2);
      assertEquals(stream.connected(), 1);
      assertStringIncludes(logs.join("\n"), "reconnected; its older stream ended");

      const dest = relayDest(RELAY);
      assertEquals((await stream.send(dest, [delivery(7, CLUSTER_SPOT, dest)])).sent, 1);
      await second.until('"id":7');
      // Nothing cleared presence: the newer stream holds it.
      await pause(20);
      assertEquals(presenceCalls(fake.calls), [true, true]);

      await second.cancel();
      await eventually(() => presenceCalls(fake.calls).length === 3, "the second disconnect");
      assertEquals(presenceCalls(fake.calls), [true, true, false]);
    }
    await withStream({}, {}, check);
  },
);

Deno.test(
  "presence calls for one relay apply in order: a reconnect lands after the close",
  async function (): Promise<void> {
    const order: string[] = [];
    async function slowPresence(args: Record<string, unknown>): Promise<Answer> {
      order.push(`start ${String(args.p_connected)}`);
      if (args.p_connected === false) {
        await pause(50);
      }
      order.push(`end ${String(args.p_connected)}`);
      return marked();
    }
    async function check(base: string, stream: ClusterStream): Promise<void> {
      const first = textReader(await connect(base, TOKEN));
      await first.until("\n\n");
      await first.cancel();
      await eventually(() => order.includes("start false"), "the close");
      const second = textReader(await connect(base, TOKEN));
      await second.until("\n\n");
      assertEquals(order, [
        "start true",
        "end true",
        "start false",
        "end false",
        "start true",
        "end true",
      ]);
      assertEquals(stream.connected(), 1);
      await second.cancel();
    }
    await withStream({ set_cluster_stream: slowPresence }, {}, check);
  },
);

Deno.test(
  "a token revoked while connecting is bad_token; a failed mark is a 500",
  async function (): Promise<void> {
    function revoked(args: Record<string, unknown>): Answer {
      if (args.p_connected === true) {
        return { data: [{ set_cluster_stream: null }], error: null };
      }
      return marked();
    }
    async function checkRevoked(base: string, stream: ClusterStream, fake: Fake): Promise<void> {
      const res = await connect(base, TOKEN);
      assertEquals(res.status, 401);
      assertEquals(await res.json(), { error: "bad_token" });
      assertEquals(stream.connected(), 0);
      await eventually(() => presenceCalls(fake.calls).length === 2, "the release");
    }
    await withStream({ set_cluster_stream: revoked }, {}, checkRevoked);
    async function checkFailed(
      base: string,
      stream: ClusterStream,
      _fake: Fake,
      logs: string[],
    ): Promise<void> {
      const res = await connect(base, TOKEN);
      assertEquals(res.status, 500);
      assertEquals(await res.json(), { error: "server_error" });
      assertEquals(stream.connected(), 0);
      assertStringIncludes(logs.join("\n"), `set_cluster_stream(${RELAY}, true) failed`);
    }
    for (
      const answer of [
        { data: null, error: "boom" },
        { data: [{ set_cluster_stream: "yes" }], error: null },
      ]
    ) {
      await withStream({ set_cluster_stream: () => answer }, {}, checkFailed);
    }
  },
);

Deno.test(
  "a spot claimed while the relay's stream is still connecting waits for the hello",
  async function (): Promise<void> {
    function nothing(): void {}
    let open: () => void = nothing;
    function capture(resolve: () => void): void {
      open = resolve;
    }
    const gate = new Promise<void>(capture);
    async function gated(): Promise<Answer> {
      await gate;
      return marked();
    }
    async function check(base: string, stream: ClusterStream, fake: Fake): Promise<void> {
      const pending = connect(base, TOKEN);
      // Current, but its mark has not answered: no hello yet, so no spot either.
      await eventually(() => presenceCalls(fake.calls).length === 1, "the mark");
      assertEquals(stream.connected(), 1);
      const dest = relayDest(RELAY);
      let early: SendResult;
      try {
        early = await stream.send(dest, [delivery(1, CLUSTER_SPOT, dest)]);
      } finally {
        // Open the mark whatever happens, so close() never waits on it.
        open();
      }
      assertEquals(early, { ok: false, sent: 0, attempted: 0, error: RELAY_NOT_CONNECTED });
      const reader = textReader(await pending);
      await reader.until("\n\n");
      assertEquals((await stream.send(dest, [delivery(2, CLUSTER_SPOT, dest)])).sent, 1);
      const text = await reader.until("event: spot");
      assertEquals(text.startsWith("event: hello\n"), true);
      assertEquals(text.split("event: spot").length, 2);
      assertStringIncludes(text, '"id":2,');
      await reader.cancel();
    }
    await withStream({ set_cluster_stream: gated }, {}, check);
  },
);

Deno.test(
  "past maxHandshakes connecting at once, a stream is refused before any lookup",
  async function (): Promise<void> {
    function nothing(): void {}
    let open: () => void = nothing;
    function capture(resolve: () => void): void {
      open = resolve;
    }
    const gate = new Promise<void>(capture);
    async function gated(): Promise<Answer> {
      await gate;
      return knownToken();
    }
    async function check(base: string, stream: ClusterStream, fake: Fake): Promise<void> {
      const pending = connect(base, TOKEN);
      await eventually(
        () => countOf(fake.calls, "authenticate_relay_token") === 1,
        "the first lookup",
      );
      const refusing = connect(base, TOKEN);
      try {
        // The refusal needs no lookup, so none starts while the first is still waiting.
        await pause(50);
        assertEquals(countOf(fake.calls, "authenticate_relay_token"), 1);
      } finally {
        open();
      }
      const refused = await refusing;
      assertEquals(refused.status, 503);
      assertEquals(await refused.json(), { error: "server_error" });
      assertEquals(countOf(fake.calls, "authenticate_relay_token"), 1);
      const reader = textReader(await pending);
      await reader.until("\n\n");
      assertEquals(stream.connected(), 1);
      // Once the first has its hello, the next may connect (and replaces it).
      const next = textReader(await connect(base, TOKEN));
      assertEquals(await next.until("event: hello"), next.text());
      assertEquals(countOf(fake.calls, "authenticate_relay_token"), 2);
      await next.cancel();
      await reader.cancel();
    }
    await withStream({ authenticate_relay_token: gated }, { maxHandshakes: 1 }, check);
  },
);

Deno.test("clientAddress keys Fly's client address, else the connection's", function (): void {
  function info(remoteAddr: Deno.Addr): Deno.ServeHandlerInfo {
    return { remoteAddr, completed: Promise.resolve() };
  }
  const tcp = info({ transport: "tcp", hostname: "203.0.113.9", port: 50_000 });
  function from(ip: string | null): Request {
    const headers = new Headers();
    if (ip !== null) {
      headers.set("Fly-Client-IP", ip);
    }
    return new Request(`http://x${SPOTS_PATH}`, { headers });
  }
  assertEquals(clientAddress(from("198.51.100.1"), tcp), "198.51.100.1");
  assertEquals(clientAddress(from("2001:db8:aa:bb:1:2:3:4"), tcp), "2001:db8:aa:bb::/64");
  assertEquals(clientAddress(from("2001:db8:aa:bb::99"), tcp), "2001:db8:aa:bb::/64");
  // No header, or one that is not an address: the connection's own.
  assertEquals(clientAddress(from(null), tcp), "203.0.113.9");
  assertEquals(clientAddress(from("not an address"), tcp), "203.0.113.9");
  const v6 = info({ transport: "tcp", hostname: "2001:db8::5", port: 1 });
  assertEquals(clientAddress(from(null), v6), "2001:db8:0:0::/64");
  assertEquals(clientAddress(from(null), info({ transport: "unix", path: "/tmp/s" })), "unknown");
});

Deno.test(
  "past maxHandshakesPerAddress from one address, a stream is refused before any lookup",
  async function (): Promise<void> {
    function nothing(): void {}
    let open: () => void = nothing;
    function capture(resolve: () => void): void {
      open = resolve;
    }
    const gate = new Promise<void>(capture);
    async function gated(): Promise<Answer> {
      await gate;
      return knownToken();
    }
    async function check(base: string, _stream: ClusterStream, fake: Fake): Promise<void> {
      function lookups(): number {
        return countOf(fake.calls, "authenticate_relay_token");
      }
      const first = connectFrom(base, TOKEN, "198.51.100.1");
      await eventually(() => lookups() === 1, "the first lookup");
      const firstV6 = connectFrom(base, TOKEN, "2001:db8:aa:bb::1");
      await eventually(() => lookups() === 2, "the IPv6 lookup");
      const pending: Promise<Response>[] = [first, firstV6];
      try {
        // The same address, or another in the same /64: refused with no lookup.
        for (const ip of ["198.51.100.1", "2001:db8:aa:bb::2"]) {
          const refused = await connectFrom(base, TOKEN, ip);
          assertEquals(refused.status, 503, ip);
          assertEquals(await refused.json(), { error: "server_error" });
        }
        // A malformed token is refused as bad_token before it takes or counts against a slot.
        const malformed = await connectFrom(base, "ll_relay_short", "198.51.100.1");
        assertEquals(malformed.status, 401);
        assertEquals(await malformed.json(), { error: "bad_token" });
        assertEquals(lookups(), 2);
        // Another address still gets its handshake.
        pending.push(connectFrom(base, TOKEN, "198.51.100.2"));
        await eventually(() => lookups() === 3, "the other address's lookup");
      } finally {
        open();
      }
      for (const res of await Promise.all(pending)) {
        assertEquals(res.status, 200);
        await res.body!.cancel();
      }
      // Its handshake over, the address may connect again.
      const again = await connectFrom(base, TOKEN, "198.51.100.1");
      assertEquals(again.status, 200);
      await again.body!.cancel();
      assertEquals(lookups(), 4);
    }
    await withStream(
      { authenticate_relay_token: gated },
      { maxHandshakesPerAddress: MAX_HANDSHAKES_PER_ADDRESS },
      check,
    );
  },
);

Deno.test(
  "a malformed token is bad_token even while every handshake slot is taken",
  async function (): Promise<void> {
    function nothing(): void {}
    let open: () => void = nothing;
    function capture(resolve: () => void): void {
      open = resolve;
    }
    const gate = new Promise<void>(capture);
    async function gated(): Promise<Answer> {
      await gate;
      return knownToken();
    }
    async function check(base: string, _stream: ClusterStream, fake: Fake): Promise<void> {
      const pending = connect(base, TOKEN);
      await eventually(
        () => countOf(fake.calls, "authenticate_relay_token") === 1,
        "the first lookup",
      );
      try {
        for (const token of [null, "ll_relay_short"]) {
          const res = await connect(base, token);
          assertEquals(res.status, 401, String(token));
          assertEquals(await res.json(), { error: "bad_token" });
        }
      } finally {
        open();
      }
      const res = await pending;
      assertEquals(res.status, 200);
      await res.body!.cancel();
    }
    await withStream({ authenticate_relay_token: gated }, { maxHandshakes: 1 }, check);
  },
);

Deno.test("a stream replaced while it connects ends at once", async function (): Promise<void> {
  function nothing(): void {}
  let open: () => void = nothing;
  function capture(resolve: () => void): void {
    open = resolve;
  }
  const gate = new Promise<void>(capture);
  let first = true;
  async function gated(): Promise<Answer> {
    if (first) {
      first = false;
      await gate;
    }
    return marked();
  }
  async function check(base: string, stream: ClusterStream, fake: Fake): Promise<void> {
    const pending = connect(base, TOKEN);
    await eventually(() => presenceCalls(fake.calls).length === 1, "the first mark");
    const second = connect(base, TOKEN);
    // The second is current once it is authenticated; the first's mark answers after that.
    await eventually(
      () => countOf(fake.calls, "authenticate_relay_token") === 2,
      "the second authenticated",
    );
    await pause(20);
    open();
    const older = textReader(await pending);
    assertEquals(await older.end(), true);
    assertEquals(older.text(), "");
    const newer = textReader(await second);
    await newer.until("\n\n");
    assertEquals(stream.connected(), 1);
    await newer.cancel();
  }
  await withStream({ set_cluster_stream: gated }, {}, check);
});

Deno.test(
  "a client that stops reading is closed rather than buffered without end",
  async function (): Promise<void> {
    async function check(
      base: string,
      stream: ClusterStream,
      fake: Fake,
      logs: string[],
    ): Promise<void> {
      const reader = textReader(await connect(base, TOKEN));
      await reader.until("\n\n");
      const dest = relayDest(RELAY);
      const batch: PendingDelivery[] = [];
      for (let i = 1; i <= 1_000; i++) {
        batch.push(delivery(i, CLUSTER_SPOT, dest));
      }
      // The client reads nothing more: past maxBufferedBytes unread the stream closes rather
      // than buffer.
      let written = 0;
      let result: SendResult = { ok: true, sent: 0 };
      for (let round = 0; round < 500 && result.ok; round++) {
        result = await stream.send(dest, batch);
        written += result.sent;
        await pause(1);
      }
      assertEquals(result.ok, false);
      assertEquals(result.error, RELAY_NOT_CONNECTED);
      assertEquals(result.attempted, result.sent);
      assertEquals(written > 0, true);
      assertStringIncludes(logs.join("\n"), "is not reading");
      assertEquals(stream.connected(), 0);
      await eventually(() => presenceCalls(fake.calls).length === 2, "the release");
      await reader.cancel();
    }
    await withStream({}, { maxBufferedBytes: 64 * 1024 }, check);
  },
);

Deno.test(
  "close ends every stream and marks every relay offline once",
  async function (): Promise<void> {
    const fake = fakeDb({});
    const logs: string[] = [];
    const stream = createClusterStream(streamConfig(fake.db, logs));
    const addr = await stream.serve();
    assertEquals((await stream.serve()).port, addr.port);
    const reader = textReader(await connect(`http://127.0.0.1:${addr.port}`, TOKEN));
    await reader.until("\n\n");
    const closing = stream.close();
    assertEquals(stream.close(), closing);
    await closing;
    assertEquals(await reader.end(), true);
    assertEquals(stream.connected(), 0);
    // One reset at start and one at shutdown; no per-relay clear.
    assertEquals(fake.calls.map((c) => c.fn), [
      "reset_cluster_streams",
      "authenticate_relay_token",
      "set_cluster_stream",
      "reset_cluster_streams",
    ]);
    assertStringIncludes(logs.join("\n"), "closed 1 streams");
    const dest = relayDest(RELAY);
    assertEquals((await stream.send(dest, [delivery(1, CLUSTER_SPOT, dest)])).attempted, 0);
  },
);

Deno.test(
  "a failed reset is logged; close without serve touches nothing",
  async function (): Promise<void> {
    function missing(): Answer {
      return { data: null, error: "no such function" };
    }
    function check(
      _base: string,
      _stream: ClusterStream,
      _fake: Fake,
      logs: string[],
    ): Promise<void> {
      assertStringIncludes(logs.join("\n"), "reset_cluster_streams failed: no such function");
      return Promise.resolve();
    }
    await withStream({ reset_cluster_streams: missing }, {}, check);
    const fake = fakeDb({});
    const idle = createClusterStream(streamConfig(fake.db, []));
    await idle.close();
    assertEquals(fake.calls, []);
  },
);

// The spots stream (contract v2, section 9 in sonyccd/longlines-relay's docs/contract.md): Long
// Lines Relay opens GET /v2/spots with its relay token and holds a Server-Sent Events response
// open; the sender writes each claimed Local DX cluster spot for that relay to it as one `spot`
// event. One stream per relay token, kept in a registry keyed by the token's id; a newer stream
// for the same token replaces the older one, whose response ends without an event.
//
// Presence is SQL's: set_cluster_stream(id, true) when a stream opens, (id, false) when the
// relay's current stream closes (the client went away, it stopped reading, or the sender shuts
// down), and reset_cluster_streams() at start and at shutdown. claim_deliveries takes a
// local_cluster row only while its relay is marked connected, so a relay that is offline never
// gets a row claimed; one whose stream closed after the claim gets its rows back as unattempted
// (send's `attempted`), and they wait out the claim's visibility timeout and then the 2-minute age.
// Nothing here ever marks a delivery failed, caps, orders or drops one.
//
// The stream's own RPCs are not sender progress: the watchdog (sender.ts) hears only from the
// delivery loop, so a relay connecting or going away neither keeps a wedged loop alive nor counts
// against a healthy one. Tokens are never logged; relay ids (relay_tokens.id) are.

import { z } from "zod";
import { hashApiToken } from "../supabase/functions/_shared/api/token.ts";
import { rateLimitSubject } from "../supabase/functions/_shared/client_address.ts";
import type { DeliveryRpc, DeliverySender } from "../supabase/functions/_shared/delivery/run.ts";
import type { SendResult } from "../supabase/functions/_shared/delivery/send.ts";
import type {
  DeliveryDestination,
  DeliverySpot,
  PendingDelivery,
} from "../supabase/functions/_shared/delivery/types.ts";
import { ValidationError } from "../supabase/functions/_shared/errors.ts";
import {
  relayToken,
  type RelayTokenRow,
  relayTokenRowsSchema,
  SPOTS_READ,
} from "../supabase/functions/_shared/relay_token.ts";
import { parseWith } from "../supabase/functions/_shared/validate.ts";

/** The stream's path; spots_url in GET /v2/me points here. */
export const SPOTS_PATH = "/v2/spots";
/** Contract 9.3: a `: keepalive` comment this often, so an idle stream still carries bytes. */
export const KEEPALIVE_MS = 20_000;
/**
 * Bytes a stream may hold unread. A relay takes at most 120 spots a minute
 * (local_cluster_relay_cap) of about 400 bytes, so one claim writes at most about 50 KB to it at
 * once; a client this far behind is not reading (a dead connection the OS has not noticed yet),
 * and the stream closes rather than buffer without end. The rows it did not take wait out the
 * visibility timeout.
 */
export const MAX_BUFFERED_BYTES = 256 * 1024;
/** How long close() waits for the server's open connections to finish after ending every stream. */
export const SHUTDOWN_GRACE_MS = 5_000;
/**
 * Streams connecting at once (each one is a token lookup and a presence call). The stream is
 * public and shares the sender's two-connection pool with the delivery loop, so a flood of
 * connection attempts must not queue lookups without end ahead of the claim: past this many, a
 * request is refused with a 503 before it reaches the database, and the relay retries with its
 * backoff (contract 9.5).
 */
export const MAX_HANDSHAKES = 4;
/**
 * Streams connecting at once from one client address (an IPv4 address or an IPv6 /64), so a
 * single client holding handshakes open cannot take every MAX_HANDSHAKES slot and turn away
 * every other relay. Refused like the global cap: 503, and the relay retries with its backoff.
 */
export const MAX_HANDSHAKES_PER_ADDRESS = 1;
/**
 * The header Fly's proxy sets to the address it accepted the connection from (sender/fly.toml's
 * http_service fronts the stream); a client's own value does not survive the proxy. Without it
 * (a local run) the connection's remote address counts.
 */
export const CLIENT_IP_HEADER = "fly-client-ip";
/** SendResult.error for a relay with no open stream. */
export const RELAY_NOT_CONNECTED = "Relay not connected";
/** SendResult.error for a claimed row without the cluster_* values. */
export const NOT_A_CLUSTER_SPOT = "The spot has no DX cluster values";

/** The `hello` event's data (contract 9.3), as set_cluster_stream answers it. */
export interface StreamHello {
  relay_id: string;
  device_name: string;
}

/** A `spot` event's data (contract 9.4), in the contract's key order. */
export interface SpotEvent {
  id: number;
  spotter: string;
  frequency_khz: number;
  callsign: string;
  comment: string;
  time_utc: string;
  mode: string | null;
  reference: string | null;
  source: string;
  source_label: string;
  connection: string;
  spot_time: string;
}

/** A set_cluster_stream row (20261028000600): the hello, or null when nothing changed. */
interface PresenceRow {
  set_cluster_stream: StreamHello | null;
}

// Our RPCs' rows, which can gain keys across deploys: loose.
const streamHelloSchema: z.ZodType<StreamHello> = z.looseObject({
  relay_id: z.string(),
  device_name: z.string(),
});
const presenceRowsSchema: z.ZodType<PresenceRow[]> = z.array(
  z.looseObject({ set_cluster_stream: streamHelloSchema.nullable() }),
);

export interface ClusterStreamConfig {
  /** The sender's database; only the three stream RPCs are called through it. */
  db: DeliveryRpc;
  /** 0.0.0.0 on Fly (the http_service reaches it); 127.0.0.1 in tests. */
  hostname: string;
  /** SENDER_STREAM_PORT; 0 picks a free port (tests). */
  port: number;
  keepaliveMs: number;
  maxBufferedBytes: number;
  /** MAX_HANDSHAKES in production. */
  maxHandshakes: number;
  /** MAX_HANDSHAKES_PER_ADDRESS in production. */
  maxHandshakesPerAddress: number;
  shutdownGraceMs: number;
  log: (message: string) => void;
}

export interface ClusterStream {
  /** Marks every relay offline (a previous process may have left some set), then listens. */
  serve(): Promise<Deno.NetAddr>;
  /**
   * Writes one `spot` event per delivery to the destination's relay. A relay without an open
   * stream is `attempted: 0`, never a failure. Never throws.
   */
  send(
    destination: DeliveryDestination,
    deliveries: readonly PendingDelivery[],
  ): Promise<SendResult>;
  /** Relays with an open stream. */
  connected(): number;
  /** Ends every stream, marks every relay offline and stops listening. Safe to call twice. */
  close(): Promise<void>;
}

/** One relay's open stream. */
interface Connection {
  readonly relayId: string;
  readonly body: ReadableStream<Uint8Array>;
  /** Sends the hello and starts the keepalive. */
  start(hello: StreamHello): void;
  /** Queues bytes; false when the stream is closed, or too far behind and now closed. */
  write(text: string): boolean;
  /** Ends the response; no presence change. Safe to call twice. */
  end(): void;
  isClosed(): boolean;
  /** True once the hello went out: no spot may go before it (contract 9.3). */
  isStarted(): boolean;
}

/** What a presence call came to: the hello, or null when nothing changed; or the error. */
interface PresenceAnswer {
  hello: StreamHello | null;
  error: string | null;
}

const encoder = new TextEncoder();

/** One SSE event: its name and one `data:` line of JSON (contract 9.3). */
export function eventFrame(name: string, data: StreamHello | SpotEvent): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** The keepalive comment (contract 9.3). */
export const KEEPALIVE_FRAME = ": keepalive\n\n";

/**
 * The spot event for a claimed local_cluster row: SQL's cluster_* values (local_cluster_spot_fields
 * and the claim's cluster_connection) under the contract's names, the id from the spot. Null when
 * a value is missing, which only a row claimed for another type can be.
 */
export function spotEvent(spot: DeliverySpot): SpotEvent | null {
  const spotter = spot.cluster_spotter;
  const frequency = spot.cluster_frequency_khz;
  const callsign = spot.cluster_callsign;
  const comment = spot.cluster_comment;
  const time = spot.cluster_time;
  const source = spot.cluster_source;
  const label = spot.cluster_source_label;
  const connection = spot.cluster_connection;
  const spotTime = spot.cluster_spot_time;
  if (
    spotter === undefined || frequency === undefined || callsign === undefined ||
    comment === undefined || time === undefined || source === undefined || label === undefined ||
    connection === undefined || spotTime === undefined
  ) {
    return null;
  }
  let mode: string | null = null;
  if (spot.cluster_mode !== undefined) {
    mode = spot.cluster_mode;
  }
  let reference: string | null = null;
  if (spot.cluster_reference !== undefined) {
    reference = spot.cluster_reference;
  }
  return {
    id: spot.id,
    spotter,
    frequency_khz: frequency,
    callsign,
    comment,
    time_utc: time,
    mode,
    reference,
    source,
    source_label: label,
    connection,
    spot_time: spotTime,
  };
}

/**
 * Whom a handshake counts against: CLIENT_IP_HEADER's address, else the connection's remote
 * address, keyed like the profile's rate limit (rateLimitSubject: IPv4 by address, IPv6 by /64).
 * Anything else shares one "unknown" key.
 */
export function clientAddress(req: Request, info: Deno.ServeHandlerInfo): string {
  const header = req.headers.get(CLIENT_IP_HEADER);
  if (header !== null) {
    const subject = rateLimitSubject(header);
    if (subject !== null) {
      return subject;
    }
  }
  if (info.remoteAddr.transport === "tcp" || info.remoteAddr.transport === "udp") {
    const subject = rateLimitSubject(info.remoteAddr.hostname);
    if (subject !== null) {
      return subject;
    }
  }
  return "unknown";
}

/** A contract error response (section 8): `{"error": code}`, never cached. */
function streamError(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

/** A 200 event stream over the connection's body (contract 9.2). */
function streamResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
  });
}

function noop(): void {
  // Nothing to do.
}

type Timer = ReturnType<typeof setTimeout>;

function waitMs(ms: number, timers: Set<Timer>): Promise<void> {
  function wait(resolve: () => void): void {
    function done(): void {
      timers.delete(timer);
      resolve();
    }
    const timer = setTimeout(done, ms);
    timers.add(timer);
  }
  return new Promise<void>(wait);
}

export function createClusterStream(config: ClusterStreamConfig): ClusterStream {
  const db = config.db;
  const log = config.log;
  /** Each relay's current stream. */
  const connections = new Map<string, Connection>();
  /** Each relay's last presence call: calls for one relay apply in the order they were made. */
  const presenceQueues = new Map<string, Promise<void>>();
  let server: Deno.HttpServer<Deno.NetAddr> | null = null;
  let closing = false;
  let closed: Promise<void> | null = null;
  const graceTimers = new Set<Timer>();
  function isClosing(): boolean {
    return closing;
  }

  async function callPresence(relayId: string, connected: boolean): Promise<PresenceAnswer> {
    const answer = await db.rpc("set_cluster_stream", {
      p_token_id: relayId,
      p_connected: connected,
    });
    if (answer.error !== null) {
      return { hello: null, error: answer.error };
    }
    try {
      const rows = parseWith(presenceRowsSchema, answer.data, "clusterStream: set_cluster_stream");
      let hello: StreamHello | null = null;
      const row = rows[0];
      if (row !== undefined) {
        hello = row.set_cluster_stream;
      }
      return { hello, error: null };
    } catch (error) {
      // A reply of another shape is a failed call, like an error from SQL.
      if (!(error instanceof ValidationError)) {
        throw error;
      }
      return { hello: null, error: error.message };
    }
  }

  async function afterPrevious(
    previous: Promise<void>,
    relayId: string,
    connected: boolean,
  ): Promise<PresenceAnswer> {
    await previous;
    return callPresence(relayId, connected);
  }

  async function settled(answer: Promise<PresenceAnswer>): Promise<void> {
    await answer;
  }

  async function forgetWhenDone(relayId: string, queued: Promise<void>): Promise<void> {
    await queued;
    if (presenceQueues.get(relayId) === queued) {
      presenceQueues.delete(relayId);
    }
  }

  /**
   * set_cluster_stream, after this relay's earlier calls, so a close and a reconnect land in the
   * order they happened. The answer never rejects: a failed call is its error.
   */
  function presence(relayId: string, connected: boolean): Promise<PresenceAnswer> {
    let previous = presenceQueues.get(relayId);
    if (previous === undefined) {
      previous = Promise.resolve();
    }
    const answer = afterPrevious(previous, relayId, connected);
    const queued = settled(answer);
    presenceQueues.set(relayId, queued);
    void forgetWhenDone(relayId, queued);
    return answer;
  }

  async function clearPresence(relayId: string): Promise<void> {
    const answer = await presence(relayId, false);
    if (answer.error !== null) {
      log(`spots stream: set_cluster_stream(${relayId}, false) failed: ${answer.error}`);
    }
  }

  /**
   * Ends a stream and, when it is still its relay's current one, marks the relay offline. A
   * stream replaced by a newer one leaves presence alone; the newer one holds it.
   */
  function release(conn: Connection): void {
    conn.end();
    if (connections.get(conn.relayId) !== conn) {
      return;
    }
    connections.delete(conn.relayId);
    log(`spots stream: relay ${conn.relayId} disconnected (${String(connections.size)} open)`);
    // close() marks every relay offline at once.
    if (!closing) {
      void clearPresence(conn.relayId);
    }
  }

  function openConnection(relayId: string): Connection {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let ended = false;
    let started = false;
    let keepalive: ReturnType<typeof setInterval> | undefined = undefined;
    function startStream(c: ReadableStreamDefaultController<Uint8Array>): void {
      controller = c;
    }
    // The client went away (Deno cancels the body when it cannot write it).
    function cancelStream(): void {
      release(conn);
    }
    const body = new ReadableStream<Uint8Array>(
      { start: startStream, cancel: cancelStream },
      new ByteLengthQueuingStrategy({ highWaterMark: config.maxBufferedBytes }),
    );
    function write(text: string): boolean {
      if (ended || controller === null) {
        return false;
      }
      const desired = controller.desiredSize;
      if (desired !== null && desired <= 0) {
        log(`spots stream: relay ${relayId} is not reading; closing its stream`);
        release(conn);
        return false;
      }
      controller.enqueue(encoder.encode(text));
      return true;
    }
    function sendKeepalive(): void {
      write(KEEPALIVE_FRAME);
    }
    const conn: Connection = {
      relayId,
      body,
      start(hello: StreamHello): void {
        started = write(eventFrame("hello", hello));
        keepalive = setInterval(sendKeepalive, config.keepaliveMs);
      },
      write,
      end(): void {
        if (ended) {
          return;
        }
        ended = true;
        clearInterval(keepalive);
        if (controller === null) {
          return;
        }
        try {
          controller.close();
        } catch (error) {
          // Already cancelled by the client: there is nothing left to end.
          if (!(error instanceof TypeError)) {
            throw error;
          }
        }
      },
      isClosed(): boolean {
        return ended;
      },
      isStarted(): boolean {
        return started;
      },
    };
    return conn;
  }

  /** The well-formed token's row, or the response that refuses it. */
  async function authenticate(token: string): Promise<RelayTokenRow | Response> {
    const auth = await db.rpc("authenticate_relay_token", {
      p_token_hash: await hashApiToken(token),
    });
    if (auth.error !== null) {
      log(`spots stream: authenticate_relay_token failed: ${auth.error}`);
      return streamError(500, "server_error");
    }
    let rows: RelayTokenRow[] | null;
    try {
      rows = parseWith(relayTokenRowsSchema, auth.data, "clusterStream: authenticate_relay_token");
    } catch (error) {
      if (!(error instanceof ValidationError)) {
        throw error;
      }
      log(`spots stream: ${error.message}`);
      return streamError(500, "server_error");
    }
    let caller: RelayTokenRow | undefined;
    if (rows !== null) {
      caller = rows[0];
    }
    if (caller === undefined) {
      return streamError(401, "bad_token");
    }
    if (!caller.scopes.includes(SPOTS_READ)) {
      return streamError(403, "insufficient_scope");
    }
    return caller;
  }

  /**
   * Releases the stream once its response is over: `completed` rejects when the client goes
   * away, and resolves only when the stream was ended (replaced or shut down), when release
   * changes nothing.
   */
  async function releaseWhenDone(conn: Connection, completed: Promise<void>): Promise<void> {
    try {
      await completed;
    } catch (error) {
      // Deno.errors.Interrupted, or whatever else cut the response short: either way it is over.
      if (!(error instanceof Error)) {
        throw error;
      }
    }
    release(conn);
  }

  /**
   * Streams between their request and their hello (or refusal): MAX_HANDSHAKES caps them all,
   * MAX_HANDSHAKES_PER_ADDRESS those of one client address (handshakesFrom, keyed by
   * clientAddress; a key leaves the map when its count is back to 0).
   */
  let handshakes = 0;
  const handshakesFrom = new Map<string, number>();

  /** Handshakes in flight from one client address. */
  function handshakesOf(address: string): number {
    const count = handshakesFrom.get(address);
    if (count === undefined) {
      return 0;
    }
    return count;
  }

  async function handler(req: Request, info: Deno.ServeHandlerInfo): Promise<Response> {
    if (req.method !== "GET" || new URL(req.url).pathname !== SPOTS_PATH) {
      return streamError(404, "not_found");
    }
    // A missing or malformed token is refused before it takes a slot or reaches the database.
    const token = relayToken(req);
    if (token === null) {
      return streamError(401, "bad_token");
    }
    const address = clientAddress(req, info);
    const fromAddress = handshakesOf(address);
    if (
      closing || handshakes >= config.maxHandshakes ||
      fromAddress >= config.maxHandshakesPerAddress
    ) {
      return streamError(503, "server_error");
    }
    handshakes += 1;
    handshakesFrom.set(address, fromAddress + 1);
    try {
      return await handshake(token, info);
    } finally {
      handshakes -= 1;
      const left = handshakesOf(address) - 1;
      if (left > 0) {
        handshakesFrom.set(address, left);
      } else {
        handshakesFrom.delete(address);
      }
    }
  }

  /** Authenticates the relay, makes its stream current, marks it connected and says hello. */
  async function handshake(token: string, info: Deno.ServeHandlerInfo): Promise<Response> {
    const caller = await authenticate(token);
    if (caller instanceof Response) {
      return caller;
    }
    // The sender may have begun closing while the token was looked up (handler checked before).
    if (isClosing()) {
      return streamError(503, "server_error");
    }
    const relayId = caller.token_id;
    const conn = openConnection(relayId);
    void releaseWhenDone(conn, info.completed);
    // Current from here, so a newer stream replaces this one even while it is still connecting.
    const previous = connections.get(relayId);
    connections.set(relayId, conn);
    if (previous !== undefined) {
      previous.end();
      log(`spots stream: relay ${relayId} reconnected; its older stream ended`);
    }
    const answer = await presence(relayId, true);
    if (answer.error !== null) {
      log(`spots stream: set_cluster_stream(${relayId}, true) failed: ${answer.error}`);
      release(conn);
      return streamError(500, "server_error");
    }
    if (answer.hello === null) {
      // Revoked, or lost spots:read, since authenticate_relay_token answered.
      release(conn);
      return streamError(401, "bad_token");
    }
    if (conn.isClosed()) {
      // Replaced, or the client or the sender went away, while it connected: an ended stream.
      return streamResponse(conn.body);
    }
    conn.start(answer.hello);
    log(`spots stream: relay ${relayId} connected (${String(connections.size)} open)`);
    return streamResponse(conn.body);
  }

  function send(
    destination: DeliveryDestination,
    deliveries: readonly PendingDelivery[],
  ): Promise<SendResult> {
    let conn: Connection | undefined;
    const target = destination.local_cluster;
    if (target !== undefined && target.relay_id !== null) {
      conn = connections.get(target.relay_id);
    }
    // A stream still connecting (a reconnect replaced the one the claim saw) has sent no hello
    // yet, and no spot may go before it: its rows wait out the visibility timeout too.
    if (conn === undefined || conn.isClosed() || !conn.isStarted()) {
      return Promise.resolve({ ok: false, sent: 0, attempted: 0, error: RELAY_NOT_CONNECTED });
    }
    let sent = 0;
    for (const delivery of deliveries) {
      const event = spotEvent(delivery.spot);
      if (event === null) {
        return Promise.resolve({ ok: false, sent, attempted: sent, error: NOT_A_CLUSTER_SPOT });
      }
      if (!conn.write(eventFrame("spot", event))) {
        return Promise.resolve({ ok: false, sent, attempted: sent, error: RELAY_NOT_CONNECTED });
      }
      sent += 1;
    }
    return Promise.resolve({ ok: true, sent, attempted: sent });
  }

  async function reset(): Promise<void> {
    const answer = await db.rpc("reset_cluster_streams", {});
    if (answer.error !== null) {
      log(`spots stream: reset_cluster_streams failed: ${answer.error}`);
    }
  }

  async function stop(): Promise<void> {
    closing = true;
    for (const conn of connections.values()) {
      conn.end();
    }
    const open = connections.size;
    connections.clear();
    await Promise.allSettled(Array.from(presenceQueues.values()));
    const listening = server;
    if (listening === null) {
      return;
    }
    await reset();
    log(`spots stream: closed ${String(open)} streams`);
    // Every response has ended; a client that stopped reading can still hold a connection open.
    await Promise.race([listening.shutdown(), waitMs(config.shutdownGraceMs, graceTimers)]);
    for (const timer of graceTimers) {
      clearTimeout(timer);
    }
    graceTimers.clear();
  }

  return {
    async serve(): Promise<Deno.NetAddr> {
      if (server !== null) {
        return server.addr;
      }
      await reset();
      const listening = Deno.serve(
        { hostname: config.hostname, port: config.port, onListen: noop },
        handler,
      );
      server = listening;
      log(`spots stream on :${String(listening.addr.port)}${SPOTS_PATH}`);
      return listening.addr;
    },
    send,
    connected(): number {
      return connections.size;
    },
    close(): Promise<void> {
      if (closed === null) {
        closed = stop();
      }
      return closed;
    },
  };
}

/**
 * The sender's DeliverySender: a Local DX cluster goes to its relay's spots stream, every other
 * type to `others` (sendToDestination).
 */
export function routeSend(stream: ClusterStream, others: DeliverySender): DeliverySender {
  function send(
    destination: DeliveryDestination,
    deliveries: readonly PendingDelivery[],
    now: Date,
  ): Promise<SendResult> {
    if (destination.type === "local_cluster") {
      return stream.send(destination, deliveries);
    }
    return others(destination, deliveries, now);
  }
  return send;
}

import { assertEquals } from "@std/assert";
import type { InboundConfig } from "../config.ts";
import { aprsFeed, dxclusterFeed, type Feed, RBN_FEED } from "../feeds.ts";
import type { InboundLine } from "../functions.ts";
import { startInbound } from "../inbound.ts";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
const SPOT_1 = "DX de SM1HEV-#: 14038.30  CT1JGA/P       CW     8 dB  24 WPM  CQ      1454Z";
const SPOT_2 = "DX de DM5GG-#:  18089.00  N2GM           CW    10 dB  25 WPM  CQ      1454Z";

function noop(): void {
  // Discards logs, the listen line and the servers' accept errors after close.
}

/** `feed` pointed at a local server on `port`. */
function localFeed(feed: Feed, port: number): Feed {
  const local: Feed = {
    id: feed.id,
    host: "127.0.0.1",
    port,
    loginPrompt: feed.loginPrompt,
    functionName: feed.functionName,
    isSpot: feed.isSpot,
  };
  if (feed.idleMs !== undefined) {
    local.idleMs = feed.idleMs;
  }
  if (feed.staleMs !== undefined) {
    local.staleMs = feed.staleMs;
  }
  if (feed.telnet !== undefined) {
    local.telnet = feed.telnet;
  }
  if (feed.loginCall !== undefined) {
    local.loginCall = feed.loginCall;
  }
  if (feed.loginLine !== undefined) {
    local.loginLine = feed.loginLine;
  }
  if (feed.maxBuffer !== undefined) {
    local.maxBuffer = feed.maxBuffer;
  }
  return local;
}

/** Telnet server that prompts, records the login, sends `lines`, then holds the connection open. */
function fakeTelnet(lines: string[]) {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const logins: string[] = [];
  const held: Deno.Conn[] = [];
  async function serve(): Promise<void> {
    for await (const conn of listener) {
      held.push(conn);
      await conn.write(enc("Please enter your call: "));
      const buf = new Uint8Array(64);
      const n = await conn.read(buf);
      let length = 0;
      if (n !== null && n !== undefined) {
        length = n;
      }
      logins.push(new TextDecoder().decode(buf.subarray(0, length)));
      await conn.write(enc(lines.map((l) => `${l}\r\n`).join("")));
    }
  }
  const served = serve().catch(noop);
  return {
    port: listener.addr.port,
    logins,
    async close() {
      listener.close();
      for (const c of held) {
        try {
          c.close();
        } catch {
          // The inbound worker closed its end first.
        }
      }
      await served;
    },
  };
}

/** Stand-in for the ingest Edge Functions and inbound-status: records each push and answers 200. */
function fakeFunctions() {
  const pushes: { path: string; secret: string | null; lines: InboundLine[] }[] = [];
  const statuses: { secret: string | null; body: Record<string, unknown> }[] = [];
  async function handler(req: Request): Promise<Response> {
    if (new URL(req.url).pathname.endsWith("/inbound-status")) {
      statuses.push({ secret: req.headers.get("x-inbound-secret"), body: await req.json() });
      return Response.json({ ok: true });
    }
    const body = await req.json() as { lines: InboundLine[] };
    pushes.push({
      path: new URL(req.url).pathname,
      secret: req.headers.get("x-inbound-secret"),
      lines: body.lines,
    });
    return Response.json({ ok: true });
  }
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: noop }, handler);
  return { url: `http://127.0.0.1:${server.addr.port}/functions/v1`, pushes, statuses, server };
}

async function waitFor(what: string, check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

Deno.test(
  "startInbound forwards spot lines, serves /healthz and flushes on shutdown",
  async function (): Promise<void> {
    const telnet = fakeTelnet(["Hello, N0CALL! Connected.", SPOT_1, "Local users: 586", SPOT_2]);
    const functions = fakeFunctions();
    const feed = localFeed(RBN_FEED, telnet.port);
    const config: InboundConfig = {
      functionsUrl: functions.url,
      inboundSecret: "s3cret",
      loginCall: "N0CALL",
      healthPort: 0,
      licenseZipUrl: null,
      catalogUrls: null,
    };
    const logs: string[] = [];
    const inbound = startInbound(config, [feed], {
      hostname: "127.0.0.1",
      log: (m) => logs.push(m),
    });
    async function health() {
      const res = await fetch(`http://127.0.0.1:${inbound.addr.port}/healthz`);
      return { status: res.status, body: await res.json() };
    }

    // The first tick sends an empty heartbeat; the two spots wait in the buffer for the 10 s flush.
    await waitFor("the heartbeat", () => functions.pushes.length === 1);
    await waitFor("both spots", async () => (await health()).body.feeds[0].buffered === 2);
    const h = await health();
    assertEquals(h.status, 200);
    assertEquals(h.body.healthy, true);
    assertEquals(h.body.feeds[0].id, "rbn");
    assertEquals(h.body.feeds[0].connected, true);
    assertEquals(h.body.feeds[0].connects, 1);

    // The Health page heartbeat goes out at start, with the inbound secret.
    await waitFor("the status", () => functions.statuses.length >= 1);
    assertEquals(functions.statuses[0]!.secret, "s3cret");
    assertEquals(functions.statuses[0]!.body.reconnects, 0);
    assertEquals((functions.statuses[0]!.body.feeds as Array<{ id: string }>).map((f) => f.id), [
      "rbn",
    ]);

    // Shutdown pushes the buffered spots before closing; a second call does not push again.
    await Promise.all([inbound.shutdown(), inbound.shutdown()]);
    await inbound.done;
    await telnet.close();
    await functions.server.shutdown();

    assertEquals(telnet.logins, ["N0CALL\r\n"]);
    assertEquals(functions.pushes.map((p) => [p.path, p.secret]), [
      ["/functions/v1/ingest-rbn", "s3cret"],
      ["/functions/v1/ingest-rbn", "s3cret"],
    ]);
    assertEquals(functions.pushes[0]!.lines, []);
    assertEquals(functions.pushes[1]!.lines.map((l) => l.line), [SPOT_1, SPOT_2]);
    assertEquals(
      functions.pushes[1]!.lines.every((l) => !Number.isNaN(Date.parse(l.received_at))),
      true,
    );
    assertEquals(logs[0], `inbound started: rbn 127.0.0.1:${telnet.port}`);
    assertEquals(logs.filter((m) => m === "shutting down").length, 1);
    assertEquals(logs.includes(`[rbn] connected to 127.0.0.1:${telnet.port}`), true);
  },
);

Deno.test(
  "startInbound shutdown with nothing buffered skips the final push",
  async function (): Promise<void> {
    const telnet = fakeTelnet([]);
    const functions = fakeFunctions();
    const inbound = startInbound(
      {
        functionsUrl: functions.url,
        inboundSecret: "s",
        loginCall: "N0CALL",
        healthPort: 0,
        licenseZipUrl: null,
        catalogUrls: null,
      },
      [localFeed(RBN_FEED, telnet.port)],
      { hostname: "127.0.0.1", log: noop },
    );
    await waitFor("the heartbeat", () => functions.pushes.length === 1);
    await waitFor("the login", () => telnet.logins.length === 1);
    await inbound.shutdown();
    await inbound.done;
    await telnet.close();
    await functions.server.shutdown();
    assertEquals(functions.pushes.map((p) => p.lines), [[]]);
  },
);

Deno.test(
  "startInbound runs the DX Cluster feed with its own idle timeout and forwards only human spots",
  async function (): Promise<void> {
    const human =
      "DX de HA7UL:      7146.0  HA7UL/P      CROTA HU-BCS-003               1316Z\u0007\u0007";
    const telnet = fakeTelnet(["Hello N0CALL, this is G1FEF-2", SPOT_1, human]);
    const functions = fakeFunctions();
    const feed = localFeed(dxclusterFeed(() => undefined), telnet.port);
    feed.idleMs = 300;
    const inbound = startInbound(
      {
        functionsUrl: functions.url,
        inboundSecret: "s",
        loginCall: "N0CALL",
        healthPort: 0,
        licenseZipUrl: null,
        catalogUrls: null,
      },
      [feed],
      { hostname: "127.0.0.1", log: noop },
    );
    async function health() {
      return (await (await fetch(`http://127.0.0.1:${inbound.addr.port}/healthz`)).json()).feeds[0];
    }

    await waitFor("the human spot", async () => (await health()).buffered === 1);
    // The server stays silent after its lines, so the 300 ms idle timeout drops the session.
    await waitFor("the idle disconnect", async () => (await health()).connected === false);
    await inbound.shutdown();
    await inbound.done;
    await telnet.close();
    await functions.server.shutdown();

    assertEquals(telnet.logins, ["N0CALL\r\n"]);
    assertEquals(functions.pushes.map((p) => p.path), [
      "/functions/v1/ingest-dxcluster",
      "/functions/v1/ingest-dxcluster",
    ]);
    assertEquals(functions.pushes[1]!.lines.map((l) => l.line), [human]);
  },
);

Deno.test(
  "startInbound holds the APRS-IS feed: logs in after the banner and forwards packets, not comments",
  async function (): Promise<void> {
    const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const logins: string[] = [];
    const held: Deno.Conn[] = [];
    const packet = "N0CALL-7>APRS,qAR,W1ABC-10:!4237.14N/07120.83W>Café 73";
    async function serve(): Promise<void> {
      for await (const conn of listener) {
        held.push(conn);
        await conn.write(enc("# aprsc 2.1.19-g730c5c0\r\n"));
        const buf = new Uint8Array(128);
        const n = await conn.read(buf);
        let length = 0;
        if (n !== null && n !== undefined) {
          length = n;
        }
        logins.push(new TextDecoder().decode(buf.subarray(0, length)));
        await conn.write(enc(`# logresp N0CALL-LL unverified, server T2TEST\r\n${packet}\r\n`));
        await conn.write(enc("# 14 Oct 2026 15:56:00 GMT T2TEST\r\n"));
      }
    }
    const served = serve().catch(noop);
    const functions = fakeFunctions();
    function env(name: string): string | undefined {
      if (name === "APRS_LOGIN_CALL") {
        return "n0call-ll";
      }
      return undefined;
    }
    const feed = localFeed(aprsFeed(env)!, listener.addr.port);
    const inbound = startInbound(
      {
        functionsUrl: functions.url,
        inboundSecret: "s",
        loginCall: "RELAYCALL",
        healthPort: 0,
        licenseZipUrl: null,
        catalogUrls: null,
      },
      [feed],
      { hostname: "127.0.0.1", log: noop },
    );
    async function health() {
      return (await (await fetch(`http://127.0.0.1:${inbound.addr.port}/healthz`)).json()).feeds[0];
    }

    await waitFor("the packet", async () => (await health()).buffered === 1);
    await inbound.shutdown();
    await inbound.done;
    listener.close();
    for (const c of held) {
      try {
        c.close();
      } catch {
        // The inbound worker closed its end first.
      }
    }
    await served;
    await functions.server.shutdown();

    // The feed's own call, not INBOUND_LOGIN_CALL, and no filter command.
    assertEquals(logins, ["user N0CALL-LL pass -1 vers LongLines 0.1\r\n"]);
    assertEquals(functions.pushes.map((p) => p.path), [
      "/functions/v1/ingest-aprs",
      "/functions/v1/ingest-aprs",
    ]);
    assertEquals(functions.pushes[1]!.lines.map((l) => l.line), [packet]);
  },
);

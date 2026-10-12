import { assertEquals } from "@std/assert";
import {
  abortableSleep,
  DEFAULT_BACKOFF,
  nextDelay,
  runTelnet,
  type SessionStatus,
  TelnetDecoder,
} from "../telnet.ts";

const enc = (s: string) => new TextEncoder().encode(s);

Deno.test("TelnetDecoder splits lines, drops CR and keeps the unterminated tail", () => {
  const d = new TelnetDecoder();
  assertEquals(d.push(enc("Please enter your call: ")), []);
  assertEquals(d.pending, "Please enter your call: ");
  assertEquals(d.push(enc("Hello\r\nDX de A-#: 1")), ["Please enter your call: Hello"]);
  assertEquals(d.push(enc("4000.0\r\n\r\n")), ["DX de A-#: 14000.0", ""]);
  assertEquals(d.pending, "");
});

Deno.test("TelnetDecoder strips IAC negotiation, subnegotiation and escaped 0xFF", () => {
  const d = new TelnetDecoder();
  const bytes = new Uint8Array([
    255,
    251,
    1, // IAC WILL ECHO
    ...enc("ab"),
    255,
    250,
    24,
    1,
    255,
    240, // IAC SB TTYPE SEND IAC SE
    ...enc("c"),
    255,
    255, // literal 0xFF
    ...enc("\r\n"),
  ]);
  assertEquals(d.push(bytes), ["abcÿ"]);
});

Deno.test("TelnetDecoder handles an IAC sequence split across reads", () => {
  const d = new TelnetDecoder();
  assertEquals(d.push(new Uint8Array([...enc("x"), 255])), []);
  assertEquals(d.push(new Uint8Array([253])), []);
  assertEquals(d.push(new Uint8Array([3, ...enc("y\n")])), ["xy"]);
});

Deno.test("nextDelay starts at the floor, doubles after short sessions and resets after stable ones", () => {
  const mid = () => 0.5; // no jitter
  assertEquals(nextDelay(null, 0, DEFAULT_BACKOFF, mid), 30_000);
  assertEquals(nextDelay(30_000, 1_000, DEFAULT_BACKOFF, mid), 60_000);
  assertEquals(nextDelay(600_000, 1_000, DEFAULT_BACKOFF, mid), 900_000);
  assertEquals(nextDelay(900_000, 1_000, DEFAULT_BACKOFF, mid), 900_000);
  assertEquals(nextDelay(900_000, 10 * 60_000, DEFAULT_BACKOFF, mid), 30_000);
});

Deno.test("nextDelay jitter never goes below the 30 s floor", () => {
  assertEquals(nextDelay(null, 0, DEFAULT_BACKOFF, () => 0), 30_000);
  assertEquals(nextDelay(30_000, 0, DEFAULT_BACKOFF, () => 1), 72_000);
});

/** A local telnet server that prompts, records the login, sends lines, and closes. */
function fakeServer(script: string[]) {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const logins: string[] = [];
  const served = (async () => {
    for await (const conn of listener) {
      await conn.write(enc("Please enter your call: "));
      const buf = new Uint8Array(64);
      const n = await conn.read(buf);
      logins.push(new TextDecoder().decode(buf.subarray(0, n ?? 0)));
      for (const chunk of script) await conn.write(enc(chunk));
      conn.close();
    }
  })().catch(() => {});
  return { port: (listener.addr as Deno.NetAddr).port, logins, listener, served };
}

Deno.test("runTelnet logs in, delivers lines, and reconnects after the server closes", async () => {
  const server = fakeServer(["Hello, N0CALL!\r\n", "DX de A-#: 7000.0  B  CW", "  1 dB\r\n"]);
  const controller = new AbortController();
  const lines: string[] = [];
  const sleeps: number[] = [];
  const status: SessionStatus = { connected: false, lastDataAt: null, connects: 0 };

  await runTelnet({
    host: "127.0.0.1",
    port: server.port,
    loginCall: "N0CALL",
    loginPrompt: /enter your call/i,
    onLine: (line) => lines.push(line),
    status,
    signal: controller.signal,
    log: () => {},
    sleep: (ms) => {
      sleeps.push(ms);
      if (sleeps.length === 2) controller.abort();
      return Promise.resolve();
    },
  });
  server.listener.close();
  await server.served;

  assertEquals(server.logins, ["N0CALL\r\n", "N0CALL\r\n"]);
  assertEquals(lines.filter((l) => l.startsWith("DX de")), [
    "DX de A-#: 7000.0  B  CW  1 dB",
    "DX de A-#: 7000.0  B  CW  1 dB",
  ]);
  assertEquals(status.connects, 2);
  assertEquals(status.connected, false);
  assertEquals(sleeps.every((ms) => ms >= 30_000), true);
});

Deno.test("runTelnet reconnects when the server goes quiet", async () => {
  // Never closes: holds the connection open after the prompt.
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const held: Deno.Conn[] = [];
  const accepting = (async () => {
    for await (const conn of listener) {
      held.push(conn);
      await conn.write(enc("Please enter your call: "));
    }
  })().catch(() => {});
  const controller = new AbortController();
  const logs: string[] = [];

  await runTelnet({
    host: "127.0.0.1",
    port: (listener.addr as Deno.NetAddr).port,
    loginCall: "N0CALL",
    loginPrompt: /enter your call/i,
    onLine: () => {},
    status: { connected: false, lastDataAt: null, connects: 0 },
    signal: controller.signal,
    idleMs: 50,
    log: (m) => logs.push(m),
    sleep: () => {
      controller.abort();
      return Promise.resolve();
    },
  });
  listener.close();
  for (const c of held) c.close();
  await accepting;

  assertEquals(logs.includes("connection closed or idle; reconnecting"), true);
});

Deno.test("runTelnet backs off after a refused connection", async () => {
  const controller = new AbortController();
  const sleeps: number[] = [];
  await runTelnet({
    host: "127.0.0.1",
    port: 1,
    loginCall: "N0CALL",
    loginPrompt: /x/,
    onLine: () => {},
    status: { connected: false, lastDataAt: null, connects: 0 },
    signal: controller.signal,
    log: () => {},
    connect: () => Promise.reject(new Error("refused")),
    sleep: (ms) => {
      sleeps.push(ms);
      if (sleeps.length === 3) controller.abort();
      return Promise.resolve();
    },
  });
  assertEquals(sleeps.length, 3);
  assertEquals(sleeps[1]! > sleeps[0]!, true);
});

Deno.test("TelnetDecoder drops NUL bytes (telnet CR NUL padding)", () => {
  const d = new TelnetDecoder();
  assertEquals(d.push(new Uint8Array([...enc("ab\r"), 0, ...enc("cd\n")])), ["abcd"]);
});

Deno.test("TelnetDecoder skips two-byte commands and IAC bytes inside a subnegotiation", () => {
  const d = new TelnetDecoder();
  const bytes = new Uint8Array([
    ...enc("a"),
    255,
    241, // IAC NOP: no option byte follows
    ...enc("b"),
    255,
    250,
    24,
    255,
    255,
    7,
    255,
    240, // IAC SB TTYPE <escaped 0xFF> 7 IAC SE
    ...enc("c\n"),
  ]);
  assertEquals(d.push(bytes), ["abc"]);
});

Deno.test("abortableSleep resolves at once on an aborted signal and early on abort", async () => {
  const aborted = new AbortController();
  aborted.abort();
  await abortableSleep(60_000, aborted.signal);

  const later = new AbortController();
  const sleeping = abortableSleep(60_000, later.signal);
  later.abort();
  await sleeping;
});

Deno.test("runTelnet stops without logging when the signal aborts during a failed connect", async () => {
  const controller = new AbortController();
  const logs: string[] = [];
  await runTelnet({
    host: "127.0.0.1",
    port: 1,
    loginCall: "N0CALL",
    loginPrompt: /x/,
    onLine: () => {},
    status: { connected: false, lastDataAt: null, connects: 0 },
    signal: controller.signal,
    log: (m) => logs.push(m),
    connect: () => {
      controller.abort();
      return Promise.reject(new Error("refused"));
    },
    sleep: () => Promise.reject(new Error("must not sleep after abort")),
  });
  assertEquals(logs, []);
});

// One long-lived telnet session per feed: connect, answer the login prompt,
// hand every complete line to the caller, and reconnect politely when the
// connection drops or goes quiet.

/** The slice of Deno.Conn the session uses, so tests can substitute a fake. */
export interface Conn {
  read(p: Uint8Array): Promise<number | null>;
  write(p: Uint8Array): Promise<number>;
  close(): void;
}

const IAC = 255;
const SB = 250;
const SE = 240;
const WILL = 251;
const DONT = 254;

/**
 * Turns telnet bytes into text lines. Strips IAC command sequences (including
 * ones split across reads), drops CR, splits on LF. Text after the last LF is
 * kept as `pending` so a prompt without a newline can be recognised.
 */
export class TelnetDecoder {
  #text = "";
  #state: "data" | "iac" | "option" | "sub" | "sub-iac" = "data";
  #decoder = new TextDecoder("latin1");

  /** Feed one read; returns the lines it completed. */
  push(bytes: Uint8Array): string[] {
    const data: number[] = [];
    for (const b of bytes) {
      switch (this.#state) {
        case "data":
          if (b === IAC) this.#state = "iac";
          else data.push(b);
          break;
        case "iac":
          if (b === IAC) {
            data.push(IAC);
            this.#state = "data";
          } else if (b >= WILL && b <= DONT) {
            this.#state = "option";
          } else if (b === SB) {
            this.#state = "sub";
          } else {
            this.#state = "data";
          }
          break;
        case "option":
          this.#state = "data";
          break;
        case "sub":
          if (b === IAC) this.#state = "sub-iac";
          break;
        case "sub-iac":
          this.#state = b === SE ? "data" : "sub";
          break;
      }
    }
    this.#text += this.#decoder.decode(new Uint8Array(data)).replaceAll("\r", "");
    const parts = this.#text.split("\n");
    this.#text = parts.pop() ?? "";
    return parts;
  }

  /** Text received after the last newline. */
  get pending(): string {
    return this.#text;
  }
}

export interface Backoff {
  /** First delay after a failed or short session. Never below 30 s (politeness). */
  minMs: number;
  maxMs: number;
  /** A session that lasted this long resets the delay to minMs. */
  stableMs: number;
}

export const DEFAULT_BACKOFF: Backoff = {
  minMs: 30_000,
  maxMs: 15 * 60_000,
  stableMs: 5 * 60_000,
};

/** Next reconnect delay: doubles after short sessions, resets after stable ones, ±20 % jitter. */
export function nextDelay(
  previousMs: number | null,
  sessionMs: number,
  backoff: Backoff,
  random: () => number = Math.random,
): number {
  const base = previousMs === null || sessionMs >= backoff.stableMs
    ? backoff.minMs
    : Math.min(previousMs * 2, backoff.maxMs);
  const jittered = base * (0.8 + 0.4 * random());
  return Math.max(backoff.minMs, Math.round(jittered));
}

export interface SessionStatus {
  connected: boolean;
  /** When the server last sent any bytes, or null before the first. */
  lastDataAt: Date | null;
  connects: number;
}

export interface TelnetOptions {
  host: string;
  port: number;
  loginCall: string;
  /** Matches the login prompt in text that has no newline yet. */
  loginPrompt: RegExp;
  onLine: (line: string, receivedAt: Date) => void;
  status: SessionStatus;
  signal: AbortSignal;
  /** Reconnect when the server sends nothing for this long. */
  idleMs?: number;
  backoff?: Backoff;
  connect?: (host: string, port: number) => Promise<Conn>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => Date;
  log?: (message: string) => void;
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

/** Read one chunk, or null on EOF or when nothing arrives within idleMs (connection closed). */
async function readWithIdleTimeout(
  conn: Conn,
  buf: Uint8Array,
  idleMs: number,
  signal: AbortSignal,
): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closeOnAbort = () => conn.close();
  signal.addEventListener("abort", closeOnAbort, { once: true });
  try {
    return await Promise.race([
      conn.read(buf),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), idleMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", closeOnAbort);
  }
}

/** One connection, from connect to EOF, idle timeout, error or abort. */
async function runSession(opts: Required<TelnetOptions>): Promise<void> {
  const conn = await opts.connect(opts.host, opts.port);
  opts.status.connected = true;
  opts.status.connects += 1;
  opts.log(`connected to ${opts.host}:${opts.port}`);
  const decoder = new TelnetDecoder();
  const buf = new Uint8Array(16 * 1024);
  let loggedIn = false;
  try {
    while (!opts.signal.aborted) {
      const n = await readWithIdleTimeout(conn, buf, opts.idleMs, opts.signal);
      if (n === null) {
        if (!opts.signal.aborted) opts.log("connection closed or idle; reconnecting");
        return;
      }
      const receivedAt = opts.now();
      opts.status.lastDataAt = receivedAt;
      for (const line of decoder.push(buf.subarray(0, n))) opts.onLine(line, receivedAt);
      if (!loggedIn && opts.loginPrompt.test(decoder.pending)) {
        await conn.write(new TextEncoder().encode(`${opts.loginCall}\r\n`));
        loggedIn = true;
      }
    }
  } finally {
    opts.status.connected = false;
    try {
      conn.close();
    } catch {
      // Already closed by the idle timeout or abort.
    }
  }
}

/** Keep a session open until the signal aborts, reconnecting with backoff. */
export async function runTelnet(options: TelnetOptions): Promise<void> {
  const opts: Required<TelnetOptions> = {
    idleMs: 5 * 60_000,
    backoff: DEFAULT_BACKOFF,
    connect: (hostname, port) => Deno.connect({ hostname, port }),
    sleep: abortableSleep,
    now: () => new Date(),
    log: (message) => console.log(message),
    ...options,
  };
  let delay: number | null = null;
  while (!opts.signal.aborted) {
    const started = opts.now().getTime();
    try {
      await runSession(opts);
    } catch (error) {
      if (opts.signal.aborted) break;
      opts.log(`session error: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (opts.signal.aborted) break;
    delay = nextDelay(delay, opts.now().getTime() - started, opts.backoff);
    opts.log(`reconnecting in ${Math.round(delay / 1000)} s`);
    await opts.sleep(delay, opts.signal);
  }
}

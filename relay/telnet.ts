// One long-lived session per feed: connect, answer the login prompt, hand
// every complete line to the caller, and reconnect politely when the
// connection drops or goes quiet. Telnet feeds (RBN, DX Cluster) go through
// TelnetDecoder; plain TCP line feeds (APRS-IS) through TcpLineDecoder.

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

/** Longest unterminated text a decoder keeps; real lines are under 600 bytes. */
export const MAX_PENDING = 8 * 1024;

/** Splits decoded text on LF, scanning only the new text, with pending text capped. */
class LineSplitter {
  #text = "";
  #discarding = false;

  push(chunk: string): string[] {
    const lines: string[] = [];
    let start = 0;
    for (let lf = chunk.indexOf("\n"); lf !== -1; lf = chunk.indexOf("\n", start)) {
      // A line completed inside this chunk is held to the same cap as pending text.
      if (!this.#discarding && this.#text.length + (lf - start) <= MAX_PENDING) {
        lines.push(this.#text + chunk.slice(start, lf));
      }
      this.#text = "";
      this.#discarding = false;
      start = lf + 1;
    }
    if (!this.#discarding) {
      this.#text += chunk.slice(start);
      // Drop an overlong line up to its LF instead of throwing: memory stays bounded and
      // one bad line costs only itself, not a healthy session and a 30 s+ reconnect.
      if (this.#text.length > MAX_PENDING) {
        this.#text = "";
        this.#discarding = true;
      }
    }
    return lines;
  }

  get pending(): string {
    return this.#text;
  }
}

/** Turns the bytes of one connection into text lines. */
export interface LineDecoder {
  /** Feed one read; returns the lines it completed. */
  push(bytes: Uint8Array): string[];
  /** Text received after the last newline. */
  readonly pending: string;
}

/**
 * Turns telnet bytes into text lines. Strips IAC command sequences (including
 * ones split across reads), drops CR, splits on LF. Text after the last LF is
 * kept as `pending` so a prompt without a newline can be recognised; a line
 * longer than MAX_PENDING is dropped whole.
 */
export class TelnetDecoder implements LineDecoder {
  #lines = new LineSplitter();
  #state: "data" | "iac" | "option" | "sub" | "sub-iac" = "data";
  #decoder = new TextDecoder("latin1");

  /** Feed one read; returns the lines it completed. */
  push(bytes: Uint8Array): string[] {
    const data: number[] = [];
    for (const b of bytes) {
      switch (this.#state) {
        case "data":
          // NUL is telnet padding (CR NUL), never content; Postgres jsonb rejects it.
          if (b === IAC) this.#state = "iac";
          else if (b !== 0) data.push(b);
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
    return this.#lines.push(this.#decoder.decode(new Uint8Array(data)).replaceAll("\r", ""));
  }

  /** Text received after the last newline. */
  get pending(): string {
    return this.#lines.pending;
  }
}

/**
 * Turns plain TCP bytes into text lines: UTF-8 (a character split across reads
 * is kept until it completes; invalid bytes become U+FFFD), CR and NUL dropped,
 * split on LF, a line longer than MAX_PENDING dropped whole. No telnet command
 * processing, so 0xFF is never special.
 */
export class TcpLineDecoder implements LineDecoder {
  #lines = new LineSplitter();
  #decoder = new TextDecoder("utf-8");

  push(bytes: Uint8Array): string[] {
    return this.#lines.push(
      this.#decoder.decode(bytes, { stream: true })
        .replaceAll("\r", "")
        .replaceAll("\0", ""),
    );
  }

  get pending(): string {
    return this.#lines.pending;
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
  /** Sent (with CRLF) once the prompt appears; loginCall when unset. */
  loginLine?: string;
  /** Matches the login prompt: in text that has no newline yet, or in a completed line. */
  loginPrompt: RegExp;
  /** Telnet framing (IAC, latin1); false for a plain TCP line feed in UTF-8. Default true. */
  telnet?: boolean;
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
  const decoder: LineDecoder = opts.telnet ? new TelnetDecoder() : new TcpLineDecoder();
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
      const lines = decoder.push(buf.subarray(0, n));
      for (const line of lines) opts.onLine(line, receivedAt);
      if (
        !loggedIn &&
        (opts.loginPrompt.test(decoder.pending) || lines.some((l) => opts.loginPrompt.test(l)))
      ) {
        await conn.write(new TextEncoder().encode(`${opts.loginLine}\r\n`));
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
    telnet: options.telnet ?? true,
    loginLine: options.loginLine ?? options.loginCall,
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

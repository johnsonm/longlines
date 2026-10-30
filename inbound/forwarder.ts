// Buffers spot lines and pushes them in batches. A push also goes out when
// nothing has been sent for heartbeatMs, even an empty one, so ingest_state
// shows the inbound worker alive. Failed pushes keep their lines and retry with backoff;
// the buffer is bounded (50,000 lines, about 50 minutes of RBN) so a long
// Supabase outage cannot exhaust memory.

import { reportError } from "../supabase/functions/_shared/sentry.ts";
import type { InboundLine } from "./functions.ts";

export interface ForwarderOptions {
  /** `signal` aborts when drain's deadline passes. */
  push: (lines: InboundLine[], signal: AbortSignal) => Promise<unknown>;
  now?: () => number;
  maxBatch?: number;
  flushMs?: number;
  heartbeatMs?: number;
  maxBuffer?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
  log?: (message: string) => void;
}

/** `value`, or `fallback` when it is undefined. */
function orDefault<T>(value: T | undefined, fallback: T): T {
  if (value === undefined) {
    return fallback;
  }
  return value;
}

function consoleLog(message: string): void {
  console.log(message);
}

export class Forwarder {
  readonly #opts: Required<ForwarderOptions>;
  #buffer: InboundLine[] = [];
  #oldestAt: number | null = null;
  #lastPushAt: number;
  #retryMs = 0;
  #retryAt = 0;
  /** The push in flight, resolving true on success, or null. */
  #inFlight: Promise<boolean> | null = null;
  /** Aborted at drain's deadline; every push gets its signal. */
  readonly #stop = new AbortController();
  /** Lines dropped from the front of the buffer while a push was in flight. */
  #droppedInFlight = 0;
  dropped = 0;
  pushed = 0;

  constructor(options: ForwarderOptions) {
    this.#opts = {
      now: orDefault(options.now, Date.now),
      maxBatch: orDefault(options.maxBatch, 1_000),
      flushMs: orDefault(options.flushMs, 10_000),
      heartbeatMs: orDefault(options.heartbeatMs, 60_000),
      maxBuffer: orDefault(options.maxBuffer, 50_000),
      retryMinMs: orDefault(options.retryMinMs, 5_000),
      retryMaxMs: orDefault(options.retryMaxMs, 5 * 60_000),
      log: orDefault(options.log, consoleLog),
      push: options.push,
    };
    // The first heartbeat goes out right away so a restart shows up quickly.
    this.#lastPushAt = this.#opts.now() - this.#opts.heartbeatMs;
  }

  get buffered(): number {
    return this.#buffer.length;
  }

  add(line: InboundLine): void {
    if (this.#buffer.length === 0) {
      this.#oldestAt = this.#opts.now();
    }
    this.#buffer.push(line);
    if (this.#buffer.length > this.#opts.maxBuffer) {
      this.#buffer.shift();
      this.dropped += 1;
      if (this.#inFlight !== null) {
        this.#droppedInFlight += 1;
      }
    }
  }

  /** Push if a batch is due. Call about once a second. */
  async tick(): Promise<void> {
    const now = this.#opts.now();
    if (this.#inFlight !== null || now < this.#retryAt) {
      return;
    }
    const due = this.#buffer.length >= this.#opts.maxBatch ||
      (this.#oldestAt !== null && now - this.#oldestAt >= this.#opts.flushMs) ||
      now - this.#lastPushAt >= this.#opts.heartbeatMs;
    if (!due) {
      return;
    }
    await this.flush();
  }

  /** Push up to one batch now, regardless of timers. A no-op while a push is in flight. */
  async flush(): Promise<void> {
    if (this.#inFlight === null) {
      await this.#start();
    }
  }

  /**
   * Push everything buffered, for shutdown: wait out a push already in flight, then
   * push batch after batch until the buffer is empty, a push fails, or timeoutMs
   * passes. At the deadline the push in flight is aborted and drain returns, so it
   * never outlasts timeoutMs; the forwarder pushes nothing after that.
   */
  async drain(timeoutMs: number): Promise<void> {
    const stop = this.#stop;
    function abortStop(): void {
      stop.abort();
    }
    function waitForStop(resolve: (value: false) => void): void {
      function onAbort(): void {
        resolve(false);
      }
      if (stop.signal.aborted) {
        resolve(false);
      }
      stop.signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(abortStop, timeoutMs);
    const stopped = new Promise<false>(waitForStop);
    try {
      for (;;) {
        let pending = this.#inFlight;
        if (pending === null) {
          pending = null;
          if (this.#buffer.length > 0 && !this.#stop.signal.aborted) {
            pending = this.#start();
          }
        }
        if (pending === null) {
          break;
        }
        if (!(await Promise.race([pending, stopped]))) {
          break;
        }
      }
    } finally {
      clearTimeout(timer);
    }
    if (this.#buffer.length > 0) {
      this.#opts.log(`drain stopped with ${String(this.#buffer.length)} lines unsent`);
    }
  }

  /** Send the first batch; resolves true when the push succeeded. */
  #start(): Promise<boolean> {
    const batch = this.#buffer.slice(0, this.#opts.maxBatch);
    this.#droppedInFlight = 0;
    const pushing = this.#sendThenClear(batch);
    this.#inFlight = pushing;
    return pushing;
  }

  /** #send, then clear the push in flight whether it succeeded or not. */
  async #sendThenClear(batch: InboundLine[]): Promise<boolean> {
    try {
      return await this.#send(batch);
    } finally {
      this.#inFlight = null;
    }
  }

  async #send(batch: InboundLine[]): Promise<boolean> {
    try {
      await this.#opts.push(batch, this.#stop.signal);
      // Overflow during the push already removed some of this batch from the front.
      this.#buffer.splice(0, Math.max(0, batch.length - this.#droppedInFlight));
      if (this.#buffer.length > 0) {
        this.#oldestAt = this.#opts.now();
      } else {
        this.#oldestAt = null;
      }
      this.#lastPushAt = this.#opts.now();
      this.pushed += batch.length;
      this.#retryMs = 0;
      this.#retryAt = 0;
      return true;
    } catch (error) {
      // The forward loop boundary: a failed push keeps its lines and retries with backoff.
      // Anything that is not an Error is thrown.
      if (!(error instanceof Error)) {
        throw error;
      }
      // One report per streak: the backoff would repeat it every minute of an outage.
      const firstFailure = this.#retryMs === 0;
      if (firstFailure) {
        this.#retryMs = this.#opts.retryMinMs;
      } else {
        this.#retryMs = Math.min(this.#retryMs * 2, this.#opts.retryMaxMs);
      }
      this.#retryAt = this.#opts.now() + this.#retryMs;
      this.#opts.log(
        `push failed (${String(batch.length)} lines, retry in ${
          String(this.#retryMs / 1000)
        } s): ${error.message}`,
      );
      if (firstFailure) {
        reportError(`push failed: ${error.message}`, error);
      }
      return false;
    }
  }
}

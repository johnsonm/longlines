// Buffers watched lines and pushes them in batches. A push also goes out when
// nothing has been sent for heartbeatMs, even an empty one, so ingest_state
// shows the relay alive. Failed pushes keep their lines and retry with backoff;
// the buffer is bounded so a long Supabase outage cannot exhaust memory.

import type { RelayLine } from "./functions.ts";

export interface ForwarderOptions {
  push: (lines: RelayLine[]) => Promise<unknown>;
  now?: () => number;
  maxBatch?: number;
  flushMs?: number;
  heartbeatMs?: number;
  maxBuffer?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
  log?: (message: string) => void;
}

export class Forwarder {
  readonly #opts: Required<ForwarderOptions>;
  #buffer: RelayLine[] = [];
  #oldestAt: number | null = null;
  #lastPushAt: number;
  #retryMs = 0;
  #retryAt = 0;
  #inFlight = false;
  /** Lines dropped from the front of the buffer while a push was in flight. */
  #droppedInFlight = 0;
  dropped = 0;
  pushed = 0;

  constructor(options: ForwarderOptions) {
    this.#opts = {
      now: Date.now,
      maxBatch: 200,
      flushMs: 10_000,
      heartbeatMs: 60_000,
      maxBuffer: 5_000,
      retryMinMs: 5_000,
      retryMaxMs: 5 * 60_000,
      log: (message) => console.log(message),
      ...options,
    };
    // The first heartbeat goes out right away so a restart shows up quickly.
    this.#lastPushAt = this.#opts.now() - this.#opts.heartbeatMs;
  }

  get buffered(): number {
    return this.#buffer.length;
  }

  add(line: RelayLine): void {
    if (this.#buffer.length === 0) this.#oldestAt = this.#opts.now();
    this.#buffer.push(line);
    if (this.#buffer.length > this.#opts.maxBuffer) {
      this.#buffer.shift();
      this.dropped += 1;
      if (this.#inFlight) this.#droppedInFlight += 1;
    }
  }

  /** Push if a batch is due. Call about once a second. */
  async tick(): Promise<void> {
    const now = this.#opts.now();
    if (this.#inFlight || now < this.#retryAt) return;
    const due = this.#buffer.length >= this.#opts.maxBatch ||
      (this.#oldestAt !== null && now - this.#oldestAt >= this.#opts.flushMs) ||
      now - this.#lastPushAt >= this.#opts.heartbeatMs;
    if (!due) return;
    await this.flush();
  }

  /** Push up to one batch now, regardless of timers. */
  async flush(): Promise<void> {
    if (this.#inFlight) return;
    const batch = this.#buffer.slice(0, this.#opts.maxBatch);
    this.#inFlight = true;
    this.#droppedInFlight = 0;
    try {
      await this.#opts.push(batch);
      // Overflow during the push already removed some of this batch from the front.
      this.#buffer.splice(0, Math.max(0, batch.length - this.#droppedInFlight));
      this.#oldestAt = this.#buffer.length > 0 ? this.#opts.now() : null;
      this.#lastPushAt = this.#opts.now();
      this.pushed += batch.length;
      this.#retryMs = 0;
      this.#retryAt = 0;
    } catch (error) {
      this.#retryMs = this.#retryMs === 0
        ? this.#opts.retryMinMs
        : Math.min(this.#retryMs * 2, this.#opts.retryMaxMs);
      this.#retryAt = this.#opts.now() + this.#retryMs;
      const message = error instanceof Error ? error.message : String(error);
      this.#opts.log(
        `push failed (${batch.length} lines, retry in ${this.#retryMs / 1000} s): ${message}`,
      );
    } finally {
      this.#inFlight = false;
    }
  }
}

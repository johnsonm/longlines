// The sender itself: one serial poll loop over runDeliveryBatch, the queue
// stats refresh, the watchdog and the /healthz server. main.ts is the process
// shell around it (environment, signals, exit code); everything here runs in
// tests against a fake database, a fake clock and a local receiver.
//
// The sender is dumb on purpose: what to claim, per-destination budgets,
// throttles, expiry and destination health are all decided in SQL by the RPCs
// the loop calls. This file only paces the calls and reports on them.

import {
  CLAIM_LIMIT,
  ClaimError,
  type DeliveryBatchResult,
  type DeliverySender,
  type ProgressStep,
  runDeliveryBatch,
} from "../supabase/functions/_shared/delivery/run.ts";
import { RETRY_MAX_MS, RETRY_MIN_MS, type SenderConfig } from "./config.ts";
import type { SenderDb } from "./db.ts";
import { healthHandler, type QueueStats, type SenderStatus, type SenderTotals } from "./health.ts";

// A failed claim or bookkeeping call is retried after RETRY_MIN_MS, doubling to
// RETRY_MAX_MS; they live in config.ts, which checks SENDER_STALE_MS against them.
export { RETRY_MAX_MS, RETRY_MIN_MS };
/** How often the watchdog compares the last progress with staleMs. */
export const WATCHDOG_TICK_MS = 1_000;

export interface SenderDeps {
  db: SenderDb;
  send: DeliverySender;
}

export interface SenderOptions {
  /** Health server bind address; 0.0.0.0 so Fly's health check can reach it. */
  hostname?: string;
  log?: (message: string) => void;
  /** The clock and the sleep, replaced by tests. */
  now?: () => Date;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Rows per claim; the loop re-claims at once after a full batch. */
  claimLimit?: number;
  /** The process's resident set size in bytes, for the heartbeat (tests pass a constant). */
  rss?: () => number;
}

export interface Sender {
  /** Where /healthz listens (config.healthPort 0 picks a free port). */
  addr: Deno.NetAddr;
  /**
   * Resolves once every loop has stopped after shutdown(). Rejects when the
   * watchdog finds no progress for staleMs, or when a cycle throws
   * anything but a ClaimError; main.ts exits 1 on either.
   */
  done: Promise<void>;
  /** Stop claiming, wait for the cycle in flight, close the pool and the health server. Safe to call twice. */
  shutdown(): Promise<void>;
  status(): SenderStatus;
}

/** Sleep that ends early when the signal aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  function wait(resolve: () => void): void {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  }
  return new Promise(wait);
}

function logLine(message: string): void {
  console.log(message);
}

function currentDate(): Date {
  return new Date();
}

function processRss(): number {
  return Deno.memoryUsage().rss;
}

function noop(): void {
  // Nothing to do.
}

export function startSender(
  config: SenderConfig,
  deps: SenderDeps,
  options: SenderOptions = {},
): Sender {
  let log = logLine;
  if (options.log !== undefined && options.log !== null) {
    log = options.log;
  }
  let now = currentDate;
  if (options.now !== undefined && options.now !== null) {
    now = options.now;
  }
  let sleep = abortableSleep;
  if (options.sleep !== undefined && options.sleep !== null) {
    sleep = options.sleep;
  }
  let rss = processRss;
  if (options.rss !== undefined && options.rss !== null) {
    rss = options.rss;
  }
  const controller = new AbortController();
  const signal = controller.signal;

  const startedAt = now();
  let lastClaimAt: Date | null = null;
  let lastProgressAt: Date | null = null;
  let lastError: string | null = null;
  let inFlight = false;
  let queue: QueueStats | null = null;
  const totals: SenderTotals = {
    cycles: 0,
    claimed: 0,
    sent: 0,
    failed: 0,
    throttled: 0,
    skipped_paused: 0,
    errors: 0,
  };
  function status(): SenderStatus {
    return {
      startedAt,
      lastClaimAt,
      lastProgressAt,
      lastError,
      inFlight,
      totals: {
        cycles: totals.cycles,
        claimed: totals.claimed,
        sent: totals.sent,
        failed: totals.failed,
        throttled: totals.throttled,
        skipped_paused: totals.skipped_paused,
        errors: totals.errors,
      },
      queue,
    };
  }

  // The watchdog's verdict. Once set, the loop in flight is presumed wedged
  // and shutdown() no longer waits for it.
  let failure: Error | null = null;
  let rejectDone: (error: Error) => void = noop;
  function captureReject(_resolve: unknown, reject: (error: Error) => void): void {
    rejectDone = reject;
  }
  const failed = new Promise<never>(captureReject);
  function fail(error: Error): void {
    if (failure !== null) {
      return;
    }
    failure = error;
    controller.abort();
    rejectDone(error);
  }

  function record(result: DeliveryBatchResult): void {
    totals.cycles += 1;
    totals.claimed += result.claimed;
    totals.sent += result.sent;
    totals.failed += result.failed;
    totals.throttled += result.throttled;
    totals.skipped_paused += result.skipped_paused;
    totals.errors += result.errors.length;
  }

  // Claim, send, mark; then sleep pollMs, or claim again at once when the
  // batch was full. A failed claim (ClaimError), or a mark still failing after
  // runDeliveryBatch's own retries, is logged and the next claim waits a
  // doubling delay; anything else thrown is a bug and ends the process through
  // `done`.
  async function pollLoop(): Promise<void> {
    let claimLimit = CLAIM_LIMIT;
    if (options.claimLimit !== undefined && options.claimLimit !== null) {
      claimLimit = options.claimLimit;
    }
    function onProgress(step: ProgressStep): void {
      lastProgressAt = now();
      if (step === "claim") {
        lastClaimAt = lastProgressAt;
      }
    }
    let retryMs = RETRY_MIN_MS;
    while (!signal.aborted) {
      inFlight = true;
      let result: DeliveryBatchResult;
      try {
        result = await runDeliveryBatch(deps.db, deps.send, now(), {
          claimLimit,
          concurrency: config.concurrency,
          onProgress,
          sleep: (ms) => sleep(ms, signal),
        });
      } catch (error) {
        inFlight = false;
        if (!(error instanceof ClaimError)) {
          throw error;
        }
        lastError = `claim_deliveries: ${error.message}`;
        log(`claim failed: ${error.message}; retrying in ${String(retryMs)} ms`);
        await sleep(retryMs, signal);
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
        continue;
      }
      inFlight = false;
      record(result);
      if (result.claimed > 0 || result.errors.length > 0) {
        log(JSON.stringify(result));
      }
      if (result.errors.length > 0) {
        lastError = result.errors.join("; ");
        await sleep(retryMs, signal);
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
        continue;
      }
      lastError = null;
      retryMs = RETRY_MIN_MS;
      if (result.claimed >= claimLimit) {
        continue;
      }
      await sleep(config.pollMs, signal);
    }
  }

  // Queue depth and spots expired undelivered in the last hour, from SQL, for
  // /healthz and the log. The one Phase 1 loss signal. Then the heartbeat for
  // the Health page: start time (restarts), last progress and memory. A failed
  // heartbeat is logged and never counts as progress.
  async function statsLoop(): Promise<void> {
    while (!signal.aborted) {
      const stats = await deps.db.rpc("delivery_queue_stats", {});
      const rows = stats.data as Array<Record<string, unknown>> | null;
      let row: Record<string, unknown> | undefined = undefined;
      if (rows !== null && rows !== undefined) {
        row = rows[0];
      }
      if (stats.error !== null) {
        log(`delivery_queue_stats failed: ${stats.error}`);
      } else if (row !== undefined && row !== null) {
        queue = { depth: Number(row.depth), expired_last_hour: Number(row.expired_last_hour) };
        log(
          `queue depth ${String(queue.depth)}, ` +
            `expired in the last hour ${String(queue.expired_last_hour)}; ` +
            `${String(totals.cycles)} cycles, ${String(totals.sent)} sent, ` +
            `${String(totals.failed)} failed, ${String(totals.throttled)} throttled`,
        );
      }
      let lastProgress: string | null = null;
      if (lastProgressAt !== null && lastProgressAt !== undefined) {
        lastProgress = lastProgressAt.toISOString();
      }
      const beat = await deps.db.rpc("record_sender_heartbeat", {
        p_started_at: startedAt.toISOString(),
        p_last_progress_at: lastProgress,
        p_rss_bytes: rss(),
      });
      if (beat.error !== null) {
        log(`record_sender_heartbeat failed: ${beat.error}`);
      }
      await sleep(config.statsMs, signal);
    }
  }

  // A wedged pooler connection looks like a healthy machine that never
  // claims or never answers a mark; after staleMs without progress (a
  // successful claim, a finished send or a successful bookkeeping RPC) the
  // process exits 1 so Fly restarts it. Progress, not finished cycles: a cycle
  // of many slow destinations can outlast staleMs, and killing it before its
  // ack would send the same rows again on every restart. /healthz alone
  // restarts nothing.
  async function watchdogLoop(): Promise<void> {
    while (!signal.aborted) {
      await sleep(WATCHDOG_TICK_MS, signal);
      if (signal.aborted) {
        return;
      }
      let last = startedAt;
      if (lastProgressAt !== null && lastProgressAt !== undefined) {
        last = lastProgressAt;
      }
      const since = now().getTime() - last.getTime();
      if (since >= config.staleMs) {
        const error = new Error(`watchdog: no progress for ${String(Math.round(since / 1000))} s`);
        log(error.message);
        fail(error);
      }
    }
  }

  let hostname = "0.0.0.0";
  if (options.hostname !== undefined && options.hostname !== null) {
    hostname = options.hostname;
  }
  const server = Deno.serve(
    { hostname, port: config.healthPort, onListen: noop },
    healthHandler(status, config.staleMs, now),
  );
  async function runLoops(): Promise<void> {
    await Promise.all([pollLoop(), statsLoop(), watchdogLoop()]);
  }
  const loops = runLoops();
  log(
    `sender started: poll ${String(config.pollMs)} ms, ` +
      `concurrency ${String(config.concurrency)}, ` +
      `stale ${String(config.staleMs)} ms, stats ${String(config.statsMs)} ms, ` +
      `health on :${String(server.addr.port)}`,
  );

  let stopping: Promise<void> | null = null;
  async function stop(): Promise<void> {
    log("shutting down");
    controller.abort();
    if (failure === null) {
      await loops.catch(noop);
    }
    await deps.db.close();
    await server.shutdown();
  }
  return {
    addr: server.addr,
    done: Promise.race([loops, failed]),
    status,
    shutdown(): Promise<void> {
      if (stopping === null || stopping === undefined) {
        stopping = stop();
      }
      return stopping;
    },
  };
}

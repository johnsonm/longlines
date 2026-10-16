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
  runDeliveryBatch,
} from "../supabase/functions/_shared/delivery/run.ts";
import type { SenderConfig } from "./config.ts";
import type { SenderDb } from "./db.ts";
import { healthHandler, type QueueStats, type SenderStatus, type SenderTotals } from "./health.ts";

/** A failed claim or bookkeeping call is retried after this, doubling to the maximum. */
export const RETRY_MIN_MS = 5_000;
export const RETRY_MAX_MS = 60_000;
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

export function startSender(
  config: SenderConfig,
  deps: SenderDeps,
  options: SenderOptions = {},
): Sender {
  const log = options.log ?? ((message: string) => console.log(message));
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? abortableSleep;
  const controller = new AbortController();
  const { signal } = controller;

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
  const status = (): SenderStatus => ({
    startedAt,
    lastClaimAt,
    lastProgressAt,
    lastError,
    inFlight,
    totals: { ...totals },
    queue,
  });

  // The watchdog's verdict. Once set, the loop in flight is presumed wedged
  // and shutdown() no longer waits for it.
  let failure: Error | null = null;
  let rejectDone: (error: Error) => void = () => {};
  const failed = new Promise<never>((_, reject) => {
    rejectDone = reject;
  });
  function fail(error: Error): void {
    if (failure !== null) return;
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
    const claimLimit = options.claimLimit ?? CLAIM_LIMIT;
    let retryMs = RETRY_MIN_MS;
    while (!signal.aborted) {
      inFlight = true;
      let result: DeliveryBatchResult;
      try {
        result = await runDeliveryBatch(deps.db, deps.send, now(), {
          claimLimit,
          concurrency: config.concurrency,
          onProgress: (step) => {
            lastProgressAt = now();
            if (step === "claim") lastClaimAt = lastProgressAt;
          },
          sleep: (ms) => sleep(ms, signal),
        });
      } catch (error) {
        inFlight = false;
        if (!(error instanceof ClaimError)) throw error;
        lastError = `claim_deliveries: ${error.message}`;
        log(`claim failed: ${error.message}; retrying in ${retryMs} ms`);
        await sleep(retryMs, signal);
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
        continue;
      }
      inFlight = false;
      record(result);
      if (result.claimed > 0 || result.errors.length > 0) log(JSON.stringify(result));
      if (result.errors.length > 0) {
        lastError = result.errors.join("; ");
        await sleep(retryMs, signal);
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
        continue;
      }
      lastError = null;
      retryMs = RETRY_MIN_MS;
      if (result.claimed >= claimLimit) continue;
      await sleep(config.pollMs, signal);
    }
  }

  // Queue depth and spots expired undelivered in the last hour, from SQL, for
  // /healthz and the log. The one Phase 1 loss signal.
  async function statsLoop(): Promise<void> {
    while (!signal.aborted) {
      const { data, error } = await deps.db.rpc("delivery_queue_stats", {});
      const row = (data as Array<Record<string, unknown>> | null)?.[0];
      if (error !== null) log(`delivery_queue_stats failed: ${error}`);
      else if (row) {
        queue = { depth: Number(row.depth), expired_last_hour: Number(row.expired_last_hour) };
        log(
          `queue depth ${queue.depth}, expired in the last hour ${queue.expired_last_hour}; ` +
            `${totals.cycles} cycles, ${totals.sent} sent, ${totals.failed} failed, ` +
            `${totals.throttled} throttled`,
        );
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
      if (signal.aborted) return;
      const since = now().getTime() - (lastProgressAt ?? startedAt).getTime();
      if (since >= config.staleMs) {
        const error = new Error(`watchdog: no progress for ${Math.round(since / 1000)} s`);
        log(error.message);
        fail(error);
      }
    }
  }

  const server = Deno.serve(
    { hostname: options.hostname ?? "0.0.0.0", port: config.healthPort, onListen: () => {} },
    healthHandler(status, config.staleMs, now),
  );
  const loops = Promise.all([pollLoop(), statsLoop(), watchdogLoop()]).then(() => {});
  log(
    `sender started: poll ${config.pollMs} ms, concurrency ${config.concurrency}, ` +
      `stale ${config.staleMs} ms, stats ${config.statsMs} ms, health on :${server.addr.port}`,
  );

  let stopping: Promise<void> | null = null;
  return {
    addr: server.addr,
    done: Promise.race([loops, failed]),
    status,
    shutdown() {
      stopping ??= (async () => {
        log("shutting down");
        controller.abort();
        if (failure === null) await loops.catch(() => {});
        await deps.db.close();
        await server.shutdown();
      })();
      return stopping;
    },
  };
}

// The sender itself: one serial poll loop over runDeliveryBatch, the LISTEN
// that wakes it, the queue stats refresh, the watchdog and the /healthz server. main.ts is the process
// shell around it (environment, signals, exit code); everything here runs in
// tests against a fake database, a fake clock and a local receiver.
//
// The sender is dumb on purpose: what to claim, per-destination budgets,
// throttles, expiry and destination health are all decided in SQL by the RPCs
// the loop calls. This file only paces the calls and reports on them.

import { z } from "zod";
import {
  CLAIM_LIMIT,
  ClaimError,
  type DeliveryBatchResult,
  type DeliverySender,
  type ProgressStep,
  runDeliveryBatch,
} from "../supabase/functions/_shared/delivery/run.ts";
import { type ErrorContext, ValidationError } from "../supabase/functions/_shared/errors.ts";
import { reportError } from "../supabase/functions/_shared/sentry.ts";
import { parseWith } from "../supabase/functions/_shared/validate.ts";
import { RETRY_MAX_MS, RETRY_MIN_MS, type SenderConfig } from "./config.ts";
import { DELIVERIES_CHANNEL, PROBE_TIMEOUT_MS, type SenderDb } from "./db.ts";
import { healthHandler, type QueueStats, type SenderStatus, type SenderTotals } from "./health.ts";

// A failed claim or bookkeeping call is retried after RETRY_MIN_MS, doubling to
// RETRY_MAX_MS; they live in config.ts, which checks SENDER_STALE_MS against them.
export { RETRY_MAX_MS, RETRY_MIN_MS };
/** How often the watchdog compares the last progress with staleMs. */
export const WATCHDOG_TICK_MS = 1_000;

/** The watchdog found no progress for staleMs; `done` rejects with it. */
export class WatchdogError extends Error {
  constructor(message: string, context: ErrorContext) {
    super(message, { cause: context.cause });
    this.name = "WatchdogError";
  }
}

/**
 * A delivery_queue_stats() row (20261015000400_rate_aware_claim.sql): two bigints, which
 * db.ts reads as Number. depth is a scalar subquery over pgmq.metrics, so it may be null.
 */
interface QueueStatsRow {
  depth: number | null;
  expired_last_hour: number;
}

// Our RPC's rows, which can gain columns across deploys: loose.
const queueStatsRowsSchema: z.ZodType<QueueStatsRow[]> = z.array(
  z.looseObject({ depth: z.number().nullable(), expired_last_hour: z.number() }),
);

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
  /** Where error reports go: reportError, replaced by tests that count them. */
  report?: (line: string, error: unknown) => void;
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
  options: SenderOptions,
): Sender {
  let log = logLine;
  if (options.log !== undefined) {
    log = options.log;
  }
  let now = currentDate;
  if (options.now !== undefined) {
    now = options.now;
  }
  let sleep = abortableSleep;
  if (options.sleep !== undefined) {
    sleep = options.sleep;
  }
  let rss = processRss;
  if (options.rss !== undefined) {
    rss = options.rss;
  }
  let report = reportError;
  if (options.report !== undefined) {
    report = options.report;
  }
  const controller = new AbortController();
  const signal = controller.signal;
  function stopped(): boolean {
    return signal.aborted;
  }

  const startedAt = now();
  let lastClaimAt: Date | null = null;
  let lastProgressAt: Date | null = null;
  let lastError: string | null = null;
  let inFlight = false;
  // LISTEN on DELIVERIES_CHANNEL was established (listenLoop). postgres.js re-subscribes
  // after a dropped listener connection on its own and can fail at it silently, so this is
  // not proof it still is; polling stays the safety net.
  let listening = false;
  let queue: QueueStats | null = null;
  const totals: SenderTotals = {
    cycles: 0,
    claimed: 0,
    sent: 0,
    failed: 0,
    throttled: 0,
    skipped_paused: 0,
    errors: 0,
    malformed: 0,
  };
  function status(): SenderStatus {
    return {
      startedAt,
      lastClaimAt,
      lastProgressAt,
      lastError,
      inFlight,
      listening,
      totals: {
        cycles: totals.cycles,
        claimed: totals.claimed,
        sent: totals.sent,
        failed: totals.failed,
        throttled: totals.throttled,
        skipped_paused: totals.skipped_paused,
        errors: totals.errors,
        malformed: totals.malformed,
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
    totals.malformed += result.malformed.length;
  }

  // A notify from the matcher (wake) ends the idle sleep between cycles early.
  // Notifies coalesce: any number during a cycle skip the next idle sleep once.
  // `notified` is cleared at the top of each cycle, since the claim about to run
  // covers every notify before it. A notify is never progress for the watchdog,
  // and the backoff sleeps after a failure are not wake-able.
  let notified = false;
  let wakeIdle: AbortController | null = null;
  function wake(): void {
    notified = true;
    if (wakeIdle !== null) {
      wakeIdle.abort();
    }
  }
  // Sleep `ms` between cycles, or not at all when a notify came in since the cycle began;
  // ends early on a notify or on shutdown.
  async function idle(ms: number): Promise<void> {
    // A shutdown during the cycle has already fired its abort event, which the waiter would miss.
    if (notified || signal.aborted) {
      return;
    }
    const waiter = new AbortController();
    function stopWaiting(): void {
      waiter.abort();
    }
    signal.addEventListener("abort", stopWaiting, { once: true });
    wakeIdle = waiter;
    try {
      await sleep(ms, waiter.signal);
    } finally {
      wakeIdle = null;
      signal.removeEventListener("abort", stopWaiting);
    }
  }

  // Claim, send, mark; then sleep pollMs (or less, on a notify), or claim again at once
  // when the batch was full. A failed claim (ClaimError), or a mark still failing after
  // runDeliveryBatch's own retries, is logged and the next claim waits a
  // doubling delay; anything else thrown is a bug and ends the process through
  // `done`. A claimed row that did not parse (`malformed`) is logged and kept in
  // lastError but never backs off: it comes back at every claim until the
  // expiry sweep drops it, and a backoff would slow every destination that long.
  async function pollLoop(): Promise<void> {
    let claimLimit = CLAIM_LIMIT;
    if (options.claimLimit !== undefined) {
      claimLimit = options.claimLimit;
    }
    function onProgress(step: ProgressStep): void {
      lastProgressAt = now();
      if (step === "claim") {
        lastClaimAt = lastProgressAt;
      }
    }
    let retryMs = RETRY_MIN_MS;
    // One report per streak of failed claims, and one per streak of claims with malformed
    // rows: each would otherwise repeat at every claim of an outage. Their own flags, since
    // a cycle's bookkeeping errors raise the shared backoff too.
    let claimFailing = false;
    let claimMalformed = false;
    while (!signal.aborted) {
      inFlight = true;
      notified = false;
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
        if (!claimFailing) {
          claimFailing = true;
          report(`claim failed: ${error.message}`, error);
        }
        await sleep(retryMs, signal);
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
        continue;
      }
      inFlight = false;
      claimFailing = false;
      record(result);
      const firstMalformed = result.malformed[0];
      if (firstMalformed === undefined) {
        claimMalformed = false;
      } else if (!claimMalformed) {
        claimMalformed = true;
        report(
          `claimed rows did not parse (${String(result.malformed.length)}): ${firstMalformed}`,
          undefined,
        );
      }
      if (result.claimed > 0 || result.errors.length > 0 || result.malformed.length > 0) {
        log(JSON.stringify(result));
      }
      const problems = result.errors.concat(result.malformed);
      lastError = null;
      if (problems.length > 0) {
        lastError = problems.join("; ");
      }
      if (result.errors.length > 0) {
        await sleep(retryMs, signal);
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
        continue;
      }
      retryMs = RETRY_MIN_MS;
      if (result.claimed >= claimLimit) {
        continue;
      }
      await idle(config.pollMs);
    }
  }

  // One LISTEN attempt, given up on after PROBE_TIMEOUT_MS or at shutdown.
  async function listenOnce(): Promise<{ error: string | null }> {
    const timer = new AbortController();
    function stopTimer(): void {
      timer.abort();
    }
    async function expiry(): Promise<{ error: string | null }> {
      await sleep(PROBE_TIMEOUT_MS, timer.signal);
      return { error: `no answer within ${String(PROBE_TIMEOUT_MS)} ms` };
    }
    signal.addEventListener("abort", stopTimer, { once: true });
    try {
      return await Promise.race([deps.db.listen(DELIVERIES_CHANNEL, wake), expiry()]);
    } finally {
      timer.abort();
      signal.removeEventListener("abort", stopTimer);
    }
  }

  // LISTEN for the matcher's notify, once. A failure (or no answer within
  // PROBE_TIMEOUT_MS) is logged, reported once per streak and tried again after
  // RETRY_MIN_MS, doubling to RETRY_MAX_MS; the sender keeps polling meanwhile
  // and never exits for it. Once established, postgres.js keeps the subscription
  // across reconnects.
  async function listenLoop(): Promise<void> {
    let retryMs = RETRY_MIN_MS;
    let listenFailing = false;
    while (!signal.aborted) {
      const answer = await listenOnce();
      // Read through a call: TypeScript keeps the loop condition's narrowing across the await.
      if (stopped()) {
        return;
      }
      if (answer.error === null) {
        listening = true;
        log("listening for deliveries");
        return;
      }
      log(`listen failed: ${answer.error}; polling only, retrying in ${String(retryMs)} ms`);
      if (!listenFailing) {
        listenFailing = true;
        report(`listen failed: ${answer.error}`, undefined);
      }
      await sleep(retryMs, signal);
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    }
  }

  // Queue depth and spots expired undelivered in the last hour, from SQL, for
  // /healthz and the log. The one Phase 1 loss signal. Then the heartbeat for
  // the Health page: start time (restarts), last progress and memory. A failed
  // heartbeat is logged and never counts as progress.
  async function statsLoop(): Promise<void> {
    while (!signal.aborted) {
      const stats = await deps.db.rpc("delivery_queue_stats", {});
      let rows: QueueStatsRow[] = [];
      let statsError = stats.error;
      if (statsError === null) {
        try {
          rows = parseWith(
            queueStatsRowsSchema,
            stats.data,
            "statsLoop: delivery_queue_stats rows",
          );
        } catch (error) {
          // Rows of another shape count as a failed call: logged, the previous figures kept.
          if (!(error instanceof ValidationError)) {
            throw error;
          }
          statsError = error.message;
        }
      }
      const row = rows[0];
      if (statsError !== null) {
        log(`delivery_queue_stats failed: ${statsError}`);
      } else if (row !== undefined) {
        // A null depth (no queue metrics) reads as 0, as Number(null) did.
        let depth = 0;
        if (row.depth !== null) {
          depth = row.depth;
        }
        queue = { depth: depth, expired_last_hour: row.expired_last_hour };
        log(
          `queue depth ${String(queue.depth)}, ` +
            `expired in the last hour ${String(queue.expired_last_hour)}; ` +
            `${String(totals.cycles)} cycles, ${String(totals.sent)} sent, ` +
            `${String(totals.failed)} failed, ${String(totals.throttled)} throttled`,
        );
      }
      let lastProgress: string | null = null;
      if (lastProgressAt !== null) {
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
      // Read through a call: TypeScript keeps the loop condition's narrowing across the await.
      if (stopped()) {
        return;
      }
      let last = startedAt;
      if (lastProgressAt !== null) {
        last = lastProgressAt;
      }
      const since = now().getTime() - last.getTime();
      if (since >= config.staleMs) {
        const error = new WatchdogError(
          `watchdog: no progress for ${String(Math.round(since / 1000))} s`,
          { cause: undefined },
        );
        log(error.message);
        fail(error);
      }
    }
  }

  let hostname = "0.0.0.0";
  if (options.hostname !== undefined) {
    hostname = options.hostname;
  }
  const server = Deno.serve(
    { hostname, port: config.healthPort, onListen: noop },
    healthHandler(status, config.staleMs, now),
  );
  async function runLoops(): Promise<void> {
    await Promise.all([pollLoop(), listenLoop(), statsLoop(), watchdogLoop()]);
  }
  const loops = runLoops();
  log(
    `sender started: poll ${String(config.pollMs)} ms, ` +
      `concurrency ${String(config.concurrency)}, ` +
      `stale ${String(config.staleMs)} ms, stats ${String(config.statsMs)} ms, ` +
      `listen on ${DELIVERIES_CHANNEL}, health on :${String(server.addr.port)}`,
  );

  let stopping: Promise<void> | null = null;
  async function stop(): Promise<void> {
    log("shutting down");
    controller.abort();
    if (failure === null) {
      // Wait for the loops to settle; a loop's error already reaches main through `done`.
      await Promise.allSettled([loops]);
    }
    await deps.db.close();
    await server.shutdown();
  }
  return {
    addr: server.addr,
    done: Promise.race([loops, failed]),
    status,
    shutdown(): Promise<void> {
      if (stopping === null) {
        stopping = stop();
      }
      return stopping;
    },
  };
}

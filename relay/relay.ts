// The relay itself: one telnet session and forwarder per feed, plus the
// /healthz server. main.ts is the process shell around it (environment,
// signals, exit code); everything here runs in tests against local servers.

import type { RelayConfig } from "./config.ts";
import type { Feed } from "./feeds.ts";
import { Forwarder } from "./forwarder.ts";
import { functionClient } from "./functions.ts";
import { type FeedHealth, healthHandler } from "./health.ts";
import { abortableSleep, runTelnet, type SessionStatus } from "./telnet.ts";

const STATS_LOG_MS = 10 * 60_000;
/** /healthz turns 503 when a feed has been silent this long, unless the feed sets its own. */
const STALE_MS = 10 * 60_000;

function startFeed(
  feed: Feed,
  config: RelayConfig,
  signal: AbortSignal,
  logLine: (message: string) => void,
): { health: FeedHealth; done: Promise<void>; forwarder: Forwarder } {
  const log = (message: string) => logLine(`[${feed.id}] ${message}`);
  const client = functionClient(config.functionsUrl, feed.functionName, config.relaySecret);
  const forwarder = new Forwarder({ push: client.push, log });
  const status: SessionStatus = { connected: false, lastDataAt: null, connects: 0 };
  let lines = 0;
  let spots = 0;

  async function every(ms: number, fn: () => Promise<unknown> | void): Promise<void> {
    while (!signal.aborted) {
      await fn();
      await abortableSleep(ms, signal);
    }
  }

  const done = Promise.all([
    every(1_000, () => forwarder.tick()),
    every(STATS_LOG_MS, () => {
      if (lines > 0) {
        log(
          `${lines} lines, ${spots} spots, ${forwarder.pushed} pushed, ` +
            `${forwarder.buffered} buffered, ${forwarder.dropped} dropped`,
        );
      }
    }),
    runTelnet({
      host: feed.host,
      port: feed.port,
      loginCall: config.loginCall,
      loginPrompt: feed.loginPrompt,
      ...(feed.idleMs === undefined ? {} : { idleMs: feed.idleMs }),
      status,
      signal,
      log,
      onLine: (line, receivedAt) => {
        lines += 1;
        if (!feed.isSpot(line)) return;
        spots += 1;
        forwarder.add({ line, received_at: receivedAt.toISOString() });
      },
    }),
  ]).then(() => {});

  return {
    forwarder,
    done,
    health: {
      id: feed.id,
      status,
      ...(feed.staleMs === undefined ? {} : { staleMs: feed.staleMs }),
      dropped: () => forwarder.dropped,
      buffered: () => forwarder.buffered,
      pushed: () => forwarder.pushed,
    },
  };
}

export interface RelayOptions {
  /** Health server bind address; 0.0.0.0 so Fly's health check can reach it. */
  hostname?: string;
  log?: (message: string) => void;
}

export interface Relay {
  /** Where /healthz listens (config.healthPort 0 picks a free port). */
  addr: Deno.NetAddr;
  /** Resolves once every feed has stopped. */
  done: Promise<void>;
  /** Stop the feeds, push what is buffered and close the health server. Safe to call twice. */
  shutdown(): Promise<void>;
}

export function startRelay(
  config: RelayConfig,
  feedList: readonly Feed[],
  options: RelayOptions = {},
): Relay {
  const log = options.log ?? ((message: string) => console.log(message));
  const controller = new AbortController();
  const feeds = feedList.map((feed) => startFeed(feed, config, controller.signal, log));

  const server = Deno.serve(
    { hostname: options.hostname ?? "0.0.0.0", port: config.healthPort, onListen: () => {} },
    healthHandler(feeds.map((f) => f.health), new Date(), STALE_MS),
  );
  log(`relay started: ${feedList.map((f) => `${f.id} ${f.host}:${f.port}`).join(", ")}`);

  let stopping: Promise<void> | null = null;
  return {
    addr: server.addr,
    done: Promise.all(feeds.map((f) => f.done)).then(() => {}),
    shutdown() {
      stopping ??= (async () => {
        log("shutting down");
        controller.abort();
        await Promise.all(feeds.map((f) => f.forwarder.buffered > 0 ? f.forwarder.flush() : null));
        await server.shutdown();
      })();
      return stopping;
    },
  };
}

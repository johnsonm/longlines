// The relay itself: one telnet (or TCP) session and forwarder per feed, the weekly
// license load (licenses.ts), the Health page heartbeat (status.ts) and the /healthz server. main.ts is the process shell around it (environment,
// signals, exit code); everything here runs in tests against local servers.

import type { RelayConfig } from "./config.ts";
import type { Feed } from "./feeds.ts";
import { Forwarder } from "./forwarder.ts";
import { functionClient, functionPoster } from "./functions.ts";
import { type FeedHealth, healthHandler } from "./health.ts";
import { licenseClient, type LicenseImportLoop, runLicenseImports } from "./licenses.ts";
import { runStatusLoop } from "./status.ts";
import { abortableSleep, runTelnet, type SessionStatus } from "./telnet.ts";

const STATS_LOG_MS = 10 * 60_000;
/** /healthz turns 503 when a feed has been silent this long, unless the feed sets its own. */
const STALE_MS = 10 * 60_000;
/**
 * How long shutdown spends pushing what is buffered. Under fly.toml's kill_timeout
 * (30 s) with room for the health server to close, so Fly never kills a push.
 */
const DRAIN_MS = 20_000;

function startFeed(
  feed: Feed,
  config: RelayConfig,
  signal: AbortSignal,
  logLine: (message: string) => void,
): { health: FeedHealth; done: Promise<void>; forwarder: Forwarder } {
  const log = (message: string) => logLine(`[${feed.id}] ${message}`);
  const client = functionClient(config.functionsUrl, feed.functionName, config.relaySecret);
  const forwarder = new Forwarder({
    push: client.push,
    log,
    ...(feed.maxBuffer === undefined ? {} : { maxBuffer: feed.maxBuffer }),
  });
  const loginCall = feed.loginCall ?? config.loginCall;
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
      loginCall,
      loginPrompt: feed.loginPrompt,
      ...(feed.loginLine === undefined ? {} : { loginLine: feed.loginLine(loginCall) }),
      ...(feed.telnet === undefined ? {} : { telnet: feed.telnet }),
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
  /** Overrides for the license load's timing and limits (tests). */
  licenses?: Partial<Omit<LicenseImportLoop, "zipUrl" | "client" | "signal" | "log">>;
  /** The Health page heartbeat's interval and memory figure (tests). */
  status?: { intervalMs?: number; rss?: () => number };
}

export interface Relay {
  /** Where /healthz listens (config.healthPort 0 picks a free port). */
  addr: Deno.NetAddr;
  /** Resolves once every feed has stopped. */
  done: Promise<void>;
  /**
   * Stop the feeds, push what is buffered (for at most DRAIN_MS) and close the health
   * server. Safe to call twice.
   */
  shutdown(): Promise<void>;
}

export function startRelay(
  config: RelayConfig,
  feedList: readonly Feed[],
  options: RelayOptions = {},
): Relay {
  const log = options.log ?? ((message: string) => console.log(message));
  const controller = new AbortController();
  const startedAt = new Date();
  const feeds = feedList.map((feed) => startFeed(feed, config, controller.signal, log));
  const licenses = config.licenseZipUrl === null ? null : runLicenseImports({
    ...options.licenses,
    zipUrl: config.licenseZipUrl,
    client: licenseClient(
      functionPoster(config.functionsUrl, "load-licenses", config.relaySecret),
    ),
    signal: controller.signal,
    log: (message) => log(`[licenses] ${message}`),
  });

  const status = runStatusLoop({
    ...options.status,
    feeds: feeds.map((f) => f.health),
    startedAt,
    post: functionPoster(config.functionsUrl, "relay-status", config.relaySecret),
    sleep: abortableSleep,
    signal: controller.signal,
    log,
  });

  const server = Deno.serve(
    { hostname: options.hostname ?? "0.0.0.0", port: config.healthPort, onListen: () => {} },
    healthHandler(feeds.map((f) => f.health), startedAt, STALE_MS),
  );
  log(`relay started: ${feedList.map((f) => `${f.id} ${f.host}:${f.port}`).join(", ")}`);

  let stopping: Promise<void> | null = null;
  return {
    addr: server.addr,
    done: Promise.all([...feeds.map((f) => f.done), licenses, status]).then(() => {}),
    shutdown() {
      stopping ??= (async () => {
        log("shutting down");
        controller.abort();
        await Promise.all(feeds.map((f) => f.forwarder.drain(DRAIN_MS)));
        await server.shutdown();
      })();
      return stopping;
    },
  };
}

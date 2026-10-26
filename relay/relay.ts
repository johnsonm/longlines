// The relay itself: one telnet (or TCP) session and forwarder per feed, the weekly
// license load (licenses.ts), the weekly reference list load (catalogs.ts), the Health page heartbeat (status.ts) and the /healthz server. main.ts is the process shell around it (environment,
// signals, exit code); everything here runs in tests against local servers.

import { type CatalogImportLoop, referenceClient, runCatalogImports } from "./catalogs.ts";
import type { RelayConfig } from "./config.ts";
import type { Feed } from "./feeds.ts";
import { Forwarder, type ForwarderOptions } from "./forwarder.ts";
import { functionClient, FunctionPoster, type RelayLine } from "./functions.ts";
import { type FeedHealth, healthHandler } from "./health.ts";
import { licenseClient, type LicenseImportLoop, runLicenseImports } from "./licenses.ts";
import { runStatusLoop, type StatusLoop } from "./status.ts";
import { abortableSleep, runTelnet, type SessionStatus, type TelnetOptions } from "./telnet.ts";

const STATS_LOG_MS = 10 * 60_000;
/** /healthz turns 503 when a feed has been silent this long, unless the feed sets its own. */
const STALE_MS = 10 * 60_000;
/**
 * How long shutdown spends pushing what is buffered. Under fly.toml's kill_timeout
 * (30 s) with room for the health server to close, so Fly never kills a push.
 */
const DRAIN_MS = 20_000;

/** A running feed: its /healthz figures, its forwarder, and a promise that settles when it stops. */
interface StartedFeed {
  health: FeedHealth;
  done: Promise<void>;
  forwarder: Forwarder;
}

function startFeed(
  feed: Feed,
  config: RelayConfig,
  signal: AbortSignal,
  logLine: (message: string) => void,
): StartedFeed {
  function log(message: string): void {
    logLine(`[${feed.id}] ${message}`);
  }
  const client = functionClient({
    functionsUrl: config.functionsUrl,
    functionName: feed.functionName,
    secret: config.relaySecret,
    fetchFn: fetch,
  });
  function push(batch: RelayLine[], pushSignal: AbortSignal): Promise<unknown> {
    return client.push(batch, pushSignal);
  }
  const forwarderOptions: ForwarderOptions = { push, log };
  if (feed.maxBuffer !== undefined) {
    forwarderOptions.maxBuffer = feed.maxBuffer;
  }
  const forwarder = new Forwarder(forwarderOptions);
  let loginCall = config.loginCall;
  if (feed.loginCall !== undefined) {
    loginCall = feed.loginCall;
  }
  const status: SessionStatus = { connected: false, lastDataAt: null, connects: 0 };
  let lines = 0;
  let spots = 0;

  async function every(ms: number, fn: () => Promise<unknown> | undefined): Promise<void> {
    while (!signal.aborted) {
      await fn();
      await abortableSleep(ms, signal);
    }
  }

  function logStats(): undefined {
    if (lines > 0) {
      log(
        `${String(lines)} lines, ${String(spots)} spots, ${String(forwarder.pushed)} pushed, ` +
          `${String(forwarder.buffered)} buffered, ${String(forwarder.dropped)} dropped`,
      );
    }
  }

  function onLine(line: string, receivedAt: Date): void {
    lines += 1;
    if (!feed.isSpot(line)) {
      return;
    }
    spots += 1;
    forwarder.add({ line, received_at: receivedAt.toISOString() });
  }

  const telnetOptions: TelnetOptions = {
    host: feed.host,
    port: feed.port,
    loginCall,
    loginPrompt: feed.loginPrompt,
    status,
    signal,
    log,
    onLine,
  };
  if (feed.loginLine !== undefined) {
    telnetOptions.loginLine = feed.loginLine(loginCall);
  }
  if (feed.telnet !== undefined) {
    telnetOptions.telnet = feed.telnet;
  }
  if (feed.idleMs !== undefined) {
    telnetOptions.idleMs = feed.idleMs;
  }

  async function run(): Promise<void> {
    await Promise.all([
      every(1_000, () => forwarder.tick()),
      every(STATS_LOG_MS, logStats),
      runTelnet(telnetOptions),
    ]);
  }
  const done = run();

  const health: FeedHealth = {
    id: feed.id,
    status,
    dropped: () => forwarder.dropped,
    buffered: () => forwarder.buffered,
    pushed: () => forwarder.pushed,
  };
  if (feed.staleMs !== undefined) {
    health.staleMs = feed.staleMs;
  }

  return { forwarder, done, health };
}

function logToConsole(message: string): void {
  console.log(message);
}

/** The Health page heartbeat's interval and memory figure (tests). */
export interface RelayStatusOptions {
  intervalMs?: number;
  rss?: () => number;
}

export interface RelayOptions {
  /** Health server bind address; 0.0.0.0 so Fly's health check can reach it. */
  hostname?: string;
  log?: (message: string) => void;
  /** Overrides for the license load's timing and limits (tests). */
  licenses?: Partial<Omit<LicenseImportLoop, "zipUrl" | "client" | "signal" | "log">>;
  /** Overrides for the reference list load's timing, limits, clock and fetch (tests). */
  catalogs?: Partial<Omit<CatalogImportLoop, "urls" | "client" | "signal" | "log">>;
  /** The Health page heartbeat's interval and memory figure (tests). */
  status?: RelayStatusOptions;
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
  options: RelayOptions,
): Relay {
  let log: (message: string) => void = logToConsole;
  if (options.log !== undefined) {
    log = options.log;
  }
  const controller = new AbortController();
  const startedAt = new Date();
  const feeds = feedList.map((feed) => startFeed(feed, config, controller.signal, log));

  function logLicenses(message: string): void {
    log(`[licenses] ${message}`);
  }
  let licenses: Promise<void> | null = null;
  if (config.licenseZipUrl !== null) {
    const licensePoster = new FunctionPoster({
      functionsUrl: config.functionsUrl,
      functionName: "load-licenses",
      secret: config.relaySecret,
      fetchFn: fetch,
    });
    const loop: LicenseImportLoop = {
      zipUrl: config.licenseZipUrl,
      client: licenseClient((body) => licensePoster.post(body, undefined)),
      signal: controller.signal,
      log: logLicenses,
    };
    const overrides = options.licenses;
    if (overrides !== undefined) {
      loop.batchSize = overrides.batchSize;
      loop.minRecords = overrides.minRecords;
      loop.readTimeoutMs = overrides.readTimeoutMs;
      loop.retryDelaysMs = overrides.retryDelaysMs;
      loop.firstCheckMs = overrides.firstCheckMs;
      loop.checkMs = overrides.checkMs;
      loop.now = overrides.now;
      loop.fetchFn = overrides.fetchFn;
    }
    licenses = runLicenseImports(loop);
  }

  function logCatalogs(message: string): void {
    log(`[catalogs] ${message}`);
  }
  let catalogs: Promise<void> | null = null;
  if (config.catalogUrls !== null) {
    const catalogPoster = new FunctionPoster({
      functionsUrl: config.functionsUrl,
      functionName: "load-references",
      secret: config.relaySecret,
      fetchFn: fetch,
    });
    const loop: CatalogImportLoop = {
      urls: config.catalogUrls,
      client: referenceClient((body) => catalogPoster.post(body, undefined)),
      signal: controller.signal,
      log: logCatalogs,
      fetchFn: fetch,
      now: () => new Date(),
    };
    const overrides = options.catalogs;
    if (overrides !== undefined) {
      if (overrides.fetchFn !== undefined) {
        loop.fetchFn = overrides.fetchFn;
      }
      if (overrides.now !== undefined) {
        loop.now = overrides.now;
      }
      loop.batchSize = overrides.batchSize;
      loop.readTimeoutMs = overrides.readTimeoutMs;
      loop.headerTimeoutMs = overrides.headerTimeoutMs;
      loop.retryDelaysMs = overrides.retryDelaysMs;
      loop.firstCheckMs = overrides.firstCheckMs;
      loop.checkMs = overrides.checkMs;
    }
    catalogs = runCatalogImports(loop);
  }

  const statusPoster = new FunctionPoster({
    functionsUrl: config.functionsUrl,
    functionName: "relay-status",
    secret: config.relaySecret,
    fetchFn: fetch,
  });
  const statusLoop: StatusLoop = {
    feeds: feeds.map((f) => f.health),
    startedAt,
    post: (body, signal) => statusPoster.post(body, signal),
    sleep: abortableSleep,
    signal: controller.signal,
    log,
  };
  if (options.status !== undefined) {
    statusLoop.intervalMs = options.status.intervalMs;
    statusLoop.rss = options.status.rss;
  }
  const status = runStatusLoop(statusLoop);

  let hostname = "0.0.0.0";
  if (options.hostname !== undefined) {
    hostname = options.hostname;
  }
  function onListen(): void {
    // Quiet: the relay logs its own start line below.
  }
  const server = Deno.serve(
    { hostname, port: config.healthPort, onListen },
    healthHandler(feeds.map((f) => f.health), startedAt, STALE_MS, () => new Date()),
  );
  log(`relay started: ${feedList.map((f) => `${f.id} ${f.host}:${String(f.port)}`).join(", ")}`);

  async function allDone(): Promise<void> {
    const waits: Array<Promise<void>> = [];
    for (const f of feeds) {
      waits.push(f.done);
    }
    // No license load runs without a zip URL.
    if (licenses !== null) {
      waits.push(licenses);
    }
    // Nor a reference list load without its URLs.
    if (catalogs !== null) {
      waits.push(catalogs);
    }
    waits.push(status);
    await Promise.all(waits);
  }

  async function stop(): Promise<void> {
    log("shutting down");
    controller.abort();
    await Promise.all(feeds.map((f) => f.forwarder.drain(DRAIN_MS)));
    await server.shutdown();
  }

  let stopping: Promise<void> | null = null;
  return {
    addr: server.addr,
    done: allDone(),
    shutdown(): Promise<void> {
      if (stopping === null) {
        stopping = stop();
      }
      return stopping;
    },
  };
}

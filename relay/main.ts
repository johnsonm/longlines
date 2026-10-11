// Long Lines stream relay. Holds one telnet connection per feed, keeps the
// lines that report a watched callsign, and pushes them to the feed's Edge
// Function. Runs on Fly.io (see the root fly.toml); docs/OPERATIONS.md has the
// deploy steps.

import { loadConfig, type RelayConfig } from "./config.ts";
import { type Feed, RBN_FEED } from "./feeds.ts";
import { Forwarder } from "./forwarder.ts";
import { functionClient } from "./functions.ts";
import { type FeedHealth, healthHandler } from "./health.ts";
import { abortableSleep, runTelnet, type SessionStatus } from "./telnet.ts";
import { Watchlist } from "./watchlist.ts";

const FEEDS: readonly Feed[] = [RBN_FEED];
const WATCHLIST_REFRESH_MS = 5 * 60_000;
const STATS_LOG_MS = 10 * 60_000;
/** /healthz turns 503 when a feed has been silent this long. */
const STALE_MS = 10 * 60_000;

function startFeed(
  feed: Feed,
  config: RelayConfig,
  signal: AbortSignal,
): { health: FeedHealth; done: Promise<void>; forwarder: Forwarder } {
  const log = (message: string) => console.log(`[${feed.id}] ${message}`);
  const client = functionClient(config.functionsUrl, feed.functionName, config.relaySecret);
  const watchlist = new Watchlist();
  const forwarder = new Forwarder({ push: client.push, log });
  const status: SessionStatus = { connected: false, lastDataAt: null, connects: 0 };
  let lines = 0;
  let spots = 0;
  let matched = 0;

  async function every(ms: number, fn: () => Promise<unknown> | void): Promise<void> {
    while (!signal.aborted) {
      await fn();
      await abortableSleep(ms, signal);
    }
  }

  const refreshWatchlist = () => watchlist.refresh(client.watchlist, log);
  // Load the watchlist before connecting so the first lines are not dropped
  // unchecked. If Supabase is unreachable the feed connects anyway and picks the
  // list up on a later refresh.
  const firstLoad = refreshWatchlist();

  const done = Promise.all([
    firstLoad
      .then(() => abortableSleep(WATCHLIST_REFRESH_MS, signal))
      .then(() => every(WATCHLIST_REFRESH_MS, refreshWatchlist)),
    every(1_000, () => forwarder.tick()),
    every(STATS_LOG_MS, () => {
      if (lines > 0) {
        log(
          `${lines} lines, ${spots} spots, ${matched} watched, ${forwarder.pushed} pushed, ` +
            `${forwarder.buffered} buffered, ${forwarder.dropped} dropped`,
        );
      }
    }),
    firstLoad.then(() =>
      runTelnet({
        host: feed.host,
        port: feed.port,
        loginCall: config.loginCall,
        loginPrompt: feed.loginPrompt,
        status,
        signal,
        log,
        onLine: (line, receivedAt) => {
          lines += 1;
          const callsign = feed.callsignOf(line);
          if (callsign === null) return;
          spots += 1;
          if (!watchlist.has(callsign)) return;
          matched += 1;
          forwarder.add({ line, received_at: receivedAt.toISOString() });
        },
      })
    ),
  ]).then(() => {});

  return {
    forwarder,
    done,
    health: {
      id: feed.id,
      status,
      watching: () => watchlist.size,
      buffered: () => forwarder.buffered,
      pushed: () => forwarder.pushed,
    },
  };
}

/** Run the relay until SIGINT/SIGTERM. `feedList` is overridable for local end-to-end runs. */
export async function main(feedList: readonly Feed[] = FEEDS): Promise<void> {
  const config = loadConfig((name) => Deno.env.get(name));
  const controller = new AbortController();
  const feeds = feedList.map((feed) => startFeed(feed, config, controller.signal));

  const server = Deno.serve(
    { hostname: "0.0.0.0", port: config.healthPort, onListen: () => {} },
    healthHandler(feeds.map((f) => f.health), new Date(), STALE_MS),
  );
  console.log(`relay started: ${feedList.map((f) => `${f.id} ${f.host}:${f.port}`).join(", ")}`);

  // Fly sends SIGINT (the default kill_signal) on deploy and restart. Push what
  // is buffered before exiting so a deploy does not lose watched spots.
  const shutdown = async () => {
    if (controller.signal.aborted) return;
    console.log("shutting down");
    controller.abort();
    await Promise.all(feeds.map((f) => f.forwarder.buffered > 0 ? f.forwarder.flush() : null));
    await server.shutdown();
    Deno.exit(0);
  };
  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);

  await Promise.all(feeds.map((f) => f.done));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`relay failed: ${error instanceof Error ? error.message : String(error)}`);
    // Exit non-zero so Fly restarts the machine.
    Deno.exit(1);
  });
}

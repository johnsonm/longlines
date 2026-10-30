// Long Lines inbound worker. Holds one connection per feed and pushes every spot
// line to the feed's Edge Function, which stores all of them (and, for RBN and
// DX Cluster, alerts on watched callsigns). Runs on Fly.io (inbound/fly.toml);
// docs/OPERATIONS.md has the deploy steps. The inbound worker itself is inbound.ts; this
// file is only the process shell.

import { flushErrors, reportError, startSentry } from "../supabase/functions/_shared/sentry.ts";
import { loadConfig } from "./config.ts";
import { aprsFeed, dxclusterFeed, type Feed, RBN_FEED } from "./feeds.ts";
import { startInbound } from "./inbound.ts";

// How long a fatal exit waits for its report to reach Sentry.
const FLUSH_MS = 2_000;

function env(name: string): string | undefined {
  return Deno.env.get(name);
}

/** RBN and DX Cluster always; APRS-IS once APRS_LOGIN_CALL is set. */
function defaultFeeds(): Feed[] {
  const aprs = aprsFeed(env);
  const feeds = [RBN_FEED, dxclusterFeed(env)];
  if (aprs !== null) {
    feeds.push(aprs);
  }
  return feeds;
}

/** Run the inbound worker until SIGINT/SIGTERM. `feedList` is overridable for local end-to-end runs. */
export async function main(
  feedList: readonly Feed[],
): Promise<void> {
  const config = loadConfig(env);
  startSentry(config.sentry);
  const inbound = startInbound(config, feedList, {});

  // Fly sends SIGINT (the default kill_signal) on deploy and restart. Push what
  // is buffered before exiting so a deploy does not lose spots.
  async function shutdown(): Promise<void> {
    await inbound.shutdown();
    Deno.exit(0);
  }
  function onSignal(): void {
    void shutdown();
  }
  Deno.addSignalListener("SIGINT", onSignal);
  Deno.addSignalListener("SIGTERM", onSignal);

  await inbound.done;
}

async function exitOnFailure(error: unknown): Promise<void> {
  let message: string;
  if (error instanceof Error) {
    message = error.message;
  } else {
    message = String(error);
  }
  console.error(`inbound failed: ${message}`);
  reportError(`inbound failed: ${message}`, error);
  await flushErrors(FLUSH_MS);
  // Exit non-zero so Fly restarts the machine.
  Deno.exit(1);
}

if (import.meta.main) {
  main(defaultFeeds()).catch(exitOnFailure);
}

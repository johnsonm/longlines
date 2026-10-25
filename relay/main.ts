// Long Lines stream relay. Holds one connection per feed and pushes every spot
// line to the feed's Edge Function, which stores all of them (and, for RBN and
// DX Cluster, alerts on watched callsigns). Runs on Fly.io (relay/fly.toml);
// docs/OPERATIONS.md has the deploy steps. The relay itself is relay.ts; this
// file is only the process shell.

import { loadConfig } from "./config.ts";
import { aprsFeed, dxclusterFeed, type Feed, RBN_FEED } from "./feeds.ts";
import { startRelay } from "./relay.ts";

function env(name: string): string | undefined {
  return Deno.env.get(name);
}

/** RBN and DX Cluster always; APRS-IS once APRS_LOGIN_CALL is set. */
function defaultFeeds(): Feed[] {
  const aprs = aprsFeed(env);
  const feeds = [RBN_FEED, dxclusterFeed(env)];
  if (aprs !== null && aprs !== undefined) {
    feeds.push(aprs);
  }
  return feeds;
}

/** Run the relay until SIGINT/SIGTERM. `feedList` is overridable for local end-to-end runs. */
export async function main(
  feedList: readonly Feed[],
): Promise<void> {
  const relay = startRelay(loadConfig(env), feedList, {});

  // Fly sends SIGINT (the default kill_signal) on deploy and restart. Push what
  // is buffered before exiting so a deploy does not lose spots.
  async function shutdown(): Promise<void> {
    await relay.shutdown();
    Deno.exit(0);
  }
  function onSignal(): void {
    void shutdown();
  }
  Deno.addSignalListener("SIGINT", onSignal);
  Deno.addSignalListener("SIGTERM", onSignal);

  await relay.done;
}

function exitOnFailure(error: unknown): void {
  let message: string;
  if (error instanceof Error) {
    message = error.message;
  } else {
    message = String(error);
  }
  console.error(`relay failed: ${message}`);
  // Exit non-zero so Fly restarts the machine.
  Deno.exit(1);
}

if (import.meta.main) {
  main(defaultFeeds()).catch(exitOnFailure);
}

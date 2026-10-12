// Long Lines stream relay. Holds one telnet connection per feed and pushes
// every spot line to the feed's Edge Function, which stores all of them and
// alerts on watched callsigns. Runs on Fly.io (see the root fly.toml);
// docs/OPERATIONS.md has the deploy steps. The relay itself is relay.ts; this
// file is only the process shell.

import { loadConfig } from "./config.ts";
import { dxclusterFeed, type Feed, RBN_FEED } from "./feeds.ts";
import { startRelay } from "./relay.ts";

const env = (name: string) => Deno.env.get(name);

/** Run the relay until SIGINT/SIGTERM. `feedList` is overridable for local end-to-end runs. */
export async function main(
  feedList: readonly Feed[] = [RBN_FEED, dxclusterFeed(env)],
): Promise<void> {
  const relay = startRelay(loadConfig(env), feedList);

  // Fly sends SIGINT (the default kill_signal) on deploy and restart. Push what
  // is buffered before exiting so a deploy does not lose spots.
  const shutdown = () => relay.shutdown().then(() => Deno.exit(0));
  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);

  await relay.done;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`relay failed: ${error instanceof Error ? error.message : String(error)}`);
    // Exit non-zero so Fly restarts the machine.
    Deno.exit(1);
  });
}

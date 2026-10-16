// Long Lines outbound sender. Claims queued deliveries from Postgres and sends
// them to Discord, webhooks and browser push services; what to claim, the
// per-destination budgets, throttles, expiry and destination health are all
// decided in SQL. Runs on Fly.io (sender/fly.toml); docs/OPERATIONS.md has the
// deploy steps. The sender itself is sender.ts; this file is only the process
// shell.

import { sendToDestination } from "../supabase/functions/_shared/delivery/send.ts";
import { loadConfig } from "./config.ts";
import { openSenderDb } from "./db.ts";
import { startSender } from "./sender.ts";

/** Run the sender until SIGINT/SIGTERM, or until the watchdog gives up. */
export async function main(): Promise<void> {
  const config = loadConfig((name) => Deno.env.get(name));
  // A pool that cannot open is exit 1, like invalid config.
  const db = await openSenderDb(config);
  const sender = startSender(config, {
    db,
    send: (destination, deliveries, now) =>
      sendToDestination(destination, deliveries, {
        allowInsecure: config.allowInsecure,
        vapid: config.vapid,
        now,
      }),
  });

  // Fly sends SIGINT (kill_signal) on deploy and restart and waits
  // kill_timeout for the exit. Stop claiming, let the cycle in flight finish
  // its marks, then exit; a cycle cut off by the timeout leaves un-acked
  // messages that reappear after the visibility timeout and are sent once more.
  const shutdown = () => sender.shutdown().then(() => Deno.exit(0));
  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);

  await sender.done;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`sender failed: ${error instanceof Error ? error.message : String(error)}`);
    // Exit non-zero so Fly restarts the machine.
    Deno.exit(1);
  });
}

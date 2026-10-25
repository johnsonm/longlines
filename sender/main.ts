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
  // openSenderDb retries with backoff for a few minutes; a pool that still
  // cannot open is exit 1, like invalid config.
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
  async function shutdown(): Promise<void> {
    await sender.shutdown();
    Deno.exit(0);
  }
  function onSignal(): void {
    void shutdown();
  }
  Deno.addSignalListener("SIGINT", onSignal);
  Deno.addSignalListener("SIGTERM", onSignal);

  await sender.done;
}

function exitOnFailure(error: unknown): void {
  let message: string;
  if (error instanceof Error) {
    message = error.message;
  } else {
    message = String(error);
  }
  console.error(`sender failed: ${message}`);
  // Exit non-zero so Fly restarts the machine.
  Deno.exit(1);
}

if (import.meta.main) {
  main().catch(exitOnFailure);
}

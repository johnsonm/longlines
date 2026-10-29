// Long Lines outbound sender. Claims queued deliveries from Postgres and sends
// them to Discord, webhooks and browser push services, and to Long Lines Relay
// through its spots stream (cluster_stream.ts); what to claim, the
// per-destination budgets, throttles, expiry and destination health are all
// decided in SQL. Runs on Fly.io (sender/fly.toml); docs/OPERATIONS.md has the
// deploy steps. The sender itself is sender.ts; this file is only the process
// shell.

import { sendToDestination } from "../supabase/functions/_shared/delivery/send.ts";
import { TimeoutError } from "../supabase/functions/_shared/errors.ts";
import {
  createClusterStream,
  KEEPALIVE_MS,
  MAX_BUFFERED_BYTES,
  MAX_HANDSHAKES,
  MAX_HANDSHAKES_PER_ADDRESS,
  routeSend,
  SHUTDOWN_GRACE_MS,
} from "./cluster_stream.ts";
import { loadConfig } from "./config.ts";
import { openSenderDb, withTimeout } from "./db.ts";
import { startSender } from "./sender.ts";

function logLine(message: string): void {
  console.log(message);
}

/** Run the sender until SIGINT/SIGTERM, or until the watchdog gives up. */
export async function main(): Promise<void> {
  const config = loadConfig((name) => Deno.env.get(name));
  // openSenderDb retries with backoff for a few minutes; a pool that still
  // cannot open is exit 1, like invalid config.
  const db = await openSenderDb(config, {});
  // Long Lines Relay's spots stream, on its own port. Its RPCs share the pool but not the
  // watchdog: only the delivery loop counts as progress.
  const stream = createClusterStream({
    db,
    hostname: "0.0.0.0",
    port: config.streamPort,
    keepaliveMs: KEEPALIVE_MS,
    maxBufferedBytes: MAX_BUFFERED_BYTES,
    maxHandshakes: MAX_HANDSHAKES,
    maxHandshakesPerAddress: MAX_HANDSHAKES_PER_ADDRESS,
    shutdownGraceMs: SHUTDOWN_GRACE_MS,
    log: logLine,
  });
  await stream.serve();
  const sender = startSender(config, {
    db,
    send: routeSend(
      stream,
      (destination, deliveries, now) =>
        sendToDestination(destination, deliveries, {
          allowInsecure: config.allowInsecure,
          vapid: config.vapid,
          now,
        }),
    ),
  }, {});

  // Fly sends SIGINT (kill_signal) on deploy and restart and waits
  // kill_timeout for the exit. End the relays' streams and mark them offline
  // while the pool is open, then stop claiming, let the cycle in flight finish
  // its marks, and exit; a cycle cut off by the timeout leaves un-acked
  // messages that reappear after the visibility timeout and are sent once more.
  // A Local DX cluster row that cycle still held finds no stream and waits out
  // the visibility timeout, like any unattempted row.
  async function shutdown(): Promise<void> {
    await stream.close();
    await sender.shutdown();
    Deno.exit(0);
  }
  function onSignal(): void {
    void shutdown();
  }
  Deno.addSignalListener("SIGINT", onSignal);
  Deno.addSignalListener("SIGTERM", onSignal);

  try {
    await sender.done;
  } catch (error) {
    // Exiting 1 (the watchdog, or a bug): end the streams and mark the relays offline if the
    // database still answers within a few seconds. The next start marks them offline anyway.
    try {
      await withTimeout(stream.close(), SHUTDOWN_GRACE_MS * 2, "closing the spots stream");
    } catch (closeError) {
      if (!(closeError instanceof TimeoutError)) {
        throw closeError;
      }
      console.error(`sender: ${closeError.message} timed out`);
    }
    throw error;
  }
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

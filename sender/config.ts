// Sender configuration from the environment (Fly secrets in production).
// Everything the process reads from the environment is read here or by
// vapidKeysFromEnv; sender/Dockerfile's --allow-env list must name each
// variable (sender/__tests__/modules.test.ts checks it).

import {
  type VapidKeys,
  vapidKeysFromEnv,
} from "../supabase/functions/_shared/delivery/webpush.ts";

export const DEFAULT_HEALTH_PORT = 8080;
export const DEFAULT_POLL_MS = 5_000;
/** A poll faster than this would hammer the pooler for nothing; the claim meters per minute anyway. */
export const MIN_POLL_MS = 1_000;
export const DEFAULT_CONCURRENCY = 4;
/** No successful claim for this long means the connection is wedged: the watchdog exits 1. */
export const DEFAULT_STALE_MS = 120_000;
export const DEFAULT_STATS_MS = 60_000;

export interface SenderConfig {
  /** postgres:// URL for the delivery_sender role. Carries the password: never log it. */
  databaseUrl: string;
  /** TLS to the pooler; off only for a local database host. */
  databaseSsl: boolean;
  healthPort: number;
  /** Pause between claims that found less than a full batch. */
  pollMs: number;
  /** Destinations sent at once within a cycle. */
  concurrency: number;
  staleMs: number;
  /** How often delivery_queue_stats() refreshes the /healthz queue figures. */
  statsMs: number;
  /** From LONGLINES_VAPID_*; push sends fail without it, the other types are unaffected. */
  vapid: VapidKeys | undefined;
  /** Plain-http destinations, for a local receiver; honoured only with a local database. */
  allowInsecure: boolean;
}

/** Hosts that stand for this machine: no TLS to the database, insecure destinations allowed. */
export function isLocalHost(hostname: string): boolean {
  return ["127.0.0.1", "localhost", "host.docker.internal", "[::1]"].includes(hostname);
}

function required(env: (name: string) => string | undefined, name: string): string {
  const value = env(name)?.trim();
  if (!value) throw new Error(`missing environment variable ${name}`);
  return value;
}

/** A TCP port from an environment variable; throws naming the variable otherwise. */
export function portNumber(value: string, name: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${name} must be a port number`);
  }
  return port;
}

/** A whole number of milliseconds (or destinations) at least `min`; unset means `fallback`. */
export function integerAtLeast(
  value: string | undefined,
  name: string,
  fallback: number,
  min: number,
): number {
  const v = value?.trim();
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${name} must be a whole number of at least ${min}`);
  }
  return n;
}

/**
 * SENDER_DATABASE_URL must be a postgres URL with a user, a password and a
 * host. The error messages never echo the value, which carries the password.
 */
function databaseUrl(value: string): { url: string; local: boolean } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("SENDER_DATABASE_URL must be a postgres:// URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("SENDER_DATABASE_URL must be a postgres:// URL");
  }
  if (!url.hostname) throw new Error("SENDER_DATABASE_URL must name a host");
  if (!url.username) throw new Error("SENDER_DATABASE_URL must name a user");
  // postgres.js would fall back to PGPASSWORD, which the image does not allow it to read.
  if (!url.password) throw new Error("SENDER_DATABASE_URL must carry a password");
  const local = isLocalHost(url.hostname);
  const sslmode = url.searchParams.get("sslmode");
  if (!local && (sslmode === "disable" || sslmode === "allow")) {
    throw new Error("SENDER_DATABASE_URL must use TLS outside local development");
  }
  return { url: value, local };
}

export function loadConfig(env: (name: string) => string | undefined): SenderConfig {
  const db = databaseUrl(required(env, "SENDER_DATABASE_URL"));
  const allowInsecure = env("LONGLINES_ALLOW_INSECURE_DESTINATIONS") === "1";
  if (allowInsecure && !db.local) {
    throw new Error(
      "LONGLINES_ALLOW_INSECURE_DESTINATIONS is for local development only (the database host is not local)",
    );
  }
  return {
    databaseUrl: db.url,
    databaseSsl: !db.local,
    healthPort: portNumber(
      env("SENDER_HEALTH_PORT") ?? String(DEFAULT_HEALTH_PORT),
      "SENDER_HEALTH_PORT",
    ),
    pollMs: integerAtLeast(env("SENDER_POLL_MS"), "SENDER_POLL_MS", DEFAULT_POLL_MS, MIN_POLL_MS),
    concurrency: integerAtLeast(
      env("SENDER_CONCURRENCY"),
      "SENDER_CONCURRENCY",
      DEFAULT_CONCURRENCY,
      1,
    ),
    staleMs: integerAtLeast(
      env("SENDER_STALE_MS"),
      "SENDER_STALE_MS",
      DEFAULT_STALE_MS,
      MIN_POLL_MS,
    ),
    statsMs: integerAtLeast(
      env("SENDER_STATS_MS"),
      "SENDER_STATS_MS",
      DEFAULT_STATS_MS,
      MIN_POLL_MS,
    ),
    vapid: vapidKeysFromEnv(env),
    allowInsecure,
  };
}

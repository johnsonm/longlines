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
/** No progress (claim, send or mark) for this long means the connection is wedged: the watchdog exits 1. */
export const DEFAULT_STALE_MS = 120_000;
export const DEFAULT_STATS_MS = 60_000;
/** A failed claim or bookkeeping call is retried after this, doubling to the maximum (sender.ts). */
export const RETRY_MIN_MS = 5_000;
export const RETRY_MAX_MS = 60_000;
/**
 * SENDER_STALE_MS must exceed the longest healthy wait between two progress
 * reports (an idle poll, or the longest claim retry) by at least this much,
 * or the watchdog would exit 1 on a healthy sender.
 */
export const STALE_MARGIN_MS = 30_000;
/** Ceiling for every millisecond knob: far below setTimeout's 2^31-1, above which it fires at once. */
export const MAX_INTERVAL_MS = 3_600_000;

export interface SenderConfig {
  /** postgres:// URL for the delivery_sender role. Carries the password: never log it. */
  databaseUrl: string;
  /** TLS to the pooler; off only for a local database host. */
  databaseSsl: boolean;
  /**
   * SENDER_DATABASE_CA, the PEM certificate(s) the pooler's certificate must
   * chain to. Unset means TLS without verifying the server (logged at start).
   */
  databaseCa: string | undefined;
  /** Check the certificate's name against the host too (sslmode verify-full, the default with a CA). */
  databaseVerifyHost: boolean;
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

/** The trimmed value, or "" when unset. */
function trimmed(value: string | undefined): string {
  if (value === undefined) {
    return "";
  }
  return value.trim();
}

function required(env: (name: string) => string | undefined, name: string): string {
  const value = trimmed(env(name));
  if (value === "") {
    throw new Error(`missing environment variable ${name}`);
  }
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

/**
 * A whole number of milliseconds (or destinations) at least `min` and, when
 * given, at most `max`; unset means `fallback`.
 */
export function integerAtLeast(
  value: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max?: number,
): number {
  const v = trimmed(value);
  if (v === "") {
    return fallback;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${name} must be a whole number of at least ${String(min)}`);
  }
  if (max !== undefined && n > max) {
    throw new Error(`${name} must be at most ${String(max)}`);
  }
  return n;
}

/**
 * SENDER_DATABASE_CA as PEM text. A Fly secret keeps real newlines; a value
 * pasted with literal "\n" escapes is accepted too.
 */
function databaseCa(value: string | undefined): string | undefined {
  const v = trimmed(value).replaceAll("\\n", "\n");
  if (v === "") {
    return undefined;
  }
  if (!v.includes("-----BEGIN CERTIFICATE-----") || !v.includes("-----END CERTIFICATE-----")) {
    throw new Error("SENDER_DATABASE_CA must be a PEM certificate (-----BEGIN CERTIFICATE-----)");
  }
  return v;
}

/**
 * SENDER_DATABASE_URL must be a postgres URL with a user, a password and a
 * host. The error messages never echo the value, which carries the password.
 */
function databaseUrl(value: string): { url: string; local: boolean; sslmode: string | null } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("SENDER_DATABASE_URL must be a postgres:// URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("SENDER_DATABASE_URL must be a postgres:// URL");
  }
  if (url.hostname === "") {
    throw new Error("SENDER_DATABASE_URL must name a host");
  }
  if (url.username === "") {
    throw new Error("SENDER_DATABASE_URL must name a user");
  }
  // postgres.js would fall back to PGPASSWORD, which the image does not allow it to read.
  if (url.password === "") {
    throw new Error("SENDER_DATABASE_URL must carry a password");
  }
  const local = isLocalHost(url.hostname);
  const sslmode = url.searchParams.get("sslmode");
  if (!local && (sslmode === "disable" || sslmode === "allow")) {
    throw new Error("SENDER_DATABASE_URL must use TLS outside local development");
  }
  return { url: value, local, sslmode };
}

export function loadConfig(env: (name: string) => string | undefined): SenderConfig {
  const db = databaseUrl(required(env, "SENDER_DATABASE_URL"));
  const allowInsecure = env("LONGLINES_ALLOW_INSECURE_DESTINATIONS") === "1";
  if (allowInsecure && !db.local) {
    throw new Error(
      "LONGLINES_ALLOW_INSECURE_DESTINATIONS is for local development only (the database host is not local)",
    );
  }
  const ca = databaseCa(env("SENDER_DATABASE_CA"));
  const verify = db.sslmode === "verify-full" || db.sslmode === "verify-ca";
  if (!db.local && verify && (ca === undefined || ca === "")) {
    throw new Error(
      `SENDER_DATABASE_URL asks for sslmode=${
        String(db.sslmode)
      }, which needs SENDER_DATABASE_CA (the server's CA certificate)`,
    );
  }
  const pollMs = integerAtLeast(
    env("SENDER_POLL_MS"),
    "SENDER_POLL_MS",
    DEFAULT_POLL_MS,
    MIN_POLL_MS,
    MAX_INTERVAL_MS,
  );
  const staleMs = integerAtLeast(
    env("SENDER_STALE_MS"),
    "SENDER_STALE_MS",
    DEFAULT_STALE_MS,
    MIN_POLL_MS,
    MAX_INTERVAL_MS,
  );
  const minStaleMs = Math.max(pollMs, RETRY_MAX_MS) + STALE_MARGIN_MS;
  if (staleMs < minStaleMs) {
    throw new Error(
      `SENDER_STALE_MS must be at least ${
        String(minStaleMs)
      } (the longer of SENDER_POLL_MS and the ` +
        `${String(RETRY_MAX_MS)} ms claim retry, plus ${
          String(STALE_MARGIN_MS)
        }), or the watchdog stops a healthy sender`,
    );
  }
  // TLS is off for a local host, so there is nothing to verify.
  let verifiedCa: string | undefined = ca;
  if (db.local) {
    verifiedCa = undefined;
  }
  let healthPort = env("SENDER_HEALTH_PORT");
  if (healthPort === undefined || healthPort === null) {
    healthPort = String(DEFAULT_HEALTH_PORT);
  }
  return {
    databaseUrl: db.url,
    databaseSsl: !db.local,
    databaseCa: verifiedCa,
    databaseVerifyHost: db.sslmode !== "verify-ca",
    healthPort: portNumber(healthPort, "SENDER_HEALTH_PORT"),
    pollMs,
    concurrency: integerAtLeast(
      env("SENDER_CONCURRENCY"),
      "SENDER_CONCURRENCY",
      DEFAULT_CONCURRENCY,
      1,
    ),
    staleMs,
    statsMs: integerAtLeast(
      env("SENDER_STATS_MS"),
      "SENDER_STATS_MS",
      DEFAULT_STATS_MS,
      MIN_POLL_MS,
      MAX_INTERVAL_MS,
    ),
    vapid: vapidKeysFromEnv(env),
    allowInsecure,
  };
}

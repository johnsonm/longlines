// Error reporting to Sentry (@sentry/deno) for the Edge Functions, the inbound worker and the
// sender, each its own project and DSN (longlines-functions, longlines-inbound,
// longlines-sender). Errors only: the default integrations are off, so nothing instruments
// Deno.serve or fetch, and no request, header, URL or destination reaches Sentry. A report
// carries the log line the code already writes and the error's own message, stack and causes,
// never more than the logs hold. The workers start Sentry from their loaded config; only an Edge
// Function, inside Supabase's Edge Runtime, starts it from the environment. Without SENTRY_DSN
// nothing starts and nothing is sent.

import * as Sentry from "@sentry/deno";
import type { DenoOptions, ErrorEvent } from "@sentry/deno";
import type { ErrorContext } from "./errors.ts";

export interface SentryConfig {
  dsn: string;
  environment: string;
  /** SENTRY_RELEASE, else Fly's FLY_IMAGE_REF; undefined on the Edge Functions. */
  release: string | undefined;
}

/** The variables sentryConfigFromEnv reads, for the workers' --allow-env lists. */
export const SENTRY_ENV = ["SENTRY_DSN", "SENTRY_ENVIRONMENT", "SENTRY_RELEASE", "FLY_IMAGE_REF"];

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  return value;
}

/** Null without SENTRY_DSN. The environment is production unless SENTRY_ENVIRONMENT says. */
export function sentryConfigFromEnv(
  env: (name: string) => string | undefined,
): SentryConfig | null {
  const dsn = nonEmpty(env("SENTRY_DSN"));
  const environment = nonEmpty(env("SENTRY_ENVIRONMENT"));
  const release = nonEmpty(env("SENTRY_RELEASE"));
  const imageRef = nonEmpty(env("FLY_IMAGE_REF"));
  if (dsn === undefined) {
    return null;
  }
  const config: SentryConfig = { dsn, environment: "production", release: imageRef };
  if (environment !== undefined) {
    config.environment = environment;
  }
  if (release !== undefined) {
    config.release = release;
  }
  return config;
}

/**
 * The last step before an event leaves: no server name (the host's), and this module's own
 * frames out of the app, so a logged failure's culprit is the code that logged it, not
 * logError. (Sentry still records the sending server's IP; the org's "Prevent Storing of IP
 * Addresses" setting is what stops that.)
 */
export function prepareEvent(event: ErrorEvent): ErrorEvent {
  delete event.server_name;
  if (event.exception === undefined || event.exception.values === undefined) {
    return event;
  }
  for (const value of event.exception.values) {
    if (value.stacktrace === undefined || value.stacktrace.frames === undefined) {
      continue;
    }
    for (const frame of value.stacktrace.frames) {
      if (frame.filename !== undefined && frame.filename.endsWith("/_shared/sentry.ts")) {
        frame.in_app = false;
      }
    }
  }
  return event;
}

export function sentryOptions(config: SentryConfig): DenoOptions {
  return {
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,
    // No Deno.serve, fetch, console or global-handler integrations: only what reportError sends.
    defaultIntegrations: false,
    // Nor the module-load hooks that rewrite CommonJS for diagnostics channels (they read files
    // the workers have no permission to read, and only the integrations above would use them).
    enableRuntimeChannelInjection: false,
    integrations: [Sentry.linkedErrorsIntegration(), Sentry.dedupeIntegration()],
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    beforeSend: prepareEvent,
  };
}

let started = false;

/**
 * Starts Sentry once per process or isolate; later calls do nothing. The workers call it from
 * main with their loaded config; the Edge Functions start it from the environment on their first
 * report (reportError). Until it runs, reportError sends nothing outside the Edge Runtime, so a
 * test with SENTRY_DSN in its environment never reports.
 */
export function startSentry(config: SentryConfig | null): void {
  if (started) {
    return;
  }
  started = true;
  if (config !== null) {
    Sentry.init(sentryOptions(config));
  }
}

function readEnv(name: string): string | undefined {
  return Deno.env.get(name);
}

// How long an Edge Function's report may take to send after the response.
const EDGE_FLUSH_MS = 2_000;

/** What reportError needs of Supabase's EdgeRuntime global. */
interface EdgeRuntimeApi {
  waitUntil: (promise: Promise<unknown>) => void;
}

/**
 * Supabase's `EdgeRuntime` global, or undefined outside the Edge Runtime (the workers, tests).
 * Its waitUntil keeps the isolate alive for a promise after the response has gone.
 */
function edgeRuntime(): EdgeRuntimeApi | undefined {
  const runtime: unknown = Reflect.get(globalThis, "EdgeRuntime");
  if (typeof runtime !== "function" && (typeof runtime !== "object" || runtime === null)) {
    return undefined;
  }
  const waitUntil: unknown = Reflect.get(runtime, "waitUntil");
  if (typeof waitUntil !== "function") {
    return undefined;
  }
  return {
    waitUntil(promise: Promise<unknown>): void {
      Reflect.apply(waitUntil, runtime, [promise]);
    },
  };
}

/** A failure logged without an Error object (a PostgREST error, a missing variable). */
export class LoggedError extends Error {
  constructor(message: string, context: ErrorContext) {
    super(message, { cause: context.cause });
    this.name = "LoggedError";
  }
}

/**
 * Reports a failure the code has already logged as `line`. An Error goes as itself, with the
 * line beside it; anything else becomes a LoggedError whose message is the line, so its stack
 * names the caller. Does nothing while Sentry is off. In the Edge Runtime it starts Sentry from
 * the environment and hands the send to waitUntil, since a handler returns its 500 at once and
 * the isolate may be suspended before the event leaves.
 */
export function reportError(line: string, error: unknown): void {
  const runtime = edgeRuntime();
  if (runtime !== undefined) {
    startSentry(sentryConfigFromEnv(readEnv));
  }
  if (!Sentry.isInitialized()) {
    return;
  }
  if (error instanceof Error) {
    Sentry.captureException(error, { contexts: { log: { line } } });
  } else {
    Sentry.captureException(new LoggedError(line, { cause: error }));
  }
  if (runtime !== undefined) {
    runtime.waitUntil(Sentry.flush(EDGE_FLUSH_MS));
  }
}

/** console.error(line), then reportError: the Edge Functions' failure log. */
export function logError(line: string, error: unknown): void {
  console.error(line);
  reportError(line, error);
}

/** Waits up to `timeoutMs` for reports in flight, before a worker exits. */
export async function flushErrors(timeoutMs: number): Promise<void> {
  if (!Sentry.isInitialized()) {
    return;
  }
  await Sentry.flush(timeoutMs);
}

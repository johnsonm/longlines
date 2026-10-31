import { assertEquals } from "@std/assert";
import * as Sentry from "@sentry/deno";
import { z } from "zod";
import {
  flushErrors,
  logError,
  prepareEvent,
  reportError,
  SENTRY_ENV,
  sentryConfigFromEnv,
  sentryOptions,
  startSentry,
} from "../sentry.ts";

function envOf(values: Record<string, string>): (name: string) => string | undefined {
  function env(name: string): string | undefined {
    return values[name];
  }
  return env;
}

// First in the file, before any test here starts the module.
Deno.test(
  "reportError outside the Edge Runtime starts nothing from the environment",
  function (): void {
    const before = Deno.env.get("SENTRY_DSN");
    Deno.env.set("SENTRY_DSN", "http://key@127.0.0.1:9/1");
    try {
      reportError("push failed: boom", new Error("boom"));
      assertEquals(Sentry.isInitialized(), false);
    } finally {
      if (before === undefined) {
        Deno.env.delete("SENTRY_DSN");
      } else {
        Deno.env.set("SENTRY_DSN", before);
      }
    }
  },
);

Deno.test("sentryConfigFromEnv is null without a DSN", function (): void {
  assertEquals(sentryConfigFromEnv(envOf({})), null);
  assertEquals(sentryConfigFromEnv(envOf({ SENTRY_DSN: "", SENTRY_ENVIRONMENT: "x" })), null);
});

Deno.test(
  "sentryConfigFromEnv defaults to production and takes Fly's image as the release",
  function (): void {
    const dsn = "https://k@o1.ingest.us.sentry.io/1";
    assertEquals(sentryConfigFromEnv(envOf({ SENTRY_DSN: dsn })), {
      dsn,
      environment: "production",
      release: undefined,
    });
    assertEquals(
      sentryConfigFromEnv(envOf({ SENTRY_DSN: dsn, FLY_IMAGE_REF: "registry.fly.io/app:d1" })),
      { dsn, environment: "production", release: "registry.fly.io/app:d1" },
    );
    assertEquals(
      sentryConfigFromEnv(
        envOf({
          SENTRY_DSN: dsn,
          SENTRY_ENVIRONMENT: "staging",
          SENTRY_RELEASE: "abc",
          FLY_IMAGE_REF: "registry.fly.io/app:d1",
        }),
      ),
      { dsn, environment: "staging", release: "abc" },
    );
  },
);

Deno.test("SENTRY_ENV names every variable sentryConfigFromEnv reads", function (): void {
  const read: string[] = [];
  function env(name: string): string | undefined {
    read.push(name);
    return undefined;
  }
  sentryConfigFromEnv(env);
  assertEquals(read.sort(), Array.from(SENTRY_ENV).sort());
});

Deno.test("sentryOptions turns off every default integration and data collection", function (): void {
  const options = sentryOptions({
    dsn: "https://k@o1.ingest.us.sentry.io/1",
    environment: "e",
    release: "r",
  });
  assertEquals(options.defaultIntegrations, false);
  assertEquals(options.enableRuntimeChannelInjection, false);
  assertEquals(options.tracesSampleRate, undefined);
  assertEquals(options.dataCollection, {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
    urlQueryParams: false,
  });
  let names: string[] = [];
  if (Array.isArray(options.integrations)) {
    names = options.integrations.map((integration) => integration.name).sort();
  }
  assertEquals(names, ["Dedupe", "LinkedErrors"]);
});

interface SentException {
  type: string;
  value: string;
}

interface SentEvent {
  environment: string;
  exception: { values: SentException[] };
  contexts: { log?: { line: string } };
}

const sentEventSchema: z.ZodType<SentEvent> = z.looseObject({
  environment: z.string(),
  exception: z.looseObject({
    values: z.array(z.looseObject({ type: z.string(), value: z.string() })),
  }),
  contexts: z.looseObject({ log: z.strictObject({ line: z.string() }).optional() }),
});

/** The event item of an envelope the receiver got (header, item header, item). */
function eventOf(body: string): SentEvent {
  const item = body.split("\n")[2];
  if (item === undefined) {
    throw new Error(`no event item in ${body}`);
  }
  return sentEventSchema.parse(JSON.parse(item));
}

function typeAndValue(value: SentException): string[] {
  return [value.type, value.value];
}

Deno.test(
  "reportError sends an Error with its log line and cause, and anything else as a LoggedError, " +
    "handing each send to the Edge Runtime's waitUntil",
  async function (): Promise<void> {
    const bodies: string[] = [];
    async function receive(req: Request): Promise<Response> {
      bodies.push(await req.text());
      return Response.json({});
    }
    const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, receive);
    const dsn = `http://key@127.0.0.1:${String(server.addr.port)}/1`;
    // Other test files may have started the module already (without a DSN); init directly.
    startSentry(null);
    Sentry.init(sentryOptions({ dsn, environment: "test", release: undefined }));
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (line: unknown) => errors.push(line);
    // Supabase's global: the handler returns at once, and waitUntil keeps the send alive.
    const waited: Promise<unknown>[] = [];
    Reflect.set(globalThis, "EdgeRuntime", {
      waitUntil(promise: Promise<unknown>): void {
        waited.push(promise);
      },
    });
    try {
      reportError("rpc failed: boom", new Error("boom", { cause: new Error("socket closed") }));
      logError("api: lookup failed: no row", { message: "no row", code: "PGRST116" });
      assertEquals(waited.length, 2);
      await Promise.all(waited);
    } finally {
      Reflect.deleteProperty(globalThis, "EdgeRuntime");
      console.error = originalError;
      // Closed, so later reports in this process are dropped and open no requests.
      await Sentry.close(2_000);
      await server.shutdown();
    }
    assertEquals(errors, ["api: lookup failed: no row"]);
    assertEquals(bodies.length, 2);
    const first = eventOf(String(bodies[0]));
    const second = eventOf(String(bodies[1]));
    assertEquals(first.environment, "test");
    assertEquals(first.exception.values.map(typeAndValue), [
      ["Error", "socket closed"],
      ["Error", "boom"],
    ]);
    assertEquals(first.contexts.log, { line: "rpc failed: boom" });
    assertEquals(second.exception.values.map(typeAndValue), [
      ["LoggedError", "api: lookup failed: no row"],
    ]);
    for (const body of bodies) {
      assertEquals(body.includes('"request"'), false);
      assertEquals(body.includes('"server_name"'), false);
    }
  },
);

Deno.test("flushErrors returns at once while Sentry is off", async function (): Promise<void> {
  // After the close above, or with no init at all, there is nothing to wait for.
  await flushErrors(1);
});

Deno.test(
  "prepareEvent drops the server name and takes this module's frames out of the app",
  function (): void {
    const event = prepareEvent({
      type: undefined,
      server_name: "host",
      exception: {
        values: [{
          type: "LoggedError",
          value: "x",
          stacktrace: {
            frames: [
              { filename: "/app/supabase/functions/_shared/handlers/api.ts", in_app: true },
              { filename: "/app/supabase/functions/_shared/sentry.ts", in_app: true },
              { in_app: true },
            ],
          },
        }, { type: "Error", value: "no stack" }],
      },
    });
    assertEquals(event.server_name, undefined);
    let inApp: (boolean | undefined)[] = [];
    if (event.exception !== undefined && event.exception.values !== undefined) {
      const first = event.exception.values[0];
      if (
        first !== undefined && first.stacktrace !== undefined &&
        first.stacktrace.frames !== undefined
      ) {
        inApp = first.stacktrace.frames.map(inAppOf);
      }
    }
    assertEquals(inApp, [true, false, true]);
    assertEquals(prepareEvent({ type: undefined }), { type: undefined });
  },
);

function inAppOf(frame: { in_app?: boolean }): boolean | undefined {
  return frame.in_app;
}

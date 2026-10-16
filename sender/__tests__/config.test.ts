import { assertEquals, assertThrows } from "@std/assert";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_HEALTH_PORT,
  DEFAULT_POLL_MS,
  DEFAULT_STALE_MS,
  DEFAULT_STATS_MS,
  integerAtLeast,
  isLocalHost,
  loadConfig,
  MIN_POLL_MS,
  portNumber,
} from "../config.ts";

const env = (values: Record<string, string>) => (name: string) => values[name];
const HOSTED =
  "postgresql://delivery_sender.abc:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres";
const LOCAL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const VAPID = {
  LONGLINES_VAPID_PUBLIC_KEY: "pub",
  LONGLINES_VAPID_PRIVATE_KEY: "priv",
  LONGLINES_VAPID_SUBJECT: "mailto:ops@example.org",
};

Deno.test("loadConfig applies the defaults and requires TLS to a hosted database", () => {
  assertEquals(loadConfig(env({ SENDER_DATABASE_URL: HOSTED })), {
    databaseUrl: HOSTED,
    databaseSsl: true,
    healthPort: DEFAULT_HEALTH_PORT,
    pollMs: DEFAULT_POLL_MS,
    concurrency: DEFAULT_CONCURRENCY,
    staleMs: DEFAULT_STALE_MS,
    statsMs: DEFAULT_STATS_MS,
    vapid: undefined,
    allowInsecure: false,
  });
  assertEquals([DEFAULT_POLL_MS, DEFAULT_STALE_MS, DEFAULT_STATS_MS], [5_000, 120_000, 60_000]);
  assertEquals([DEFAULT_CONCURRENCY, DEFAULT_HEALTH_PORT, MIN_POLL_MS], [4, 8080, 1_000]);
});

Deno.test("loadConfig reads every knob and the VAPID triple", () => {
  const config = loadConfig(env({
    SENDER_DATABASE_URL: HOSTED,
    SENDER_HEALTH_PORT: "9090",
    SENDER_POLL_MS: " 2000 ",
    SENDER_CONCURRENCY: "1",
    SENDER_STALE_MS: "30000",
    SENDER_STATS_MS: "10000",
    ...VAPID,
  }));
  assertEquals(config.healthPort, 9090);
  assertEquals(config.pollMs, 2000);
  assertEquals(config.concurrency, 1);
  assertEquals(config.staleMs, 30000);
  assertEquals(config.statsMs, 10000);
  assertEquals(config.vapid, {
    publicKey: "pub",
    privateKey: "priv",
    subject: "mailto:ops@example.org",
  });
  // A partial triple is no triple: push sends fail, the other types carry on.
  const partial = { ...VAPID, LONGLINES_VAPID_SUBJECT: " " };
  assertEquals(loadConfig(env({ SENDER_DATABASE_URL: HOSTED, ...partial })).vapid, undefined);
});

Deno.test("loadConfig turns TLS off and allows insecure destinations only for a local database", () => {
  const local = loadConfig(
    env({ SENDER_DATABASE_URL: LOCAL, LONGLINES_ALLOW_INSECURE_DESTINATIONS: "1" }),
  );
  assertEquals([local.databaseSsl, local.allowInsecure], [false, true]);
  assertEquals(loadConfig(env({ SENDER_DATABASE_URL: LOCAL })).allowInsecure, false);
  const docker = loadConfig(
    env({
      SENDER_DATABASE_URL: "postgres://postgres:postgres@host.docker.internal:54322/postgres",
    }),
  );
  assertEquals(docker.databaseSsl, false);
  assertThrows(
    () =>
      loadConfig(env({ SENDER_DATABASE_URL: HOSTED, LONGLINES_ALLOW_INSECURE_DESTINATIONS: "1" })),
    Error,
    "local development only",
  );
  // Anything but "1" is off.
  assertEquals(
    loadConfig(env({ SENDER_DATABASE_URL: HOSTED, LONGLINES_ALLOW_INSECURE_DESTINATIONS: "true" }))
      .allowInsecure,
    false,
  );
});

Deno.test("loadConfig rejects a missing, malformed, userless, passwordless or TLS-less database URL without echoing it", () => {
  const bad = (url: string, message: string) => {
    const error = assertThrows(() => loadConfig(env({ SENDER_DATABASE_URL: url })), Error, message);
    assertEquals(error.message.includes("pw"), false);
  };
  assertThrows(() => loadConfig(env({})), Error, "SENDER_DATABASE_URL");
  bad("not a url", "postgres:// URL");
  bad("https://u:pw@db.example.org/postgres", "postgres:// URL");
  bad("postgresql://:pw@db.example.org/postgres", "must name a user");
  bad("postgresql://u@db.example.org/postgres", "must carry a password");
  bad("postgresql://u:pw@db.example.org/postgres?sslmode=disable", "TLS");
  bad("postgresql://u:pw@db.example.org/postgres?sslmode=allow", "TLS");
  // sslmode=disable is fine locally, where there is no TLS to begin with.
  assertEquals(
    loadConfig(env({ SENDER_DATABASE_URL: `${LOCAL}?sslmode=disable` })).databaseSsl,
    false,
  );
});

Deno.test("loadConfig rejects bad ports and intervals, naming the variable", () => {
  const base = { SENDER_DATABASE_URL: HOSTED };
  assertThrows(
    () => loadConfig(env({ ...base, SENDER_HEALTH_PORT: "x" })),
    Error,
    "SENDER_HEALTH_PORT",
  );
  assertThrows(() => loadConfig(env({ ...base, SENDER_POLL_MS: "999" })), Error, "SENDER_POLL_MS");
  assertThrows(() => loadConfig(env({ ...base, SENDER_POLL_MS: "1.5" })), Error, "SENDER_POLL_MS");
  assertThrows(
    () => loadConfig(env({ ...base, SENDER_CONCURRENCY: "0" })),
    Error,
    "SENDER_CONCURRENCY",
  );
  assertThrows(
    () => loadConfig(env({ ...base, SENDER_STALE_MS: "abc" })),
    Error,
    "SENDER_STALE_MS",
  );
  assertThrows(() => loadConfig(env({ ...base, SENDER_STATS_MS: "-1" })), Error, "SENDER_STATS_MS");
  assertEquals(loadConfig(env({ ...base, SENDER_POLL_MS: "1000" })).pollMs, 1000);
});

Deno.test("portNumber, integerAtLeast and isLocalHost", () => {
  assertEquals(portNumber("8080", "P"), 8080);
  assertThrows(() => portNumber("0", "P"), Error, "P must be a port number");
  assertThrows(() => portNumber("70000", "P"), Error, "P must be a port number");
  assertEquals(integerAtLeast(undefined, "X", 7, 1), 7);
  assertEquals(integerAtLeast("  ", "X", 7, 1), 7);
  assertEquals(integerAtLeast("3", "X", 7, 1), 3);
  assertThrows(
    () => integerAtLeast("0", "X", 7, 1),
    Error,
    "X must be a whole number of at least 1",
  );
  for (const host of ["127.0.0.1", "localhost", "host.docker.internal", "[::1]"]) {
    assertEquals(isLocalHost(host), true, host);
  }
  assertEquals(isLocalHost("aws-0-us-east-1.pooler.supabase.com"), false);
  assertEquals(isLocalHost("10.0.0.1"), false);
});

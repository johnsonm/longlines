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
  MAX_INTERVAL_MS,
  MIN_POLL_MS,
  portNumber,
  RETRY_MAX_MS,
  STALE_MARGIN_MS,
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
    databaseCa: undefined,
    databaseVerifyHost: true,
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
    SENDER_STALE_MS: "90000",
    SENDER_STATS_MS: "10000",
    ...VAPID,
  }));
  assertEquals(config.healthPort, 9090);
  assertEquals(config.pollMs, 2000);
  assertEquals(config.concurrency, 1);
  assertEquals(config.staleMs, 90000);
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

const CA = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";

Deno.test("loadConfig reads SENDER_DATABASE_CA and honours sslmode verify-full and verify-ca", () => {
  const withCa = loadConfig(env({ SENDER_DATABASE_URL: HOSTED, SENDER_DATABASE_CA: `${CA}\n` }));
  assertEquals([withCa.databaseCa, withCa.databaseVerifyHost], [CA, true]);
  // Literal \n escapes, as a single-line paste would carry them.
  const escaped = CA.replaceAll("\n", "\\n");
  assertEquals(
    loadConfig(env({ SENDER_DATABASE_URL: HOSTED, SENDER_DATABASE_CA: escaped })).databaseCa,
    CA,
  );
  const full = loadConfig(
    env({ SENDER_DATABASE_URL: `${HOSTED}?sslmode=verify-full`, SENDER_DATABASE_CA: CA }),
  );
  assertEquals([full.databaseCa, full.databaseVerifyHost], [CA, true]);
  const chainOnly = loadConfig(
    env({ SENDER_DATABASE_URL: `${HOSTED}?sslmode=verify-ca`, SENDER_DATABASE_CA: CA }),
  );
  assertEquals([chainOnly.databaseCa, chainOnly.databaseVerifyHost], [CA, false]);
  // Asking for verification without a CA is refused rather than silently unverified.
  for (const mode of ["verify-full", "verify-ca"]) {
    assertThrows(
      () => loadConfig(env({ SENDER_DATABASE_URL: `${HOSTED}?sslmode=${mode}` })),
      Error,
      `sslmode=${mode}, which needs SENDER_DATABASE_CA`,
    );
  }
  assertThrows(
    () => loadConfig(env({ SENDER_DATABASE_URL: HOSTED, SENDER_DATABASE_CA: "not a cert" })),
    Error,
    "SENDER_DATABASE_CA must be a PEM certificate",
  );
  // A blank value is unset; a local database has no TLS to verify.
  assertEquals(
    loadConfig(env({ SENDER_DATABASE_URL: HOSTED, SENDER_DATABASE_CA: " " })).databaseCa,
    undefined,
  );
  assertEquals(
    loadConfig(env({ SENDER_DATABASE_URL: `${LOCAL}?sslmode=verify-full` })).databaseCa,
    undefined,
  );
  assertEquals(
    loadConfig(env({ SENDER_DATABASE_URL: LOCAL, SENDER_DATABASE_CA: CA })).databaseCa,
    undefined,
  );
});

Deno.test("loadConfig caps the interval knobs and keeps the watchdog above the poll and the claim retry", () => {
  const base = { SENDER_DATABASE_URL: HOSTED };
  assertEquals([MAX_INTERVAL_MS, RETRY_MAX_MS, STALE_MARGIN_MS], [3_600_000, 60_000, 30_000]);
  // The defaults pass with room: 120 s against 60 s + 30 s.
  assertEquals(DEFAULT_STALE_MS >= Math.max(DEFAULT_POLL_MS, RETRY_MAX_MS) + STALE_MARGIN_MS, true);
  for (const name of ["SENDER_POLL_MS", "SENDER_STALE_MS", "SENDER_STATS_MS"]) {
    assertThrows(
      () => loadConfig(env({ ...base, [name]: String(MAX_INTERVAL_MS + 1) })),
      Error,
      `${name} must be at most 3600000`,
    );
  }
  assertThrows(
    () => loadConfig(env({ ...base, SENDER_STALE_MS: "89999" })),
    Error,
    "SENDER_STALE_MS must be at least 90000",
  );
  assertEquals(loadConfig(env({ ...base, SENDER_STALE_MS: "90000" })).staleMs, 90000);
  // A poll longer than the retry raises the floor.
  assertThrows(
    () => loadConfig(env({ ...base, SENDER_POLL_MS: "300000", SENDER_STALE_MS: "320000" })),
    Error,
    "SENDER_STALE_MS must be at least 330000",
  );
  // The longest poll that still fits under the cap.
  const slow = loadConfig(env({ ...base, SENDER_POLL_MS: "3570000", SENDER_STALE_MS: "3600000" }));
  assertEquals([slow.pollMs, slow.staleMs], [3_570_000, 3_600_000]);
});

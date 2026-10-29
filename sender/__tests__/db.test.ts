// The postgres.js adapter. The pure parts (the allowlist, the statements, the
// row and error mapping) always run; the last tests open a real pool and run
// only with SENDER_TEST_DATABASE_URL set (CI's migrations job points it at the
// fresh local stack; never a hosted database).
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { TimeoutError } from "../../supabase/functions/_shared/errors.ts";
import { isLocalHost } from "../config.ts";
import { RETRY_MAX_MS, RETRY_MIN_MS } from "../config.ts";
import {
  clientOptions,
  DatabaseOpenError,
  OPEN_DEADLINE_MS,
  openSenderDb,
  PROBE_TIMEOUT_MS,
  RpcAllowlistError,
  rpcStatement,
  SENDER_RPCS,
  senderDb,
  type SqlClient,
  type SqlParam,
  sslOption,
  withTimeout,
} from "../db.ts";

/** SENDER_TEST_DATABASE_URL, trimmed; unset or blank is undefined. */
function testDatabaseUrl(): string | undefined {
  const value = Deno.env.get("SENDER_TEST_DATABASE_URL");
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }
  return trimmed;
}

const DATABASE_URL = testDatabaseUrl();

// Rejects with whatever it is given, so a test can reject with a non-Error.
async function rejectWith(reason: unknown): Promise<never> {
  await Promise.resolve();
  throw reason;
}

/** Does nothing: a promise executor that never settles, or a log that drops every line. */
function noop(): void {}

Deno.test("SENDER_RPCS is exactly the sender role's allowlist", function (): void {
  assertEquals(Object.keys(SENDER_RPCS).sort(), [
    "authenticate_relay_token",
    "claim_deliveries",
    "delivery_queue_stats",
    "mark_deliveries_failed",
    "mark_deliveries_sent",
    "prune_push_devices",
    "record_push_results",
    "record_sender_heartbeat",
    "reset_cluster_streams",
    "set_cluster_stream",
    "throttle_destination",
  ]);
});

Deno.test("rpcStatement casts the spots stream's token hash, id and state", function (): void {
  assertEquals(rpcStatement("authenticate_relay_token", { p_token_hash: "ab" }), {
    text: "select * from public.authenticate_relay_token(p_token_hash => $1::text)",
    params: [{ value: "ab", type: "text" }],
  });
  assertEquals(rpcStatement("set_cluster_stream", { p_token_id: "u", p_connected: false }), {
    text: "select * from public.set_cluster_stream(p_token_id => $1::uuid, " +
      "p_connected => $2::boolean)",
    params: [{ value: "u", type: "uuid" }, { value: false, type: "boolean" }],
  });
  assertEquals(rpcStatement("reset_cluster_streams", {}), {
    text: "select * from public.reset_cluster_streams()",
    params: [],
  });
});

Deno.test("rpcStatement casts the heartbeat's times and memory", function (): void {
  assertEquals(
    rpcStatement("record_sender_heartbeat", {
      p_started_at: "2026-10-21T12:00:00.000Z",
      p_last_progress_at: null,
      p_rss_bytes: 90_000_000,
    }),
    {
      text: "select * from public.record_sender_heartbeat(p_started_at => $1::timestamptz, " +
        "p_last_progress_at => $2::timestamptz, p_rss_bytes => $3::bigint)",
      params: [
        { value: "2026-10-21T12:00:00.000Z", type: "timestamptz" },
        { value: null, type: "timestamptz" },
        { value: 90_000_000, type: "bigint" },
      ],
    },
  );
});

Deno.test(
  "rpcStatement names and casts every parameter in the function's order",
  function (): void {
    assertEquals(rpcStatement("claim_deliveries", { p_limit: 200, p_vt: 60 }), {
      text: "select * from public.claim_deliveries(p_limit => $1::int, p_vt => $2::int)",
      params: [{ value: 200, type: "int" }, { value: 60, type: "int" }],
    });
    assertEquals(
      rpcStatement("mark_deliveries_failed", {
        p_error: "HTTP 500",
        p_delay_seconds: 30,
        p_msg_ids: [10],
        p_delivery_ids: [1],
      }),
      {
        text: "select * from public.mark_deliveries_failed(p_delivery_ids => $1::bigint[], " +
          "p_msg_ids => $2::bigint[], p_error => $3::text, p_delay_seconds => $4::int)",
        params: [
          { value: [1], type: "bigint[]" },
          { value: [10], type: "bigint[]" },
          { value: "HTTP 500", type: "text" },
          { value: 30, type: "int" },
        ],
      },
    );
    assertEquals(rpcStatement("delivery_queue_stats", {}), {
      text: "select * from public.delivery_queue_stats()",
      params: [],
    });
    // A missing argument (throttle_destination without Retry-After) is null.
    const throttle = rpcStatement("throttle_destination", {
      p_destination_id: "u",
      p_msg_ids: [1],
    });
    assertEquals(throttle.params[2], { value: null, type: "int" });
    assertEquals(
      rpcStatement("throttle_destination", {
        p_destination_id: "u",
        p_msg_ids: [1],
        p_seconds: null,
      })
        .params[2],
      {
        value: null,
        type: "int",
      },
    );
  },
);

Deno.test("rpcStatement refuses functions and parameters outside the allowlist", function (): void {
  assertThrows(
    () => rpcStatement("delay_deliveries", {}),
    RpcAllowlistError,
    "not in the sender's RPC allowlist",
  );
  assertThrows(
    () => rpcStatement("toString", {}),
    RpcAllowlistError,
    "not in the sender's RPC allowlist",
  );
  assertThrows(
    () => rpcStatement("claim_deliveries", { p_limit: 1, limit: 1 }),
    RpcAllowlistError,
    "has no parameter limit",
  );
});

interface Executed {
  text: string;
  params: SqlParam[];
  options: { prepare: boolean };
}

/** A SqlClient that records statements and answers from `rows`, or throws `failure`. */
function fakeSql(rows: Array<Record<string, unknown>>, failure: Error | undefined) {
  const executed: Executed[] = [];
  const ended: Array<{ timeout?: number } | undefined> = [];
  const sql: SqlClient = {
    unsafe(text, params, options) {
      executed.push({ text, params, options });
      if (failure !== undefined) {
        return Promise.reject(failure);
      }
      return Promise.resolve(rows);
    },
    json: (value) => ({ json: value }),
    end(options) {
      ended.push(options);
      return Promise.resolve();
    },
  };
  return { sql, executed, ended };
}

Deno.test(
  "senderDb runs the statement prepared, returns the rows as data and wraps jsonb with sql.json",
  async function (): Promise<void> {
    const fake = fakeSql([{ msg_id: 7, delivery_id: 3 }], undefined);
    const db = senderDb(fake.sql);
    assertEquals(await db.rpc("claim_deliveries", { p_limit: 5, p_vt: 60 }), {
      data: [{ msg_id: 7, delivery_id: 3 }],
      error: null,
    });
    assertEquals(fake.executed[0], {
      text: "select * from public.claim_deliveries(p_limit => $1::int, p_vt => $2::int)",
      params: [5, 60],
      options: { prepare: true },
    });
    await db.rpc("record_push_results", { p_ok: ["https://a"], p_errors: { "https://b": "410" } });
    assertEquals(fake.executed[1]!.params, [["https://a"], { json: { "https://b": "410" } }]);
    await db.close();
    assertEquals(fake.ended, [{ timeout: 5 }]);
  },
);

Deno.test(
  "senderDb turns a thrown error, or a call outside the allowlist, into an error message",
  async function (): Promise<void> {
    const failing = senderDb(
      fakeSql([], new Error("permission denied for function claim_deliveries")).sql,
    );
    assertEquals(await failing.rpc("claim_deliveries", { p_limit: 1, p_vt: 1 }), {
      data: null,
      error: "permission denied for function claim_deliveries",
    });
    const fake = fakeSql([], undefined);
    assertEquals(await senderDb(fake.sql).rpc("delay_deliveries", {}), {
      data: null,
      error: "delay_deliveries is not in the sender's RPC allowlist",
    });
    assertEquals(fake.executed, []); // never reached the database
  },
);

Deno.test(
  "senderDb answers an argument of the wrong type with an error message, before the database",
  async function (): Promise<void> {
    const fake = fakeSql([], undefined);
    const db = senderDb(fake.sql);
    const limit = await db.rpc("claim_deliveries", { p_limit: "5", p_vt: 60 });
    assertEquals(limit.data, null);
    assertEquals(
      limit.error!.startsWith("senderDb.rpc: parameter $1::int: (root): Invalid input"),
      true,
      limit.error!,
    );
    const ids = await db.rpc("mark_deliveries_sent", { p_delivery_ids: [1, "2"], p_msg_ids: [] });
    assertEquals(ids.error!.startsWith("senderDb.rpc: parameter $1::bigint[]: 1: "), true);
    const json = await db.rpc("record_push_results", { p_ok: [], p_errors: { a: 1n } });
    assertEquals(json.error!.startsWith("senderDb.rpc: parameter $2::jsonb: "), true, json.error!);
    const state = await db.rpc("set_cluster_stream", { p_token_id: "u", p_connected: "true" });
    assertEquals(
      state.error!.startsWith("senderDb.rpc: parameter $2::boolean: (root): Invalid input"),
      true,
      state.error!,
    );
    assertEquals(fake.executed, []);
    // A missing argument is null, which every type takes.
    assertEquals((await db.rpc("throttle_destination", {})).error, null);
    assertEquals(fake.executed[0]!.params, [null, null, null]);
  },
);

Deno.test(
  "senderDb rethrows a rejection that is not an Error",
  async function (): Promise<void> {
    const sql: SqlClient = {
      unsafe: () => rejectWith("not an Error"),
      json: (value) => ({ json: value }),
      end: () => Promise.resolve(),
    };
    let caught: unknown = undefined;
    try {
      await senderDb(sql).rpc("delivery_queue_stats", {});
    } catch (error) {
      caught = error;
    }
    assertEquals(caught, "not an Error");
  },
);

Deno.test(
  "clientOptions takes the connection from the URL and sets every option postgres.js has a PG* fallback for",
  function (): void {
    const options = clientOptions({
      databaseUrl:
        "postgresql://delivery_sender.abc:p%40ss@aws-0-us-east-1.pooler.supabase.com/postgres",
      databaseSsl: true,
    });
    assertEquals(
      [options.host, options.port, options.user, options.password, options.database, options.ssl],
      [
        "aws-0-us-east-1.pooler.supabase.com",
        5432,
        "delivery_sender.abc",
        "p@ss",
        "postgres",
        "require",
      ],
    );
    assertEquals([options.max, options.prepare, options.connection.application_name], [
      2,
      true,
      "longlines-sender",
    ]);
    const local = clientOptions({
      databaseUrl: "postgresql://u:pw@127.0.0.1:54322/",
      databaseSsl: false,
    });
    assertEquals([local.port, local.database, local.ssl], [54322, "postgres", false]);
    // Every key postgres.js would otherwise read as PG<KEY> from the environment.
    for (
      const key of [
        "max",
        "ssl",
        "sslnegotiation",
        "idle_timeout",
        "connect_timeout",
        "max_lifetime",
        "max_pipeline",
        "backoff",
        "keep_alive",
        "prepare",
        "debug",
        "fetch_types",
        "publications",
        "target_session_attrs",
      ]
    ) {
      assertEquals(key in options, true, key);
    }
    // int8 and timestamps: Number and the raw string, like PostgREST.
    assertEquals(options.types.bigint.parse("42"), 42);
    assertEquals(options.types.bigint.serialize(42), "42");
    assertEquals(options.types.date.parse("2026-10-15 12:00:00+00"), "2026-10-15 12:00:00+00");
    assertEquals(
      options.types.date.serialize(new Date("2026-10-15T12:00:00Z")),
      "2026-10-15T12:00:00.000Z",
    );
    assertEquals(options.types.date.serialize("x"), "x");
    assertEquals(typeof options.backoff(1), "number");
  },
);

const POOLER = "postgresql://u:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres";
const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";

Deno.test("clientOptions verifies the server certificate only with a CA", function (): void {
  // No CA: encrypted, unverified ("require" sets rejectUnauthorized false in postgres.js).
  assertEquals(clientOptions({ databaseUrl: POOLER, databaseSsl: true }).ssl, "require");
  assertEquals(
    clientOptions({ databaseUrl: POOLER, databaseSsl: true, databaseCa: undefined }).ssl,
    "require",
  );
  // With a CA: the chain and the host name are checked.
  assertEquals(
    clientOptions({
      databaseUrl: POOLER,
      databaseSsl: true,
      databaseCa: PEM,
      databaseVerifyHost: true,
    })
      .ssl,
    { ca: PEM, rejectUnauthorized: true, servername: "aws-0-us-east-1.pooler.supabase.com" },
  );
  // sslmode=verify-ca: the chain only.
  const chainOnly = sslOption(
    { databaseUrl: POOLER, databaseSsl: true, databaseCa: PEM, databaseVerifyHost: false },
    "aws-0-us-east-1.pooler.supabase.com",
  );
  if (typeof chainOnly !== "object" || !chainOnly.checkServerIdentity) {
    throw new Error("verify-ca must replace the host name check");
  }
  assertEquals([chainOnly.ca, chainOnly.rejectUnauthorized], [PEM, true]);
  assertEquals(chainOnly.checkServerIdentity(), undefined);
  // No TLS at all for a local database, CA or not.
  assertEquals(
    sslOption({ databaseUrl: POOLER, databaseSsl: false, databaseCa: PEM }, "127.0.0.1"),
    false,
  );
});

Deno.test(
  "withTimeout passes a settled value through and rejects after the timeout",
  async function (): Promise<void> {
    assertEquals(await withTimeout(Promise.resolve(1), 1_000, "slow"), 1);
    await assertRejects(() => withTimeout(new Promise(noop), 10, "slow"), TimeoutError, "slow");
    await assertRejects(
      () => withTimeout(Promise.reject(new Error("boom")), 1_000, "slow"),
      Error,
      "boom",
    );
  },
);

/** A clock and sleep for openSenderDb: sleeping moves the clock. */
function fakeClock() {
  let t = 0;
  const slept: number[] = [];
  function sleep(ms: number) {
    slept.push(ms);
    t += ms;
    return Promise.resolve();
  }
  return {
    now: () => t,
    sleep,
    slept,
  };
}

Deno.test(
  "openSenderDb retries a failed probe with doubling delays and returns once it answers",
  async function (): Promise<void> {
    const clock = fakeClock();
    const logs: string[] = [];
    const clients: ReturnType<typeof fakeSql>[] = [];
    // The first four pools fail their probe; the fifth answers.
    function connect() {
      let fake = fakeSql([{ depth: 0 }], undefined);
      if (clients.length < 4) {
        fake = fakeSql([], new Error("connection refused"));
      }
      clients.push(fake);
      return fake.sql;
    }
    const db = await openSenderDb({ databaseUrl: POOLER, databaseSsl: true, databaseCa: PEM }, {
      now: clock.now,
      sleep: clock.sleep,
      log: (m) => logs.push(m),
      connect,
    });
    assertEquals(clock.slept, [RETRY_MIN_MS, 2 * RETRY_MIN_MS, 4 * RETRY_MIN_MS, 8 * RETRY_MIN_MS]);
    assertEquals(
      logs[0],
      `database probe failed: connection refused; retrying in ${RETRY_MIN_MS} ms`,
    );
    assertEquals(logs.length, 4); // a CA was given: no TLS warning
    // Every failed pool is closed; the one that answered stays open.
    assertEquals(clients.map((c) => c.ended.length), [1, 1, 1, 1, 0]);
    assertEquals(clients[4]!.executed[0]!.text, "select * from public.delivery_queue_stats()");
    await db.close();
  },
);

Deno.test(
  "openSenderDb caps the delay, gives up at the deadline and warns about unverified TLS",
  async function (): Promise<void> {
    const clock = fakeClock();
    const logs: string[] = [];
    let attempts = 0;
    function connect() {
      attempts++;
      return fakeSql([], new Error("password authentication failed")).sql;
    }
    await assertRejects(
      () =>
        openSenderDb({ databaseUrl: POOLER, databaseSsl: true }, {
          now: clock.now,
          sleep: clock.sleep,
          log: (m) => logs.push(m),
          connect,
        }),
      DatabaseOpenError,
      "database probe failed: password authentication failed",
    );
    assertEquals(OPEN_DEADLINE_MS, 300_000);
    let longest = -Infinity;
    let total = 0;
    for (const ms of clock.slept) {
      longest = Math.max(longest, ms);
      total += ms;
    }
    assertEquals(longest, RETRY_MAX_MS);
    // It never sleeps past the deadline.
    assertEquals(total <= OPEN_DEADLINE_MS, true);
    assertEquals(attempts, clock.slept.length + 1);
    assertEquals(logs[0]!.includes("does not verify the server certificate"), true);
    assertEquals(logs[0]!.includes("SENDER_DATABASE_CA"), true);
  },
);

Deno.test(
  "openSenderDb counts a probe that never answers as a failure and logs a failed close",
  async function (): Promise<void> {
    assertEquals(PROBE_TIMEOUT_MS, 30_000);
    const logs: string[] = [];
    let ended = 0;
    const hung: SqlClient = {
      unsafe: () => new Promise(noop),
      json: (value) => ({ json: value }),
      end() {
        ended++;
        return Promise.reject(new Error("already closed"));
      },
    };
    await assertRejects(
      () =>
        openSenderDb({ databaseUrl: POOLER, databaseSsl: false }, {
          connect: () => hung,
          probeTimeoutMs: 10,
          deadlineMs: 0,
          log: (m) => logs.push(m),
        }),
      DatabaseOpenError,
      "database probe failed: no answer within 10 ms",
    );
    assertEquals(ended, 1);
    assertEquals(logs, ["database close failed: already closed"]);
  },
);

Deno.test(
  "openSenderDb does not retry a probe that rejects with anything but an Error",
  async function (): Promise<void> {
    let attempts = 0;
    function connect(): SqlClient {
      attempts++;
      return {
        unsafe: () => rejectWith("not an Error"),
        json: (value) => ({ json: value }),
        end: () => Promise.resolve(),
      };
    }
    let caught: unknown = undefined;
    try {
      await openSenderDb({ databaseUrl: POOLER, databaseSsl: false }, { connect, log: noop });
    } catch (error) {
      caught = error;
    }
    assertEquals([caught, attempts], ["not an Error", 1]);
  },
);

Deno.test({
  name: "openSenderDb calls the allowlisted RPCs on a real database with int8 as Number",
  ignore: DATABASE_URL === undefined,
  async fn() {
    const url = DATABASE_URL!;
    const db = await openSenderDb({
      databaseUrl: url,
      databaseSsl: !isLocalHost(new URL(url).hostname),
    }, {});
    try {
      const stats = await db.rpc("delivery_queue_stats", {});
      assertEquals(stats.error, null);
      const row = (stats.data as Array<Record<string, unknown>>)[0]!;
      assertEquals(typeof row.depth, "number");
      assertEquals(typeof row.expired_last_hour, "number");

      // The heartbeat keeps at most one row per 30 seconds, so repeated runs add little.
      const beat = await db.rpc("record_sender_heartbeat", {
        p_started_at: new Date().toISOString(),
        p_last_progress_at: null,
        p_rss_bytes: 1,
      });
      assertEquals(beat.error, null);

      // p_limit 0 runs the expiry sweep and claims nothing, so a shared local database is left alone.
      const claimed = await db.rpc("claim_deliveries", { p_limit: 0, p_vt: 60 });
      assertEquals(claimed, { data: [], error: null });

      // bigint[] and text parameters round-trip; ids that exist nowhere change nothing.
      const big = 9_007_199_254_740_000;
      assertEquals(
        (await db.rpc("mark_deliveries_sent", { p_delivery_ids: [big], p_msg_ids: [big] })).error,
        null,
      );
      assertEquals(
        (await db.rpc("mark_deliveries_failed", {
          p_delivery_ids: [],
          p_msg_ids: [],
          p_error: "sender db test",
          p_delay_seconds: 1,
        })).error,
        null,
      );
      assertEquals((await db.rpc("prune_push_devices", { p_endpoints: [] })).error, null);
      // jsonb through sql.json.
      assertEquals(
        (await db.rpc("record_push_results", {
          p_ok: [],
          p_errors: { "https://fcm.googleapis.com/fcm/send/sender-db-test": "no such device" },
        })).error,
        null,
      );
      // An error from SQL is the message, not a throw; uuid casting reaches the function.
      const throttled = await db.rpc("throttle_destination", {
        p_destination_id: "00000000-0000-0000-0000-000000000000",
        p_msg_ids: [],
        p_seconds: null,
      });
      assertEquals(throttled.data, null);
      assertEquals(throttled.error, "Destination not found.");

      // The spots stream's RPCs, with a token and a relay that exist nowhere: no rows, a null
      // hello, and a boolean that reaches the function as one.
      const auth = await db.rpc("authenticate_relay_token", { p_token_hash: "0".repeat(64) });
      assertEquals(auth, { data: [], error: null });
      const missing = "00000000-0000-0000-0000-000000000000";
      for (const connected of [true, false]) {
        const presence = await db.rpc("set_cluster_stream", {
          p_token_id: missing,
          p_connected: connected,
        });
        assertEquals(presence, { data: [{ set_cluster_stream: null }], error: null });
      }
      const refused = await db.rpc("set_cluster_stream", { p_token_id: missing });
      assertEquals(refused.error, "set_cluster_stream needs a token and a state.");
      // reset_cluster_streams is left out: it would mark a local relay offline under a running
      // sender.
    } finally {
      await db.close();
    }
  },
});

Deno.test({
  name: "openSenderDb fails at start when the probe fails",
  ignore: DATABASE_URL === undefined,
  async fn() {
    const url = new URL(DATABASE_URL!);
    url.password = "wrong-password";
    let message = "";
    try {
      // No deadline: the first failure ends the start-up retries.
      await openSenderDb({ databaseUrl: url.toString(), databaseSsl: false }, { deadlineMs: 0 });
    } catch (error) {
      message = (error as Error).message;
    }
    assertEquals(message.startsWith("database probe failed:"), true, message);
  },
});

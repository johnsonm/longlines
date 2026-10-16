// The postgres.js adapter. The pure parts (the allowlist, the statements, the
// row and error mapping) always run; the last tests open a real pool and run
// only with SENDER_TEST_DATABASE_URL set (CI's migrations job points it at the
// fresh local stack; never a hosted database).
import { assertEquals, assertThrows } from "@std/assert";
import { isLocalHost } from "../config.ts";
import {
  clientOptions,
  openSenderDb,
  rpcStatement,
  SENDER_RPCS,
  senderDb,
  type SqlClient,
  type SqlParam,
} from "../db.ts";

const DATABASE_URL = Deno.env.get("SENDER_TEST_DATABASE_URL")?.trim() || undefined;

Deno.test("SENDER_RPCS is exactly the sender role's allowlist", () => {
  assertEquals(Object.keys(SENDER_RPCS).sort(), [
    "claim_deliveries",
    "delivery_queue_stats",
    "mark_deliveries_failed",
    "mark_deliveries_sent",
    "prune_push_devices",
    "record_push_results",
    "throttle_destination",
  ]);
});

Deno.test("rpcStatement names and casts every parameter in the function's order", () => {
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
  const throttle = rpcStatement("throttle_destination", { p_destination_id: "u", p_msg_ids: [1] });
  assertEquals(throttle.params[2], { value: null, type: "int" });
  assertEquals(
    rpcStatement("throttle_destination", { p_destination_id: "u", p_msg_ids: [1], p_seconds: null })
      .params[2],
    {
      value: null,
      type: "int",
    },
  );
});

Deno.test("rpcStatement refuses functions and parameters outside the allowlist", () => {
  assertThrows(
    () => rpcStatement("delay_deliveries", {}),
    Error,
    "not in the sender's RPC allowlist",
  );
  assertThrows(() => rpcStatement("toString", {}), Error, "not in the sender's RPC allowlist");
  assertThrows(
    () => rpcStatement("claim_deliveries", { p_limit: 1, limit: 1 }),
    Error,
    "has no parameter limit",
  );
});

interface Executed {
  text: string;
  params: SqlParam[];
  options: { prepare: boolean };
}

/** A SqlClient that records statements and answers from `rows`, or throws `failure`. */
function fakeSql(rows: Array<Record<string, unknown>> = [], failure?: Error) {
  const executed: Executed[] = [];
  const ended: Array<{ timeout?: number } | undefined> = [];
  const sql: SqlClient = {
    unsafe(text, params, options) {
      executed.push({ text, params, options });
      return failure ? Promise.reject(failure) : Promise.resolve(rows);
    },
    json: (value) => ({ json: value }) as unknown as SqlParam,
    end(options) {
      ended.push(options);
      return Promise.resolve();
    },
  };
  return { sql, executed, ended };
}

Deno.test("senderDb runs the statement prepared, returns the rows as data and wraps jsonb with sql.json", async () => {
  const fake = fakeSql([{ msg_id: 7, delivery_id: 3 }]);
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
});

Deno.test("senderDb turns a thrown error, or a call outside the allowlist, into an error message", async () => {
  const failing = senderDb(
    fakeSql([], new Error("permission denied for function claim_deliveries")).sql,
  );
  assertEquals(await failing.rpc("claim_deliveries", { p_limit: 1, p_vt: 1 }), {
    data: null,
    error: "permission denied for function claim_deliveries",
  });
  const fake = fakeSql();
  assertEquals(await senderDb(fake.sql).rpc("delay_deliveries", {}), {
    data: null,
    error: "delay_deliveries is not in the sender's RPC allowlist",
  });
  assertEquals(fake.executed, []); // never reached the database
});

Deno.test("clientOptions takes the connection from the URL and sets every option postgres.js has a PG* fallback for", () => {
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
});

Deno.test({
  name: "openSenderDb calls the allowlisted RPCs on a real database with int8 as Number",
  ignore: DATABASE_URL === undefined,
  async fn() {
    const url = DATABASE_URL!;
    const db = await openSenderDb({
      databaseUrl: url,
      databaseSsl: !isLocalHost(new URL(url).hostname),
    });
    try {
      const stats = await db.rpc("delivery_queue_stats", {});
      assertEquals(stats.error, null);
      const row = (stats.data as Array<Record<string, unknown>>)[0]!;
      assertEquals(typeof row.depth, "number");
      assertEquals(typeof row.expired_last_hour, "number");

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
      await openSenderDb({ databaseUrl: url.toString(), databaseSsl: false });
    } catch (error) {
      message = (error as Error).message;
    }
    assertEquals(message.startsWith("database probe failed:"), true, message);
  },
});

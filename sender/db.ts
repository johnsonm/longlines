// The sender's database: postgres.js over the delivery_sender role, calling
// the RPC allowlist and nothing else. This is the only module that imports
// postgres.js; sender.ts and the loop see it as a DeliveryRpc.
//
// npm:postgres@3.4.9 (postgres.js) is the sender's one runtime dependency:
// the sender reaches Postgres directly through the Supavisor pooler (every
// poll through an Edge Function or PostgREST would be an invocation), needs
// TLS and named-parameter calls, and will LISTEN for the matcher's pg_notify
// later. jsr:@db/postgres has no LISTEN. Full specifier, no import map, so the
// image runs with --no-config.
import postgres, { type JSONValue, type ParameterOrJSON } from "npm:postgres@3.4.9";
import type { DeliveryRpc } from "../supabase/functions/_shared/delivery/run.ts";
import type { SenderConfig } from "./config.ts";

type SqlType = "int" | "bigint[]" | "text" | "text[]" | "uuid" | "jsonb";

/**
 * The allowlist: every RPC the sender may call with its named parameters and
 * their SQL types, in the function's own order. The grants in
 * 20261015000200_sender_role.sql and 20261015000400_rate_aware_claim.sql are
 * the other half; supabase/tests/sender_role.test.sql pins them.
 */
export const SENDER_RPCS: Readonly<Record<string, Readonly<Record<string, SqlType>>>> = {
  claim_deliveries: { p_limit: "int", p_vt: "int" },
  mark_deliveries_sent: { p_delivery_ids: "bigint[]", p_msg_ids: "bigint[]" },
  mark_deliveries_failed: {
    p_delivery_ids: "bigint[]",
    p_msg_ids: "bigint[]",
    p_error: "text",
    p_delay_seconds: "int",
  },
  throttle_destination: { p_destination_id: "uuid", p_msg_ids: "bigint[]", p_seconds: "int" },
  delivery_queue_stats: {},
  prune_push_devices: { p_endpoints: "text[]" },
  record_push_results: { p_ok: "text[]", p_errors: "jsonb" },
};

export interface RpcStatement {
  text: string;
  params: Array<{ value: unknown; type: SqlType }>;
}

/**
 * `select * from public.<fn>(p_x => $1::type, ...)` for an allowlisted RPC.
 * Every parameter is cast to its declared type, so overload resolution never
 * depends on what postgres.js infers from a JavaScript value. A missing
 * argument is passed as null. Throws for a function or argument not listed.
 */
export function rpcStatement(fn: string, args: Record<string, unknown>): RpcStatement {
  const spec = Object.hasOwn(SENDER_RPCS, fn) ? SENDER_RPCS[fn] : undefined;
  if (!spec) throw new Error(`${fn} is not in the sender's RPC allowlist`);
  for (const name of Object.keys(args)) {
    if (!Object.hasOwn(spec, name)) throw new Error(`${fn} has no parameter ${name}`);
  }
  const params = Object.entries(spec).map(([name, type]) => ({ value: args[name] ?? null, type }));
  const list = Object.keys(spec).map((name, i) => `${name} => $${i + 1}::${spec[name]}`).join(", ");
  return { text: `select * from public.${fn}(${list})`, params };
}

/** A statement parameter as postgres.js takes it: a value, or sql.json()'s wrapper. */
export type SqlParam = ParameterOrJSON<number | string>;

/** The slice of postgres.js the adapter uses, so tests can pass a fake. */
export interface SqlClient {
  unsafe(
    text: string,
    params: SqlParam[],
    options: { prepare: boolean },
  ): PromiseLike<Iterable<Record<string, unknown>>>;
  json(value: JSONValue): SqlParam;
  end(options?: { timeout?: number }): Promise<void>;
}

export interface SenderDb extends DeliveryRpc {
  /** Close the pool; waits up to a few seconds for an in-flight statement. */
  close(): Promise<void>;
}

/**
 * A DeliveryRpc over a postgres.js client. `data` is the row array (what the
 * loop expects from claim_deliveries); `error` is the message or null, so a
 * failed call never throws.
 */
export function senderDb(sql: SqlClient): SenderDb {
  return {
    async rpc(fn, args) {
      try {
        const { text, params } = rpcStatement(fn, args);
        const rows = await sql.unsafe(
          text,
          params.map((
            p,
          ) => (p.type === "jsonb" ? sql.json(p.value as JSONValue) : p.value)) as SqlParam[],
          { prepare: true },
        );
        return { data: Array.from(rows), error: null };
      } catch (error) {
        return { data: null, error: error instanceof Error ? error.message : String(error) };
      }
    },
    close: () => sql.end({ timeout: 5 }),
  };
}

/**
 * postgres.js options with every value set, so the library never falls back
 * to a PG* environment variable: under the image's --allow-env list a read of
 * an unlisted variable throws. (It still reads PGAPPNAME and
 * PGTARGETSESSIONATTRS unconditionally; the Dockerfile allows those two.)
 * int8 comes back as Number (msg_id and delivery_id are numbers in
 * PendingDelivery), timestamps as strings, as PostgREST returns them.
 */
export function clientOptions(config: Pick<SenderConfig, "databaseUrl" | "databaseSsl">) {
  const url = new URL(config.databaseUrl);
  return {
    host: url.hostname,
    port: Number(url.port) || 5432,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)) || "postgres",
    ssl: config.databaseSsl ? ("require" as const) : false,
    // Two connections: the poll loop and the stats refresh may overlap; LISTEN takes one later.
    max: 2,
    prepare: true,
    connect_timeout: 10,
    // Close the second connection after a minute unused instead of holding a pooler slot.
    idle_timeout: 60,
    // postgres.js's own defaults for the rest, spelled out.
    max_lifetime: 60 * (30 + Math.random() * 30),
    max_pipeline: 100,
    backoff: (retries: number) => (0.5 + Math.random() / 2) * Math.min(3 ** retries / 100, 20),
    keep_alive: 60,
    debug: false,
    fetch_types: true,
    publications: "alltables",
    target_session_attrs: undefined,
    sslnegotiation: null,
    connection: { application_name: "longlines-sender" },
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (value: number | bigint) => value.toString(),
        parse: (raw: string) => Number(raw),
      },
      date: {
        to: 1184,
        from: [1082, 1114, 1184],
        serialize: (
          value: Date | string,
        ) => (typeof value === "string" ? value : value.toISOString()),
        parse: (raw: string) => raw,
      },
    },
  };
}

/** The postgres.js client, constructed but not yet connected (it connects on the first statement). */
export function createClient(config: Pick<SenderConfig, "databaseUrl" | "databaseSsl">): SqlClient {
  return postgres(clientOptions(config));
}

/**
 * Opens the pool and proves it works with one allowlisted call, so a wrong
 * URL, password or grant fails at start (exit 1) rather than as a wedged
 * loop.
 */
export async function openSenderDb(
  config: Pick<SenderConfig, "databaseUrl" | "databaseSsl">,
): Promise<SenderDb> {
  const db = senderDb(createClient(config));
  const probe = await db.rpc("delivery_queue_stats", {});
  if (probe.error !== null) {
    await db.close();
    throw new Error(`database probe failed: ${probe.error}`);
  }
  return db;
}

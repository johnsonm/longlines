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
import { RETRY_MAX_MS, RETRY_MIN_MS, type SenderConfig } from "./config.ts";

type SqlType = "int" | "bigint" | "bigint[]" | "text" | "text[]" | "uuid" | "jsonb" | "timestamptz";

/**
 * The allowlist: every RPC the sender may call with its named parameters and
 * their SQL types, in the function's own order. The grants in
 * 20261015000200_sender_role.sql, 20261015000400_rate_aware_claim.sql and
 * 20261021000100_health.sql are the other half; supabase/tests/sender_role.test.sql
 * pins them.
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
  record_sender_heartbeat: {
    p_started_at: "timestamptz",
    p_last_progress_at: "timestamptz",
    p_rss_bytes: "bigint",
  },
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

/** What the client needs from the config; the CA settings default to an unverified TLS link. */
export type DbConnectionConfig =
  & Pick<SenderConfig, "databaseUrl" | "databaseSsl">
  & Partial<Pick<SenderConfig, "databaseCa" | "databaseVerifyHost">>;

/**
 * The ssl option. postgres.js's "require" encrypts without checking the
 * server's certificate (it sets rejectUnauthorized false); with
 * SENDER_DATABASE_CA the certificate must chain to that CA and, unless the URL
 * says sslmode=verify-ca, name the host. postgres.js ignores the URL's sslmode
 * because the sender passes options, so config.ts reads it.
 */
export function sslOption(config: DbConnectionConfig, host: string) {
  if (!config.databaseSsl) return false as const;
  if (!config.databaseCa) return "require" as const;
  return {
    ca: config.databaseCa,
    rejectUnauthorized: true as const,
    servername: host,
    ...(config.databaseVerifyHost === false ? { checkServerIdentity: () => undefined } : {}),
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
export function clientOptions(config: DbConnectionConfig) {
  const url = new URL(config.databaseUrl);
  return {
    host: url.hostname,
    port: Number(url.port) || 5432,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)) || "postgres",
    ssl: sslOption(config, url.hostname),
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
export function createClient(config: DbConnectionConfig): SqlClient {
  return postgres(clientOptions(config));
}

/** How long the start-up probe may take before the attempt counts as failed. */
export const PROBE_TIMEOUT_MS = 30_000;
/** How long start-up keeps retrying an unreachable or failing database before exiting 1. */
export const OPEN_DEADLINE_MS = 300_000;

export interface OpenOptions {
  log?: (message: string) => void;
  /** The clock (ms) and the sleep, replaced by tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Builds the client; tests pass a fake. */
  connect?: (config: DbConnectionConfig) => SqlClient;
  probeTimeoutMs?: number;
  deadlineMs?: number;
}

/** Rejects with `message` after `ms` unless `promise` settles first. */
export function withTimeout<T>(promise: PromiseLike<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([Promise.resolve(promise), expiry]).finally(() => clearTimeout(timer));
}

/**
 * Opens the pool and proves it works with one allowlisted call. A failed or
 * timed-out probe closes that pool and tries again after RETRY_MIN_MS,
 * doubling to RETRY_MAX_MS, so a database or pooler incident at start does not
 * become a tight restart loop; after OPEN_DEADLINE_MS it throws (exit 1), so a
 * wrong URL, password or grant still fails the start rather than wedging.
 */
export async function openSenderDb(
  config: DbConnectionConfig,
  options: OpenOptions = {},
): Promise<SenderDb> {
  const log = options.log ?? ((message: string) => console.log(message));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const connect = options.connect ?? createClient;
  const probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const deadline = now() + (options.deadlineMs ?? OPEN_DEADLINE_MS);
  if (config.databaseSsl && !config.databaseCa) {
    log(
      "warning: TLS to the database does not verify the server certificate; " +
        "set SENDER_DATABASE_CA (docs/OPERATIONS.md)",
    );
  }
  let retryMs = RETRY_MIN_MS;
  for (;;) {
    const db = senderDb(connect(config));
    let error: string;
    try {
      const probe = await withTimeout(
        db.rpc("delivery_queue_stats", {}),
        probeTimeoutMs,
        `no answer within ${probeTimeoutMs} ms`,
      );
      if (probe.error === null) return db;
      error = probe.error;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    // end() waits at most its own timeout; a close that fails changes nothing here.
    await db.close().catch(() => {});
    if (now() + retryMs > deadline) throw new Error(`database probe failed: ${error}`);
    log(`database probe failed: ${error}; retrying in ${retryMs} ms`);
    await sleep(retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  }
}

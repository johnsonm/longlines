// The callsign profile build lock in cached_callsign_profile (20261013000310),
// with two sessions. callsign_profile.test.sql checks the lock from one session
// only (which key it takes, that lock_timeout is put back); what the lock is for
// takes a builder and a waiter:
//   1. a waiter whose builder commits serves that entry and does not rebuild;
//   2. a waiter gives up after 2 s and builds its own, rather than running into
//      its statement timeout;
//   3. a call hidden while a request waits is not served from the builder's entry.
//
// Session A plays the builder: it takes the same advisory lock in a transaction
// (and in 1 and 3 writes a marker entry no real build would produce) while
// session B calls cached_callsign_profile. The tests run only with
// PROFILE_LOCK_TEST_DATABASE_URL pointing at the local stack (CI's migrations
// job sets it; never a hosted database). A and B both commit, so each test
// deletes its cache and hidden_callsigns rows before and after.
//
// postgres is the sender's postgres.js (sender/db.ts), mapped in the root
// deno.json at the same version; a test-only import, so no new runtime dependency.
import postgres from "postgres";
import { assert, assertEquals, assertNotEquals } from "@std/assert";

// The trimmed URL, or undefined when it is unset or blank.
function databaseUrl(): string | undefined {
  const raw = Deno.env.get("PROFILE_LOCK_TEST_DATABASE_URL");
  if (raw === null || raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return undefined;
  }
  return trimmed;
}

const DATABASE_URL = databaseUrl();

// Made up: no seed or fixture spots it, and it is already a base call.
const CALL = "KZ9LCK";
const MARKER = { builder: "profile_lock_db.test.ts" };
// The waiter's own budget, as the API gives it.
const STATEMENT_TIMEOUT = "8s";

type Sql = ReturnType<typeof postgres>;

/** B's pending cached_callsign_profile and when it started. */
interface Waiting {
  payload: Promise<unknown>;
  startedAt: number;
}

function ignore(): void {}

function one<T>(rows: readonly T[]): T {
  assertEquals(rows.length, 1);
  return rows[0]!;
}

// Every option spelled out, as sender/db.ts does: postgres.js reads PG<OPTION>
// from the environment for any option left out, which the test permissions deny.
function connect(): Sql {
  const url = new URL(DATABASE_URL!);
  // A variable, not a literal: the typings lack sslnegotiation, which postgres.js reads.
  const options = {
    host: url.hostname,
    port: Number(url.port) || 5432,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)) || "postgres",
    ssl: false,
    sslnegotiation: null,
    // One session each, so B's pid and its statement timeout stay put.
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
    max_lifetime: null,
    max_pipeline: 100,
    backoff: () => 1,
    keep_alive: 60,
    prepare: true,
    debug: false,
    fetch_types: true,
    publications: "alltables",
    target_session_attrs: undefined,
    connection: { application_name: "longlines-profile-lock-test" },
    onnotice: ignore,
  };
  return postgres(options);
}

async function cleanUp(sql: Sql): Promise<void> {
  await sql`delete from public.callsign_profile_cache where callsign = ${CALL}`;
  await sql`delete from public.hidden_callsigns where callsign = ${CALL}`;
}

/** A's side: takes the build lock on CALL, then runs fn while B waits on it. */
async function holdBuildLock(
  tx: postgres.TransactionSql,
  b: Sql,
  bPid: number,
  fn: (a: postgres.TransactionSql, call: () => Promise<Waiting>) => Promise<void>,
): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext('callsign_profile_cache'), hashtext(${CALL}))`;
  async function profileOf(): Promise<unknown> {
    const rows = await b<{ p: unknown }[]>`select public.cached_callsign_profile(${CALL}) as p`;
    return rows[0]!.p;
  }
  async function call(): Promise<Waiting> {
    const startedAt = performance.now();
    const payload = profileOf();
    // Surface B's error from fn's await rather than as an unhandled rejection.
    payload.catch(ignore);
    for (let i = 0; i < 200; i++) {
      const waiting = one(
        await tx<{ waiting: boolean }[]>`
        select exists (select 1 from pg_locks
                       where locktype = 'advisory' and pid = ${bPid} and not granted) as waiting`,
      ).waiting;
      if (waiting) {
        return { payload, startedAt };
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("the waiter never queued on the build lock");
  }
  await fn(tx, call);
}

/**
 * Runs `fn` with a builder (A, inside a transaction holding the build lock on
 * CALL) and a waiter (B, its own session with the API's statement timeout).
 * `call` starts B's cached_callsign_profile and resolves once B is queued on
 * the lock, so `fn` acts while B waits. A commits when `fn` returns; `after`
 * then runs on A's session before the clean-up.
 */
async function withBuilderAndWaiter(
  fn: (
    a: postgres.TransactionSql,
    call: () => Promise<Waiting>,
  ) => Promise<void>,
  after: ((sql: Sql) => Promise<void>) | undefined,
): Promise<void> {
  const a = connect();
  const b = connect();
  try {
    await cleanUp(a);
    await b.unsafe(`set statement_timeout = '${STATEMENT_TIMEOUT}'`);
    const bPid = one(await b<{ pid: number }[]>`select pg_backend_pid() as pid`).pid;
    await a.begin((tx) => holdBuildLock(tx, b, bPid, fn));
    if (after !== null && after !== undefined) {
      await after(a);
    }
  } finally {
    try {
      await cleanUp(a);
    } finally {
      await a.end();
      await b.end();
    }
  }
}

/** A copy of the profile without generatedAt, which differs between builds. */
function withoutGeneratedAt(profile: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(profile)) {
    if (key !== "generatedAt") {
      rest[key] = profile[key];
    }
  }
  return rest;
}

Deno.test({
  name: "a waiter whose builder commits serves that entry and does not rebuild",
  ignore: DATABASE_URL === undefined,
  async fn() {
    let served: Promise<unknown> | undefined;
    async function whileWaiting(a: postgres.TransactionSql, call: () => Promise<Waiting>) {
      await a`insert into public.callsign_profile_cache (callsign, payload, generated_at)
              values (${CALL}, ${a.json(MARKER)}, now())`;
      served = (await call()).payload;
    }
    async function afterCommit(sql: Sql) {
      assertEquals(await served, MARKER);
      // A rebuild would have replaced the marker.
      const rows = await sql<{ payload: unknown }[]>`
        select payload from public.callsign_profile_cache where callsign = ${CALL}`;
      assertEquals(rows.map((r) => r.payload), [MARKER]);
    }
    await withBuilderAndWaiter(whileWaiting, afterCommit);
  },
});

Deno.test({
  name: "a waiter gives up after 2 s and builds its own, inside its statement timeout",
  ignore: DATABASE_URL === undefined,
  async fn() {
    async function whileWaiting(a: postgres.TransactionSql, call: () => Promise<Waiting>) {
      // A never commits while B waits: a stuck build.
      const waiting = await call();
      const payload = waiting.payload;
      const startedAt = waiting.startedAt;
      const profile = await payload as Record<string, unknown>;
      const elapsed = performance.now() - startedAt;
      assertEquals(profile.callsign, CALL);
      assertNotEquals(profile, MARKER);
      assert(elapsed >= 1_900, `answered in ${elapsed} ms, before the 2 s cap`);
      assert(elapsed < 4_000, `answered in ${elapsed} ms, well past the 2 s cap`);
      // B's build committed its own entry while A still holds the lock.
      const cached = one(
        await a<{ cached: unknown }[]>`
        select payload as cached from public.callsign_profile_cache where callsign = ${CALL}`,
      ).cached;
      assertEquals((cached as Record<string, unknown>).callsign, CALL);
    }
    await withBuilderAndWaiter(whileWaiting, undefined);
  },
});

Deno.test({
  name: "a call hidden while a request waits is not served from the builder's entry",
  ignore: DATABASE_URL === undefined,
  async fn() {
    let served: Promise<unknown> | undefined;
    let hiddenShape: Record<string, unknown> | undefined;
    async function whileWaiting(a: postgres.TransactionSql, call: () => Promise<Waiting>) {
      await a`insert into public.callsign_profile_cache (callsign, payload, generated_at)
              values (${CALL}, ${a.json(MARKER)}, now())`;
      served = (await call()).payload;
      await a`insert into public.hidden_callsigns (callsign, note) values (${CALL}, 'profile_lock_db.test.ts')`;
      hiddenShape = one(
        await a<{ p: Record<string, unknown> }[]>`
        select public.callsign_profile(${CALL}) as p`,
      ).p;
    }
    await withBuilderAndWaiter(whileWaiting, undefined);
    const profile = await served as Record<string, unknown>;
    assertNotEquals(profile, MARKER);
    assertEquals(withoutGeneratedAt(profile), withoutGeneratedAt(hiddenShape!));
    assertEquals(profile.heard, null);
    assertEquals(profile.license, null);
  },
});

import { assertEquals, assertMatch } from "@std/assert";
import { handleArchive } from "../handlers/archive.ts";
import { type FakeCalls, fakeSupabase } from "./fake_supabase.ts";
import { ARCHIVE_SCHEMAS } from "../archive.ts";
import type { ArchiveStore, Source } from "../types.ts";

/** An in-memory bucket recording upload paths; `fail` makes every upload throw. */
function fakeStore(fail: string | undefined) {
  const paths: string[] = [];
  const store: ArchiveStore = {
    upload(path) {
      if (fail) {
        return Promise.reject(new Error(fail));
      }
      paths.push(path);
      return Promise.resolve();
    },
  };
  return { store: () => store, paths };
}

/** archive_columns' answer for a one-row slice: every column null but `values`. */
function oneRow(source: Source, values: Record<string, unknown>) {
  const columns: Record<string, unknown[]> = {};
  for (const column of ARCHIVE_SCHEMAS[source]) {
    const name = column[0];
    let value = values[name];
    if (value === null || value === undefined) {
      value = null;
    }
    columns[name] = [value];
  }
  return { data: [{ row_count: 1, columns }] };
}

/** archive_pending_slices' answer: `slice` for `source`, nothing for the others. */
function pendingSlices(source: Source, slice: unknown) {
  function respond(args: Record<string, unknown> | undefined) {
    if (args !== undefined && args["p_source"] === source) {
      return { data: [slice] };
    }
    return { data: [] };
  }
  return respond;
}

/** The p_source of each archive_pending_slices call, in order. */
function pendingSources(calls: FakeCalls): unknown[] {
  const sources: unknown[] = [];
  for (const call of calls.rpc) {
    if (call.fn !== "archive_pending_slices") {
      continue;
    }
    if (call.args === undefined) {
      sources.push(undefined);
    } else {
      sources.push(call.args["p_source"]);
    }
  }
  return sources;
}

function serverTiming(res: Response): string {
  const timing = res.headers.get("Server-Timing");
  if (timing === null) {
    return "";
  }
  return timing;
}

const KEY = "service-key";
const NOW = new Date("2026-10-11T20:05:00Z");

/** A service-role POST whose body stream fails partway. */
function brokenReq(): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.error(new Error("connection reset"));
    },
  });
  return new Request("http://x/", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}` },
    body,
  });
}

function req(token: string | undefined, body: string | undefined): Request {
  const init: RequestInit = { method: "POST", headers: {} };
  if (token) {
    init.headers = { Authorization: `Bearer ${token}` };
  }
  if (body !== undefined) {
    init.body = body;
  }
  return new Request("http://x/archive", init);
}

Deno.test(
  "handleArchive refuses callers without the service-role key",
  async function (): Promise<void> {
    const fake = fakeSupabase({});
    const client = fake.client;
    const bucket = fakeStore(undefined);
    for (const token of [undefined, "anon-key"]) {
      const res = await handleArchive(req(token, undefined), {
        serviceRoleKey: KEY,
        db: () => client,
        store: bucket.store,
      }, NOW);
      assertEquals(res.status, 403);
    }
    const unset = await handleArchive(req(KEY, undefined), {
      serviceRoleKey: undefined,
      db: () => client,
      store: bucket.store,
    }, NOW);
    assertEquals(unset.status, 403);
    assertEquals(fake.calls.rpc, []);
  },
);

Deno.test(
  "handleArchive runs the archive and returns its summary",
  async function (): Promise<void> {
    const slice = {
      slice_start: "2026-10-11T14:10:00+00:00",
      slice_end: "2026-10-11T14:20:00+00:00",
    };
    const fake = fakeSupabase({
      rpc: {
        archive_pending_slices: pendingSlices("rbn", slice),
        archive_columns: oneRow("rbn", { callsign: "K1ABC" }),
      },
    });
    const client = fake.client;
    const bucket = fakeStore(undefined);
    const res = await handleArchive(req(KEY, undefined), {
      serviceRoleKey: KEY,
      db: () => client,
      store: bucket.store,
    }, NOW);
    assertEquals(res.status, 200);
    assertMatch(serverTiming(res), /^total;dur=\d+\.\d$/);
    const body = await res.json();
    assertEquals([body.slices, body.rows, body.errors], [1, 1, []]);
    assertEquals(bucket.paths, ["rbn/year=2026/month=10/day=11/1410.parquet"]);
  },
);

Deno.test("handleArchive answers 500 when any slice failed", async function (): Promise<void> {
  const slice = {
    slice_start: "2026-10-11T14:00:00+00:00",
    slice_end: "2026-10-11T15:00:00+00:00",
  };
  const fake = fakeSupabase({
    rpc: {
      archive_pending_slices: pendingSlices("pota", slice),
      archive_columns: oneRow("pota", {}),
    },
  });
  const client = fake.client;
  const bucket = fakeStore("HTTP 503");
  const res = await handleArchive(req(KEY, undefined), {
    serviceRoleKey: KEY,
    db: () => client,
    store: bucket.store,
  }, NOW);
  assertEquals(res.status, 500);
  assertEquals((await res.json()).errors.length, 1);
});

Deno.test(
  "handleArchive accepts the gateway-verified service-role JWT pg_cron sends",
  async function (): Promise<void> {
    function b64url(o: unknown) {
      return btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    }
    const cronJwt = `${b64url({ alg: "HS256" })}.${b64url({ role: "service_role" })}.sig`;
    const fake = fakeSupabase({});
    const client = fake.client;
    const res = await handleArchive(req(cronJwt, undefined), {
      serviceRoleKey: "sb_secret_runtime",
      db: () => client,
      store: fakeStore(undefined).store,
    }, NOW);
    assertEquals(res.status, 200);
  },
);

Deno.test(
  "handleArchive archives only the sources the body names",
  async function (): Promise<void> {
    const slice = {
      slice_start: "2026-10-11T17:55:00+00:00",
      slice_end: "2026-10-11T18:00:00+00:00",
    };
    const fake = fakeSupabase({
      rpc: {
        archive_pending_slices: pendingSlices("aprs", slice),
        archive_columns: oneRow("aprs", { source_call: "N0CALL" }),
      },
    });
    const client = fake.client;
    const bucket = fakeStore(undefined);
    const res = await handleArchive(
      req(KEY, '{"sources":["aprs"]}'),
      { serviceRoleKey: KEY, db: () => client, store: bucket.store },
      NOW,
    );
    assertEquals(res.status, 200);
    assertEquals(pendingSources(fake.calls), ["aprs"]);
    assertEquals(bucket.paths, ["aprs/year=2026/month=10/day=11/1755.parquet"]);
  },
);

Deno.test(
  "handleArchive answers 400 for a body it cannot use, before touching the database",
  async function (): Promise<void> {
    for (const body of ["not json", '{"sources":["nope"]}', "[]"]) {
      const fake = fakeSupabase({});
      const client = fake.client;
      const bucket = fakeStore(undefined);
      const res = await handleArchive(req(KEY, body), {
        serviceRoleKey: KEY,
        db: () => client,
        store: bucket.store,
      }, NOW);
      assertEquals(res.status, 400, body);
      assertEquals((await res.json()).error.startsWith("Bad request"), true);
      assertEquals(fake.calls.rpc, []);
    }
  },
);

Deno.test(
  "handleArchive treats pg_cron's empty JSON object as the default sources",
  async function (): Promise<void> {
    const fake = fakeSupabase({});
    const client = fake.client;
    const bucket = fakeStore(undefined);
    const res = await handleArchive(req(KEY, "{}"), {
      serviceRoleKey: KEY,
      db: () => client,
      store: bucket.store,
    }, NOW);
    assertEquals(res.status, 200);
    assertEquals(pendingSources(fake.calls), [
      "pota",
      "sotawatch",
      "dxcluster",
      "wwff",
      "wwbota",
      "logged",
      "rbn",
    ]);
  },
);

Deno.test(
  "handleArchive answers 500 without touching the database when the bucket is not configured",
  async function (): Promise<void> {
    function unconfigured(): ArchiveStore {
      throw new Error("archive store not configured: missing LONGLINES_ARCHIVE_S3_BUCKET");
    }
    const fake = fakeSupabase({});
    const client = fake.client;
    const res = await handleArchive(req(KEY, undefined), {
      serviceRoleKey: KEY,
      db: () => client,
      store: unconfigured,
    }, NOW);
    assertEquals(res.status, 500);
    assertEquals((await res.json()).error.includes("LONGLINES_ARCHIVE_S3_BUCKET"), true);
    assertEquals(fake.calls.rpc, []);
  },
);

Deno.test(
  "handleArchive answers 500 when the body cannot be read",
  async function (): Promise<void> {
    const fake = fakeSupabase({});
    const client = fake.client;
    const res = await handleArchive(brokenReq(), {
      serviceRoleKey: KEY,
      db: () => client,
      store: fakeStore(undefined).store,
    }, NOW);
    assertEquals(res.status, 500);
    assertEquals(await res.json(), { error: "connection reset" });
    assertEquals(fake.calls.rpc, []);
  },
);

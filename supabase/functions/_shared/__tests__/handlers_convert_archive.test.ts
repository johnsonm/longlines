import { assertEquals, assertMatch } from "@std/assert";
import { handleConvertArchive } from "../handlers/convert_archive.ts";
import { fakeSupabase } from "./fake_supabase.ts";
import type { ArchiveObjectStore } from "../types.ts";

const KEY = "service-key";

function req(token: string | undefined, body: string | undefined): Request {
  const init: RequestInit = { method: "POST", headers: {} };
  if (token) {
    init.headers = { Authorization: `Bearer ${token}` };
  }
  if (body !== undefined) {
    init.body = body;
  }
  return new Request("http://x/convert-archive", init);
}

/** A bucket where every object is missing; records what was asked. */
function emptyStore() {
  const ops: string[] = [];
  const store: ArchiveObjectStore = {
    read(p) {
      ops.push(`read ${p}`);
      return Promise.resolve(null);
    },
    upload(p) {
      ops.push(`upload ${p}`);
      return Promise.resolve();
    },
    size(p) {
      ops.push(`size ${p}`);
      return Promise.resolve(null);
    },
    remove(p) {
      ops.push(`remove ${p}`);
      return Promise.resolve();
    },
  };
  return { store: () => store, ops };
}

function unconfigured(): ArchiveObjectStore {
  throw new Error("archive store not configured: missing LONGLINES_ARCHIVE_S3_BUCKET");
}

function serverTiming(res: Response): string {
  const timing = res.headers.get("Server-Timing");
  if (timing === null) {
    return "";
  }
  return timing;
}

const SLICE = {
  source: "rbn",
  slice_start: "2026-10-11T14:10:00+00:00",
  slice_end: "2026-10-11T14:20:00+00:00",
  row_count: "3",
  object_path: "rbn/2026/10/11/1410.ndjson.gz",
};

Deno.test(
  "handleConvertArchive refuses callers without the service-role key",
  async function (): Promise<void> {
    const fake = fakeSupabase({});
    const client = fake.client;
    for (const token of [undefined, "anon-key"]) {
      const res = await handleConvertArchive(req(token, undefined), {
        serviceRoleKey: KEY,
        db: () => client,
        store: emptyStore().store,
      });
      assertEquals(res.status, 403);
    }
    assertEquals(fake.calls.rpc, []);
  },
);

Deno.test(
  "handleConvertArchive answers 400 for a body it cannot use, before touching anything",
  async function (): Promise<void> {
    for (const body of ["not json", '{"limit":0}', "[]"]) {
      const fake = fakeSupabase({});
      const client = fake.client;
      const res = await handleConvertArchive(req(KEY, body), {
        serviceRoleKey: KEY,
        db: () => client,
        store: emptyStore().store,
      });
      assertEquals(res.status, 400, body);
      assertEquals((await res.json()).error.startsWith("Bad request"), true);
      assertEquals(fake.calls.rpc, []);
    }
  },
);

Deno.test(
  "handleConvertArchive answers 500 without touching the database when the bucket is not configured",
  async function (): Promise<void> {
    const fake = fakeSupabase({});
    const client = fake.client;
    const res = await handleConvertArchive(req(KEY, undefined), {
      serviceRoleKey: KEY,
      db: () => client,
      store: unconfigured,
    });
    assertEquals(res.status, 500);
    assertEquals((await res.json()).error.includes("LONGLINES_ARCHIVE_S3_BUCKET"), true);
    assertEquals(fake.calls.rpc, []);
  },
);

Deno.test(
  "handleConvertArchive answers 500 when the listing fails",
  async function (): Promise<void> {
    const fake = fakeSupabase({
      rpc: { archive_ndjson_slices: { error: { message: "boom" } } },
    });
    const client = fake.client;
    const res = await handleConvertArchive(req(KEY, undefined), {
      serviceRoleKey: KEY,
      db: () => client,
      store: emptyStore().store,
    });
    assertEquals(res.status, 500);
    assertEquals((await res.json()).error, "archive_ndjson_slices failed: boom");
  },
);

Deno.test(
  "handleConvertArchive lists with the cursor and limit and reports each slice",
  async function (): Promise<void> {
    const fake = fakeSupabase({ rpc: { archive_ndjson_slices: { data: [SLICE] } } });
    const client = fake.client;
    const bucket = emptyStore();
    const res = await handleConvertArchive(
      req(KEY, '{"limit": 1, "after": {"slice_start": "2026-10-11T14:00:00Z", "source": "pota"}}'),
      { serviceRoleKey: KEY, db: () => client, store: bucket.store },
    );
    assertMatch(serverTiming(res), /^total;dur=\d+\.\d$/);
    assertEquals(res.status, 500);
    assertEquals(fake.calls.rpc, [{
      fn: "archive_ndjson_slices",
      args: { p_after_start: "2026-10-11T14:00:00Z", p_after_source: "pota", p_limit: 1 },
    }]);
    const body = await res.json();
    assertEquals(body.failed, [{
      source: "rbn",
      slice_start: SLICE.slice_start,
      error: "NDJSON object missing: rbn/2026/10/11/1410.ndjson.gz",
    }]);
    assertEquals(body.next, { slice_start: SLICE.slice_start, source: "rbn" });
    assertEquals(bucket.ops, ["read rbn/2026/10/11/1410.ndjson.gz"]);
  },
);

Deno.test(
  "handleConvertArchive answers 200 when nothing is left",
  async function (): Promise<void> {
    const fake = fakeSupabase({});
    const client = fake.client;
    const res = await handleConvertArchive(req(KEY, "{}"), {
      serviceRoleKey: KEY,
      db: () => client,
      store: emptyStore().store,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals([body.converted, body.failed, body.next], [0, [], null]);
    const first = fake.calls.rpc[0];
    let args: Record<string, unknown> | undefined = undefined;
    if (first !== undefined) {
      args = first.args;
    }
    assertEquals(args, { p_after_start: null, p_after_source: null, p_limit: 10 });
  },
);

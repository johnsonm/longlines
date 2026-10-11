import { assertEquals } from "@std/assert";
import { handleArchive } from "../handlers/archive.ts";
import { fakeSupabase } from "./fake_supabase.ts";

const KEY = "service-key";
const NOW = new Date("2026-10-11T20:05:00Z");
const req = (token?: string) =>
  new Request("http://x/archive", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

Deno.test("handleArchive refuses callers without the service-role key", async () => {
  const { client, calls } = fakeSupabase();
  for (const token of [undefined, "anon-key"]) {
    const res = await handleArchive(req(token), { serviceRoleKey: KEY, db: () => client }, NOW);
    assertEquals(res.status, 403);
  }
  const unset = await handleArchive(req(KEY), { serviceRoleKey: undefined, db: () => client }, NOW);
  assertEquals(unset.status, 403);
  assertEquals(calls.rpc, []);
});

Deno.test("handleArchive runs the archive and returns its summary", async () => {
  const slice = {
    slice_start: "2026-10-11T14:10:00+00:00",
    slice_end: "2026-10-11T14:20:00+00:00",
  };
  const { client, calls } = fakeSupabase({
    rpc: {
      archive_pending_slices: (args) => ({ data: args?.["p_source"] === "rbn" ? [slice] : [] }),
      archive_ndjson: { data: [{ row_count: 1, ndjson: '{"callsign":"K1ABC"}' }] },
    },
  });
  const res = await handleArchive(req(KEY), { serviceRoleKey: KEY, db: () => client }, NOW);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals([body.slices, body.rows, body.errors], [1, 1, []]);
  assertEquals(calls.storage.map((s) => s.path), ["rbn/2026/10/11/1410.ndjson.gz"]);
});

Deno.test("handleArchive answers 500 when any slice failed", async () => {
  const slice = {
    slice_start: "2026-10-11T14:00:00+00:00",
    slice_end: "2026-10-11T15:00:00+00:00",
  };
  const { client } = fakeSupabase({
    rpc: {
      archive_pending_slices: (args) => ({ data: args?.["p_source"] === "pota" ? [slice] : [] }),
      archive_ndjson: { data: [{ row_count: 1, ndjson: "{}" }] },
    },
    storageUpload: { error: { message: "storage 503" } },
  });
  const res = await handleArchive(req(KEY), { serviceRoleKey: KEY, db: () => client }, NOW);
  assertEquals(res.status, 500);
  assertEquals((await res.json()).errors.length, 1);
});

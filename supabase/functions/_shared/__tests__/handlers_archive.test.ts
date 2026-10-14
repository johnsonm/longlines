import { assertEquals } from "@std/assert";
import { handleArchive } from "../handlers/archive.ts";
import { fakeSupabase } from "./fake_supabase.ts";

const KEY = "service-key";
const NOW = new Date("2026-10-11T20:05:00Z");
const req = (token?: string, body?: string) =>
  new Request("http://x/archive", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { body }),
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

Deno.test("handleArchive accepts the gateway-verified service-role JWT pg_cron sends", async () => {
  const b64url = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const cronJwt = `${b64url({ alg: "HS256" })}.${b64url({ role: "service_role" })}.sig`;
  const { client } = fakeSupabase();
  const res = await handleArchive(req(cronJwt), {
    serviceRoleKey: "sb_secret_runtime",
    db: () => client,
  }, NOW);
  assertEquals(res.status, 200);
});

Deno.test("handleArchive archives only the sources the body names", async () => {
  const slice = {
    slice_start: "2026-10-11T17:55:00+00:00",
    slice_end: "2026-10-11T18:00:00+00:00",
  };
  const { client, calls } = fakeSupabase({
    rpc: {
      archive_pending_slices: (args) => ({ data: args?.["p_source"] === "aprs" ? [slice] : [] }),
      archive_ndjson: { data: [{ row_count: 1, ndjson: '{"source_call":"N0CALL"}' }] },
    },
  });
  const res = await handleArchive(
    req(KEY, '{"sources":["aprs"]}'),
    { serviceRoleKey: KEY, db: () => client },
    NOW,
  );
  assertEquals(res.status, 200);
  assertEquals(
    calls.rpc.filter((c) => c.fn === "archive_pending_slices").map((c) => c.args?.["p_source"]),
    ["aprs"],
  );
  assertEquals(calls.storage.map((s) => s.path), ["aprs/2026/10/11/1755.ndjson.gz"]);
});

Deno.test("handleArchive answers 400 for a body it cannot use, before touching the database", async () => {
  for (const body of ["not json", '{"sources":["nope"]}', "[]"]) {
    const { client, calls } = fakeSupabase();
    const res = await handleArchive(req(KEY, body), { serviceRoleKey: KEY, db: () => client }, NOW);
    assertEquals(res.status, 400, body);
    assertEquals((await res.json()).error.startsWith("Bad request"), true);
    assertEquals(calls.rpc, []);
  }
});

Deno.test("handleArchive treats pg_cron's empty JSON object as the default sources", async () => {
  const { client, calls } = fakeSupabase();
  const res = await handleArchive(req(KEY, "{}"), { serviceRoleKey: KEY, db: () => client }, NOW);
  assertEquals(res.status, 200);
  assertEquals(
    calls.rpc.filter((c) => c.fn === "archive_pending_slices").map((c) => c.args?.["p_source"]),
    ["pota", "sotawatch", "dxcluster", "rbn"],
  );
});

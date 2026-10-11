import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createIngestDb, createServiceClient, createWatchlistDb } from "../db.ts";
import type { NormalizedSpot } from "../types.ts";
import { fakeSupabase } from "./fake_supabase.ts";

const boom = { error: { message: "boom" } };

Deno.test("createServiceClient requires the runtime's environment", () => {
  // The test permission set does not grant these variables, so reading them throws
  // before a client is built.
  assertThrows(() => createServiceClient(), Error);
});

Deno.test("getLastEpoch reads ingest_state for the source", async () => {
  const { client, calls } = fakeSupabase({
    from: { ingest_state: { data: { last_epoch: "e1" } } },
  });
  assertEquals(await createIngestDb(client).getLastEpoch("sotawatch"), "e1");
  assertEquals(calls.from[0]!.ops, [["select", ["last_epoch"]], ["eq", ["source", "sotawatch"]], [
    "single",
    [],
  ]]);
});

Deno.test("getLastEpoch returns null when no epoch is stored", async () => {
  const { client } = fakeSupabase({ from: { ingest_state: { data: { last_epoch: null } } } });
  assertEquals(await createIngestDb(client).getLastEpoch("pota"), null);
});

Deno.test("ingestSpots sends the batch to the RPC and returns inserted rows", async () => {
  const rows = [{ id: 1, source: "pota", source_spot_id: "9" }];
  const { client, calls } = fakeSupabase({ rpc: { ingest_spots: { data: rows } } });
  const spots = [{ source_spot_id: "9" }] as unknown as NormalizedSpot[];
  assertEquals(await createIngestDb(client).ingestSpots(spots), rows);
  assertEquals(calls.rpc, [{ fn: "ingest_spots", args: { p_spots: spots } }]);
});

Deno.test("ingestSpots treats a null result as no rows", async () => {
  const { client } = fakeSupabase({ rpc: { ingest_spots: { data: null } } });
  assertEquals(await createIngestDb(client).ingestSpots([]), []);
});

Deno.test("record calls pass their arguments to the right RPC or table", async () => {
  const { client, calls } = fakeSupabase();
  const db = createIngestDb(client);
  const failure = { source: "pota" as const, error: "x", raw_payload: {} };
  await db.recordSpotFailures([failure]);
  await db.recordSuccess("pota", 3, "e2");
  await db.recordFailure("sotawatch", "upstream 503");
  assertEquals(calls.from[0], { table: "ingest_failures", ops: [["insert", [[failure]]]] });
  assertEquals(calls.rpc, [
    { fn: "record_ingest_success", args: { p_source: "pota", p_inserted: 3, p_epoch: "e2" } },
    { fn: "record_ingest_failure", args: { p_source: "sotawatch", p_error: "upstream 503" } },
  ]);
});

Deno.test("matchPendingSpots returns the matcher's count, or 0 for a non-number", async () => {
  const a = fakeSupabase({ rpc: { match_pending_spots: { data: 4 } } });
  assertEquals(await createIngestDb(a.client).matchPendingSpots(), 4);
  const b = fakeSupabase({ rpc: { match_pending_spots: { data: null } } });
  assertEquals(await createIngestDb(b.client).matchPendingSpots(), 0);
});

Deno.test("every IngestDb method surfaces database errors with context", async () => {
  const { client } = fakeSupabase({
    from: { ingest_state: boom, ingest_failures: boom },
    rpc: {
      ingest_spots: boom,
      record_ingest_success: boom,
      record_ingest_failure: boom,
      match_pending_spots: boom,
    },
  });
  const db = createIngestDb(client);
  await assertRejects(() => db.getLastEpoch("pota"), Error, "ingest_state read failed: boom");
  await assertRejects(() => db.ingestSpots([]), Error, "ingest_spots failed: boom");
  await assertRejects(() => db.recordSpotFailures([]), Error, "ingest_failures insert failed");
  await assertRejects(() => db.recordSuccess("pota", 0, null), Error, "record_ingest_success");
  await assertRejects(() => db.recordFailure("pota", "x"), Error, "record_ingest_failure");
  await assertRejects(() => db.matchPendingSpots(), Error, "match_pending_spots failed");
});

Deno.test("watchedCallsigns calls the RPC for the source and keeps only strings", async () => {
  const { client, calls } = fakeSupabase({
    rpc: { watched_callsigns: { data: ["K1ABC", null, "W1AW"] } },
  });
  assertEquals(await createWatchlistDb(client).watchedCallsigns("rbn"), ["K1ABC", "W1AW"]);
  assertEquals(calls.rpc, [{ fn: "watched_callsigns", args: { p_source: "rbn" } }]);
});

Deno.test("watchedCallsigns treats a null result as an empty list and throws on error", async () => {
  const a = fakeSupabase({ rpc: { watched_callsigns: { data: null } } });
  assertEquals(await createWatchlistDb(a.client).watchedCallsigns("rbn"), []);
  const b = fakeSupabase({ rpc: { watched_callsigns: boom } });
  await assertRejects(
    () => createWatchlistDb(b.client).watchedCallsigns("rbn"),
    Error,
    "watched_callsigns failed: boom",
  );
});

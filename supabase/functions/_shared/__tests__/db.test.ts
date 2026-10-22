import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  createAprsDb,
  createArchiveDb,
  createConvertDb,
  createIngestDb,
  createRbnDb,
  createServiceClient,
  createWatchlistDb,
} from "../db.ts";
import type { AprsPacketRow, NormalizedSpot, RbnSpotRow } from "../types.ts";
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

Deno.test("watchedAmong asks the RPC about the batch's stations and keeps only strings", async () => {
  const { client, calls } = fakeSupabase({
    rpc: { watched_among: { data: ["K1ABC", null, "W1AW/P"] } },
  });
  assertEquals(await createWatchlistDb(client).watchedAmong("rbn", ["K1ABC", "W1AW/P", "N0NE"]), [
    "K1ABC",
    "W1AW/P",
  ]);
  assertEquals(calls.rpc, [{
    fn: "watched_among",
    args: { p_source: "rbn", p_callsigns: ["K1ABC", "W1AW/P", "N0NE"] },
  }]);
});

Deno.test("watchedAmong skips the RPC for no stations, treats null as empty and throws on error", async () => {
  const none = fakeSupabase({ rpc: {} });
  assertEquals(await createWatchlistDb(none.client).watchedAmong("rbn", []), []);
  assertEquals(none.calls.rpc, []);
  const a = fakeSupabase({ rpc: { watched_among: { data: null } } });
  assertEquals(await createWatchlistDb(a.client).watchedAmong("rbn", ["K1ABC"]), []);
  const b = fakeSupabase({ rpc: { watched_among: boom } });
  await assertRejects(
    () => createWatchlistDb(b.client).watchedAmong("rbn", ["K1ABC"]),
    Error,
    "watched_among failed: boom",
  );
});

Deno.test("ingestRbnSpots sends the batch to the RPC and returns the inserted count", async () => {
  const { client, calls } = fakeSupabase({ rpc: { ingest_rbn_spots: { data: 2 } } });
  const rows = [{ callsign: "K1ABC" }] as unknown as RbnSpotRow[];
  assertEquals(await createRbnDb(client).ingestRbnSpots(rows), 2);
  assertEquals(calls.rpc, [{ fn: "ingest_rbn_spots", args: { p_rows: rows } }]);
});

Deno.test("ingestRbnSpots treats a non-number as 0 and throws on error", async () => {
  const a = fakeSupabase({ rpc: { ingest_rbn_spots: { data: null } } });
  assertEquals(await createRbnDb(a.client).ingestRbnSpots([]), 0);
  const b = fakeSupabase({ rpc: { ingest_rbn_spots: boom } });
  await assertRejects(
    () => createRbnDb(b.client).ingestRbnSpots([]),
    Error,
    "ingest_rbn_spots failed: boom",
  );
});

Deno.test("ingestAprsPackets sends the batch to the RPC and returns the inserted count", async () => {
  const { client, calls } = fakeSupabase({ rpc: { ingest_aprs_packets: { data: 3 } } });
  const rows = [{ source_call: "N0CALL" }] as unknown as AprsPacketRow[];
  assertEquals(await createAprsDb(client).ingestAprsPackets(rows), 3);
  assertEquals(calls.rpc, [{ fn: "ingest_aprs_packets", args: { p_rows: rows } }]);
});

Deno.test("ingestAprsPackets treats a non-number as 0 and throws on error", async () => {
  const a = fakeSupabase({ rpc: { ingest_aprs_packets: { data: null } } });
  assertEquals(await createAprsDb(a.client).ingestAprsPackets([]), 0);
  const b = fakeSupabase({ rpc: { ingest_aprs_packets: boom } });
  await assertRejects(
    () => createAprsDb(b.client).ingestAprsPackets([]),
    Error,
    "ingest_aprs_packets failed: boom",
  );
});

const SLICE = { slice_start: "2026-10-11T14:10:00+00:00", slice_end: "2026-10-11T14:20:00+00:00" };

Deno.test("pendingSlices calls archive_pending_slices with an ISO cutoff", async () => {
  const { client, calls } = fakeSupabase({ rpc: { archive_pending_slices: { data: [SLICE] } } });
  const before = new Date("2026-10-11T18:00:00Z");
  assertEquals(await createArchiveDb(client).pendingSlices("rbn", before, 24), [SLICE]);
  assertEquals(calls.rpc, [{
    fn: "archive_pending_slices",
    args: { p_source: "rbn", p_before: "2026-10-11T18:00:00.000Z", p_limit: 24 },
  }]);
});

Deno.test("sliceColumns returns the RPC's single row, or an empty slice", async () => {
  const columns = { callsign: ["K1ABC", "W1AW"] };
  const a = fakeSupabase({
    rpc: { archive_columns: { data: [{ row_count: 2, columns }] } },
  });
  assertEquals(await createArchiveDb(a.client).sliceColumns("rbn", SLICE), {
    row_count: 2,
    columns,
  });
  assertEquals(a.calls.rpc[0]!.args, {
    p_source: "rbn",
    p_from: SLICE.slice_start,
    p_to: SLICE.slice_end,
  });
  const b = fakeSupabase({ rpc: { archive_columns: { data: [] } } });
  assertEquals(await createArchiveDb(b.client).sliceColumns("pota", SLICE), {
    row_count: 0,
    columns: null,
  });
});

Deno.test("logArchive passes every field to log_archive", async () => {
  const { client, calls } = fakeSupabase();
  await createArchiveDb(client).logArchive({
    source: "rbn",
    ...SLICE,
    row_count: 3,
    bytes: 120,
    object_path: "rbn/year=2026/month=10/day=11/1410.parquet",
  });
  assertEquals(calls.rpc, [{
    fn: "log_archive",
    args: {
      p_source: "rbn",
      p_slice_start: SLICE.slice_start,
      p_slice_end: SLICE.slice_end,
      p_row_count: 3,
      p_bytes: 120,
      p_object_path: "rbn/year=2026/month=10/day=11/1410.parquet",
    },
  }]);
});

Deno.test("archive RPC errors are thrown with the function name", async () => {
  const { client } = fakeSupabase({
    rpc: { archive_pending_slices: boom, archive_columns: boom, log_archive: boom },
  });
  const db = createArchiveDb(client);
  await assertRejects(
    () => db.pendingSlices("rbn", new Date(), 1),
    Error,
    "archive_pending_slices failed: boom",
  );
  await assertRejects(() => db.sliceColumns("rbn", SLICE), Error, "archive_columns failed: boom");
  await assertRejects(
    () => db.logArchive({ source: "rbn", ...SLICE, row_count: 0, bytes: null, object_path: null }),
    Error,
    "log_archive failed: boom",
  );
});

Deno.test("the conversion RPCs pass the cursor, the verified count and the new path", async () => {
  const row = {
    source: "rbn",
    slice_start: "2026-10-11T14:10:00+00:00",
    slice_end: "2026-10-11T14:20:00+00:00",
    row_count: "3",
    object_path: "rbn/2026/10/11/1410.ndjson.gz",
  };
  const { client, calls } = fakeSupabase({
    rpc: { archive_ndjson_slices: { data: [row] }, archive_repoint_slice: { data: true } },
  });
  const db = createConvertDb(client);
  const [slice] = await db.ndjsonSlices({ slice_start: row.slice_start, source: "pota" }, 5);
  assertEquals(slice, { ...row, source: "rbn", row_count: 3 });
  assertEquals(
    await db.repointSlice(slice!, {
      object_path: "rbn/year=2026/month=10/day=11/1410.parquet",
      bytes: 9,
    }),
    true,
  );
  assertEquals(calls.rpc, [
    {
      fn: "archive_ndjson_slices",
      args: { p_after_start: row.slice_start, p_after_source: "pota", p_limit: 5 },
    },
    {
      fn: "archive_repoint_slice",
      args: {
        p_source: "rbn",
        p_slice_start: row.slice_start,
        p_from_path: row.object_path,
        p_to_path: "rbn/year=2026/month=10/day=11/1410.parquet",
        p_row_count: 3,
        p_bytes: 9,
      },
    },
  ]);
  assertEquals(await createConvertDb(fakeSupabase().client).ndjsonSlices(null, 1), []);
  assertEquals(
    await createConvertDb(fakeSupabase({ rpc: { archive_repoint_slice: { data: false } } }).client)
      .repointSlice(slice!, { object_path: "x", bytes: 1 }),
    false,
  );
  const failing = createConvertDb(
    fakeSupabase({ rpc: { archive_ndjson_slices: boom, archive_repoint_slice: boom } }).client,
  );
  await assertRejects(
    () => failing.ndjsonSlices(null, 1),
    Error,
    "archive_ndjson_slices failed: boom",
  );
  await assertRejects(
    () => failing.repointSlice(slice!, { object_path: "x", bytes: 1 }),
    Error,
    "archive_repoint_slice failed: boom",
  );
});

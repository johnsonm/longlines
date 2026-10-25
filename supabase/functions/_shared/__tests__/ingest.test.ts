import { assertEquals, assertExists, assertMatch, assertRejects } from "@std/assert";
import { FunctionCallError, ValidationError } from "../errors.ts";
import { runIngest } from "../ingest.ts";
import { wwff } from "../wwff.ts";
import type {
  IngestDb,
  InsertedSpot,
  JsonObject,
  NormalizedSpot,
  NormalizeResult,
  Source,
  SourceAdapter,
  SpotFailure,
} from "../types.ts";

const NOW = new Date("2026-10-05T13:41:00Z");

function spotFor(raw: JsonObject): NormalizedSpot {
  return {
    source: "pota",
    source_spot_id: String(raw["id"]),
    content_hash: "h".repeat(64),
    spot_time: NOW.toISOString(),
    callsign: "W1AW",
    spotter: null,
    frequency_khz: 14074,
    band: "20m",
    mode: "ft8",
    mode_family: "digital",
    comment: "",
    pota_reference: null,
    pota_park_name: null,
    pota_location: null,
    sota_summit_ref: null,
    wwff_reference: null,
    wwff_reference_name: null,
    raw_payload: raw,
  };
}

/** Adapter whose feed items declare how they should be handled. */
function fakeAdapter(
  feed: JsonObject[] | Error,
  options: { epoch?: string; source?: Source },
): SourceAdapter & { fetchCount: number } {
  let source: Source = "pota";
  if (options.source !== undefined) {
    source = options.source;
  }
  const adapter: SourceAdapter & { fetchCount: number } = {
    source,
    fetchCount: 0,
    fetchSpots(): Promise<unknown> {
      adapter.fetchCount++;
      if (feed instanceof Error) {
        return Promise.reject(feed);
      }
      return Promise.resolve(feed);
    },
    parseFeed(body: unknown): JsonObject[] {
      if (!Array.isArray(body)) {
        throw new Error("bad shape");
      }
      return body as JsonObject[];
    },
    normalize(raw: JsonObject): Promise<NormalizeResult> {
      if (raw["throws"]) {
        return Promise.reject(
          new ValidationError(`cannot process ${raw["id"]}`, { cause: undefined, where: "fake" }),
        );
      }
      if (raw["bug"]) {
        return Promise.reject(new TypeError("not a validation failure"));
      }
      if (raw["skip"]) {
        return Promise.resolve({ kind: "skip", reason: "too_old" });
      }
      return Promise.resolve({ kind: "spot", spot: spotFor(raw) });
    },
  };
  if (options.epoch !== undefined) {
    const epoch = options.epoch;
    adapter.fetchEpoch = () => Promise.resolve(epoch);
  }
  return adapter;
}

function fakeDb(
  options: { lastEpoch?: string | null; insertAll?: boolean; matcherFails?: boolean },
) {
  const calls = {
    ingested: [] as NormalizedSpot[][],
    failures: [] as SpotFailure[][],
    success: [] as Array<[Source, number, string | null]>,
    failure: [] as Array<[Source, string]>,
    matched: 0,
  };
  const db: IngestDb = {
    getLastEpoch() {
      if (options.lastEpoch === undefined || options.lastEpoch === null) {
        return Promise.resolve(null);
      }
      return Promise.resolve(options.lastEpoch);
    },
    ingestSpots(spots) {
      calls.ingested.push(spots);
      // Simulate the unique constraint dropping every second spot unless insertAll.
      let kept = spots;
      if (options.insertAll === false) {
        kept = spots.filter((_, i) => i % 2 === 0);
      }
      const rows: InsertedSpot[] = kept.map((s, i) => ({
        id: i + 1,
        source: s.source,
        source_spot_id: s.source_spot_id,
      }));
      return Promise.resolve(rows);
    },
    recordSpotFailures(failures) {
      calls.failures.push(failures);
      return Promise.resolve();
    },
    recordSuccess(source, inserted, epoch) {
      calls.success.push([source, inserted, epoch]);
      return Promise.resolve();
    },
    recordFailure(source, error) {
      calls.failure.push([source, error]);
      return Promise.resolve();
    },
    matchPendingSpots() {
      calls.matched += 1;
      if (options.matcherFails === true) {
        return Promise.reject(
          new FunctionCallError("matcher down", { cause: undefined, status: 500 }),
        );
      }
      return Promise.resolve(3);
    },
  };
  return { db, calls };
}

Deno.test(
  "runIngest inserts good spots, counts skips, and dead-letters bad ones",
  async function (): Promise<void> {
    const feed = [{ id: 1 }, { id: 2, skip: true }, { id: 3, throws: true }, { id: 4 }];
    const fake = fakeDb({});
    const db = fake.db;
    const calls = fake.calls;
    const summary = await runIngest(fakeAdapter(feed, {}), db, NOW);

    assertEquals(summary.source, "pota");
    assertEquals(summary.epoch_unchanged, false);
    assertEquals(summary.fetched, 4);
    assertEquals(summary.inserted, 2);
    assertEquals(summary.skipped, { too_old: 1, test_comment: 0, not_normal: 0 });
    assertEquals(summary.failed, 1);

    assertEquals(calls.ingested.length, 1);
    const ingested = calls.ingested[0];
    assertExists(ingested);
    assertEquals(ingested.map((s) => s.source_spot_id), ["1", "4"]);
    assertEquals(calls.failures, [[{
      source: "pota",
      error: "cannot process 3",
      raw_payload: { id: 3, throws: true },
    }]]);
    assertEquals(calls.success, [["pota", 2, null]]);
    assertEquals(calls.failure, []);
  },
);

Deno.test(
  "runIngest reports the inserted count the database returned, not the batch size",
  async function (): Promise<void> {
    const fake = fakeDb({ insertAll: false });
    const db = fake.db;
    const calls = fake.calls;
    const summary = await runIngest(fakeAdapter([{ id: 1 }, { id: 2 }, { id: 3 }], {}), db, NOW);
    assertEquals(summary.inserted, 2);
    assertEquals(calls.success, [["pota", 2, null]]);
  },
);

Deno.test(
  "runIngest skips the database insert and failure writes when there is nothing to write",
  async function (): Promise<void> {
    const fake = fakeDb({});
    const db = fake.db;
    const calls = fake.calls;
    const summary = await runIngest(fakeAdapter([{ id: 1, skip: true }], {}), db, NOW);
    assertEquals(summary.inserted, 0);
    assertEquals(calls.ingested, []);
    assertEquals(calls.failures, []);
    assertEquals(calls.success, [["pota", 0, null]]);
  },
);

Deno.test(
  "runIngest exits early when the upstream epoch is unchanged",
  async function (): Promise<void> {
    const adapter = fakeAdapter([{ id: 1 }], { epoch: "e1", source: "sotawatch" });
    const fake = fakeDb({ lastEpoch: "e1" });
    const db = fake.db;
    const calls = fake.calls;
    const summary = await runIngest(adapter, db, NOW);
    assertEquals(summary.epoch_unchanged, true);
    assertEquals(summary.fetched, 0);
    assertEquals(adapter.fetchCount, 0);
    assertEquals(calls.ingested, []);
    assertEquals(calls.success, [["sotawatch", 0, "e1"]]);
  },
);

Deno.test(
  "runIngest fetches and stores the new epoch when it changed",
  async function (): Promise<void> {
    const adapter = fakeAdapter([{ id: 1 }], { epoch: "e2", source: "sotawatch" });
    const fake = fakeDb({ lastEpoch: "e1" });
    const db = fake.db;
    const calls = fake.calls;
    const summary = await runIngest(adapter, db, NOW);
    assertEquals(summary.epoch_unchanged, false);
    assertEquals(adapter.fetchCount, 1);
    assertEquals(calls.success, [["sotawatch", 1, "e2"]]);
  },
);

Deno.test(
  "runIngest records a function-level failure when the upstream fetch fails",
  async function (): Promise<void> {
    const fake = fakeDb({});
    const db = fake.db;
    const calls = fake.calls;
    await assertRejects(
      () => runIngest(fakeAdapter(new Error("ECONNRESET"), {}), db, NOW),
      Error,
      "ECONNRESET",
    );
    assertEquals(calls.failure, [["pota", "ECONNRESET"]]);
    assertEquals(calls.success, []);
  },
);

Deno.test(
  "runIngest records a function-level failure when the feed has the wrong shape",
  async function (): Promise<void> {
    const fake = fakeDb({});
    const db = fake.db;
    const calls = fake.calls;
    const adapter = fakeAdapter([], {});
    adapter.fetchSpots = () => Promise.resolve({ error: "maintenance" });
    await assertRejects(() => runIngest(adapter, db, NOW), Error, "bad shape");
    assertEquals(calls.failure, [["pota", "bad shape"]]);
  },
);

Deno.test(
  "runIngest runs the matcher after recording success when spots were inserted",
  async function (): Promise<void> {
    const fake = fakeDb({});
    const db = fake.db;
    const calls = fake.calls;
    const summary = await runIngest(fakeAdapter([{ id: 1 }], {}), db, NOW);
    assertEquals(calls.matched, 1);
    assertEquals(summary.matched, 3);
    assertEquals(calls.success.length, 1);
  },
);

Deno.test(
  "runIngest skips the matcher when nothing was inserted",
  async function (): Promise<void> {
    const fake = fakeDb({});
    const db = fake.db;
    const calls = fake.calls;
    const summary = await runIngest(fakeAdapter([{ id: 1, skip: true }], {}), db, NOW);
    assertEquals(calls.matched, 0);
    assertEquals(summary.matched, null);
  },
);

Deno.test(
  "runIngest fails the run on an error from normalize that is not a ValidationError",
  async function (): Promise<void> {
    const fake = fakeDb({});
    const db = fake.db;
    const calls = fake.calls;
    await assertRejects(
      () => runIngest(fakeAdapter([{ id: 1 }, { id: 2, bug: true }], {}), db, NOW),
      TypeError,
      "not a validation failure",
    );
    assertEquals(calls.ingested, []);
    assertEquals(calls.failures, []);
    assertEquals(calls.failure, [["pota", "not a validation failure"]]);
  },
);

Deno.test(
  "runIngest fails the run on a matcher error that is not the RPC's",
  async function (): Promise<void> {
    const fake = fakeDb({});
    const db = fake.db;
    const calls = fake.calls;
    db.matchPendingSpots = () => Promise.reject(new TypeError("matcher bug"));
    await assertRejects(() => runIngest(fakeAdapter([{ id: 1 }], {}), db, NOW), TypeError);
    assertEquals(calls.failure, [["pota", "matcher bug"]]);
  },
);

Deno.test(
  "runIngest reports a matcher failure without failing the ingest run",
  async function (): Promise<void> {
    const fake = fakeDb({ matcherFails: true });
    const db = fake.db;
    const calls = fake.calls;
    const summary = await runIngest(fakeAdapter([{ id: 1 }], {}), db, NOW);
    assertEquals(summary.inserted, 1);
    assertEquals(summary.matched, null);
    assertEquals(summary.match_error, "matcher down");
    assertEquals(calls.failure, []);
  },
);

Deno.test(
  "runIngest strips U+0000 from pulled items before normalize, insert and dead letters",
  async function (): Promise<void> {
    // Postgres rejects U+0000 in jsonb (22P05), which would fail the whole batch.
    const feed = [
      { id: 1, comment: "QRV\u0000 now", park: { name: "Big\u0000 Park" } },
      { id: 2, throws: true, comment: "bad\u0000" },
      { id: 3, comment: String.raw`typed \u0000 text` },
    ];
    const seen: JsonObject[] = [];
    const adapter = fakeAdapter(feed, {});
    const normalize = adapter.normalize;
    adapter.normalize = function (raw, now) {
      seen.push(raw);
      return normalize(raw, now);
    };
    const fake = fakeDb({});
    const db = fake.db;
    const calls = fake.calls;
    const summary = await runIngest(adapter, db, NOW);

    assertEquals(summary.inserted, 2);
    assertEquals(summary.failed, 1);
    assertEquals(JSON.stringify(seen).includes("\\u0000"), true); // only the typed text
    assertEquals(seen.some((raw) => JSON.stringify(raw).includes("\u0000")), false);
    const ingested = calls.ingested[0];
    assertExists(ingested);
    assertEquals(ingested.map((s) => s.raw_payload), [
      { id: 1, comment: "QRV now", park: { name: "Big Park" } },
      { id: 3, comment: String.raw`typed \u0000 text` },
    ]);
    const failed = calls.failures[0];
    assertExists(failed);
    assertExists(failed[0]);
    assertEquals(failed[0].raw_payload, { id: 2, throws: true, comment: "bad" });
  },
);

Deno.test(
  "runIngest dead-letters a far-future or oversized spot and stores the rest of the batch",
  async function (): Promise<void> {
    // A WWFF spot_time in milliseconds would be year 58763 and fail the whole ingest_spots call.
    const now = new Date("2026-10-15T18:28:00Z");
    const good = {
      id: 1,
      spot_time: now.getTime() / 1000 - 60,
      activator: "DL1ABC",
      reference: "DLFF-0001",
      frequency_khz: 7144,
      mode: "SSB",
      remarks: "",
    };
    const feed = [
      good,
      Object.assign({}, good, { id: 2, spot_time: now.getTime() }),
      Object.assign({}, good, { id: 3, activator: "D".repeat(3000) }),
    ];
    const adapter: SourceAdapter = Object.assign({}, wwff, {
      fetchSpots: () => Promise.resolve(feed),
    });
    const fake = fakeDb({});
    const db = fake.db;
    const calls = fake.calls;
    const summary = await runIngest(adapter, db, now);
    assertEquals([summary.inserted, summary.failed], [1, 2]);
    const ingested = calls.ingested[0];
    assertExists(ingested);
    assertEquals(ingested.map((s) => s.source_spot_id), ["1"]);
    assertEquals(calls.failures.flat().map((f) => [f.raw_payload["id"], f.error.split(":")[0]]), [
      [2, "spot time out of range"],
      [3, "callsign is 3000 characters; the limit is 64"],
    ]);
  },
);

Deno.test(
  "runIngest makes lone surrogates storable before normalize and the dead letter see them",
  async function (): Promise<void> {
    const seen: JsonObject[] = [];
    const adapter = fakeAdapter([{ id: 1, comment: "hi \ud83d" }, {
      id: 2,
      throws: true,
      c: "\udc00",
    }], {});
    const normalize = adapter.normalize;
    adapter.normalize = function (raw, now) {
      seen.push(raw);
      return normalize(raw, now);
    };
    const fake = fakeDb({});
    const db = fake.db;
    const calls = fake.calls;
    await runIngest(adapter, db, NOW);
    assertEquals(seen[0], { id: 1, comment: "hi \ufffd" });
    const failed = calls.failures[0];
    assertExists(failed);
    assertExists(failed[0]);
    assertEquals(failed[0].raw_payload, { id: 2, throws: true, c: "\ufffd" });
  },
);

async function capturingErrors<T>(fn: () => Promise<T>): Promise<unknown[]> {
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args[0]);
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return errors;
}

Deno.test(
  "runIngest rethrows the run's own error when recording the failure fails too",
  async function (): Promise<void> {
    const fake = fakeDb({});
    const db = fake.db;
    db.recordFailure = () =>
      Promise.reject(
        new FunctionCallError("record_ingest_failure failed: db down", {
          cause: undefined,
          status: 500,
        }),
      );
    const errors = await capturingErrors(() =>
      assertRejects(
        () => runIngest(fakeAdapter(new Error("ECONNRESET"), {}), db, NOW),
        Error,
        "ECONNRESET",
      )
    );
    assertEquals(errors.length, 1);
    assertMatch(String(errors[0]), /ingest-pota: recording the failure failed: .*db down/);
  },
);

Deno.test(
  "runIngest rethrows a recording error that is not the RPC's",
  async function (): Promise<void> {
    const fake = fakeDb({});
    const db = fake.db;
    db.recordFailure = () => Promise.reject(new TypeError("recording bug"));
    await assertRejects(
      () => runIngest(fakeAdapter(new Error("ECONNRESET"), {}), db, NOW),
      TypeError,
      "recording bug",
    );
  },
);

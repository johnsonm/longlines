import { FunctionCallError, ValidationError } from "../errors.ts";
import { assertEquals, assertMatch, assertRejects } from "@std/assert";
import { runRbnPush } from "../rbn_push.ts";
import type { InsertedSpot, NormalizedSpot, RbnSpotRow, Source, SpotFailure } from "../types.ts";
import type { RbnPushDb } from "../rbn_push.ts";

const NOW = new Date("2026-10-11T14:57:00Z");
const RECEIVED = "2026-10-11T14:55:30Z";
const watchedLine = "DX de SM1HEV-#: 14038.30  CT1JGA/P       CW     8 dB  24 WPM  CQ      1454Z";
const otherLine = "DX de DM5GG-#:  18089.00  N2GM           CW    10 dB  25 WPM  CQ      1454Z";
function item(line: string, received_at: string) {
  return { line, received_at };
}

function fakeDb(options: { watched?: string[]; stored?: number; storeFails?: boolean }) {
  const calls = {
    stored: [] as RbnSpotRow[][],
    ingested: [] as NormalizedSpot[][],
    failures: [] as SpotFailure[][],
    success: [] as Array<[Source, number]>,
    failure: [] as Array<[Source, string]>,
    asked: [] as string[][],
  };
  const db: RbnPushDb = {
    ingestRbnSpots(rows) {
      calls.stored.push(rows);
      if (options.storeFails) {
        return Promise.reject(new Error("disk full"));
      }
      if (options.stored !== undefined) {
        return Promise.resolve(options.stored);
      }
      return Promise.resolve(rows.length);
    },
    watchedAmong(_source, callsigns) {
      calls.asked.push(callsigns);
      let watched = ["CT1JGA/P"];
      if (options.watched !== undefined) {
        watched = options.watched;
      }
      return Promise.resolve(callsigns.filter((c) => watched.includes(c)));
    },
    ingestSpots(spots) {
      calls.ingested.push(spots);
      return Promise.resolve(
        spots.map((s, i): InsertedSpot => ({
          id: i + 1,
          source: s.source,
          source_spot_id: s.source_spot_id,
        })),
      );
    },
    recordSpotFailures(failures) {
      calls.failures.push(failures);
      return Promise.resolve();
    },
    recordSuccess(source, inserted) {
      calls.success.push([source, inserted]);
      return Promise.resolve();
    },
    recordFailure(source, error) {
      calls.failure.push([source, error]);
      return Promise.resolve();
    },
    getLastEpoch: () => Promise.resolve(null),
    matchPendingSpots: () => Promise.resolve(0),
  };
  return { db, calls };
}

Deno.test(
  "runRbnPush stores every line and alerts only watched callsigns",
  async function (): Promise<void> {
    const fake = fakeDb({});
    const db = fake.db;
    const calls = fake.calls;
    const body = {
      lines: [
        item(watchedLine, RECEIVED),
        item(otherLine, RECEIVED),
        item("Local users: 586", RECEIVED),
        item(otherLine, "not a time"),
      ],
    };
    const summary = await runRbnPush(body, db, NOW);
    assertEquals(calls.stored.length, 1);
    assertEquals(calls.stored[0]!.map((r) => r.callsign), ["CT1JGA/P", "N2GM"]);
    assertEquals(calls.ingested.length, 1);
    assertEquals(calls.ingested[0]!.map((s) => s.callsign), ["CT1JGA/P"]);
    assertEquals(calls.asked, [["CT1JGA/P", "N2GM"]], "asks once about each parsed station");
    assertEquals(calls.failures.flat().map((f) => f.error), [
      "not an RBN spot line",
      'invalid timestamp: "not a time"',
    ]);
    assertEquals([summary.fetched, summary.stored, summary.inserted, summary.failed], [4, 2, 1, 2]);
    assertEquals(calls.success, [["rbn", 1]]);
  },
);

Deno.test(
  "runRbnPush records a heartbeat when nothing is watched or the batch is empty",
  async function (): Promise<void> {
    const fake = fakeDb({ watched: [] });
    const db = fake.db;
    const calls = fake.calls;
    const summary = await runRbnPush({ lines: [] }, db, NOW);
    assertEquals(calls.stored, []);
    assertEquals(calls.ingested, []);
    assertEquals(calls.success, [["rbn", 0]]);
    assertEquals(summary.stored, 0);
  },
);

Deno.test(
  "runRbnPush reports a retried batch as stored 0 without failing",
  async function (): Promise<void> {
    const fake = fakeDb({ stored: 0 });
    const db = fake.db;
    const calls = fake.calls;
    const summary = await runRbnPush({ lines: [item(otherLine, RECEIVED)] }, db, NOW);
    assertEquals(summary.stored, 0);
    assertEquals(calls.failure, []);
  },
);

Deno.test("runRbnPush stores late lines but does not alert them", async function (): Promise<void> {
  const fake = fakeDb({});
  const db = fake.db;
  const calls = fake.calls;
  const late = new Date("2026-10-11T15:40:00Z"); // 46 minutes after the spot
  const summary = await runRbnPush({ lines: [item(watchedLine, RECEIVED)] }, db, late);
  assertEquals(calls.stored[0]!.length, 1);
  assertEquals(calls.ingested, []);
  assertEquals([summary.stored, summary.inserted, summary.skipped.too_old], [1, 0, 1]);
});

Deno.test(
  "runRbnPush records the failure and rethrows when storage fails",
  async function (): Promise<void> {
    const fake = fakeDb({ storeFails: true });
    const db = fake.db;
    const calls = fake.calls;
    await assertRejects(
      () => runRbnPush({ lines: [item(otherLine, RECEIVED)] }, db, NOW),
      Error,
      "disk full",
    );
    assertEquals(calls.failure, [["rbn", "disk full"]]);
    assertEquals(calls.ingested, []);
  },
);

Deno.test(
  "runRbnPush records the failure and rethrows on a malformed body",
  async function (): Promise<void> {
    const fake = fakeDb({});
    const db = fake.db;
    const calls = fake.calls;
    await assertRejects(
      () => runRbnPush({ nope: true }, db, NOW),
      ValidationError,
      "parseRelayBody: relay body: lines",
    );
    assertEquals(calls.failure.length, 1);
    assertEquals(calls.stored, []);
  },
);

Deno.test(
  "runRbnPush stores a failure for a NUL line without the NUL",
  async function (): Promise<void> {
    const fake = fakeDb({});
    const db = fake.db;
    const calls = fake.calls;
    const nul = "DX de W3LPL-#:  14035.10  K1\u0000ABC        CW    12 dB  22 WPM  CQ      1454Z";
    await runRbnPush({ lines: [item(nul, RECEIVED), item(otherLine, RECEIVED)] }, db, NOW);
    assertEquals(calls.stored[0]!.map((r) => r.callsign), ["N2GM"]);
    const failed = calls.failures.flat();
    assertEquals(failed.length, 1);
    assertEquals(String(failed[0]!.raw_payload["line"]).includes("\u0000"), false);
  },
);

Deno.test(
  "runRbnPush dead-letters an oversized or far-future line and stores the rest",
  async function (): Promise<void> {
    const fake = fakeDb({});
    const db = fake.db;
    const calls = fake.calls;
    const long = otherLine.replace("N2GM", "N".repeat(3000));
    await runRbnPush(
      {
        lines: [
          item(long, RECEIVED),
          item(otherLine, "2027-01-01T00:00:00Z"),
          item(otherLine, RECEIVED),
        ],
      },
      db,
      NOW,
    );
    assertEquals(calls.stored[0]!.map((r) => r.callsign), ["N2GM"]);
    assertEquals(calls.failures.flat().map((f) => f.error.split(":")[0]), [
      "callsign is 3000 characters; the limit is 64",
      "received_at out of range",
    ]);
    assertEquals(calls.failure, []);
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
  "runRbnPush rethrows the store error when recording the failure fails too",
  async function (): Promise<void> {
    const fake = fakeDb({ storeFails: true });
    const db = fake.db;
    db.recordFailure = () =>
      Promise.reject(new FunctionCallError("db down", { cause: undefined, status: 500 }));
    const errors = await capturingErrors(() =>
      assertRejects(
        () => runRbnPush({ lines: [item(watchedLine, RECEIVED)] }, db, NOW),
        Error,
        "disk full",
      )
    );
    assertMatch(String(errors[0]), /ingest-rbn: recording the failure failed: db down/);
  },
);

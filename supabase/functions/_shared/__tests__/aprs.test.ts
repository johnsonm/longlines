import { FunctionCallError, ValidationError } from "../errors.ts";
import { contentHash } from "../hash.ts";
import { assertEquals, assertExists, assertMatch, assertRejects, assertThrows } from "@std/assert";
import {
  APRS_PACKET_TYPES,
  APRS_SPOT_BUCKET_MS,
  aprsAdapter,
  aprsPacketRow,
  aprsPacketType,
  type AprsPushDb,
  aprsSpotBucket,
  normalizeAprsSpot,
  parseAprsLine,
  runAprsPush,
} from "../aprs.ts";
import type {
  AprsPacketRow,
  InsertedSpot,
  NormalizedSpot,
  NormalizeResult,
  Source,
  SpotFailure,
} from "../types.ts";

const FIXTURE = Deno.readTextFileSync(new URL("./fixtures/aprs-is.txt", import.meta.url))
  .split("\n")
  .filter((l) => l !== "");
const RECEIVED = "2026-10-14T15:56:01.250Z";
const NOW = new Date("2026-10-14T15:57:00Z");
const POSITION = "N0CALL-9>APDR16,WIDE1-1,WIDE2-1,qAR,W1ABC-10:=4237.14N/07120.83W[/A=000164";

/** The parsed header of a line that must be a packet. */
function parsed(line: string) {
  const p = parseAprsLine(line);
  assertExists(p);
  return p;
}

Deno.test(
  "parseAprsLine splits the header into source, destination, path, q-construct and igate",
  function (): void {
    assertEquals(parseAprsLine(POSITION), {
      sourceCall: "N0CALL-9",
      destination: "APDR16",
      path: "WIDE1-1,WIDE2-1",
      qConstruct: "qAR",
      igate: "W1ABC-10",
      info: "=4237.14N/07120.83W[/A=000164",
    });
  },
);

Deno.test(
  "parseAprsLine handles an empty path, no q-construct and colons in the info field",
  function (): void {
    assertEquals(parseAprsLine("N0CALL-1>APRS,TCPIP*,qAC,T2TEST::KB1XYZ   :Hi{001"), {
      sourceCall: "N0CALL-1",
      destination: "APRS",
      path: "TCPIP*",
      qConstruct: "qAC",
      igate: "T2TEST",
      info: ":KB1XYZ   :Hi{001",
    });
    assertEquals(parsed("N0CALL>APRS,qAR,W1ABC-10:>hi").path, "");
    const bare = parsed("N0CALL-8>APRS:!4237.14N/07120.83W-");
    assertEquals([bare.path, bare.qConstruct, bare.igate], ["", null, null]);
    // qAr and qAo are q-constructs too, so their igate is not part of the path.
    const lowerQ = parsed("N0CALL>APRS,WIDE1-1,qAr,W1ABC-10:>x");
    assertEquals([lowerQ.path, lowerQ.qConstruct, lowerQ.igate], ["WIDE1-1", "qAr", "W1ABC-10"]);
    assertEquals(parsed("N0CALL>APRS,qAo,W1ABC-10:>x").qConstruct, "qAo");
    // A q-construct at the end of the path has no igate after it.
    assertEquals(parsed("N0CALL>APRS,qAR:>x").igate, null);
    assertEquals(parsed("N0CALL>APRS:").info, "");
  },
);

Deno.test(
  "parseAprsLine keeps a third-party packet's inner header in the info field",
  function (): void {
    const p = parsed("W1ABC-10>APRS,TCPIP*,qAC,T2TEST:}N0CALL-5>APRS,TCPIP,W1ABC-10*:!4237");
    assertEquals([p.sourceCall, p.info], ["W1ABC-10", "}N0CALL-5>APRS,TCPIP,W1ABC-10*:!4237"]);
  },
);

Deno.test(
  "parseAprsLine rejects server comments and anything that is not a packet",
  function (): void {
    for (
      const line of [
        "# aprsc 2.1.19-g730c5c0",
        "# logresp N0CALL unverified, server T2TEST",
        "",
        "garbage line without a header",
        "N0CALL APRS:no gt",
        "N0CALL>:missing destination",
        ">APRS:missing source",
        "N0 CALL>APRS:space in the source",
        "N0CALL>APRS,,WIDE1-1:empty hop",
        "N0CALL>AP\tRS:control character",
        "NØCALL>APRS:non-ASCII source",
      ]
    ) {
      assertEquals(parseAprsLine(line), null, line);
    }
  },
);

Deno.test("aprsPacketType maps every data type identifier", function (): void {
  const cases: Array<[string, string]> = [
    ["!4237.14N", "position"],
    ["=4237.14N", "position"],
    ["/141556h", "position"],
    ["@141554z", "position"],
    ["`p(0l!n[/", "mic_e"],
    ["'p(0l!n[/", "mic_e"],
    ["\x1cold mic-e", "mic_e"],
    ["\x1dold mic-e", "mic_e"],
    [";LEADER   *", "object"],
    [")AID #2!", "item"],
    [":KB1XYZ   :hi", "message"],
    [">status", "status"],
    ["_10090556c220", "weather"],
    ["T#005,199", "telemetry"],
    ["$GPRMC,", "nmea"],
    ["}N0CALL>APRS:x", "third_party"],
    ["<IGATE,", "capabilities"],
    ["?APRS?", "query"],
    ["{Q1qwerty", "user_defined"],
    [",test", "other"],
    ["", "other"],
  ];
  for (const c of cases) {
    assertEquals(aprsPacketType(c[0]), c[1], c[0]);
  }
  assertEquals(new Set(cases.map((c) => c[1])), new Set(APRS_PACKET_TYPES));
});

Deno.test(
  "the fixture: every packet line parses, every server line and garbage line does not",
  function (): void {
    const packets = FIXTURE.filter((l) => parseAprsLine(l) !== null);
    assertEquals(packets.length, 20);
    assertEquals(FIXTURE.filter((l) => l.startsWith("#")).every((l) => !parseAprsLine(l)), true);
    const types = packets.map((l) => aprsPacketType(parseAprsLine(l)!.info));
    assertEquals(new Set(types), new Set(APRS_PACKET_TYPES));
  },
);

Deno.test(
  "aprsPacketRow builds the aprs_packets row and keeps the line exactly",
  function (): void {
    const utf8 = "N0CALL-7>APRS,qAR,W1ABC-10:!4237.14N/07120.83W>Café 73 ° ✓";
    assertEquals(aprsPacketRow({ line: utf8, received_at: RECEIVED }, NOW), {
      received_at: RECEIVED,
      source_call: "N0CALL-7",
      destination: "APRS",
      path: "",
      q_construct: "qAR",
      igate: "W1ABC-10",
      packet_type: "position",
      line: utf8,
    });
    // received_at without an offset is UTC, as everywhere else.
    assertEquals(
      aprsPacketRow({ line: POSITION, received_at: "2026-10-14T15:56:01" }, NOW).received_at,
      "2026-10-14T15:56:01.000Z",
    );
  },
);

Deno.test(
  "aprsPacketRow throws on a non-packet, a NUL, or a missing or bad received_at",
  function (): void {
    assertThrows(
      () => aprsPacketRow({ line: "# keepalive", received_at: RECEIVED }, NOW),
      Error,
      "not an APRS packet line",
    );
    assertThrows(
      () => aprsPacketRow({ line: `${POSITION}\u0000`, received_at: RECEIVED }, NOW),
      Error,
      "NUL",
    );
    assertThrows(() => aprsPacketRow({ line: POSITION }, NOW), Error, "received_at");
    assertThrows(
      () => aprsPacketRow({ line: POSITION, received_at: "x" }, NOW),
      Error,
      "timestamp",
    );
    assertThrows(() => aprsPacketRow({ received_at: RECEIVED }, NOW), Error, "line");
  },
);

function fakeDb(options: { stored?: number; storeFails?: boolean; watched?: string[] }) {
  const calls = {
    stored: [] as AprsPacketRow[][],
    asked: [] as string[][],
    ingested: [] as NormalizedSpot[][],
    failures: [] as SpotFailure[][],
    success: [] as Array<[Source, number, string | null]>,
    failure: [] as Array<[Source, string]>,
    matched: 0,
  };
  // raw_spots' unique key, so a repeat is not inserted, as ON CONFLICT DO NOTHING does.
  const keys = new Set<string>();
  let nextId = 1;
  const db: AprsPushDb = {
    ingestAprsPackets(rows) {
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
      let watched: string[] = [];
      if (options.watched !== undefined) {
        watched = options.watched;
      }
      return Promise.resolve(callsigns.filter((c) => watched.includes(c)));
    },
    ingestSpots(spots) {
      calls.ingested.push(spots);
      const inserted: InsertedSpot[] = [];
      for (const s of spots) {
        const key = `${s.source}|${s.source_spot_id}|${s.content_hash}`;
        if (!keys.has(key)) {
          keys.add(key);
          inserted.push({ id: nextId, source: s.source, source_spot_id: s.source_spot_id });
          nextId += 1;
        }
      }
      return Promise.resolve(inserted);
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
    getLastEpoch: () => Promise.resolve(null),
    matchPendingSpots() {
      calls.matched += 1;
      return Promise.resolve(1);
    },
  };
  return { db, calls };
}

Deno.test(
  "runAprsPush stores every packet, records failures and counts what was inserted",
  async function (): Promise<void> {
    const fake = fakeDb({ stored: 19 });
    const db = fake.db;
    const calls = fake.calls;
    const lines = FIXTURE.filter((l) => !l.startsWith("#")).map((line) => ({
      line,
      received_at: RECEIVED,
    }));
    const summary = await runAprsPush({ lines }, db, new Date());
    assertEquals(calls.stored.length, 1);
    assertEquals(calls.stored[0]!.length, 20);
    assertEquals(calls.failures.flat().map((f) => [f.source, f.error]), [
      ["aprs", "not an APRS packet line"],
      ["aprs", "not an APRS packet line"],
      ["aprs", "not an APRS packet line"],
      ["aprs", "not an APRS packet line"],
    ]);
    // Nothing is watched, so no spot is inserted; ingest_state still counts the stored packets.
    assertEquals(calls.success, [["aprs", 19, null]]);
    assertEquals(calls.failure, []);
    assertEquals(calls.ingested, []);
    assertEquals(
      [summary.source, summary.fetched, summary.stored, summary.inserted, summary.failed],
      ["aprs", 24, 19, 0, 4],
    );
    assertEquals(summary.matched, null);
  },
);

Deno.test(
  "runAprsPush records the inbound worker's empty heartbeat as a success",
  async function (): Promise<void> {
    const fake = fakeDb({});
    const db = fake.db;
    const calls = fake.calls;
    const summary = await runAprsPush({ lines: [] }, db, new Date());
    assertEquals(calls.stored, []);
    assertEquals(calls.failures, []);
    assertEquals(calls.success, [["aprs", 0, null]]);
    assertEquals([summary.fetched, summary.stored], [0, 0]);
  },
);

Deno.test(
  "runAprsPush strips NUL from a failure's payload so ingest_failures can store it",
  async function (): Promise<void> {
    const fake = fakeDb({});
    const db = fake.db;
    const calls = fake.calls;
    await runAprsPush(
      { lines: [{ line: `${POSITION}\u0000`, received_at: RECEIVED }] },
      db,
      new Date(),
    );
    assertEquals(calls.failures[0]![0]!.raw_payload["line"], POSITION);
  },
);

Deno.test(
  "runAprsPush records a failure and rethrows on a bad body or a failed insert",
  async function (): Promise<void> {
    const bad = fakeDb({});
    await assertRejects(
      () => runAprsPush({ nope: 1 }, bad.db, new Date()),
      ValidationError,
      "parseInboundBody: inbound body: lines",
    );
    assertEquals(bad.calls.failure, [[
      "aprs",
      'parseInboundBody: inbound body: lines: Invalid input: expected array, received undefined; (root): Unrecognized key: "nope"',
    ]]);

    const full = fakeDb({ storeFails: true });
    await assertRejects(
      () =>
        runAprsPush({ lines: [{ line: POSITION, received_at: RECEIVED }] }, full.db, new Date()),
      Error,
      "disk full",
    );
    assertEquals(full.calls.failure, [["aprs", "disk full"]]);
    assertEquals(full.calls.success, []);
  },
);

Deno.test(
  "aprsPacketRow rejects a lone surrogate, an implausible received_at and an oversized source call",
  function (): void {
    assertThrows(
      () => aprsPacketRow({ line: `${POSITION} \ud83d`, received_at: RECEIVED }, NOW),
      Error,
      "surrogate",
    );
    assertThrows(
      () => aprsPacketRow({ line: POSITION, received_at: "2026-10-16T00:00:00Z" }, NOW),
      Error,
      "received_at out of range",
    );
    assertThrows(
      () => aprsPacketRow({ line: POSITION, received_at: "1970-01-01T00:00:00Z" }, NOW),
      Error,
      "received_at out of range",
    );
    const long = POSITION.replace("N0CALL-9", "N".repeat(3000));
    assertThrows(
      () => aprsPacketRow({ line: long, received_at: RECEIVED }, NOW),
      Error,
      "source call is 3000",
    );
  },
);

Deno.test(
  "runAprsPush dead-letters a bad packet and stores the rest of the batch",
  async function (): Promise<void> {
    const fake = fakeDb({});
    const db = fake.db;
    const calls = fake.calls;
    const lines = [
      { line: POSITION.replace("N0CALL-9", "N".repeat(3000)), received_at: RECEIVED },
      { line: `${POSITION} \ud83d`, received_at: RECEIVED },
      { line: POSITION, received_at: RECEIVED },
    ];
    const summary = await runAprsPush({ lines }, db, NOW);
    assertEquals(calls.stored[0]!.map((r) => r.source_call), ["N0CALL-9"]);
    assertEquals(summary.failed, 2);
    // The failure payload is made storable too.
    assertEquals(calls.failures[0]![1]!.raw_payload["line"], `${POSITION} \ufffd`);
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
  "runAprsPush rethrows the store error when recording the failure fails too",
  async function (): Promise<void> {
    const fake = fakeDb({ storeFails: true });
    const db = fake.db;
    db.recordFailure = () =>
      Promise.reject(new FunctionCallError("db down", { cause: undefined, status: 500 }));
    const errors = await capturingErrors(() =>
      assertRejects(
        () => runAprsPush({ lines: [{ line: POSITION, received_at: RECEIVED }] }, db, new Date()),
        Error,
        "disk full",
      )
    );
    assertMatch(String(errors[0]), /ingest-aprs: recording the failure failed: db down/);
  },
);

/** normalizeAprsSpot's spot for an item that must become one. */
async function spotOf(line: string, receivedAt: string, now: Date): Promise<NormalizedSpot> {
  const result = await normalizeAprsSpot({ line, received_at: receivedAt }, now);
  if (result.kind !== "spot") {
    throw new Error(`expected a spot, got a ${result.reason} skip`);
  }
  return result.spot;
}

Deno.test(
  "normalizeAprsSpot makes a spot of a position packet with no frequency, band or mode",
  async function (): Promise<void> {
    const item = { line: POSITION, received_at: RECEIVED };
    const result = await normalizeAprsSpot(item, NOW);
    const bucket = "2026-10-14T15:45:00.000Z";
    const expected: NormalizeResult = {
      kind: "spot",
      spot: {
        source: "aprs",
        source_spot_id: `N0CALL-9|${bucket}`,
        // The hash field order is fixed forever.
        content_hash: await contentHash(["N0CALL-9", bucket]),
        spot_time: RECEIVED,
        callsign: "N0CALL-9",
        spotter: "W1ABC-10",
        frequency_khz: null,
        band: null,
        mode: null,
        mode_family: null,
        comment: "=4237.14N/07120.83W[/A=000164",
        pota_reference: null,
        pota_park_name: null,
        pota_location: null,
        sota_summit_ref: null,
        wwff_reference: null,
        wwff_reference_name: null,
        wwbota_references: null,
        wwbota_reference_name: null,
        iota_reference: null,
        raw_payload: item,
      },
    };
    assertEquals(result, expected);
    if (result.kind === "spot") {
      assertMatch(result.spot.content_hash, /^[0-9a-f]{64}$/);
    }
  },
);

Deno.test(
  "normalizeAprsSpot keeps position, Mic-E, object and item packets and skips the rest",
  async function (): Promise<void> {
    const kept: string[] = [];
    const skipped: string[] = [];
    for (const line of FIXTURE.filter((l) => parseAprsLine(l) !== null)) {
      const result = await normalizeAprsSpot({ line, received_at: RECEIVED }, NOW);
      const type = aprsPacketType(parseAprsLine(line)!.info);
      if (result.kind === "spot") {
        kept.push(type);
      } else {
        assertEquals(result.reason, "not_normal", line);
        skipped.push(type);
      }
    }
    assertEquals(new Set(kept), new Set(["position", "mic_e", "object", "item"]));
    assertEquals(
      new Set(skipped),
      new Set(
        APRS_PACKET_TYPES.filter((t) => !["position", "mic_e", "object", "item"].includes(t)),
      ),
    );
    // An object or item is spotted under the station that sent it; its own name stays in
    // the comment.
    const object = await spotOf(
      "DB0XYZ>APRS,TCPIP*,qAC,T2GER:;LEADER   *092345z4903.50N/07201.75W>",
      RECEIVED,
      NOW,
    );
    assertEquals([object.callsign, object.comment], [
      "DB0XYZ",
      ";LEADER   *092345z4903.50N/07201.75W>",
    ]);
    const item = await spotOf(
      "N0CALL>APRS,TCPIP*,qAC,T2TEST:)AID #2!4903.50N/07201.75WA",
      RECEIVED,
      NOW,
    );
    assertEquals(item.callsign, "N0CALL");
    const micE = await spotOf("KD0ABC-7>S7SUWU,WIDE1-1,qAR,KD0XYZ-10:`p(0l!n[/`", RECEIVED, NOW);
    assertEquals([micE.callsign, micE.spotter, micE.comment], [
      "KD0ABC-7",
      "KD0XYZ-10",
      "`p(0l!n[/`",
    ]);
  },
);

Deno.test(
  "normalizeAprsSpot names the igate as spotter only for qAR, qAr, qAO and qAo",
  async function (): Promise<void> {
    const cases: Array<[string, string | null]> = [
      ["N0CALL-9>APRS,qAR,W1ABC-10:!4237.14N/07120.83W-", "W1ABC-10"],
      ["N0CALL-9>APRS,qAr,W1ABC-10:!4237.14N/07120.83W-", "W1ABC-10"],
      ["N0CALL-9>APRS,qAo,w1abc-10:!4237.14N/07120.83W-", "W1ABC-10"],
      ["N0CALL-9>APRS,TCPIP*,qAC,T2BOSTON:!4237.14N/07120.83W-", null],
      ["N0CALL-9>APRS,TCPIP*,qAS,T2BOSTON:!4237.14N/07120.83W-", null],
      ["N0CALL-9>APRS,TCPXX*,qAX,T2BOSTON:!4237.14N/07120.83W-", null],
      ["N0CALL-9>APRS,qAO,EA1XYZ-10:!4237.14N/07120.83W-", "EA1XYZ-10"],
      // A q-construct with nothing after it, or none at all.
      ["N0CALL-9>APRS,qAR:!4237.14N/07120.83W-", null],
      ["N0CALL-9>APRS:!4237.14N/07120.83W-", null],
    ];
    for (const c of cases) {
      assertEquals((await spotOf(c[0], RECEIVED, NOW)).spotter, c[1], c[0]);
    }
  },
);

Deno.test(
  "normalizeAprsSpot upper-cases the source call and skips one that is not a callsign",
  async function (): Promise<void> {
    const lower = await spotOf("n0call-9>APRS,qAR,W1ABC-10:!4237.14N/07120.83W-", RECEIVED, NOW);
    assertEquals([lower.callsign, lower.source_spot_id.split("|")[0]], ["N0CALL-9", "N0CALL-9"]);
    for (const source of ["MYANET", "WINLINK", "12345", "123-4"]) {
      assertEquals(
        await normalizeAprsSpot(
          { line: `${source}>APRS,TCPIP*,qAC,T2TEST:!4237.14N/07120.83W-`, received_at: RECEIVED },
          NOW,
        ),
        { kind: "skip", reason: "not_callsign" },
        source,
      );
    }
  },
);

Deno.test(
  "normalizeAprsSpot skips a packet more than five minutes old at ingest",
  async function (): Promise<void> {
    const now = new Date("2026-10-14T16:00:00Z");
    assertEquals(
      await normalizeAprsSpot({ line: POSITION, received_at: "2026-10-14T15:54:59.999Z" }, now),
      { kind: "skip", reason: "too_old" },
    );
    const edge = await spotOf(POSITION, "2026-10-14T15:55:00Z", now);
    assertEquals(edge.spot_time, "2026-10-14T15:55:00.000Z");
  },
);

Deno.test("aprsSpotBucket floors received_at to the 15-minute window", function (): void {
  assertEquals(APRS_SPOT_BUCKET_MS, 900_000);
  const cases: Array<[string, string]> = [
    ["2026-10-14T15:45:00.000Z", "2026-10-14T15:45:00.000Z"],
    ["2026-10-14T15:59:59.999Z", "2026-10-14T15:45:00.000Z"],
    ["2026-10-14T16:00:00.000Z", "2026-10-14T16:00:00.000Z"],
    ["2026-10-14T16:14:59.999Z", "2026-10-14T16:00:00.000Z"],
    ["2026-10-14T23:59:59.999Z", "2026-10-14T23:45:00.000Z"],
    ["2026-10-15T00:00:00.000Z", "2026-10-15T00:00:00.000Z"],
  ];
  for (const c of cases) {
    assertEquals(aprsSpotBucket(new Date(c[0])), c[1], c[0]);
  }
});

Deno.test(
  "normalizeAprsSpot keeps one key per station per window",
  async function (): Promise<void> {
    const now = new Date("2026-10-14T16:01:00Z");
    const first = await spotOf(POSITION, "2026-10-14T15:56:01Z", now);
    const sameWindow = await spotOf(
      "N0CALL-9>APDR16,qAR,K1XYZ-10:!4237.20N/07120.90W>moved",
      "2026-10-14T15:59:59.999Z",
      now,
    );
    const nextWindow = await spotOf(POSITION, "2026-10-14T16:00:00Z", now);
    const otherSsid = await spotOf(
      POSITION.replace("N0CALL-9", "N0CALL-7"),
      "2026-10-14T15:56:01Z",
      now,
    );
    // Same station and window: same key whatever the path, igate, position or time.
    assertEquals(
      [sameWindow.source_spot_id, sameWindow.content_hash],
      [first.source_spot_id, first.content_hash],
    );
    assertEquals(first.source_spot_id, "N0CALL-9|2026-10-14T15:45:00.000Z");
    assertEquals(nextWindow.source_spot_id, "N0CALL-9|2026-10-14T16:00:00.000Z");
    assertEquals(nextWindow.content_hash === first.content_hash, false);
    // An SSID is its own station.
    assertEquals(otherSsid.source_spot_id, "N0CALL-7|2026-10-14T15:45:00.000Z");
    assertEquals(otherSsid.content_hash === first.content_hash, false);
  },
);

Deno.test(
  "normalizeAprsSpot throws on a malformed item or a line that is not a packet",
  async function (): Promise<void> {
    await assertRejects(
      () => normalizeAprsSpot({ received_at: RECEIVED }, NOW),
      ValidationError,
      "normalizeAprsSpot: inbound line",
    );
    await assertRejects(
      () => normalizeAprsSpot({ line: "# keepalive", received_at: RECEIVED }, NOW),
      ValidationError,
      "not an APRS packet line",
    );
    await assertRejects(
      () => normalizeAprsSpot({ line: POSITION, received_at: "x" }, NOW),
      ValidationError,
      "invalid timestamp",
    );
  },
);

Deno.test(
  "aprsAdapter parses an inbound body and normalizes with normalizeAprsSpot",
  async function (): Promise<void> {
    const adapter = aprsAdapter({ lines: [{ line: POSITION, received_at: RECEIVED }] });
    assertEquals(adapter.source, "aprs");
    const feed = adapter.parseFeed(await adapter.fetchSpots());
    assertEquals(feed, [{ line: POSITION, received_at: RECEIVED }]);
    assertEquals((await adapter.normalize(feed[0]!, NOW)).kind, "spot");
  },
);

Deno.test(
  "runAprsPush stores every packet and sends only watched stations' packets to raw_spots",
  async function (): Promise<void> {
    const fake = fakeDb({ watched: ["N0CALL-9", "N0CALL-1", "DB0XYZ"] });
    const lines = FIXTURE.filter((l) => !l.startsWith("#")).map((line) => ({
      line,
      received_at: RECEIVED,
    }));
    const summary = await runAprsPush({ lines }, fake.db, NOW);
    assertEquals(fake.calls.stored[0]!.length, 20);
    // Asked once, about each stored source call as stored.
    assertEquals(fake.calls.asked.length, 1);
    assertEquals(
      fake.calls.asked[0],
      Array.from(new Set(fake.calls.stored[0]!.map((r) => r.source_call))),
    );
    // N0CALL-1 sent two messages, which are not spots.
    assertEquals(fake.calls.ingested.length, 1);
    assertEquals(fake.calls.ingested[0]!.map((s) => s.callsign), ["N0CALL-9", "DB0XYZ"]);
    // ingest_state counts the 20 stored packets, not the 2 spots.
    assertEquals(fake.calls.success, [["aprs", 20, null]]);
    assertEquals(fake.calls.matched, 1);
    assertEquals(
      [summary.fetched, summary.stored, summary.inserted, summary.failed, summary.matched],
      [24, 20, 2, 4, 1],
    );
    assertEquals(summary.skipped, { too_old: 0, test_comment: 0, not_normal: 2, not_callsign: 0 });
  },
);

/** POSITION as received at a time of day on the fixture's date. */
function at(time: string): { line: string; received_at: string } {
  return { line: POSITION, received_at: `2026-10-14T${time}Z` };
}

Deno.test(
  "runAprsPush makes one spot per station per 15-minute window",
  async function (): Promise<void> {
    const fake = fakeDb({ watched: ["N0CALL-9"] });
    const first = await runAprsPush(
      { lines: [at("15:46:00"), at("15:46:30")] },
      fake.db,
      new Date("2026-10-14T15:47:00Z"),
    );
    const later = await runAprsPush(
      { lines: [at("15:59:30")] },
      fake.db,
      new Date("2026-10-14T16:00:00Z"),
    );
    const next = await runAprsPush(
      { lines: [at("16:00:00")] },
      fake.db,
      new Date("2026-10-14T16:00:10Z"),
    );
    assertEquals([first.stored, first.inserted], [2, 1]);
    assertEquals([later.stored, later.inserted, later.matched], [1, 0, null]);
    assertEquals([next.stored, next.inserted], [1, 1]);
    assertEquals(fake.calls.ingested.flat().map((s) => s.source_spot_id), [
      "N0CALL-9|2026-10-14T15:45:00.000Z",
      "N0CALL-9|2026-10-14T15:45:00.000Z",
      "N0CALL-9|2026-10-14T15:45:00.000Z",
      "N0CALL-9|2026-10-14T16:00:00.000Z",
    ]);
  },
);

Deno.test(
  "runAprsPush still records the heartbeat when no packet is watched",
  async function (): Promise<void> {
    const fake = fakeDb({ watched: [] });
    const summary = await runAprsPush(
      { lines: [{ line: POSITION, received_at: RECEIVED }] },
      fake.db,
      NOW,
    );
    assertEquals(fake.calls.stored[0]!.length, 1);
    assertEquals(fake.calls.asked, [["N0CALL-9"]]);
    assertEquals(fake.calls.ingested, []);
    assertEquals(fake.calls.success, [["aprs", 1, null]]);
    assertEquals([summary.fetched, summary.stored, summary.inserted], [1, 1, 0]);
  },
);

Deno.test(
  "runAprsPush stores a late packet but does not spot it",
  async function (): Promise<void> {
    const fake = fakeDb({ watched: ["N0CALL-9"] });
    const late = new Date("2026-10-14T16:10:00Z");
    const summary = await runAprsPush(
      { lines: [{ line: POSITION, received_at: RECEIVED }] },
      fake.db,
      late,
    );
    assertEquals(fake.calls.stored[0]!.length, 1);
    assertEquals(fake.calls.ingested, []);
    assertEquals([summary.stored, summary.inserted, summary.skipped.too_old], [1, 0, 1]);
  },
);

Deno.test(
  "runAprsPush records the failure and rethrows when the watchlist lookup fails",
  async function (): Promise<void> {
    const fake = fakeDb({});
    fake.db.watchedAmong = () =>
      Promise.reject(
        new FunctionCallError("watched_among failed", { cause: undefined, status: 500 }),
      );
    await assertRejects(
      () => runAprsPush({ lines: [{ line: POSITION, received_at: RECEIVED }] }, fake.db, NOW),
      FunctionCallError,
      "watched_among failed",
    );
    assertEquals(fake.calls.failure, [["aprs", "watched_among failed"]]);
    assertEquals(fake.calls.success, []);
  },
);

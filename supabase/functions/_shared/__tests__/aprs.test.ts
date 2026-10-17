import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  APRS_PACKET_TYPES,
  aprsPacketRow,
  aprsPacketType,
  type AprsPushDb,
  parseAprsLine,
  runAprsPush,
} from "../aprs.ts";
import type { AprsPacketRow, Source, SpotFailure } from "../types.ts";

const FIXTURE = Deno.readTextFileSync(new URL("./fixtures/aprs-is.txt", import.meta.url))
  .split("\n")
  .filter((l) => l !== "");
const RECEIVED = "2026-10-14T15:56:01.250Z";
const NOW = new Date("2026-10-14T15:57:00Z");
const POSITION = "N0CALL-9>APDR16,WIDE1-1,WIDE2-1,qAR,W1ABC-10:=4237.14N/07120.83W[/A=000164";

Deno.test("parseAprsLine splits the header into source, destination, path, q-construct and igate", () => {
  assertEquals(parseAprsLine(POSITION), {
    sourceCall: "N0CALL-9",
    destination: "APDR16",
    path: "WIDE1-1,WIDE2-1",
    qConstruct: "qAR",
    igate: "W1ABC-10",
    info: "=4237.14N/07120.83W[/A=000164",
  });
});

Deno.test("parseAprsLine handles an empty path, no q-construct and colons in the info field", () => {
  assertEquals(parseAprsLine("N0CALL-1>APRS,TCPIP*,qAC,T2TEST::KB1XYZ   :Hi{001"), {
    sourceCall: "N0CALL-1",
    destination: "APRS",
    path: "TCPIP*",
    qConstruct: "qAC",
    igate: "T2TEST",
    info: ":KB1XYZ   :Hi{001",
  });
  assertEquals(parseAprsLine("N0CALL>APRS,qAR,W1ABC-10:>hi")?.path, "");
  const bare = parseAprsLine("N0CALL-8>APRS:!4237.14N/07120.83W-");
  assertEquals([bare?.path, bare?.qConstruct, bare?.igate], ["", null, null]);
  // A q-construct at the end of the path has no igate after it.
  assertEquals(parseAprsLine("N0CALL>APRS,qAR:>x")?.igate, null);
  assertEquals(parseAprsLine("N0CALL>APRS:")?.info, "");
});

Deno.test("parseAprsLine keeps a third-party packet's inner header in the info field", () => {
  const p = parseAprsLine("W1ABC-10>APRS,TCPIP*,qAC,T2TEST:}N0CALL-5>APRS,TCPIP,W1ABC-10*:!4237");
  assertEquals([p?.sourceCall, p?.info], ["W1ABC-10", "}N0CALL-5>APRS,TCPIP,W1ABC-10*:!4237"]);
});

Deno.test("parseAprsLine rejects server comments and anything that is not a packet", () => {
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
});

Deno.test("aprsPacketType maps every data type identifier", () => {
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
  for (const [info, type] of cases) assertEquals(aprsPacketType(info), type, info);
  assertEquals(new Set(cases.map(([, t]) => t)), new Set(APRS_PACKET_TYPES));
});

Deno.test("the fixture: every packet line parses, every server line and garbage line does not", () => {
  const packets = FIXTURE.filter((l) => parseAprsLine(l) !== null);
  assertEquals(packets.length, 20);
  assertEquals(FIXTURE.filter((l) => l.startsWith("#")).every((l) => !parseAprsLine(l)), true);
  const types = packets.map((l) => aprsPacketType(parseAprsLine(l)!.info));
  assertEquals(new Set(types), new Set(APRS_PACKET_TYPES));
});

Deno.test("aprsPacketRow builds the aprs_packets row and keeps the line exactly", () => {
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
});

Deno.test("aprsPacketRow throws on a non-packet, a NUL, or a missing or bad received_at", () => {
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
  assertThrows(() => aprsPacketRow({ line: POSITION, received_at: "x" }, NOW), Error, "timestamp");
  assertThrows(() => aprsPacketRow({ received_at: RECEIVED }, NOW), Error, "line");
});

function fakeDb(options: { stored?: number; storeFails?: boolean } = {}) {
  const calls = {
    stored: [] as AprsPacketRow[][],
    failures: [] as SpotFailure[][],
    success: [] as Array<[Source, number, string | null]>,
    failure: [] as Array<[Source, string]>,
  };
  const db: AprsPushDb = {
    ingestAprsPackets(rows) {
      calls.stored.push(rows);
      if (options.storeFails) return Promise.reject(new Error("disk full"));
      return Promise.resolve(options.stored ?? rows.length);
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
  };
  return { db, calls };
}

Deno.test("runAprsPush stores every packet, records failures and counts what was inserted", async () => {
  const { db, calls } = fakeDb({ stored: 19 });
  const lines = FIXTURE.filter((l) => !l.startsWith("#")).map((line) => ({
    line,
    received_at: RECEIVED,
  }));
  const summary = await runAprsPush({ lines }, db);
  assertEquals(calls.stored.length, 1);
  assertEquals(calls.stored[0]!.length, 20);
  assertEquals(calls.failures.flat().map((f) => [f.source, f.error]), [
    ["aprs", "not an APRS packet line"],
    ["aprs", "not an APRS packet line"],
    ["aprs", "not an APRS packet line"],
    ["aprs", "not an APRS packet line"],
  ]);
  assertEquals(calls.success, [["aprs", 19, null]]);
  assertEquals(calls.failure, []);
  assertEquals(
    [summary.source, summary.fetched, summary.stored, summary.inserted, summary.failed],
    ["aprs", 24, 19, 0, 4],
  );
  assertEquals(summary.matched, null);
});

Deno.test("runAprsPush records the relay's empty heartbeat as a success", async () => {
  const { db, calls } = fakeDb();
  const summary = await runAprsPush({ lines: [] }, db);
  assertEquals(calls.stored, []);
  assertEquals(calls.failures, []);
  assertEquals(calls.success, [["aprs", 0, null]]);
  assertEquals([summary.fetched, summary.stored], [0, 0]);
});

Deno.test("runAprsPush strips NUL from a failure's payload so ingest_failures can store it", async () => {
  const { db, calls } = fakeDb();
  await runAprsPush({ lines: [{ line: `${POSITION}\u0000`, received_at: RECEIVED }] }, db);
  assertEquals(calls.failures[0]![0]!.raw_payload["line"], POSITION);
});

Deno.test("runAprsPush records a failure and rethrows on a bad body or a failed insert", async () => {
  const bad = fakeDb();
  await assertRejects(() => runAprsPush({ nope: 1 }, bad.db), Error, '"lines"');
  assertEquals(bad.calls.failure, [["aprs", 'expected a "lines" array from the relay']]);

  const full = fakeDb({ storeFails: true });
  await assertRejects(
    () => runAprsPush({ lines: [{ line: POSITION, received_at: RECEIVED }] }, full.db),
    Error,
    "disk full",
  );
  assertEquals(full.calls.failure, [["aprs", "disk full"]]);
  assertEquals(full.calls.success, []);
});

Deno.test("aprsPacketRow rejects a lone surrogate, an implausible received_at and an oversized source call", () => {
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
});

Deno.test("runAprsPush dead-letters a bad packet and stores the rest of the batch", async () => {
  const { db, calls } = fakeDb();
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
});

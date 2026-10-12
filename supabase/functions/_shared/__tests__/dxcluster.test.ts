import { assertEquals, assertRejects } from "@std/assert";
import { dxclusterAdapter, parseDxLine, runDxclusterPush } from "../dxcluster.ts";
import { contentHash } from "../hash.ts";
import type { IngestDb, InsertedSpot, JsonObject, NormalizedSpot, Source } from "../types.ts";

// Fixture captured 2026-10-12 13:15-13:19Z from dxc.hamserve.uk:7300 (G1FEF-2,
// DXSpider): the login banner, then spot lines as the node sent them (CR
// removed, the two trailing BEL characters kept).
const fixture = Deno.readTextFileSync(new URL("./fixtures/dxcluster-telnet.txt", import.meta.url))
  .split("\n");
const spotLines = fixture.filter((l) => l.startsWith("DX de "));

const RECEIVED = "2026-10-12T13:18:20Z";
const NOW = new Date("2026-10-12T13:19:30Z");

function line(prefix: string): string {
  const found = spotLines.find((l) => l.startsWith(prefix));
  if (!found) throw new Error(`fixture has no line starting ${prefix}`);
  return found;
}

function item(text: string, receivedAt = RECEIVED): JsonObject {
  return { line: text, received_at: receivedAt };
}

async function normalized(text: string): Promise<NormalizedSpot> {
  const result = await dxclusterAdapter(null).normalize(item(text), NOW);
  if (result.kind !== "spot") throw new Error(`expected spot, got skip ${result.reason}`);
  return result.spot;
}

Deno.test("parseDxLine parses every spot line in the fixture", () => {
  assertEquals(spotLines.length > 20, true);
  for (const l of spotLines) {
    if (parseDxLine(l) === null) throw new Error(`did not parse: ${l}`);
  }
});

Deno.test("parseDxLine returns null for the banner, prompt and login lines", () => {
  const others = fixture.filter((l) => !l.startsWith("DX de "));
  assertEquals(others.map(parseDxLine).every((p) => p === null), true);
});

Deno.test("parseDxLine reads the columns and drops the trailing bells", () => {
  assertEquals(parseDxLine(line("DX de YB1LVL:    28074.0  F4HKP")), {
    spotter: "YB1LVL",
    frequency: "28074.0",
    callsign: "F4HKP",
    comment: "FT8 -19dB from JN18 1524Hz",
    hhmm: "1316",
    locator: null,
  });
});

Deno.test("parseDxLine accepts an empty comment and an appended locator", () => {
  const empty = parseDxLine(line("DX de KB8OTK"));
  assertEquals([empty?.callsign, empty?.comment, empty?.hhmm], ["VP2MAW", "", "1318"]);
  const grid = parseDxLine("DX de w3lpl:     14025.0  ja1abc       up 2      1234Z FN20\u0007");
  assertEquals(grid, {
    spotter: "W3LPL",
    frequency: "14025.0",
    callsign: "JA1ABC",
    comment: "up 2",
    hhmm: "1234",
    locator: "FN20",
  });
});

Deno.test("parseDxLine ignores whatever a node appends after the time", () => {
  const at = (tail: string) =>
    parseDxLine(`DX de W3LPL:  14025.0  JA1ABC  up 2 QSX 1400Z   1234Z${tail}`);
  assertEquals([at(" FN20xr")?.hhmm, at(" FN20xr")?.locator], ["1234", "FN20XR"]);
  assertEquals([at(" MD")?.comment, at(" MD")?.locator], ["up 2 QSX 1400Z", null]);
  assertEquals(at(" 8 5")?.locator, null);
  assertEquals(at("")?.comment, "up 2 QSX 1400Z");
});

Deno.test("parseDxLine rejects skimmer spots and non-spot broadcasts", () => {
  const rejected = [
    "DX de SM1HEV-#: 14038.30  CT1JGA/P       CW     8 dB  24 WPM  CQ      1454Z",
    "DX de W3LPL:    14038.3  CT1JGA/P     12 dB  24 WPM  CQ                1454Z",
    "DX de W3LPL:    14038.3  CT1JGA/P     CW 15 dB 22 WPM CQ               1454Z",
    "DX de W3LPL:     7043.7  ON6A         RTTY -3 dB 45 BPS CQ             1454Z",
    "WWV de VE7CC <18>:   SFI=128, A=8, K=2, No Storms -> No Storms",
    "WCY de DK0WCY-1 <13> : K=2 expK=2 A=7 R=88 SFI=145 SA=qui GMF=qui Au=no",
    "To ALL de G4ABC: anyone hearing VK on 40?",
    "",
  ];
  for (const l of rejected) assertEquals(parseDxLine(l), null, l);
});

Deno.test("dxclusterAdapter.parseFeed and fetchSpots pass the relay body through", async () => {
  const body = { lines: [item(line("DX de HA7UL"))] };
  const adapter = dxclusterAdapter(body);
  assertEquals(await adapter.fetchSpots(), body);
  assertEquals(adapter.parseFeed(body), body.lines);
});

Deno.test("dxclusterAdapter.normalize maps a fixture spot to the common schema", async () => {
  const raw = line("DX de EA1FIC");
  const s = await normalized(raw);
  assertEquals(s.source, "dxcluster");
  assertEquals(s.source_spot_id, "2026-10-12T13:18:00.000Z|EA1FIC|SV8/DJ0MY|14305.0");
  assertEquals(s.spot_time, "2026-10-12T13:18:00.000Z");
  assertEquals(s.callsign, "SV8/DJ0MY");
  assertEquals(s.spotter, "EA1FIC");
  assertEquals(s.frequency_khz, 14305);
  assertEquals(s.band, "20m");
  assertEquals(s.mode, "ssb");
  assertEquals(s.mode_family, "phone");
  assertEquals(s.comment, "SSB [POTA] GR-0131 cq cq");
  assertEquals(s.pota_reference, null);
  assertEquals(s.sota_summit_ref, null);
  assertEquals(s.raw_payload, item(raw));
});

Deno.test("dxclusterAdapter.normalize hashes the fields in the fixed order", async () => {
  const s = await normalized(line("DX de EA1FIC"));
  assertEquals(
    s.content_hash,
    await contentHash([
      "2026-10-12T13:18:00.000Z",
      "EA1FIC",
      "SV8/DJ0MY",
      "14305.0",
      "SSB [POTA] GR-0131 cq cq",
    ]),
  );
});

Deno.test("dxclusterAdapter.normalize takes the mode from the comment, then the band plan", async () => {
  assertEquals((await normalized(line("DX de YB1LVL:    28074.0  F4HKP"))).mode, "ft8");
  assertEquals((await normalized(line("DX de AC3RA:      7031.5"))).mode, "cw");
  const vhf = await normalized(line("DX de N0YO"));
  assertEquals([vhf.mode, vhf.mode_family], ["ft8", "digital"]);
  const none = await normalized("DX de DK2EA:    144174.0  IK0CHU       tnx       1318Z");
  assertEquals([none.band, none.mode, none.mode_family], ["2m", null, null]);
});

Deno.test("dxclusterAdapter.normalize skips spots older than five minutes", async () => {
  const late = new Date("2026-10-12T13:30:00Z");
  const result = await dxclusterAdapter(null).normalize(item(line("DX de HA7UL")), late);
  assertEquals(result, { kind: "skip", reason: "too_old" });
});

Deno.test("dxclusterAdapter.normalize throws on a non-spot or a missing time", async () => {
  const adapter = dxclusterAdapter(null);
  await assertRejects(() => adapter.normalize(item("Local users: 5"), NOW), Error, "not a DX");
  await assertRejects(
    () => adapter.normalize({ line: line("DX de HA7UL") }, NOW),
    Error,
    "received_at",
  );
});

Deno.test("dxclusterAdapter.parseFeed strips NULs so stored and failed items fit in jsonb", () => {
  const items = dxclusterAdapter(null).parseFeed({
    lines: [item("DX de W3LPL:  14025.0  K1\u0000ABC   up 2   1318Z"), item("Local\u0000 users")],
  });
  assertEquals(items.map((i) => i["line"]), [
    "DX de W3LPL:  14025.0  K1ABC   up 2   1318Z",
    "Local users",
  ]);
});

function fakeDb() {
  const calls = {
    ingested: [] as NormalizedSpot[][],
    success: [] as Array<[Source, number]>,
    failure: [] as Array<[Source, string]>,
  };
  const db: IngestDb = {
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
    recordSpotFailures: () => Promise.resolve(),
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

Deno.test("runDxclusterPush stores every spot of a batch in raw_spots", async () => {
  const { db, calls } = fakeDb();
  const recent = spotLines.filter((l) => /13(1[89])Z/.test(l));
  const summary = await runDxclusterPush({ lines: recent.map((l) => item(l)) }, db, NOW);
  assertEquals(summary.source, "dxcluster");
  assertEquals(summary.inserted, recent.length);
  assertEquals(calls.ingested.flat().every((s) => s.source === "dxcluster"), true);
  assertEquals(calls.success, [["dxcluster", recent.length]]);
});

Deno.test("runDxclusterPush records the heartbeat on an empty batch", async () => {
  const { db, calls } = fakeDb();
  await runDxclusterPush({ lines: [] }, db, NOW);
  assertEquals(calls.success, [["dxcluster", 0]]);
});

import { assertEquals, assertExists, assertRejects, assertThrows } from "@std/assert";
import { parseRbnLine, rbnAdapter, rbnSpotRow } from "../rbn.ts";
import { contentHash } from "../hash.ts";
import type { JsonObject } from "../types.ts";

// Fixture captured 2026-10-11 14:54-14:56Z from telnet.reversebeacon.net:7000:
// the login banner, then spot lines as RBN sent them (CR removed).
const fixture = Deno.readTextFileSync(new URL("./fixtures/rbn-telnet.txt", import.meta.url))
  .split("\n");
const spotLines = fixture.filter((l) => l.startsWith("DX de "));

const RECEIVED = "2026-10-11T14:55:30Z";
const NOW = new Date("2026-10-11T14:57:00Z");

function line(prefix: string): string {
  const found = spotLines.find((l) => l.startsWith(prefix));
  if (!found) {
    throw new Error(`fixture has no line starting ${prefix}`);
  }
  return found;
}

function item(text: string, receivedAt: string): JsonObject {
  return { line: text, received_at: receivedAt };
}

Deno.test("parseRbnLine parses every spot line in the fixture", function (): void {
  for (const l of spotLines) {
    if (parseRbnLine(l) === null) {
      throw new Error(`did not parse: ${l}`);
    }
  }
});

Deno.test("parseRbnLine returns null for the banner and prompt lines", function (): void {
  const others = fixture.filter((l) => !l.startsWith("DX de "));
  assertEquals(others.map(parseRbnLine).every((p) => p === null), true);
});

Deno.test("parseRbnLine reads the columns of a CW spot", function (): void {
  assertEquals(parseRbnLine(line("DX de SM1HEV-#")), {
    spotter: "SM1HEV",
    frequency: "14038.30",
    callsign: "CT1JGA/P",
    mode: "CW",
    snr: "8",
    speed: "24",
    speedUnit: "WPM",
    type: "CQ",
    hhmm: "1454",
  });
});

Deno.test(
  "parseRbnLine handles BPS, hyphenated skimmers, two-word types and no gap after the colon",
  function (): void {
    const rtty = parseRbnLine(line("DX de LZ7AA-#:   7043.73"));
    assertExists(rtty);
    assertEquals([rtty.mode, rtty.speedUnit], ["RTTY", "BPS"]);
    const hyphenated = parseRbnLine(line("DX de K3PA-1-#"));
    assertExists(hyphenated);
    assertEquals(hyphenated.spotter, "K3PA-1");
    const beacon = parseRbnLine(line("DX de K3GMQ-#:  21150.00"));
    assertExists(beacon);
    assertEquals(beacon.type, "NCDXF B");
    const vhf = parseRbnLine(line("DX de HA1VHF-#"));
    assertExists(vhf);
    assertEquals([vhf.frequency, vhf.callsign, vhf.type], ["144433.60", "9A0BVH", "DX"]);
  },
);

Deno.test(
  "rbnAdapter.parseFeed returns the relay's lines and rejects bad shapes",
  function (): void {
    const adapter = rbnAdapter(null);
    const items = [item(line("DX de SM1HEV-#"), RECEIVED)];
    assertEquals(adapter.parseFeed({ lines: items }), items);
    assertEquals(adapter.parseFeed({ lines: [] }), []);
    assertThrows(() => adapter.parseFeed([]));
    assertThrows(() => adapter.parseFeed({ lines: "x" }));
    assertThrows(() => adapter.parseFeed({ lines: [null] }));
    assertThrows(() => adapter.parseFeed({ lines: Array(1001).fill(items[0]) }));
  },
);

Deno.test("rbnAdapter.fetchSpots resolves to the request body", async function (): Promise<void> {
  const body = { lines: [] };
  assertEquals(await rbnAdapter(body).fetchSpots(), body);
});

Deno.test(
  "rbnAdapter.normalize maps a fixture spot to the common schema",
  async function (): Promise<void> {
    const raw = item(line("DX de SM1HEV-#"), RECEIVED);
    const result = await rbnAdapter(null).normalize(raw, NOW);
    if (result.kind !== "spot") {
      throw new Error(`expected spot, got skip ${result.reason}`);
    }
    const s = result.spot;
    assertEquals(s.source, "rbn");
    assertEquals(s.source_spot_id, "2026-10-11T14:54:00.000Z|SM1HEV|CT1JGA/P|14038.30");
    assertEquals(s.spot_time, "2026-10-11T14:54:00.000Z");
    assertEquals(s.callsign, "CT1JGA/P");
    assertEquals(s.spotter, "SM1HEV");
    assertEquals(s.frequency_khz, 14038.3);
    assertEquals(s.band, "20m");
    assertEquals(s.mode, "cw");
    assertEquals(s.mode_family, "cw");
    assertEquals(s.comment, "8 dB 24 WPM CQ");
    assertEquals(s.pota_reference, null);
    assertEquals(s.sota_summit_ref, null);
    assertEquals(s.raw_payload, raw);
  },
);

Deno.test(
  "rbnAdapter.normalize hashes the fields in the fixed order",
  async function (): Promise<void> {
    const result = await rbnAdapter(null).normalize(item(line("DX de SM1HEV-#"), RECEIVED), NOW);
    if (result.kind !== "spot") {
      throw new Error("expected spot");
    }
    assertEquals(
      result.spot.content_hash,
      await contentHash([
        "2026-10-11T14:54:00.000Z",
        "SM1HEV",
        "CT1JGA/P",
        "14038.30",
        "CW",
        "8",
        "24 WPM",
        "CQ",
      ]),
    );
  },
);

Deno.test("rbnAdapter.normalize marks RTTY as digital", async function (): Promise<void> {
  const result = await rbnAdapter(null).normalize(
    item(line("DX de LZ7AA-#:   7043.73"), RECEIVED),
    NOW,
  );
  if (result.kind !== "spot") {
    throw new Error("expected spot");
  }
  assertEquals([result.spot.mode, result.spot.mode_family], ["rtty", "digital"]);
  assertEquals(result.spot.comment, "13 dB 45 BPS CQ");
});

Deno.test(
  "rbnAdapter.normalize skips spots older than five minutes",
  async function (): Promise<void> {
    const result = await rbnAdapter(null).normalize(
      item(line("DX de SM1HEV-#"), RECEIVED),
      new Date("2026-10-11T15:00:00Z"),
    );
    assertEquals(result, { kind: "skip", reason: "too_old" });
  },
);

Deno.test(
  "rbnAdapter.normalize throws on lines it cannot process",
  async function (): Promise<void> {
    const adapter = rbnAdapter(null);
    await assertRejects(() => adapter.normalize(item("Local users: 586", RECEIVED), NOW));
    await assertRejects(() => adapter.normalize({ line: line("DX de SM1HEV-#") }, NOW));
    await assertRejects(() => adapter.normalize(item(line("DX de SM1HEV-#"), "yesterday"), NOW));
  },
);

Deno.test("rbnSpotRow maps a fixture line to an rbn_spots row", function (): void {
  const raw = item(line("DX de SM1HEV-#"), RECEIVED);
  assertEquals(rbnSpotRow(raw, NOW), {
    spot_time: "2026-10-11T14:54:00.000Z",
    received_at: "2026-10-11T14:55:30.000Z",
    spotter: "SM1HEV",
    callsign: "CT1JGA/P",
    frequency_khz: 14038.3,
    band: "20m",
    mode: "cw",
    mode_family: "cw",
    snr: 8,
    speed: 24,
    speed_unit: "WPM",
    spot_type: "CQ",
    line: line("DX de SM1HEV-#"),
  });
});

Deno.test("rbnSpotRow keeps BPS and marks RTTY digital", function (): void {
  const row = rbnSpotRow(item(line("DX de LZ7AA-#:   7043.73"), RECEIVED), NOW);
  assertEquals([row.mode, row.mode_family, row.speed, row.speed_unit], [
    "rtty",
    "digital",
    45,
    "BPS",
  ]);
});

Deno.test(
  "rbnSpotRow dates a 2359Z spot received after midnight on the previous day",
  function (): void {
    const text = "DX de W3LPL-#:  14035.10  K1ABC          CW    12 dB  22 WPM  CQ      2359Z";
    assertEquals(
      rbnSpotRow(item(text, "2026-10-12T00:00:10Z"), NOW).spot_time,
      "2026-10-11T23:59:00.000Z",
    );
  },
);

Deno.test("rbnSpotRow throws on a banner, a missing received_at or a bad one", function (): void {
  assertThrows(
    () => rbnSpotRow(item("Local users: 586", RECEIVED), NOW),
    Error,
    "not an RBN spot line",
  );
  assertThrows(() => rbnSpotRow({ line: line("DX de SM1HEV-#") }, NOW), Error, "received_at");
  assertThrows(() => rbnSpotRow(item(line("DX de SM1HEV-#"), "yesterday"), NOW));
});

Deno.test(
  "rbnSpotRow rejects values Postgres would refuse, so one line cannot fail a batch",
  function (): void {
    const big = "DX de W3LPL-#:  14035.10  K1ABC          CW  99999 dB  22 WPM  CQ      1200Z";
    assertThrows(() => rbnSpotRow(item(big, RECEIVED), NOW), Error, "snr out of range");
    const fast = "DX de W3LPL-#:  14035.10  K1ABC          CW    12 dB  70000 WPM  CQ      1200Z";
    assertThrows(() => rbnSpotRow(item(fast, RECEIVED), NOW), Error, "speed out of range");
    const nul = "DX de W3LPL-#:  14035.10  K1\u0000ABC        CW    12 dB  22 WPM  CQ      1200Z";
    assertThrows(() => rbnSpotRow(item(nul, RECEIVED), NOW), Error, "NUL");
  },
);

Deno.test(
  "rbnSpotRow rejects a lone surrogate, an implausible received_at and oversized calls",
  function (): void {
    const ok = "DX de W3LPL-#:  14035.10  K1ABC          CW    12 dB  22 WPM  CQ      1454Z";
    assertThrows(
      () => rbnSpotRow(item(ok.replace("K1ABC", "K1\ud83d"), RECEIVED), NOW),
      Error,
      "surrogate",
    );
    assertThrows(
      () => rbnSpotRow(item(ok, "+058763-01-01T00:00:00Z"), NOW),
      Error,
      "received_at out of range",
    );
    assertThrows(() => rbnSpotRow(item(ok, "2026-10-12T15:00:00Z"), NOW), Error, "out of range");
    const long = "K".repeat(3000);
    assertThrows(
      () => rbnSpotRow(item(ok.replace("K1ABC", long), RECEIVED), NOW),
      Error,
      "callsign is 3000",
    );
    assertThrows(
      () => rbnSpotRow(item(ok.replace("W3LPL", long), RECEIVED), NOW),
      Error,
      "spotter is 3000",
    );
  },
);

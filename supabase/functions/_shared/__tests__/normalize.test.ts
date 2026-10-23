import { assertEquals, assertThrows } from "@std/assert";
import {
  assertMaxLength,
  assertPlausibleTime,
  assertStorableSpot,
  cleanCallsign,
  cleanPotaComment,
  cleanPotaSpotter,
  cleanSotaComment,
  cleanSotaSpotter,
  isTestComment,
  isTooOld,
  MAX_CALLSIGN_LENGTH,
  MAX_SPOT_ID_LENGTH,
  parseKhz,
  parseUtc,
} from "../normalize.ts";
import type { NormalizedSpot } from "../types.ts";

Deno.test("cleanCallsign uppercases and removes all whitespace", function (): void {
  assertEquals(cleanCallsign(" dl/hb9jnh \t"), "DL/HB9JNH");
  assertEquals(cleanCallsign("w1 aw"), "W1AW");
});

Deno.test("cleanPotaSpotter uppercases, trims and strips a trailing -#", function (): void {
  assertEquals(cleanPotaSpotter("ok1hra-# "), "OK1HRA");
  assertEquals(cleanPotaSpotter("KJ5GKK"), "KJ5GKK");
});

Deno.test("cleanPotaSpotter returns null for missing or blank spotter", function (): void {
  assertEquals(cleanPotaSpotter(null), null);
  assertEquals(cleanPotaSpotter(undefined), null);
  assertEquals(cleanPotaSpotter("  "), null);
});

Deno.test("cleanSotaSpotter uppercases and trims", function (): void {
  assertEquals(cleanSotaSpotter(" sq1gpr ", ""), "SQ1GPR");
});

Deno.test("cleanSotaSpotter extracts the real spotter from an RBNHole comment", function (): void {
  assertEquals(cleanSotaSpotter("RBNHOLE", "[RBNHole] at DL1HWS 21 WPM 23 dB SNR"), "DL1HWS");
  assertEquals(cleanSotaSpotter("RBNHOLE", "[RBNHole] at WX7V/5 13 WPM 15 dB SNR"), "WX7V/5");
});

Deno.test(
  "cleanSotaSpotter uppercases the RBNHole spotter and accepts it at the end of the comment",
  function (): void {
    assertEquals(cleanSotaSpotter("RBNHOLE", "[RBNHole] at dl1hws 21 WPM 23 dB SNR"), "DL1HWS");
    assertEquals(cleanSotaSpotter("RBNHOLE", "[RBNHole] at DL1HWS"), "DL1HWS");
  },
);

Deno.test(
  "cleanSotaSpotter returns null for an RBNHole spot whose comment names no skimmer",
  function (): void {
    // RBNHOLE is the relay bot, not a station; storing it would count it as a chaser.
    assertEquals(cleanSotaSpotter("RBNHOLE", "something else"), null);
    assertEquals(cleanSotaSpotter("rbnhole", ""), null);
  },
);

Deno.test("cleanPotaComment trims and maps null to empty string", function (): void {
  assertEquals(cleanPotaComment("  55 LA "), "55 LA");
  assertEquals(cleanPotaComment(null), "");
});

Deno.test("cleanSotaComment strips a leading '. ' or '*' and trims", function (): void {
  assertEquals(cleanSotaComment(". hello"), "hello");
  assertEquals(cleanSotaComment("*hello "), "hello");
  assertEquals(cleanSotaComment("  plain  "), "plain");
});

Deno.test("cleanSotaComment maps '(null)' and null to empty string", function (): void {
  assertEquals(cleanSotaComment("(null)"), "");
  assertEquals(cleanSotaComment(null), "");
});

Deno.test("isTestComment matches the word test or testing, case-insensitively", function (): void {
  assertEquals(isTestComment("just a TEST"), true);
  assertEquals(isTestComment("Testing 123"), true);
  assertEquals(isTestComment("contest station"), false);
  assertEquals(isTestComment("55 LA"), false);
});

Deno.test("parseKhz accepts a kHz string and rounds to 3 decimals", function (): void {
  assertEquals(parseKhz("14074.0", "khz"), 14074);
  assertEquals(parseKhz("10123.9", "khz"), 10123.9);
  assertEquals(parseKhz("7030.12345", "khz"), 7030.123);
});

Deno.test("parseKhz converts a MHz number to kHz", function (): void {
  assertEquals(parseKhz(7.097, "mhz"), 7097);
  assertEquals(parseKhz(28.42, "mhz"), 28420);
  assertEquals(parseKhz(144.305, "mhz"), 144305);
});

Deno.test("parseKhz throws on missing, non-numeric or non-positive input", function (): void {
  assertThrows(() => parseKhz(null, "mhz"));
  assertThrows(() => parseKhz("abc", "khz"));
  assertThrows(() => parseKhz(0, "khz"));
  assertThrows(() => parseKhz(-7, "mhz"));
});

Deno.test("parseKhz rejects frequencies the database cannot store", function (): void {
  // raw_spots.frequency_khz is numeric(12,3): anything from 1e9 kHz up overflows it.
  assertThrows(() => parseKhz("1234567890123", "khz"));
  assertThrows(() => parseKhz(1e6, "mhz"));
  assertEquals(parseKhz(999999999.999, "khz"), 999999999.999);
});

Deno.test("parseUtc treats a timestamp without offset as UTC", function (): void {
  assertEquals(parseUtc("2026-10-05T13:37:03").toISOString(), "2026-10-05T13:37:03.000Z");
});

Deno.test("parseUtc keeps an explicit offset", function (): void {
  assertEquals(parseUtc("2026-10-05T13:43:07.025770Z").toISOString(), "2026-10-05T13:43:07.025Z");
  assertEquals(parseUtc("2026-10-05T15:00:00+02:00").toISOString(), "2026-10-05T13:00:00.000Z");
});

Deno.test("parseUtc throws on missing or unparseable input", function (): void {
  assertThrows(() => parseUtc(null));
  assertThrows(() => parseUtc("not a date"));
});

Deno.test("isTooOld compares spot time to now with a max age", function (): void {
  const now = new Date("2026-10-05T13:50:00Z");
  const fiveMin = 5 * 60 * 1000;
  assertEquals(isTooOld(new Date("2026-10-05T13:44:59Z"), now, fiveMin), true);
  assertEquals(isTooOld(new Date("2026-10-05T13:45:01Z"), now, fiveMin), false);
  assertEquals(isTooOld(new Date("2026-10-05T13:55:00Z"), now, fiveMin), false);
});

Deno.test("assertMaxLength allows the limit and throws past it", function (): void {
  assertMaxLength("x".repeat(4), 4, "callsign");
  assertThrows(() => assertMaxLength("x".repeat(5), 4, "callsign"), Error, "callsign is 5");
});

Deno.test(
  "assertPlausibleTime allows up to a day ahead and refuses later, earlier than 2000 or invalid",
  function (): void {
    const now = new Date("2026-10-15T18:28:00Z");
    assertPlausibleTime(new Date("2026-10-16T18:28:00Z"), now, "spot time");
    assertPlausibleTime(new Date("2000-01-01T00:00:00Z"), now, "spot time");
    // A milliseconds value read as seconds: year 58763.
    assertThrows(
      () => assertPlausibleTime(new Date(1792238400000 * 1000), now, "spot time"),
      Error,
      "spot time out of range: +058763",
    );
    assertThrows(
      () => assertPlausibleTime(new Date("2026-10-16T18:28:01Z"), now, "x"),
      Error,
      "x out of range",
    );
    assertThrows(
      () => assertPlausibleTime(new Date("1999-12-31T23:59:59Z"), now, "x"),
      Error,
      "out of range",
    );
    assertThrows(() => assertPlausibleTime(new Date(Number.NaN), now, "x"), Error, "invalid");
  },
);

Deno.test("assertStorableSpot bounds the time, id, calls and references", function (): void {
  const now = new Date("2026-10-05T13:41:00Z");
  const spot: NormalizedSpot = {
    source: "pota",
    source_spot_id: "1",
    content_hash: "h".repeat(64),
    spot_time: now.toISOString(),
    callsign: "W1AW",
    spotter: null,
    frequency_khz: 14074,
    band: "20m",
    mode: "ft8",
    mode_family: "digital",
    comment: "x".repeat(5000),
    pota_reference: "US-0001",
    pota_park_name: null,
    pota_location: null,
    sota_summit_ref: null,
    wwff_reference: null,
    wwff_reference_name: null,
    raw_payload: {},
  };
  assertStorableSpot(spot, now);
  const long = "W".repeat(MAX_CALLSIGN_LENGTH + 1);
  const cases: [Partial<NormalizedSpot>, string][] = [
    [{ spot_time: "2026-10-07T00:00:00.000Z" }, "spot time out of range"],
    [{ source_spot_id: "1".repeat(MAX_SPOT_ID_LENGTH + 1) }, "source_spot_id is"],
    [{ callsign: long }, "callsign is"],
    [{ spotter: long }, "spotter is"],
    [{ pota_reference: long }, "pota_reference is"],
    [{ sota_summit_ref: long }, "sota_summit_ref is"],
    [{ wwff_reference: long }, "wwff_reference is"],
  ];
  for (const testCase of cases) {
    const changed = Object.assign({}, spot, testCase[0]);
    assertThrows(() => assertStorableSpot(changed, now), Error, testCase[1]);
  }
});

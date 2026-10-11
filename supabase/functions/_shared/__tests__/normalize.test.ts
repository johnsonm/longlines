import { assertEquals, assertThrows } from "@std/assert";
import {
  cleanCallsign,
  cleanPotaComment,
  cleanPotaSpotter,
  cleanSotaComment,
  cleanSotaSpotter,
  isTestComment,
  isTooOld,
  parseKhz,
  parseUtc,
} from "../normalize.ts";

Deno.test("cleanCallsign uppercases and removes all whitespace", () => {
  assertEquals(cleanCallsign(" dl/hb9jnh \t"), "DL/HB9JNH");
  assertEquals(cleanCallsign("w1 aw"), "W1AW");
});

Deno.test("cleanPotaSpotter uppercases, trims and strips a trailing -#", () => {
  assertEquals(cleanPotaSpotter("ok1hra-# "), "OK1HRA");
  assertEquals(cleanPotaSpotter("KJ5GKK"), "KJ5GKK");
});

Deno.test("cleanPotaSpotter returns null for missing or blank spotter", () => {
  assertEquals(cleanPotaSpotter(null), null);
  assertEquals(cleanPotaSpotter(undefined), null);
  assertEquals(cleanPotaSpotter("  "), null);
});

Deno.test("cleanSotaSpotter uppercases and trims", () => {
  assertEquals(cleanSotaSpotter(" sq1gpr ", ""), "SQ1GPR");
});

Deno.test("cleanSotaSpotter extracts the real spotter from an RBNHole comment", () => {
  assertEquals(cleanSotaSpotter("RBNHOLE", "[RBNHole] at DL1HWS 21 WPM 23 dB SNR"), "DL1HWS");
  assertEquals(cleanSotaSpotter("RBNHOLE", "[RBNHole] at WX7V/5 13 WPM 15 dB SNR"), "WX7V/5");
});

Deno.test("cleanSotaSpotter uppercases the RBNHole spotter and accepts it at the end of the comment", () => {
  assertEquals(cleanSotaSpotter("RBNHOLE", "[RBNHole] at dl1hws 21 WPM 23 dB SNR"), "DL1HWS");
  assertEquals(cleanSotaSpotter("RBNHOLE", "[RBNHole] at DL1HWS"), "DL1HWS");
});

Deno.test("cleanSotaSpotter returns null for an RBNHole spot whose comment names no skimmer", () => {
  // RBNHOLE is the relay bot, not a station; storing it would count it as a chaser.
  assertEquals(cleanSotaSpotter("RBNHOLE", "something else"), null);
  assertEquals(cleanSotaSpotter("rbnhole", ""), null);
});

Deno.test("cleanPotaComment trims and maps null to empty string", () => {
  assertEquals(cleanPotaComment("  55 LA "), "55 LA");
  assertEquals(cleanPotaComment(null), "");
});

Deno.test("cleanSotaComment strips a leading '. ' or '*' and trims", () => {
  assertEquals(cleanSotaComment(". hello"), "hello");
  assertEquals(cleanSotaComment("*hello "), "hello");
  assertEquals(cleanSotaComment("  plain  "), "plain");
});

Deno.test("cleanSotaComment maps '(null)' and null to empty string", () => {
  assertEquals(cleanSotaComment("(null)"), "");
  assertEquals(cleanSotaComment(null), "");
});

Deno.test("isTestComment matches the word test or testing, case-insensitively", () => {
  assertEquals(isTestComment("just a TEST"), true);
  assertEquals(isTestComment("Testing 123"), true);
  assertEquals(isTestComment("contest station"), false);
  assertEquals(isTestComment("55 LA"), false);
});

Deno.test("parseKhz accepts a kHz string and rounds to 3 decimals", () => {
  assertEquals(parseKhz("14074.0", "khz"), 14074);
  assertEquals(parseKhz("10123.9", "khz"), 10123.9);
  assertEquals(parseKhz("7030.12345", "khz"), 7030.123);
});

Deno.test("parseKhz converts a MHz number to kHz", () => {
  assertEquals(parseKhz(7.097, "mhz"), 7097);
  assertEquals(parseKhz(28.42, "mhz"), 28420);
  assertEquals(parseKhz(144.305, "mhz"), 144305);
});

Deno.test("parseKhz throws on missing, non-numeric or non-positive input", () => {
  assertThrows(() => parseKhz(null, "mhz"));
  assertThrows(() => parseKhz("abc", "khz"));
  assertThrows(() => parseKhz(0, "khz"));
  assertThrows(() => parseKhz(-7, "mhz"));
});

Deno.test("parseKhz rejects frequencies the database cannot store", () => {
  // raw_spots.frequency_khz is numeric(12,3): anything from 1e9 kHz up overflows it.
  assertThrows(() => parseKhz("1234567890123", "khz"));
  assertThrows(() => parseKhz(1e6, "mhz"));
  assertEquals(parseKhz(999999999.999, "khz"), 999999999.999);
});

Deno.test("parseUtc treats a timestamp without offset as UTC", () => {
  assertEquals(parseUtc("2026-10-05T13:37:03").toISOString(), "2026-10-05T13:37:03.000Z");
});

Deno.test("parseUtc keeps an explicit offset", () => {
  assertEquals(parseUtc("2026-10-05T13:43:07.025770Z").toISOString(), "2026-10-05T13:43:07.025Z");
  assertEquals(parseUtc("2026-10-05T15:00:00+02:00").toISOString(), "2026-10-05T13:00:00.000Z");
});

Deno.test("parseUtc throws on missing or unparseable input", () => {
  assertThrows(() => parseUtc(null));
  assertThrows(() => parseUtc("not a date"));
});

Deno.test("isTooOld compares spot time to now with a max age", () => {
  const now = new Date("2026-10-05T13:50:00Z");
  const fiveMin = 5 * 60 * 1000;
  assertEquals(isTooOld(new Date("2026-10-05T13:44:59Z"), now, fiveMin), true);
  assertEquals(isTooOld(new Date("2026-10-05T13:45:01Z"), now, fiveMin), false);
  assertEquals(isTooOld(new Date("2026-10-05T13:55:00Z"), now, fiveMin), false);
});

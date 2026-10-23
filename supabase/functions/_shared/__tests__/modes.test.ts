import { assertEquals } from "@std/assert";
import {
  canonicalMode,
  modeFamily,
  modeFromComment,
  modeFromFrequency,
  modeHintFromComment,
  resolveDxMode,
  resolveMode,
} from "../modes.ts";

Deno.test("canonicalMode lowercases, trims and removes spaces and hyphens", function (): void {
  assertEquals(canonicalMode(" CW "), "cw");
  assertEquals(canonicalMode("FT-8"), "ft8");
  assertEquals(canonicalMode("PSK 31"), "psk31");
});

Deno.test("canonicalMode keeps generic labels as-is", function (): void {
  assertEquals(canonicalMode("DATA"), "data");
});

Deno.test("canonicalMode returns null for missing or blank input", function (): void {
  assertEquals(canonicalMode(""), null);
  assertEquals(canonicalMode("  "), null);
  assertEquals(canonicalMode(null), null);
  assertEquals(canonicalMode(undefined), null);
});

Deno.test("modeHintFromComment finds a specific digital mode named in the comment", function (): void {
  assertEquals(modeHintFromComment("FT8 QRP"), "ft8");
  assertEquals(modeHintFromComment("[SOTA Activator] ft-8 now"), "ft8");
  assertEquals(modeHintFromComment("trying PSK31 then RTTY"), "psk31");
  assertEquals(modeHintFromComment("JS8Call tonight"), null);
});

Deno.test("modeHintFromComment returns null when nothing is named", function (): void {
  assertEquals(modeHintFromComment("cq POTA"), null);
  assertEquals(modeHintFromComment(""), null);
});

Deno.test("resolveMode replaces a generic digital label with the comment hint", function (): void {
  assertEquals(resolveMode("DATA", "FT8 QRP"), "ft8");
  assertEquals(resolveMode("DIGI", "ft4 on 14.080"), "ft4");
});

Deno.test("resolveMode keeps a generic label when the comment has no hint", function (): void {
  assertEquals(resolveMode("DATA", "[SOTA Activator] QRP"), "data");
});

Deno.test("resolveMode fills a blank mode from the comment hint", function (): void {
  assertEquals(resolveMode("", "FT8"), "ft8");
  assertEquals(resolveMode(null, "cq POTA"), null);
});

Deno.test("resolveMode never overrides an explicit specific mode", function (): void {
  assertEquals(resolveMode("SSB", "FT8 later"), "ssb");
  assertEquals(resolveMode("FT4", "was on FT8"), "ft4");
});

Deno.test("resolveMode folds USB and LSB to ssb", function (): void {
  assertEquals(resolveMode("USB", ""), "ssb");
  assertEquals(resolveMode("lsb", "FT8 later"), "ssb");
  assertEquals(resolveMode("SSB", ""), "ssb");
});

Deno.test("modeFamily classifies cw, phone and digital modes", function (): void {
  assertEquals(modeFamily("cw"), "cw");
  assertEquals(modeFamily("ssb"), "phone");
  assertEquals(modeFamily("fm"), "phone");
  assertEquals(modeFamily("am"), "phone");
  assertEquals(modeFamily("ft8"), "digital");
  assertEquals(modeFamily("ft4"), "digital");
  assertEquals(modeFamily("data"), "digital");
  assertEquals(modeFamily("rtty"), "digital");
  assertEquals(modeFamily("psk31"), "digital");
});

Deno.test("modeFamily returns null for unknown or missing modes", function (): void {
  assertEquals(modeFamily("other"), null);
  assertEquals(modeFamily(null), null);
});

Deno.test("modeFromComment finds CW, SSB and digital modes, sideband as ssb", function (): void {
  assertEquals(modeFromComment("FT8 -19dB from JN18 1524Hz"), "ft8");
  assertEquals(modeFromComment("SSB [POTA] GR-0131 cq cq"), "ssb");
  assertEquals(modeFromComment("up 2 cw"), "cw");
  assertEquals(modeFromComment("USB pse QSY"), "ssb");
  assertEquals(modeFromComment("WSPR sign -26"), "wspr");
  assertEquals(modeFromComment("73 from Gabriele - FT-8"), "ft8");
  assertEquals(modeFromComment("D-STAR ref 001"), "dstar");
  assertEquals(modeFromComment("PSK31 tnx"), "psk31");
});

Deno.test("modeFromComment ignores callsigns, locators and fm/am as words", function (): void {
  assertEquals(modeFromComment("CROTA HU-BCS-003"), null);
  assertEquals(modeFromComment("tnx fm Italy, I am qrv"), null);
  assertEquals(modeFromComment("JO50UF<>IM98PB 1004Hz CQ -8"), null);
  assertEquals(modeFromComment(""), null);
});

Deno.test("modeFromFrequency puts FT8 and FT4 dial windows ahead of the segments", function (): void {
  assertEquals(modeFromFrequency(14074), "ft8");
  assertEquals(modeFromFrequency(14076.9), "ft8");
  assertEquals(modeFromFrequency(14077), null);
  assertEquals(modeFromFrequency(24915.8), "ft8");
  assertEquals(modeFromFrequency(7047.5), "ft4");
  assertEquals(modeFromFrequency(3575.5), "ft4");
  assertEquals(modeFromFrequency(3573.5), "ft8");
  assertEquals(modeFromFrequency(50313), "ft8");
});

Deno.test("modeFromFrequency reads the CW and phone segments and leaves gaps unknown", function (): void {
  assertEquals(modeFromFrequency(14025), "cw");
  assertEquals(modeFromFrequency(7031.5), "cw");
  assertEquals(modeFromFrequency(14238), "ssb");
  assertEquals(modeFromFrequency(7146), "ssb");
  assertEquals(modeFromFrequency(28450), "ssb");
  assertEquals(modeFromFrequency(29600), "fm");
  assertEquals(modeFromFrequency(14095.6), null);
  assertEquals(modeFromFrequency(5357.5), "ft8");
  assertEquals(modeFromFrequency(5403.5), null);
  assertEquals(modeFromFrequency(144200), null);
});

Deno.test("resolveDxMode prefers the comment over the band plan", function (): void {
  assertEquals(resolveDxMode("FT8", 14025), "ft8");
  assertEquals(resolveDxMode("cq dx", 14025), "cw");
  assertEquals(resolveDxMode("", 144200), null);
});

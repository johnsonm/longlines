import { assertEquals } from "@std/assert";
import { bandForFrequency, BANDS } from "../bands.ts";

Deno.test("bandForFrequency maps a mid-band frequency", function (): void {
  assertEquals(bandForFrequency(14074), "20m");
});

Deno.test("bandForFrequency includes both band edges", function (): void {
  assertEquals(bandForFrequency(14000), "20m");
  assertEquals(bandForFrequency(14500), "20m");
});

Deno.test("bandForFrequency returns null just outside a band", function (): void {
  assertEquals(bandForFrequency(14501), null);
  assertEquals(bandForFrequency(13999.999), null);
});

Deno.test("bandForFrequency returns null below and above all bands", function (): void {
  assertEquals(bandForFrequency(0), null);
  assertEquals(bandForFrequency(99_999_999), null);
});

Deno.test("bandForFrequency prefers 3cm_qo100 over 3cm in the overlap", function (): void {
  assertEquals(bandForFrequency(10489700), "3cm_qo100");
  assertEquals(bandForFrequency(10368100), "3cm");
});

Deno.test("BANDS lists 3cm_qo100 before 3cm", function (): void {
  const names = BANDS.map((b) => b.band);
  const qo100 = names.indexOf("3cm_qo100");
  const threeCm = names.indexOf("3cm");
  assertEquals(qo100 >= 0 && threeCm > qo100, true);
});

Deno.test("goal_bands() in SQL lists BANDS' names in order", function (): void {
  const sql = Deno.readTextFileSync(
    new URL("../../../migrations/20261029001100_goals.sql", import.meta.url),
  );
  const body = /function public\.goal_bands\(\)[\s\S]*?array\[([^\]]*)\]/.exec(sql);
  if (body === null || body[1] === undefined) {
    throw new Error("the migration defines no goal_bands()");
  }
  const names = Array.from(body[1].matchAll(/'([^']+)'/g)).map((m) => m[1]);
  assertEquals(names, BANDS.map((b) => b.band));
});

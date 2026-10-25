import { assertEquals, assertRejects, assertStrictEquals, assertThrows } from "@std/assert";
import { ValidationError } from "../errors.ts";
import { pota } from "../pota.ts";
import { contentHash } from "../hash.ts";
import type { JsonObject } from "../types.ts";

const fixture = JSON.parse(
  Deno.readTextFileSync(new URL("./fixtures/pota-activator.json", import.meta.url)),
) as JsonObject[];

// Fixture captured 2026-10-05 ~13:45Z; spot times range 13:16 to 13:44. Five-minute window from NOW.
const NOW = new Date("2026-10-05T13:41:00Z");

function spot(id: number): JsonObject {
  const found = fixture.find((s) => s["spotId"] === id);
  if (!found) {
    throw new Error(`fixture has no spotId ${id}`);
  }
  return found;
}

Deno.test("pota.parseFeed returns the array as-is", function (): void {
  assertEquals(pota.parseFeed(fixture).length, 5);
});

Deno.test("pota.parseFeed throws when the body is not an array of objects", function (): void {
  assertThrows(() => pota.parseFeed({ error: "nope" }), ValidationError, "pota.parseFeed: feed");
  assertThrows(() => pota.parseFeed([1, 2]), ValidationError, "0: expected an object");
  assertThrows(() => pota.parseFeed([[]]), ValidationError);
});

Deno.test("pota.parseFeed returns the items themselves, not copies", function (): void {
  const items = pota.parseFeed(fixture);
  assertStrictEquals(items[0], fixture[0]);
});

Deno.test(
  "pota.normalize maps a fixture spot to the common schema",
  async function (): Promise<void> {
    const raw = spot(58161241);
    const result = await pota.normalize(raw, NOW);
    if (result.kind !== "spot") {
      throw new Error(`expected spot, got skip ${result.reason}`);
    }
    const s = result.spot;
    assertEquals(s.source, "pota");
    assertEquals(s.source_spot_id, "58161241");
    assertEquals(s.spot_time, "2026-10-05T13:37:03.000Z");
    assertEquals(s.callsign, "DL/HB9JNH");
    assertEquals(s.spotter, "OK1HRA");
    assertEquals(s.frequency_khz, 10123.9);
    assertEquals(s.band, "30m");
    assertEquals(s.mode, "cw");
    assertEquals(s.mode_family, "cw");
    assertEquals(s.comment, "RBN 22 dB 19 WPM via OK1HRA-#");
    assertEquals(s.pota_reference, "DE-0858");
    assertEquals(s.pota_park_name, "Via Sancti Martini National Historic Trail");
    assertEquals(s.pota_location, "DE-BW,DE-BY,DE-RP,DE-SL");
    assertEquals(s.sota_summit_ref, null);
    assertEquals(s.raw_payload, raw);
  },
);

Deno.test(
  "pota.normalize hashes spotTime, activator, reference, frequency, mode, comments",
  async function (): Promise<void> {
    const raw = spot(58161562);
    const result = await pota.normalize(raw, NOW);
    if (result.kind !== "spot") {
      throw new Error("expected spot");
    }
    assertEquals(
      result.spot.content_hash,
      await contentHash([
        raw["spotTime"],
        raw["activator"],
        raw["reference"],
        raw["frequency"],
        raw["mode"],
        raw["comments"],
      ]),
    );
  },
);

Deno.test(
  "pota.normalize stores a null mode and family when upstream mode is blank",
  async function (): Promise<void> {
    const result = await pota.normalize(Object.assign({}, spot(58161562), { mode: "" }), NOW);
    if (result.kind !== "spot") {
      throw new Error("expected spot");
    }
    assertEquals(result.spot.mode, null);
    assertEquals(result.spot.mode_family, null);
  },
);

Deno.test(
  "pota.normalize stores USB as ssb but hashes the upstream USB",
  async function (): Promise<void> {
    const raw: JsonObject = Object.assign({}, spot(58161562), { mode: "USB" });
    const result = await pota.normalize(raw, NOW);
    if (result.kind !== "spot") {
      throw new Error("expected spot");
    }
    assertEquals([result.spot.mode, result.spot.mode_family], ["ssb", "phone"]);
    assertEquals(
      result.spot.content_hash,
      await contentHash([
        raw["spotTime"],
        raw["activator"],
        raw["reference"],
        raw["frequency"],
        "USB",
        raw["comments"],
      ]),
    );
  },
);

Deno.test(
  "pota.normalize takes the mode from the comment when upstream mode is blank",
  async function (): Promise<void> {
    const result = await pota.normalize(
      Object.assign({}, spot(58161562), { mode: "", comments: "FT8 QRP" }),
      NOW,
    );
    if (result.kind !== "spot") {
      throw new Error("expected spot");
    }
    assertEquals(result.spot.mode, "ft8");
    assertEquals(result.spot.mode_family, "digital");
  },
);

Deno.test("pota.normalize skips spots older than five minutes", async function (): Promise<void> {
  assertEquals(await pota.normalize(spot(58159728), NOW), { kind: "skip", reason: "too_old" });
});

Deno.test("pota.normalize skips test spots", async function (): Promise<void> {
  const raw = Object.assign({}, spot(58161562), { comments: "just testing" });
  assertEquals(await pota.normalize(raw, NOW), { kind: "skip", reason: "test_comment" });
});

Deno.test(
  "pota.normalize stores an empty comment when upstream sends null",
  async function (): Promise<void> {
    const raw = Object.assign({}, spot(58161562), { comments: null });
    const result = await pota.normalize(raw, NOW);
    if (result.kind !== "spot") {
      throw new Error("expected spot");
    }
    assertEquals(result.spot.comment, "");
  },
);

Deno.test("pota.normalize leaves band null outside known bands", async function (): Promise<void> {
  const raw = Object.assign({}, spot(58161562), { frequency: "13999.0" });
  const result = await pota.normalize(raw, NOW);
  if (result.kind !== "spot") {
    throw new Error("expected spot");
  }
  assertEquals(result.spot.band, null);
});

Deno.test("pota.normalize rejects a spot with no activator", async function (): Promise<void> {
  const error = await assertRejects(
    () => pota.normalize(Object.assign({}, spot(58161562), { activator: null }), NOW),
    ValidationError,
    "pota.normalize: spot: activator",
  );
  assertEquals(error.where, "pota.normalize: spot");
});

Deno.test(
  "pota.normalize stores the raw item as raw_payload, own __proto__ key included",
  async function (): Promise<void> {
    const raw: JsonObject = JSON.parse(
      JSON.stringify(spot(58161562)).replace("{", '{"__proto__":{"x":1},'),
    );
    const result = await pota.normalize(raw, NOW);
    if (result.kind !== "spot") {
      throw new Error("expected spot");
    }
    assertStrictEquals(result.spot.raw_payload, raw);
    assertEquals(Object.keys(result.spot.raw_payload)[0], "__proto__");
  },
);

Deno.test(
  "pota.normalize reads a non-string optional field as absent, as before",
  async function (): Promise<void> {
    const raw = Object.assign({}, spot(58161562), { comments: 73, name: false, spotter: 5 });
    const result = await pota.normalize(raw, NOW);
    if (result.kind !== "spot") {
      throw new Error("expected spot");
    }
    assertEquals([result.spot.comment, result.spot.pota_park_name, result.spot.spotter], [
      "",
      null,
      null,
    ]);
  },
);

Deno.test(
  "pota.normalize rejects a spot with a malformed frequency",
  async function (): Promise<void> {
    await assertRejects(() =>
      pota.normalize(Object.assign({}, spot(58161562), { frequency: "lots" }), NOW)
    );
  },
);

Deno.test("pota.normalize rejects a spot with no spotId", async function (): Promise<void> {
  await assertRejects(() =>
    pota.normalize(Object.assign({}, spot(58161562), { spotId: undefined }), NOW)
  );
});

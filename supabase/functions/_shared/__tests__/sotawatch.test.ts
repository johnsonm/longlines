import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { sotawatch } from "../sotawatch.ts";
import { contentHash } from "../hash.ts";
import type { JsonObject } from "../types.ts";

const fixture = JSON.parse(
  Deno.readTextFileSync(new URL("./fixtures/sotawatch-spots.json", import.meta.url)),
) as JsonObject[];

// Fixture captured 2026-10-05 ~13:45Z; spot times range 12:15 to 13:43. Five-minute window from NOW.
const NOW = new Date("2026-10-05T13:44:00Z");

function spot(id: number): JsonObject {
  const found = fixture.find((s) => s["id"] === id);
  if (!found) {
    throw new Error(`fixture has no id ${id}`);
  }
  return found;
}

Deno.test("sotawatch.parseFeed sorts spots by id ascending", function (): void {
  assertEquals(
    sotawatch.parseFeed(fixture).map((s) => s["id"]),
    [405105, 405146, 405153, 405155, 405156, 405157],
  );
});

Deno.test("sotawatch.parseFeed throws when the body is not an array of objects", function (): void {
  assertThrows(() => sotawatch.parseFeed("<html>"));
  assertThrows(() => sotawatch.parseFeed([null]));
});

Deno.test(
  "sotawatch.normalize maps a fixture spot to the common schema",
  async function (): Promise<void> {
    const raw = spot(405157);
    const result = await sotawatch.normalize(raw, NOW);
    if (result.kind !== "spot") {
      throw new Error(`expected spot, got skip ${result.reason}`);
    }
    const s = result.spot;
    assertEquals(s.source, "sotawatch");
    assertEquals(s.source_spot_id, "405157");
    assertEquals(s.spot_time, "2026-10-05T13:43:07.025Z");
    assertEquals(s.callsign, "SQ1GPR/P");
    assertEquals(s.spotter, "SQ1GPR");
    assertEquals(s.frequency_khz, 7097);
    assertEquals(s.band, "40m");
    assertEquals(s.mode, "ssb");
    assertEquals(s.mode_family, "phone");
    assertEquals(s.comment, "[sotl.as]");
    assertEquals(s.sota_summit_ref, "SP/SS-004");
    assertEquals(s.pota_reference, null);
    assertEquals(s.pota_park_name, null);
    assertEquals(s.pota_location, null);
    assertEquals(s.raw_payload, raw);
  },
);

Deno.test(
  "sotawatch.normalize hashes timeStamp, activatorCallsign, summitCode, frequency, mode, comments",
  async function (): Promise<void> {
    const raw = spot(405156);
    const result = await sotawatch.normalize(raw, NOW);
    if (result.kind !== "spot") {
      throw new Error("expected spot");
    }
    assertEquals(
      result.spot.content_hash,
      await contentHash([
        raw["timeStamp"],
        raw["activatorCallsign"],
        raw["summitCode"],
        raw["frequency"],
        raw["mode"],
        raw["comments"],
      ]),
    );
  },
);

Deno.test(
  "sotawatch.normalize keeps DATA as a digital-family mode",
  async function (): Promise<void> {
    const result = await sotawatch.normalize(
      Object.assign({}, spot(405157), { mode: "DATA", comments: "QRP" }),
      NOW,
    );
    if (result.kind !== "spot") {
      throw new Error("expected spot");
    }
    assertEquals(result.spot.mode, "data");
    assertEquals(result.spot.mode_family, "digital");
  },
);

Deno.test(
  "sotawatch.normalize resolves DATA to the mode named in the comment",
  async function (): Promise<void> {
    const result = await sotawatch.normalize(
      Object.assign({}, spot(405157), { mode: "DATA", comments: "FT8 QRP" }),
      NOW,
    );
    if (result.kind !== "spot") {
      throw new Error("expected spot");
    }
    assertEquals(result.spot.mode, "ft8");
    assertEquals(result.spot.mode_family, "digital");
  },
);

Deno.test(
  "sotawatch.normalize extracts the spotter from RBNHole comments and accepts null type",
  async function (): Promise<void> {
    const result = await sotawatch.normalize(spot(405155), NOW);
    if (result.kind !== "spot") {
      throw new Error("expected spot");
    }
    assertEquals(result.spot.spotter, "DL1HWS");
    assertEquals(result.spot.frequency_khz, 10118);
    assertEquals(result.spot.band, "30m");
  },
);

Deno.test(
  "sotawatch.normalize stores an empty comment when upstream sends null",
  async function (): Promise<void> {
    const result = await sotawatch.normalize(spot(405153), NOW);
    if (result.kind !== "spot") {
      throw new Error("expected spot");
    }
    assertEquals(result.spot.comment, "");
  },
);

Deno.test(
  "sotawatch.normalize skips spots older than five minutes",
  async function (): Promise<void> {
    assertEquals(await sotawatch.normalize(spot(405105), NOW), { kind: "skip", reason: "too_old" });
  },
);

Deno.test(
  "sotawatch.normalize skips non-NORMAL spots before touching other fields",
  async function (): Promise<void> {
    // The QRT fixture spot has frequency null; the type check must come first.
    const now = new Date("2026-10-05T13:26:00Z");
    assertEquals(await sotawatch.normalize(spot(405146), now), {
      kind: "skip",
      reason: "not_normal",
    });
  },
);

Deno.test("sotawatch.normalize skips test spots", async function (): Promise<void> {
  const raw = Object.assign({}, spot(405157), { comments: ". TEST spot" });
  assertEquals(await sotawatch.normalize(raw, NOW), { kind: "skip", reason: "test_comment" });
});

Deno.test(
  "sotawatch.normalize cleans comment prefixes and the literal (null)",
  async function (): Promise<void> {
    const a = await sotawatch.normalize(
      Object.assign({}, spot(405157), { comments: "*hello" }),
      NOW,
    );
    const b = await sotawatch.normalize(
      Object.assign({}, spot(405157), { comments: "(null)" }),
      NOW,
    );
    if (a.kind !== "spot" || b.kind !== "spot") {
      throw new Error("expected spots");
    }
    assertEquals(a.spot.comment, "hello");
    assertEquals(b.spot.comment, "");
  },
);

Deno.test(
  "sotawatch.normalize rejects a spot with no activatorCallsign",
  async function (): Promise<void> {
    await assertRejects(() =>
      sotawatch.normalize(Object.assign({}, spot(405157), { activatorCallsign: "" }), NOW)
    );
  },
);

Deno.test(
  "sotawatch.normalize rejects a NORMAL spot with a null frequency",
  async function (): Promise<void> {
    await assertRejects(() =>
      sotawatch.normalize(Object.assign({}, spot(405157), { frequency: null }), NOW)
    );
  },
);

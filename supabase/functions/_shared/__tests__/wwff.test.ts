import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { ValidationError } from "../errors.ts";
import { wwff } from "../wwff.ts";
import { contentHash } from "../hash.ts";
import type { JsonObject } from "../types.ts";

const fixture = JSON.parse(
  Deno.readTextFileSync(new URL("./fixtures/wwff-spots.json", import.meta.url)),
) as JsonObject[];

// Fixture captured 2026-10-15 ~18:27Z; spot times range 17:33 to 18:27. Five-minute window from NOW
// keeps 157369, 157368 and 157367.
const NOW = new Date("2026-10-15T18:28:00Z");

function spot(id: number): JsonObject {
  const found = fixture.find((s) => s["id"] === id);
  if (!found) {
    throw new Error(`fixture has no id ${id}`);
  }
  return found;
}

Deno.test("wwff.parseFeed returns the array as-is", function (): void {
  assertEquals(wwff.parseFeed(fixture).length, 7);
});

Deno.test("wwff.parseFeed throws when the body is not an array of objects", function (): void {
  assertThrows(() => wwff.parseFeed({ error: "nope" }), ValidationError, "wwff.parseFeed: feed");
  assertThrows(() => wwff.parseFeed([1, 2]), ValidationError);
});

Deno.test(
  "wwff.normalize maps a fixture spot to the common schema",
  async function (): Promise<void> {
    const raw = spot(157368);
    const result = await wwff.normalize(raw, NOW);
    if (result.kind !== "spot") {
      throw new Error(`expected spot, got skip ${result.reason}`);
    }
    const s = result.spot;
    assertEquals(s.source, "wwff");
    assertEquals(s.source_spot_id, "157368");
    assertEquals(s.spot_time, "2026-10-15T18:25:38.000Z");
    assertEquals(s.callsign, "W3O");
    assertEquals(s.spotter, "WA7LNW");
    assertEquals(s.frequency_khz, 14045.4);
    assertEquals(s.band, "20m");
    assertEquals(s.mode, "cw");
    assertEquals(s.mode_family, "cw");
    assertEquals(s.comment, "Re-spotted via RBN");
    assertEquals(s.wwff_reference, "KFF-6101");
    assertEquals(s.wwff_reference_name, "State Game Land PA 013");
    assertEquals(s.pota_reference, null);
    assertEquals(s.pota_park_name, null);
    assertEquals(s.pota_location, null);
    assertEquals(s.sota_summit_ref, null);
    assertEquals(s.raw_payload, raw);
  },
);

Deno.test(
  "wwff.normalize keeps an empty comment and a phone mode",
  async function (): Promise<void> {
    const result = await wwff.normalize(spot(157369), NOW);
    if (result.kind !== "spot") {
      throw new Error("expected spot");
    }
    assertEquals(result.spot.comment, "");
    assertEquals(result.spot.mode, "ssb");
    assertEquals(result.spot.mode_family, "phone");
    assertEquals(result.spot.band, "17m");
  },
);

Deno.test(
  "wwff.normalize hashes spot_time, activator, reference, frequency_khz, mode, remarks",
  async function (): Promise<void> {
    const raw = spot(157367);
    const result = await wwff.normalize(raw, NOW);
    if (result.kind !== "spot") {
      throw new Error("expected spot");
    }
    assertEquals(
      result.spot.content_hash,
      await contentHash([
        raw["spot_time"],
        raw["activator"],
        raw["reference"],
        raw["frequency_khz"],
        raw["mode"],
        raw["remarks"],
      ]),
    );
  },
);

Deno.test(
  "wwff.normalize takes the mode from the comment when upstream mode is blank",
  async function (): Promise<void> {
    const result = await wwff.normalize(
      Object.assign({}, spot(157369), { mode: "", remarks: "FT8 QRP" }),
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
  "wwff.normalize uppercases the calls and reference and nulls blank optional fields",
  async function (): Promise<void> {
    const result = await wwff.normalize(
      Object.assign({}, spot(157369), {
        activator: "k2caf/p",
        spotter: " ",
        reference: "kff-5268",
        reference_name: "",
      }),
      NOW,
    );
    if (result.kind !== "spot") {
      throw new Error("expected spot");
    }
    assertEquals(result.spot.callsign, "K2CAF/P");
    assertEquals(result.spot.spotter, null);
    assertEquals(result.spot.wwff_reference, "KFF-5268");
    assertEquals(result.spot.wwff_reference_name, null);
  },
);

Deno.test("wwff.normalize skips spots older than five minutes", async function (): Promise<void> {
  assertEquals(await wwff.normalize(spot(157366), NOW), { kind: "skip", reason: "too_old" });
});

Deno.test("wwff.normalize skips test spots", async function (): Promise<void> {
  assertEquals(
    await wwff.normalize(Object.assign({}, spot(157369), { remarks: "testing the rig" }), NOW),
    { kind: "skip", reason: "test_comment" },
  );
});

Deno.test("wwff.normalize keeps exactly the fresh fixture spots", async function (): Promise<void> {
  const kept: string[] = [];
  for (const raw of wwff.parseFeed(fixture)) {
    const result = await wwff.normalize(raw, NOW);
    if (result.kind === "spot") {
      kept.push(result.spot.source_spot_id);
    }
  }
  assertEquals(kept, ["157369", "157368", "157367"]);
});

Deno.test("wwff.normalize throws on an unprocessable spot", async function (): Promise<void> {
  await assertRejects(() => wwff.normalize(Object.assign({}, spot(157369), { id: null }), NOW));
  await assertRejects(() =>
    wwff.normalize(Object.assign({}, spot(157369), { activator: "" }), NOW)
  );
  await assertRejects(
    () =>
      wwff.normalize(Object.assign({}, spot(157369), { spot_time: "2026-10-15 18:27:02" }), NOW),
    ValidationError,
    "spot_time",
  );
  // Finite but past Date's range: one failed spot, not a RangeError that fails the run.
  await assertRejects(
    () => wwff.normalize(Object.assign({}, spot(157369), { spot_time: 1e13 }), NOW),
    ValidationError,
    "spot_time is outside the range of a date",
  );
  await assertRejects(() =>
    wwff.normalize(Object.assign({}, spot(157369), { frequency_khz: null }), NOW)
  );
});

Deno.test("wwff.normalize accepts a string id", async function (): Promise<void> {
  const result = await wwff.normalize(Object.assign({}, spot(157369), { id: " 157369 " }), NOW);
  if (result.kind !== "spot") {
    throw new Error("expected spot");
  }
  assertEquals(result.spot.source_spot_id, "157369");
});

Deno.test("wwff.fetchSpots requests the WWFF feed", async function (): Promise<void> {
  const realFetch = globalThis.fetch;
  let requested = "";
  globalThis.fetch = function (input: string | URL | Request) {
    if (input instanceof Request) {
      requested = input.url;
    } else {
      requested = String(input);
    }
    return Promise.resolve(Response.json([]));
  };
  try {
    assertEquals(await wwff.fetchSpots(), []);
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEquals(requested, "https://spots.wwff.co/static/spots.json");
});

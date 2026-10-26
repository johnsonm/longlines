import { assertEquals, assertNotEquals, assertRejects, assertThrows } from "@std/assert";
import { ValidationError } from "../errors.ts";
import { wwbota } from "../wwbota.ts";
import { contentHash } from "../hash.ts";
import type { JsonObject } from "../types.ts";

const fixture = JSON.parse(
  Deno.readTextFileSync(new URL("./fixtures/wwbota-spots.json", import.meta.url)),
) as JsonObject[];

// Fixture captured 2026-10-26 ~19:03Z; spot times range 10:57 to 18:53, every one QRT by then
// (WWBOTA flips an activator's spots to QRT after the fact). NOW keeps the 18:53 and 18:52 spots.
const NOW = new Date("2026-10-26T18:55:00Z");

function spot(time: string): JsonObject {
  const found = fixture.find((s) => s["time"] === time);
  if (!found) {
    throw new Error(`fixture has no spot at ${time}`);
  }
  return found;
}

/** A minute after the spot, so it is kept. */
function justAfter(time: string): Date {
  return new Date(new Date(time).getTime() + 60_000);
}

Deno.test("wwbota.parseFeed returns the array as-is", function (): void {
  assertEquals(wwbota.parseFeed(fixture).length, 8);
});

Deno.test("wwbota.parseFeed throws when the body is not an array of objects", function (): void {
  assertThrows(
    () => wwbota.parseFeed({ detail: "nope" }),
    ValidationError,
    "wwbota.parseFeed: feed",
  );
  assertThrows(() => wwbota.parseFeed([1, 2]), ValidationError);
});

Deno.test(
  "wwbota.normalize maps a fixture spot to the common schema",
  async function (): Promise<void> {
    const raw = spot("2026-10-26T18:53:24.664185Z");
    const result = await wwbota.normalize(raw, NOW);
    if (result.kind !== "spot") {
      throw new Error(`expected spot, got skip ${result.reason}`);
    }
    const s = result.spot;
    assertEquals(s.source, "wwbota");
    assertEquals(s.source_spot_id, "2026-10-26T18:53:24.664185Z");
    assertEquals(s.spot_time, "2026-10-26T18:53:24.664Z");
    assertEquals(s.callsign, "MW0PJE/P");
    assertEquals(s.spotter, "MW0PJE");
    assertEquals(s.frequency_khz, 3537);
    assertEquals(s.band, "80m");
    assertEquals(s.mode, "ft8");
    assertEquals(s.mode_family, "digital");
    assertEquals(s.comment, "B/GW-0064");
    assertEquals(s.wwbota_references, ["B/GW-0064"]);
    assertEquals(s.wwbota_reference_name, "ROC Post St. Asaph");
    assertEquals(s.pota_reference, null);
    assertEquals(s.sota_summit_ref, null);
    assertEquals(s.wwff_reference, null);
    assertEquals(s.wwff_reference_name, null);
    assertEquals(s.raw_payload, raw);
  },
);

Deno.test("wwbota.normalize keeps every bunker of an n-fer, in the feed's order", async function (): Promise<
  void
> {
  const time = "2026-10-26T17:23:08.479344Z";
  const result = await wwbota.normalize(spot(time), justAfter(time));
  if (result.kind !== "spot") {
    throw new Error(`expected spot, got skip ${result.reason}`);
  }
  // The comment says 0105,0104,0103; the feed lists them sorted, and the first name is 0103's.
  assertEquals(result.spot.comment, "B/EA-0105,0104,0103");
  assertEquals(result.spot.wwbota_references, ["B/EA-0103", "B/EA-0104", "B/EA-0105"]);
  assertEquals(result.spot.wwbota_reference_name, "Búnker 1 del Cerro de los Ángeles");
});

Deno.test("wwbota.normalize uppercases references and drops duplicates", async function (): Promise<
  void
> {
  const time = "2026-10-26T12:49:06.725398Z";
  const raw: JsonObject = Object.assign({}, spot(time), {
    references: [{ reference: "b/gw-0065", name: "A" }, { reference: "B/GW-0065", name: "B" }, {
      reference: " B/GW-0156 ",
      name: null,
    }],
  });
  const result = await wwbota.normalize(raw, justAfter(time));
  if (result.kind !== "spot") {
    throw new Error(`expected spot, got skip ${result.reason}`);
  }
  assertEquals(result.spot.wwbota_references, ["B/GW-0065", "B/GW-0156"]);
  assertEquals(result.spot.wwbota_reference_name, "A");
});

Deno.test("wwbota.normalize reads a 2m FM spot from another spotter", async function (): Promise<
  void
> {
  const time = "2026-10-26T13:15:57.473923Z";
  const result = await wwbota.normalize(spot(time), justAfter(time));
  if (result.kind !== "spot") {
    throw new Error(`expected spot, got skip ${result.reason}`);
  }
  assertEquals(result.spot.callsign, "OT4V/P");
  assertEquals(result.spot.spotter, "PA7RA");
  assertEquals(result.spot.frequency_khz, 145400);
  assertEquals(result.spot.band, "2m");
  assertEquals(result.spot.mode, "fm");
  const references = result.spot.wwbota_references;
  if (references === null) {
    throw new Error("expected references");
  }
  assertEquals(references.length, 5);
});

Deno.test("wwbota.normalize gives no band for a frequency outside the bands", async function (): Promise<
  void
> {
  const result = await wwbota.normalize(spot("2026-10-26T18:52:16.952139Z"), NOW);
  if (result.kind !== "spot") {
    throw new Error(`expected spot, got skip ${result.reason}`);
  }
  assertEquals(result.spot.frequency_khz, 6637.5);
  assertEquals(result.spot.band, null);
});

Deno.test("wwbota.normalize skips spots older than five minutes", async function (): Promise<void> {
  const result = await wwbota.normalize(spot("2026-10-26T17:26:31.135815Z"), NOW);
  assertEquals(result, { kind: "skip", reason: "too_old" });
});

Deno.test("wwbota.normalize skips Test spots and test comments", async function (): Promise<void> {
  const raw = spot("2026-10-26T18:53:24.664185Z");
  assertEquals(await wwbota.normalize(Object.assign({}, raw, { type: "Test" }), NOW), {
    kind: "skip",
    reason: "not_normal",
  });
  assertEquals(
    await wwbota.normalize(Object.assign({}, raw, { comment: "B/GW-0064 testing" }), NOW),
    {
      kind: "skip",
      reason: "test_comment",
    },
  );
});

Deno.test("wwbota.normalize keeps QRT and Live spots alike", async function (): Promise<void> {
  const raw = spot("2026-10-26T18:53:24.664185Z");
  assertEquals((await wwbota.normalize(Object.assign({}, raw, { type: "QRT" }), NOW)).kind, "spot");
  assertEquals(
    (await wwbota.normalize(Object.assign({}, raw, { type: "Live" }), NOW)).kind,
    "spot",
  );
  assertEquals((await wwbota.normalize(Object.assign({}, raw, { type: null }), NOW)).kind, "spot");
});

Deno.test("wwbota.normalize skips a QRT spot without a frequency", async function (): Promise<
  void
> {
  const raw = spot("2026-10-26T18:53:24.664185Z");
  assertEquals(await wwbota.normalize(Object.assign({}, raw, { type: "QRT", freq: null }), NOW), {
    kind: "skip",
    reason: "not_normal",
  });
});

Deno.test("wwbota.normalize throws for a Live spot without a frequency", async function (): Promise<
  void
> {
  const raw = spot("2026-10-26T18:53:24.664185Z");
  await assertRejects(
    () => wwbota.normalize(Object.assign({}, raw, { type: "Live", freq: null }), NOW),
    ValidationError,
  );
});

Deno.test("wwbota.normalize throws for a spot that names no bunker", async function (): Promise<
  void
> {
  const raw = spot("2026-10-26T18:53:24.664185Z");
  await assertRejects(
    () => wwbota.normalize(Object.assign({}, raw, { references: [] }), NOW),
    ValidationError,
    "spot names no bunker",
  );
});

Deno.test("wwbota.normalize throws when a required field is missing", async function (): Promise<
  void
> {
  const raw = spot("2026-10-26T18:53:24.664185Z");
  for (const key of ["time", "call", "references"]) {
    const broken: JsonObject = Object.fromEntries(
      Object.entries(raw).filter((entry) => entry[0] !== key),
    );
    await assertRejects(
      () => wwbota.normalize(broken, NOW),
      ValidationError,
      "wwbota.normalize: spot",
    );
  }
  await assertRejects(
    () => wwbota.normalize(Object.assign({}, raw, { time: "yesterday" }), NOW),
    ValidationError,
  );
});

Deno.test("wwbota.normalize makes a blank spotter null", async function (): Promise<void> {
  const raw = spot("2026-10-26T18:53:24.664185Z");
  const result = await wwbota.normalize(Object.assign({}, raw, { spotter: "  " }), NOW);
  if (result.kind !== "spot") {
    throw new Error(`expected spot, got skip ${result.reason}`);
  }
  assertEquals(result.spot.spotter, null);
});

Deno.test(
  "wwbota content hash covers time, call, freq, mode and comment in that order, not type",
  async function (): Promise<void> {
    const raw = spot("2026-10-26T18:53:24.664185Z");
    const result = await wwbota.normalize(raw, NOW);
    if (result.kind !== "spot") {
      throw new Error("expected spot");
    }
    assertEquals(
      result.spot.content_hash,
      await contentHash([raw["time"], raw["call"], raw["freq"], raw["mode"], raw["comment"]]),
    );
    // A spot that flips from Live to QRT is the same spot.
    const live = await wwbota.normalize(Object.assign({}, raw, { type: "Live" }), NOW);
    if (live.kind !== "spot") {
      throw new Error("expected spot");
    }
    assertEquals(live.spot.content_hash, result.spot.content_hash);
    // An edited comment is a new row.
    const edited = await wwbota.normalize(
      Object.assign({}, raw, { comment: "B/GW-0064 QRV" }),
      NOW,
    );
    if (edited.kind !== "spot") {
      throw new Error("expected spot");
    }
    assertNotEquals(edited.spot.content_hash, result.spot.content_hash);
  },
);

Deno.test("wwbota.fetchSpots requests the WWBOTA feed", async function (): Promise<void> {
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
    assertEquals(await wwbota.fetchSpots(), []);
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEquals(requested, "https://api.wwbota.net/spots/");
});

import { assertEquals, assertNotEquals, assertRejects, assertThrows } from "@std/assert";
import { ValidationError } from "../errors.ts";
import { contentHash } from "../hash.ts";
import {
  loggedApplyItems,
  loggedContactSchema,
  loggedRequestSchema,
  loggedResultsSchema,
  MAX_CLOCK_SKEW_MS,
  MAX_CONTACT_AGE_MS,
  mergeLoggedResults,
  normalizeLoggedContact,
} from "../logged.ts";
import type { LoggedApplyItem, LoggedOutcome, LoggedResult } from "../logged.ts";
import type { JsonObject, NormalizedSpot } from "../types.ts";

// The example request of docs/contract.md (sonyccd/longlines-relay), section 6: a new contact, an
// edit, a delete, and a contact logged under another call. Its times are 20:31 to 21:15:45Z.
const fixture = JSON.parse(
  Deno.readTextFileSync(new URL("./fixtures/logged-contacts.json", import.meta.url)),
) as { relay_version: string; contacts: JsonObject[] };

const NOW = new Date("2026-10-28T21:20:00Z");
const ACCOUNT = { userId: "11111111-1111-1111-1111-111111111111" };
const VERSION = "0.1.0";

function item(index: number): JsonObject {
  const found = fixture.contacts[index];
  if (found === undefined) {
    throw new Error(`fixture has no item ${String(index)}`);
  }
  return found;
}

/** The fixture's first item with some fields replaced. */
function upsert(changes: JsonObject): JsonObject {
  return Object.assign({}, item(0), changes);
}

async function applied(raw: unknown, now: Date): Promise<LoggedApplyItem> {
  const outcome = await normalizeLoggedContact(raw, ACCOUNT, VERSION, now);
  if (outcome.kind !== "apply") {
    throw new Error(`expected an apply item, got ${JSON.stringify(outcome.result)}`);
  }
  return outcome.item;
}

async function spotOf(raw: unknown): Promise<NormalizedSpot> {
  const spot = (await applied(raw, NOW)).spot;
  if (spot === null) {
    throw new Error("expected a spot");
  }
  return spot;
}

async function answer(raw: unknown, now: Date): Promise<LoggedResult> {
  const outcome = await normalizeLoggedContact(raw, ACCOUNT, VERSION, now);
  if (outcome.kind !== "result") {
    throw new Error("expected a result");
  }
  return outcome.result;
}

/** A time `ms` after the fixture's first contact, as timestamp_utc. */
function shifted(ms: number): string {
  return new Date(Date.parse("2026-10-28T21:14:00Z") + ms).toISOString().replace(".000Z", "Z");
}

Deno.test("loggedRequestSchema accepts the contract's example request", function (): void {
  const request = loggedRequestSchema.parse(fixture);
  assertEquals(request.relay_version, "0.1.0");
  assertEquals(request.contacts.length, 4);
});

Deno.test("loggedRequestSchema refuses a request the contract answers with 400", function (): void {
  const one = [item(0)];
  const bad: unknown[] = [
    null,
    [],
    { contacts: one },
    { relay_version: "", contacts: one },
    { relay_version: "x".repeat(33), contacts: one },
    { relay_version: VERSION, contacts: [] },
    { relay_version: VERSION, contacts: Array.from({ length: 101 }, () => item(0)) },
    { relay_version: VERSION, contacts: [1] },
    { relay_version: VERSION, contacts: [{ op: "delete" }] },
    { relay_version: VERSION, contacts: [{ external_id: "" }] },
    { relay_version: VERSION, contacts: [{ external_id: "x".repeat(257) }] },
    { relay_version: VERSION, contacts: [{ external_id: 7 }] },
  ];
  for (const body of bad) {
    assertEquals(loggedRequestSchema.safeParse(body).success, false, JSON.stringify(body));
  }
  assertEquals(
    loggedRequestSchema.safeParse({
      relay_version: VERSION,
      contacts: [{ external_id: "x" }],
      later: 1,
    })
      .success,
    true,
    "a field the server does not know is ignored",
  );
});

Deno.test("an upsert becomes a logged spot: mycall spots the worked call", async function (): Promise<
  void
> {
  const out = await applied(item(0), NOW);
  assertEquals(out.op, "upsert");
  assertEquals(out.external_id, "4f0d1c2b3a5e4d6f8a9b0c1d2e3f4a5b");
  assertEquals(out.logger_app, "N1MM");
  assertEquals(out.relay_version, VERSION);
  assertEquals(out.spot, {
    source: "logged",
    source_spot_id: "11111111-1111-1111-1111-111111111111|4f0d1c2b3a5e4d6f8a9b0c1d2e3f4a5b",
    content_hash: await contentHash([
      "KK4PWJ",
      "W1AW",
      14025000,
      "20m",
      "CW",
      "2026-10-28T21:14:00Z",
    ]),
    spot_time: "2026-10-28T21:14:00.000Z",
    callsign: "W1AW",
    spotter: "KK4PWJ",
    frequency_khz: 14025,
    band: "20m",
    mode: "cw",
    mode_family: "cw",
    comment: "",
    pota_reference: null,
    pota_park_name: null,
    pota_location: null,
    sota_summit_ref: null,
    wwff_reference: null,
    wwff_reference_name: null,
    wwbota_references: null,
    wwbota_reference_name: null,
    iota_reference: null,
    raw_payload: item(0),
  });
});

Deno.test("calls and mode are trimmed and upper-cased before they are stored or hashed", async function (): Promise<
  void
> {
  const messy = await spotOf(upsert({ mycall: " kk4pwj ", call: "w1aw", mode: " cw " }));
  const clean = await spotOf(item(0));
  assertEquals(messy.callsign, "W1AW");
  assertEquals(messy.spotter, "KK4PWJ");
  assertEquals(messy.content_hash, clean.content_hash);
  assertEquals(messy.raw_payload["mycall"], " kk4pwj ", "raw_payload keeps the item as sent");
});

Deno.test("the stored mode goes through resolveMode; the hash keeps the mode as logged", async function (): Promise<
  void
> {
  const lsb = await spotOf(item(1));
  assertEquals(lsb.mode, "ssb");
  assertEquals(lsb.mode_family, "phone");
  assertEquals(lsb.spotter, "KK4PWJ/P", "mycall is stored exactly as logged");
  assertEquals(lsb.frequency_khz, 7185.5);
  const usb = await spotOf(Object.assign({}, item(1), { mode: "USB" }));
  assertEquals(usb.mode, "ssb");
  assertNotEquals(usb.content_hash, lsb.content_hash, "an edit from LSB to USB is new content");
});

Deno.test("the band is the server's, from the frequency; the request's band is not content", async function (): Promise<
  void
> {
  const plain = await spotOf(item(0));
  const otherBand = await spotOf(upsert({ band: "40m" }));
  assertEquals(otherBand.band, "20m");
  assertEquals(otherBand.content_hash, plain.content_hash);
  const nowhere = await spotOf(upsert({ frequency_hz: 14500500, band: null }));
  assertEquals(nowhere.band, null);
  assertEquals(nowhere.frequency_khz, 14500.5);
  assertNotEquals(
    (await spotOf(upsert({ frequency_hz: 14025010 }))).content_hash,
    plain.content_hash,
  );
});

Deno.test("each content field changes the hash; logger_app and unknown fields do not", async function (): Promise<
  void
> {
  const base = (await spotOf(item(0))).content_hash;
  const changes: JsonObject[] = [
    { mycall: "KK4PWJ/P" },
    { call: "W1AX" },
    { frequency_hz: 14025500 },
    { mode: "SSB" },
    { timestamp_utc: "2026-10-28T21:14:01Z" },
  ];
  for (const change of changes) {
    assertNotEquals((await spotOf(upsert(change))).content_hash, base, JSON.stringify(change));
  }
  assertEquals((await spotOf(upsert({ logger_app: "DXLog" }))).content_hash, base);
  const extra = await spotOf(upsert({ later_field: { any: "shape" } }));
  assertEquals(extra.content_hash, base);
  assertEquals(extra.raw_payload["later_field"], { any: "shape" });
});

Deno.test("logger_app absent or null is null", async function (): Promise<void> {
  const absent: JsonObject = {};
  for (const key of Object.keys(item(0))) {
    if (key !== "logger_app") {
      absent[key] = item(0)[key];
    }
  }
  assertEquals((await applied(absent, NOW)).logger_app, null);
  assertEquals((await applied(item(3), NOW)).logger_app, null);
});

Deno.test("a delete needs only its id, op and time and carries no spot", async function (): Promise<
  void
> {
  assertEquals(await applied(item(2), NOW), {
    op: "delete",
    external_id: "0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e",
    logger_app: null,
    relay_version: VERSION,
    spot: null,
  });
  const noisy = await applied(
    Object.assign({}, item(2), { mycall: 7, frequency_hz: "x", logger_app: "N1MM" }),
    NOW,
  );
  assertEquals(noisy.spot, null, "other fields on a delete are ignored");
  assertEquals(noisy.logger_app, null);
});

Deno.test("the contact logged as another call still passes here: mycall_mismatch is SQL's", async function (): Promise<
  void
> {
  assertEquals((await spotOf(item(3))).spotter, "K4XYZ");
});

Deno.test("an item that breaks a rule of 6.1 is rejected as invalid, with its id echoed", async function (): Promise<
  void
> {
  const bad: JsonObject[] = [
    upsert({ op: "replace" }),
    upsert({ op: undefined }),
    upsert({ mycall: undefined }),
    upsert({ mycall: "" }),
    upsert({ mycall: "   " }),
    upsert({ mycall: "KK4 PWJ" }),
    upsert({ call: "W".repeat(65) }),
    upsert({ call: 12 }),
    upsert({ frequency_hz: 0 }),
    upsert({ frequency_hz: 14025000.5 }),
    upsert({ frequency_hz: 300_000_000_001 }),
    upsert({ frequency_hz: "14025000" }),
    upsert({ band: undefined }),
    upsert({ band: 20 }),
    upsert({ mode: "" }),
    upsert({ mode: "  " }),
    upsert({ mode: "M".repeat(33) }),
    upsert({ timestamp_utc: "2026-10-28T21:14:00" }),
    upsert({ timestamp_utc: "2026-10-28T21:14:00.000Z" }),
    upsert({ timestamp_utc: "2026-10-28 21:14:00Z" }),
    upsert({ timestamp_utc: "2026-02-30T21:14:00Z" }),
    upsert({ timestamp_utc: "2026-10-28T25:14:00Z" }),
    upsert({ logger_app: "x".repeat(65) }),
    { external_id: "d1", op: "delete" },
    { external_id: "d1", op: "delete", timestamp_utc: 1761686040 },
  ];
  for (const raw of bad) {
    const result = await answer(raw, NOW);
    assertEquals(result.status, "rejected", JSON.stringify(raw));
    assertEquals(result.reason, "invalid", JSON.stringify(raw));
    assertEquals(result.external_id, raw["external_id"]);
  }
});

Deno.test("clock_skew: any item more than five minutes ahead of the server", async function (): Promise<
  void
> {
  const at = new Date(Date.parse("2026-10-28T21:14:00Z") - MAX_CLOCK_SKEW_MS);
  assertEquals((await applied(item(0), at)).op, "upsert", "exactly five minutes ahead is accepted");
  const later = new Date(at.getTime() - 1000);
  assertEquals(await answer(item(0), later), {
    external_id: "4f0d1c2b3a5e4d6f8a9b0c1d2e3f4a5b",
    status: "rejected",
    reason: "clock_skew",
  });
  const del = Object.assign({}, item(2), { timestamp_utc: shifted(MAX_CLOCK_SKEW_MS + 1000) });
  assertEquals(
    (await answer(del, new Date("2026-10-28T21:14:00Z"))).reason,
    "clock_skew",
    "deletes too",
  );
});

Deno.test("too_old: an upsert more than 30 minutes old; a delete never ages out", async function (): Promise<
  void
> {
  const edge = new Date(Date.parse("2026-10-28T21:14:00Z") + MAX_CONTACT_AGE_MS);
  assertEquals((await applied(item(0), edge)).op, "upsert", "exactly 30 minutes old is accepted");
  const past = new Date(edge.getTime() + 1000);
  assertEquals((await answer(item(0), past)).reason, "too_old");
  const day = new Date(Date.parse("2026-10-29T21:00:00Z"));
  assertEquals((await applied(item(2), day)).op, "delete");
});

Deno.test("checks run in the contract's order: invalid before clock_skew before too_old", async function (): Promise<
  void
> {
  const future = new Date("2026-10-28T21:00:00Z");
  assertEquals((await answer(upsert({ call: "" }), future)).reason, "invalid");
  assertEquals(
    (await answer(upsert({ timestamp_utc: shifted(-MAX_CONTACT_AGE_MS * 4) }), future)).reason,
    "too_old",
  );
});

Deno.test("an external_id of 256 characters is stored with the account id in front", async function (): Promise<
  void
> {
  const id = "e".repeat(256);
  const spot = await spotOf(upsert({ external_id: id }));
  assertEquals(spot.source_spot_id, `${ACCOUNT.userId}|${id}`);
  assertEquals(spot.source_spot_id.length, 293);
});

Deno.test("normalizeLoggedContact throws for an item the request-level check refuses", async function (): Promise<
  void
> {
  for (const raw of [null, "x", { op: "upsert" }, { external_id: "" }]) {
    await assertRejects(
      () => normalizeLoggedContact(raw, ACCOUNT, VERSION, NOW),
      ValidationError,
      "normalizeLoggedContact: item",
    );
  }
});

Deno.test("loggedContactSchema reads both ops", function (): void {
  assertEquals(loggedContactSchema.parse(item(2)).op, "delete");
  assertEquals(loggedContactSchema.parse(item(1)).op, "upsert");
});

/** The fixture's outcomes, with the third item answered here. */
async function outcomes(): Promise<LoggedOutcome[]> {
  const out: LoggedOutcome[] = [];
  for (const raw of [item(0), upsert({ external_id: "bad", call: "" }), item(2), item(3)]) {
    out.push(await normalizeLoggedContact(raw, ACCOUNT, VERSION, NOW));
  }
  return out;
}

Deno.test("loggedApplyItems keeps only the items for the database, in order", async function (): Promise<
  void
> {
  assertEquals(loggedApplyItems(await outcomes()).map((i) => i.external_id), [
    "4f0d1c2b3a5e4d6f8a9b0c1d2e3f4a5b",
    "0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e",
    "f79e495bd37010e153bd2da07fd4eb22a248faa643887dffdd1d33e918e1c91c",
  ]);
});

Deno.test("mergeLoggedResults puts both kinds of result back in input order", async function (): Promise<
  void
> {
  const reply = loggedResultsSchema.parse([
    { external_id: "4f0d1c2b3a5e4d6f8a9b0c1d2e3f4a5b", status: "created" },
    { external_id: "0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e", status: "retracted" },
    {
      external_id: "f79e495bd37010e153bd2da07fd4eb22a248faa643887dffdd1d33e918e1c91c",
      status: "rejected",
      reason: "mycall_mismatch",
    },
  ]);
  assertEquals(mergeLoggedResults(await outcomes(), reply), [
    { external_id: "4f0d1c2b3a5e4d6f8a9b0c1d2e3f4a5b", status: "created" },
    { external_id: "bad", status: "rejected", reason: "invalid" },
    { external_id: "0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e", status: "retracted" },
    {
      external_id: "f79e495bd37010e153bd2da07fd4eb22a248faa643887dffdd1d33e918e1c91c",
      status: "rejected",
      reason: "mycall_mismatch",
    },
  ]);
});

Deno.test("mergeLoggedResults throws when the reply does not line up", async function (): Promise<
  void
> {
  const all = await outcomes();
  const first: LoggedResult = {
    external_id: "4f0d1c2b3a5e4d6f8a9b0c1d2e3f4a5b",
    status: "created",
  };
  const second: LoggedResult = {
    external_id: "0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e",
    status: "unknown",
  };
  const third: LoggedResult = {
    external_id: "f79e495bd37010e153bd2da07fd4eb22a248faa643887dffdd1d33e918e1c91c",
    status: "created",
  };
  assertThrows(() => mergeLoggedResults(all, [first, second]), ValidationError, "out of line");
  assertThrows(
    () => mergeLoggedResults(all, [second, first, third]),
    ValidationError,
    "out of line",
  );
  assertThrows(
    () => mergeLoggedResults(all, [first, second, third, third]),
    ValidationError,
    "4 items for 3",
  );
  assertEquals(mergeLoggedResults([], []), []);
});

Deno.test("loggedResultsSchema refuses a status or reason v1 does not have", function (): void {
  assertEquals(
    loggedResultsSchema.safeParse([{ external_id: "a", status: "merged" }]).success,
    false,
  );
  assertEquals(
    loggedResultsSchema.safeParse([{ external_id: "a", status: "rejected", reason: "late" }])
      .success,
    false,
  );
  assertEquals(loggedResultsSchema.safeParse({ results: [] }).success, false);
});

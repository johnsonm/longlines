import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import { ValidationError } from "../errors.ts";
import { parseRelayBody, relayLineSchema, spotTimeFromHhmm } from "../relay_lines.ts";

Deno.test(
  "spotTimeFromHhmm uses the receive day and picks the nearest day across midnight",
  function (): void {
    assertEquals(
      spotTimeFromHhmm("1454", new Date("2026-10-11T14:55:30Z")).toISOString(),
      "2026-10-11T14:54:00.000Z",
    );
    assertEquals(
      spotTimeFromHhmm("2359", new Date("2026-10-12T00:00:10Z")).toISOString(),
      "2026-10-11T23:59:00.000Z",
    );
    // A relay clock a little behind RBN rolls forward instead.
    assertEquals(
      spotTimeFromHhmm("0001", new Date("2026-10-11T23:59:50Z")).toISOString(),
      "2026-10-12T00:01:00.000Z",
    );
    assertThrows(() => spotTimeFromHhmm("2460", new Date()), ValidationError, "invalid HHMM time");
    assertThrows(() => spotTimeFromHhmm("12a4", new Date()));
  },
);

Deno.test(
  "parseRelayBody returns the items and rejects bad shapes and oversize batches",
  function (): void {
    const items = [{
      line: "DX de W3LPL: 14025.0 JA1ABC 1234Z",
      received_at: "2026-10-12T12:34:10Z",
    }];
    const parsed = parseRelayBody({ lines: items });
    assertEquals(parsed, items);
    assertStrictEquals(parsed[0], items[0]);
    assertThrows(() => parseRelayBody([]), ValidationError, "parseRelayBody: relay body");
    assertThrows(() => parseRelayBody({ lines: [null] }), ValidationError, "lines.0");
    // Only a line's shape is left to the adapter, so one bad line fails alone.
    assertEquals(parseRelayBody({ lines: [{ line: 3 }] }), [{ line: 3 }]);
    assertThrows(
      () => parseRelayBody({ lines: Array(1001).fill(items[0]) }),
      ValidationError,
      "at most 1000 lines",
    );
    // The body is our relay's, and it sends only "lines".
    assertThrows(() => parseRelayBody({ lines: items, extra: 1 }), ValidationError, "extra");
  },
);

Deno.test("relayLineSchema takes exactly a non-blank line and received_at", function (): void {
  const item = { line: "x", received_at: "2026-10-12T12:34:10Z" };
  assertEquals(relayLineSchema.parse(item), item);
  assertEquals(relayLineSchema.safeParse({ line: "  ", received_at: "t" }).success, false);
  assertEquals(relayLineSchema.safeParse({ line: 3, received_at: "t" }).success, false);
  assertEquals(relayLineSchema.safeParse({ received_at: "t" }).success, false);
  assertEquals(
    relayLineSchema.safeParse({ line: "x", received_at: "t", feed: "rbn" }).success,
    false,
  );
});

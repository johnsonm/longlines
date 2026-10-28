import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import { ValidationError } from "../errors.ts";
import { inboundLineSchema, parseInboundBody, spotTimeFromHhmm } from "../inbound_lines.ts";

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
    // An inbound worker clock a little behind RBN rolls forward instead.
    assertEquals(
      spotTimeFromHhmm("0001", new Date("2026-10-11T23:59:50Z")).toISOString(),
      "2026-10-12T00:01:00.000Z",
    );
    assertThrows(() => spotTimeFromHhmm("2460", new Date()), ValidationError, "invalid HHMM time");
    assertThrows(() => spotTimeFromHhmm("12a4", new Date()));
  },
);

Deno.test(
  "parseInboundBody returns the items and rejects bad shapes and oversize batches",
  function (): void {
    const items = [{
      line: "DX de W3LPL: 14025.0 JA1ABC 1234Z",
      received_at: "2026-10-12T12:34:10Z",
    }];
    const parsed = parseInboundBody({ lines: items });
    assertEquals(parsed, items);
    assertStrictEquals(parsed[0], items[0]);
    assertThrows(() => parseInboundBody([]), ValidationError, "parseInboundBody: inbound body");
    assertThrows(() => parseInboundBody({ lines: [null] }), ValidationError, "lines.0");
    // Only a line's shape is left to the adapter, so one bad line fails alone.
    assertEquals(parseInboundBody({ lines: [{ line: 3 }] }), [{ line: 3 }]);
    assertThrows(
      () => parseInboundBody({ lines: Array(1001).fill(items[0]) }),
      ValidationError,
      "at most 1000 lines",
    );
    // The body is our inbound's, and it sends only "lines".
    assertThrows(() => parseInboundBody({ lines: items, extra: 1 }), ValidationError, "extra");
  },
);

Deno.test("inboundLineSchema takes exactly a non-blank line and received_at", function (): void {
  const item = { line: "x", received_at: "2026-10-12T12:34:10Z" };
  assertEquals(inboundLineSchema.parse(item), item);
  assertEquals(inboundLineSchema.safeParse({ line: "  ", received_at: "t" }).success, false);
  assertEquals(inboundLineSchema.safeParse({ line: 3, received_at: "t" }).success, false);
  assertEquals(inboundLineSchema.safeParse({ received_at: "t" }).success, false);
  assertEquals(
    inboundLineSchema.safeParse({ line: "x", received_at: "t", feed: "rbn" }).success,
    false,
  );
});

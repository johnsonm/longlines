import { assertEquals, assertThrows } from "@std/assert";
import { parseRelayBody, requireString, spotTimeFromHhmm } from "../relay_lines.ts";

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
    assertThrows(() => spotTimeFromHhmm("2460", new Date()), Error, "invalid HHMM time");
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
    assertEquals(parseRelayBody({ lines: items }), items);
    assertThrows(() => parseRelayBody([]));
    assertThrows(() => parseRelayBody({ lines: [null] }));
    assertThrows(
      () => parseRelayBody({ lines: Array(1001).fill(items[0]) }),
      Error,
      "limit is 1000",
    );
  },
);

Deno.test("requireString returns a non-blank string and rejects anything else", function (): void {
  assertEquals(requireString({ line: "x" }, "line"), "x");
  assertThrows(() => requireString({ line: "  " }, "line"), Error, 'field "line"');
  assertThrows(() => requireString({ line: 3 }, "line"));
  assertThrows(() => requireString({}, "line"));
});

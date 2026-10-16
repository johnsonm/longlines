import { assertEquals } from "@std/assert";
import { withoutNul } from "../strip_nul.ts";

Deno.test("withoutNul removes a real U+0000 from string values", () => {
  assertEquals(withoutNul({ comment: "a\u0000b", n: 1, ok: true, none: null }), {
    comment: "ab",
    n: 1,
    ok: true,
    none: null,
  });
});

Deno.test("withoutNul leaves the typed text \\u0000 unchanged", () => {
  // Six ordinary characters, not a NUL: the old serialized-text replace turned
  // these into a stray backslash and a JSON parse error.
  const typed = String.raw`hi \u0000 x`;
  assertEquals(withoutNul({ comment: typed }), { comment: typed });
  assertEquals(withoutNul({ comment: String.raw`a\u0000b` })["comment"], String.raw`a\u0000b`);
  assertEquals(withoutNul({ comment: String.raw`\\u0000` })["comment"], String.raw`\\u0000`);
});

Deno.test("withoutNul strips nested objects, arrays and keys", () => {
  assertEquals(
    withoutNul({
      "k\u0000ey": "v",
      park: { name: "Big\u0000 Park", tags: ["a\u0000", { x: "\u0000y" }, 3] },
      list: [["\u0000"], []],
    }),
    {
      key: "v",
      park: { name: "Big Park", tags: ["a", { x: "y" }, 3] },
      list: [[""], []],
    },
  );
});

Deno.test("withoutNul does not modify its argument", () => {
  const raw = { comment: "a\u0000b", nested: { c: "\u0000" } };
  withoutNul(raw);
  assertEquals(raw, { comment: "a\u0000b", nested: { c: "\u0000" } });
});

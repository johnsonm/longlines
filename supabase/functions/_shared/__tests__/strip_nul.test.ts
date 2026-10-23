import { assertEquals } from "@std/assert";
import { contentHash } from "../hash.ts";
import { withoutNul } from "../strip_nul.ts";
import type { JsonObject } from "../types.ts";

Deno.test("withoutNul removes a real U+0000 from string values", function (): void {
  assertEquals(withoutNul({ comment: "a\u0000b", n: 1, ok: true, none: null }), {
    comment: "ab",
    n: 1,
    ok: true,
    none: null,
  });
});

Deno.test("withoutNul leaves the typed text \\u0000 unchanged", function (): void {
  // Six ordinary characters, not a NUL: the old serialized-text replace turned
  // these into a stray backslash and a JSON parse error.
  const typed = String.raw`hi \u0000 x`;
  assertEquals(withoutNul({ comment: typed }), { comment: typed });
  assertEquals(withoutNul({ comment: String.raw`a\u0000b` })["comment"], String.raw`a\u0000b`);
  assertEquals(withoutNul({ comment: String.raw`\\u0000` })["comment"], String.raw`\\u0000`);
});

Deno.test("withoutNul strips nested objects, arrays and keys", function (): void {
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

Deno.test("withoutNul does not modify its argument", function (): void {
  const raw = { comment: "a\u0000b", nested: { c: "\u0000" } };
  withoutNul(raw);
  assertEquals(raw, { comment: "a\u0000b", nested: { c: "\u0000" } });
});

Deno.test(
  "withoutNul replaces lone surrogates in values and keys, which Postgres refuses",
  function (): void {
    assertEquals(
      withoutNul({ "k\ud800": "hi \ud83d", list: ["\udc00x", { y: "a\u0000\ud83d" }] }),
      { "k�": "hi �", list: ["�x", { y: "a�" }] },
    );
  },
);

Deno.test("withoutNul keeps surrogate pairs, including one a NUL split", function (): void {
  assertEquals(withoutNul({ c: "73 😀" }), { c: "73 😀" });
  assertEquals(withoutNul({ c: "\ud83d\u0000\ude00" }), { c: "😀" });
});

Deno.test(
  "withoutNul returns a storable item unchanged, so its content hash is unchanged",
  async function (): Promise<void> {
    const fixture = JSON.parse(
      Deno.readTextFileSync(new URL("./fixtures/pota-activator.json", import.meta.url)),
    ) as JsonObject[];
    function fields(raw: JsonObject) {
      return [raw["spotId"], raw["activator"], raw["comments"]];
    }
    for (const raw of fixture.concat([{ comments: "Café 73 ° ✓ 😀" }])) {
      assertEquals(withoutNul(raw), raw);
      assertEquals(await contentHash(fields(withoutNul(raw))), await contentHash(fields(raw)));
    }
  },
);

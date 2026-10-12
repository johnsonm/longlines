import { assertEquals, assertThrows } from "@std/assert";
import { fetchCty, parseCty } from "../cty.ts";
import { userAgent } from "../http.ts";

// Fixture downloaded 2026-10-12 from https://www.country-files.com/cty/cty.dat
// (version 20260915), byte for byte, CRLF line endings included.
const fixture = Deno.readTextFileSync(new URL("./fixtures/cty.dat", import.meta.url));
const parsed = parseCty(fixture);

function prefix(pattern: string, exact = false) {
  const found = parsed.prefixes.find((p) => p.pattern === pattern && p.exact === exact);
  if (!found) throw new Error(`no ${exact ? "=" : ""}${pattern} in fixture`);
  return found;
}

Deno.test("parseCty reads the whole fixture and its version", () => {
  assertEquals(parsed.version, "20260915");
  // 346 records, 6 of them WAE-only.
  assertEquals(parsed.entities.length, 340);
  assertEquals(parsed.entities.filter((e) => e.prefix.startsWith("*")), []);
  assertEquals(parsed.prefixes.length > 5000, true);
});

Deno.test("parseCty keeps each entity's header fields, longitude east positive", () => {
  assertEquals(parsed.entities.find((e) => e.prefix === "K"), {
    prefix: "K",
    name: "United States",
    continent: "NA",
    cq_zone: 5,
    itu_zone: 8,
    lat: 37.6,
    lon: -91.87,
  });
});

Deno.test("parseCty applies zone overrides to exact calls and prefixes", () => {
  assertEquals(prefix("AA0BY", true), {
    pattern: "AA0BY",
    exact: true,
    entity: "K",
    continent: "NA",
    cq_zone: 3,
    itu_zone: 6,
  });
  assertEquals(prefix("W"), {
    pattern: "W",
    exact: false,
    entity: "K",
    continent: "NA",
    cq_zone: 5,
    itu_zone: 8,
  });
});

Deno.test("parseCty skips WAE-only entities so their calls fall through to the parent", () => {
  assertEquals(parsed.prefixes.some((p) => p.pattern === "IT9" && !p.exact), false);
  assertEquals(parsed.prefixes.some((p) => p.entity === "*TA1"), false);
  assertEquals(prefix("I").entity, "I");
});

Deno.test("parseCty does not store the version markers as callsigns", () => {
  assertEquals(parsed.prefixes.filter((p) => p.pattern.startsWith("VER")), []);
});

Deno.test("parseCty reads a continent override and keeps the first of a repeated pattern", () => {
  const text = [
    "Somewhere:   01:  02:  EU:   10.00:   -20.00:    -1.0:  XX:",
    "    XX,XY{AS}(3)[4]<1.0/2.0>~-2.0~,=XX1A,XX;",
    "Elsewhere:   05:  06:  AF:  -10.00:    20.00:     2.0:  ZZ:",
    "    ZZ,XY;",
  ].join("\r\n");
  const data = parseCty(text);
  assertEquals(data.version, null);
  assertEquals(data.entities.map((e) => [e.prefix, e.lon]), [["XX", 20], ["ZZ", -20]]);
  assertEquals(data.prefixes.map((p) => `${p.exact ? "=" : ""}${p.pattern}>${p.entity}`), [
    "XX>XX",
    "XY>XX",
    "=XX1A>XX",
    "ZZ>ZZ",
  ]);
  assertEquals(data.prefixes[1], {
    pattern: "XY",
    exact: false,
    entity: "XX",
    continent: "AS",
    cq_zone: 3,
    itu_zone: 4,
  });
});

Deno.test("parseCty throws on malformed records instead of loading part of a file", () => {
  const header = "Somewhere:   01:  02:  EU:   10.00:   -20.00:    -1.0:  XX:";
  assertThrows(() => parseCty("<html>Not Found</html>;"), Error, "header fields");
  assertThrows(() => parseCty(`${header} XX,bad-alias;`), Error, 'bad alias "bad-alias"');
  assertThrows(() => parseCty(header.replace("EU", "XX") + " XX;"), Error, "bad continent");
  assertThrows(() => parseCty(header.replace("01", "1.5") + " XX;"), Error, "bad CQ zone");
  assertThrows(() => parseCty(header.replace("02", "x") + " XX;"), Error, "bad ITU zone");
  assertThrows(() => parseCty(header.replace("10.00", "") + " XX;"), Error, "bad latitude");
  assertThrows(() => parseCty(header.replace("-20.00", "W") + " XX;"), Error, "bad longitude");
  assertThrows(() => parseCty(`${header} XX{ZZ};`), Error, 'bad continent "ZZ"');
});

Deno.test("fetchCty sends the User-Agent and returns the body", async () => {
  let seenAgent: string | null = null;
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen() {} },
    (req) => {
      seenAgent = req.headers.get("user-agent");
      return new Response("Somewhere: 1: 2: EU: 0: 0: 0: XX:\r\n    XX;\r\n");
    },
  );
  try {
    const text = await fetchCty(`http://127.0.0.1:${server.addr.port}/cty.dat`);
    assertEquals(parseCty(text).entities.length, 1);
    assertEquals(seenAgent, userAgent());
  } finally {
    ac.abort();
    await server.finished;
  }
});

import { assertEquals, assertThrows } from "@std/assert";
import { ValidationError } from "../errors.ts";
import { type CtyPrefix, fetchCty, parseCty } from "../cty.ts";
import { userAgent } from "../http.ts";

// Fixture downloaded 2026-10-12 from https://www.country-files.com/cty/cty.dat
// (version 20260915), byte for byte, CRLF line endings included.
const fixture = Deno.readTextFileSync(new URL("./fixtures/cty.dat", import.meta.url));
const parsed = parseCty(fixture);

function prefix(pattern: string, exact: boolean) {
  const found = parsed.prefixes.find((p) => p.pattern === pattern && p.exact === exact);
  if (!found) {
    let key = pattern;
    if (exact) {
      key = `=${pattern}`;
    }
    throw new Error(`no ${key} in fixture`);
  }
  return found;
}

Deno.test("parseCty reads the whole fixture and its version", function (): void {
  assertEquals(parsed.version, "20260915");
  // 346 records, 6 of them WAE-only.
  assertEquals(parsed.entities.length, 340);
  assertEquals(parsed.entities.filter((e) => e.prefix.startsWith("*")), []);
  assertEquals(parsed.prefixes.length > 5000, true);
});

Deno.test("parseCty keeps each entity's header fields, longitude east positive", function (): void {
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

Deno.test("parseCty applies zone overrides to exact calls and prefixes", function (): void {
  assertEquals(prefix("AA0BY", true), {
    pattern: "AA0BY",
    exact: true,
    entity: "K",
    continent: "NA",
    cq_zone: 3,
    itu_zone: 6,
  });
  assertEquals(prefix("W", false), {
    pattern: "W",
    exact: false,
    entity: "K",
    continent: "NA",
    cq_zone: 5,
    itu_zone: 8,
  });
});

Deno.test(
  "parseCty skips WAE-only entities so their calls fall through to the parent",
  function (): void {
    assertEquals(parsed.prefixes.some((p) => p.pattern === "IT9" && !p.exact), false);
    assertEquals(parsed.prefixes.some((p) => p.entity === "*TA1"), false);
    assertEquals(prefix("I", false).entity, "I");
  },
);

Deno.test("parseCty does not store the version markers as callsigns", function (): void {
  assertEquals(parsed.prefixes.filter((p) => p.pattern.startsWith("VER")), []);
});

function prefixKey(p: CtyPrefix): string {
  if (p.exact) {
    return `=${p.pattern}>${p.entity}`;
  }
  return `${p.pattern}>${p.entity}`;
}

Deno.test(
  "parseCty reads a continent override and keeps the first of a repeated pattern",
  function (): void {
    const text = [
      "Somewhere:   01:  02:  EU:   10.00:   -20.00:    -1.0:  XX:",
      "    XX,XY{AS}(3)[4]<1.0/2.0>~-2.0~,=XX1A,XX;",
      "Elsewhere:   05:  06:  AF:  -10.00:    20.00:     2.0:  ZZ:",
      "    ZZ,XY;",
    ].join("\r\n");
    const data = parseCty(text);
    assertEquals(data.version, null);
    assertEquals(data.entities.map((e) => [e.prefix, e.lon]), [["XX", 20], ["ZZ", -20]]);
    assertEquals(data.prefixes.map(prefixKey), [
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
  },
);

Deno.test(
  "parseCty throws on malformed records instead of loading part of a file",
  function (): void {
    const header = "Somewhere:   01:  02:  EU:   10.00:   -20.00:    -1.0:  XX:";
    assertThrows(() => parseCty("<html>Not Found</html>;"), ValidationError, "header fields");
    assertThrows(
      () => parseCty(`${header} XX,bad-alias;`),
      ValidationError,
      'bad alias "bad-alias"',
    );
    assertThrows(
      () => parseCty(header.replace("EU", "XX") + " XX;"),
      ValidationError,
      "bad continent",
    );
    assertThrows(
      () => parseCty(header.replace("01", "1.5") + " XX;"),
      ValidationError,
      "bad CQ zone",
    );
    assertThrows(
      () => parseCty(header.replace("02", "x") + " XX;"),
      ValidationError,
      "bad ITU zone",
    );
    assertThrows(
      () => parseCty(header.replace("10.00", "") + " XX;"),
      ValidationError,
      "bad latitude",
    );
    assertThrows(
      () => parseCty(header.replace("-20.00", "W") + " XX;"),
      ValidationError,
      "bad longitude",
    );
    assertThrows(() => parseCty(`${header} XX{ZZ};`), ValidationError, 'bad continent "ZZ"');
    assertThrows(
      () => parseCty(header.replace("01", "  ") + " XX;"),
      ValidationError,
      "bad CQ zone",
    );
    assertThrows(
      () => parseCty(header.replace("02", "0") + " XX;"),
      ValidationError,
      "bad ITU zone",
    );
    assertThrows(
      () => parseCty(header.replace("01", "-1") + " XX;"),
      ValidationError,
      "bad CQ zone",
    );
  },
);

Deno.test("parseCty refuses a file cut off mid-download", function (): void {
  // Cut inside the last record's alias list: every complete record before it
  // would parse, and so would the cut one.
  const cut = fixture.slice(0, fixture.lastIndexOf(";", fixture.length - 10) - 3);
  assertThrows(() => parseCty(cut), ValidationError, "truncated download");
  assertThrows(() => parseCty(""), ValidationError, "truncated download");
});

Deno.test("fetchCty sends the User-Agent and returns the body", async function (): Promise<void> {
  let seenAgent: string | null = null;
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen() {} },
    function (req) {
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

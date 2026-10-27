import { assertEquals, assertThrows } from "@std/assert";
import { ValidationError } from "../errors.ts";
import { fetchIotaGroups, IOTA_GROUPS_URL, iotaReference, parseIotaGroups } from "../iota.ts";

// Fifteen groups cut from groups.json as served on 2026-10-27: two per continent, then EU-005.
const fixture: unknown = JSON.parse(
  Deno.readTextFileSync(new URL("./fixtures/iota-groups.json", import.meta.url)),
);

Deno.test("iotaReference reads a reference anywhere in a comment, as Spothole does", function (): void {
  const cases: [string, string | null][] = [
    ["CQ from Arctowski (AN-010)-UP", "AN-010"],
    ["IOTA EU-005", "EU-005"],
    ["IOTA-EU-005 up 2", "EU-005"],
    ["iota oc-148 qrv", "OC-148"],
    ["EU-005", "EU-005"],
    ["SSB NA-112 IOTA", "NA-112"],
    // The first of two.
    ["NA-112 then NA-113", "NA-112"],
    ["", null],
    ["up 2", null],
    // Only the dash form, between non-word characters.
    ["EU005", null],
    ["EU 005", null],
    ["XEU-005", null],
    ["EU-0051", null],
    ["EU-05", null],
    ["_EU-005", null],
    // Not a continent code.
    ["US-2763", null],
    ["KFF-5268", null],
    ["B/EA-0103", null],
  ];
  for (const testCase of cases) {
    assertEquals(iotaReference(testCase[0]), testCase[1], testCase[0]);
  }
});

Deno.test("parseIotaGroups keeps the reference and the trimmed name of each group", function (): void {
  const groups = parseIotaGroups(fixture);
  assertEquals(groups.length, 15);
  assertEquals(groups[0], { refno: "AF-001", name: "Agalega Islands" });
  assertEquals(groups.find((g) => g.refno === "EU-005"), {
    refno: "EU-005",
    name: "Great Britain",
  });
  // The real file has a trailing space here.
  const graham = groups.find((g) => g.refno === "AN-001");
  if (graham === undefined) {
    throw new Error("fixture has no AN-001");
  }
  assertEquals(graham.name, "Graham Land West -Adelaide Island- group");
  for (const group of groups) {
    assertEquals(Object.keys(group), ["refno", "name"]);
  }
});

Deno.test("parseIotaGroups uppercases and trims a reference", function (): void {
  assertEquals(parseIotaGroups([{ refno: " eu-005 ", name: "Great Britain" }]), [
    { refno: "EU-005", name: "Great Britain" },
  ]);
});

Deno.test("parseIotaGroups refuses a body that is not a list of groups", function (): void {
  const bad: unknown[] = [
    { error: "nope" },
    "<html>Not Found</html>",
    [{ refno: "EU-5", name: "Short" }],
    [{ refno: "XX-001", name: "Nowhere" }],
    [{ refno: "EU-005", name: "  " }],
    [{ refno: "EU-005" }],
    [{ name: "No reference" }],
  ];
  for (const body of bad) {
    assertThrows(() => parseIotaGroups(body), ValidationError, "parseIotaGroups: groups.json");
  }
});

Deno.test("parseIotaGroups refuses a reference listed twice", function (): void {
  assertThrows(
    () => parseIotaGroups([{ refno: "EU-005", name: "A" }, { refno: "eu-005", name: "B" }]),
    ValidationError,
    "groups.json lists EU-005 twice",
  );
});

Deno.test("fetchIotaGroups requests the list with a User-Agent", async function (): Promise<void> {
  const realFetch = globalThis.fetch;
  let requested = "";
  let agent: string | null = null;
  globalThis.fetch = function (input: string | URL | Request, init: RequestInit | undefined) {
    if (input instanceof Request) {
      requested = input.url;
    } else {
      requested = String(input);
    }
    if (init !== undefined) {
      agent = new Headers(init.headers).get("User-Agent");
    }
    return Promise.resolve(Response.json([]));
  };
  try {
    assertEquals(await fetchIotaGroups(IOTA_GROUPS_URL), []);
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEquals(requested, IOTA_GROUPS_URL);
  assertEquals(agent !== null && String(agent).startsWith("LongLines/"), true);
});

import { describe, expect, it } from "vitest";
import { flagCode, flagUrl, knownEntities } from "./flags";

// Read at transform time by Vite, as states.test.ts reads the migrations, so
// no Node APIs are needed. The cty.dat is the one the Deno tests parse;
// load_cty skips the WAE-only entities (primary prefix starting with "*"), so
// the table need not cover them.
const CTY: Record<string, string> = import.meta.glob("../../../supabase/functions/_shared/__tests__/fixtures/cty.dat", {
  query: "?raw",
  import: "default",
  eager: true,
});

function dxccEntities(): string[] {
  return Object.values(CTY)[0]!
    .split(";")
    .map((record) => record.replace(/\n\s*/g, " ").trim())
    .filter((record) => record !== "")
    .map((record) => record.split(":").map((f) => f.trim()))
    .filter((fields) => fields.length >= 8 && !fields[7]!.startsWith("*"))
    .map((fields) => fields[0]!);
}

describe("flagCode", () => {
  it("maps a cty.dat entity to a flag-icons code", () => {
    expect(flagCode("United States")).toBe("us");
    expect(flagCode("England")).toBe("gb-eng");
    expect(flagCode("Fed. Rep. of Germany")).toBe("de");
  });

  it("returns null for no country, an unknown name or an entity without a flag", () => {
    expect(flagCode(null)).toBeNull();
    expect(flagCode(undefined)).toBeNull();
    expect(flagCode("Atlantis")).toBeNull();
    expect(flagCode("Scarborough Reef")).toBeNull();
  });

  it("covers every DXCC entity in the cty.dat fixture", () => {
    const entities = dxccEntities();
    expect(entities.length).toBeGreaterThan(300);
    const known = new Set(knownEntities());
    expect(entities.filter((name) => !known.has(name))).toEqual([]);
  });

  it("uses only flags the package ships", () => {
    const missing = knownEntities().filter((name) => flagCode(name) !== null && flagUrl(name) === null);
    expect(missing).toEqual([]);
  });
});

describe("flagUrl", () => {
  it("resolves a mapped entity to its SVG and nothing else", () => {
    expect(flagUrl("United States")).toMatch(/us\.svg$/);
    expect(flagUrl("Scarborough Reef")).toBeNull();
    expect(flagUrl(null)).toBeNull();
  });
});

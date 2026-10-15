import { describe, expect, it } from "vitest";
import worldTopology from "world-atlas/countries-110m.json";
import { countryName, NAMED_TO_ALPHA2, NUMERIC_TO_ALPHA2 } from "./countries";
import { COUNTRY_SHAPES, WORLD_VIEWBOX } from "./countryShapes";

const geometries: { id?: string; properties: { name: string } }[] = worldTopology.objects.countries.geometries;

// Sources read at transform time by Vite so no Node APIs are needed.
const MIGRATIONS: Record<string, string> = import.meta.glob("../../../supabase/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const CTY: string = Object.values(
  import.meta.glob("../../../supabase/functions/_shared/__tests__/fixtures/cty.dat", { query: "?raw", import: "default", eager: true }),
)[0] as string;

/** entity -> country from the newest migration that fills cty_entity_countries. */
function sqlEntityCountries(): Map<string, string> {
  const file = Object.keys(MIGRATIONS).sort().filter((f) => MIGRATIONS[f]?.includes("insert into cty_entity_countries")).at(-1);
  if (!file) throw new Error("no migration fills cty_entity_countries");
  const sql = MIGRATIONS[file] ?? "";
  const start = sql.indexOf("insert into cty_entity_countries");
  const stmt = sql.slice(start, sql.indexOf(";", start));
  return new Map([...stmt.matchAll(/\('([^']+)', '([A-Z]{2})'\)/g)].map((m) => [m[1] as string, m[2] as string]));
}

/** Primary prefixes import-cty loads from the fixture: field 8 of each record, WAE entities ("*") skipped as cty.ts does. */
function ctyEntities(): string[] {
  return CTY.split("\n")
    .filter((line) => /^\S/.test(line))
    .map((line) => (line.split(":")[7] ?? "").trim())
    .filter((prefix) => prefix !== "" && !prefix.startsWith("*"));
}

describe("NUMERIC_TO_ALPHA2 and NAMED_TO_ALPHA2", () => {
  it("map every atlas feature, by id or by name", () => {
    for (const g of geometries) {
      const code = g.id === undefined ? NAMED_TO_ALPHA2[g.properties.name] : NUMERIC_TO_ALPHA2[g.id];
      expect(code, g.properties.name).toMatch(/^[A-Z]{2}$/);
    }
    expect(Object.keys(NUMERIC_TO_ALPHA2)).toHaveLength(geometries.filter((g) => g.id !== undefined).length);
  });
  it("give each numeric id its own code", () => {
    const codes = Object.values(NUMERIC_TO_ALPHA2);
    expect(new Set(codes).size).toBe(codes.length);
    expect(NUMERIC_TO_ALPHA2["840"]).toBe("US");
    expect(NUMERIC_TO_ALPHA2["826"]).toBe("GB");
  });
});

describe("cty_entity_countries", () => {
  const mapping = sqlEntityCountries();
  it("maps every entity import-cty loads, except the three with no country", () => {
    const unmapped = ctyEntities().filter((e) => !mapping.has(e));
    expect(unmapped.sort()).toEqual(["1A", "1S", "BS7"]);
    expect([...mapping.keys()].filter((e) => !ctyEntities().includes(e))).toEqual([]);
  });
  it("uses only codes the runtime can name", () => {
    for (const code of new Set(mapping.values())) expect(countryName(code), code).not.toBe(code);
  });
  it("folds DXCC entities into their country", () => {
    expect(mapping.get("K")).toBe("US");
    expect(mapping.get("KL")).toBe("US");
    expect(mapping.get("GM")).toBe("GB");
    expect(mapping.get("UA9")).toBe("RU");
    expect(mapping.get("KP4")).toBe("PR");
  });
});

describe("countryName", () => {
  it("names a code and falls back to the code", () => {
    expect(countryName("DE")).toBe("Germany");
    expect(countryName("XK")).toBe("Kosovo");
    expect(countryName("not a code")).toBe("not a code");
  });
});

describe("COUNTRY_SHAPES", () => {
  it("draws every atlas feature but Antarctica", () => {
    expect(COUNTRY_SHAPES).toHaveLength(geometries.length - 1);
    expect(COUNTRY_SHAPES.some((s) => s.code === "AQ")).toBe(false);
    for (const s of COUNTRY_SHAPES) expect(s.d.startsWith("M")).toBe(true);
  });
  it("fits a 960-wide viewBox", () => {
    const [x, , width, height] = WORLD_VIEWBOX.split(" ").map(Number);
    expect(x).toBe(0);
    expect(width).toBe(960);
    expect(height).toBeGreaterThan(300);
    expect(height).toBeLessThan(600);
  });
});

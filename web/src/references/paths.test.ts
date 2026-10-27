import { describe, expect, it } from "vitest";
import { programSource, referencePath, referenceProgram, referenceUrl, sourceProgram } from "./paths";

describe("referencePath", () => {
  it("lower-cases the program and keeps SOTA's slash as a path separator", () => {
    expect(referencePath("POTA", "US-2763")).toBe("/ref/pota/US-2763");
    expect(referencePath("sota", "W4C/CM-001")).toBe("/ref/sota/W4C/CM-001");
    expect(referencePath("WWFF", "KFF-6101")).toBe("/ref/wwff/KFF-6101");
  });

  it("links only programs with pages, never WWBOTA or IOTA", () => {
    expect(referencePath("WWBOTA", "B/G-0001")).toBeNull();
    expect(referencePath("IOTA", "EU-005")).toBeNull();
  });

  it("encodes each segment and refuses what the router would resolve elsewhere", () => {
    expect(referencePath("pota", "US 1?")).toBe("/ref/pota/US%201%3F");
    expect(referencePath("pota", "")).toBeNull();
    expect(referencePath("sota", "W4C/../STATS")).toBeNull();
    expect(referencePath("sota", "W4C//CM-001")).toBeNull();
    expect(referencePath("sota", ".")).toBeNull();
  });

  it("maps programs and sources both ways", () => {
    expect(referenceProgram("Sota")).toBe("sota");
    expect(referenceProgram("bota")).toBeNull();
    expect(sourceProgram("sotawatch")).toBe("sota");
    expect(sourceProgram("pota")).toBe("pota");
    expect(sourceProgram("dxcluster")).toBeNull();
    expect(programSource("sota")).toBe("sotawatch");
    expect(programSource("wwff")).toBe("wwff");
  });

  it("builds the shareable link", () => {
    expect(referenceUrl("https://longlines.io", "sota", "W4C/CM-001")).toBe("https://longlines.io/ref/sota/W4C/CM-001");
    expect(referenceUrl("https://longlines.io", "pota", "")).toBe("https://longlines.io/");
  });
});

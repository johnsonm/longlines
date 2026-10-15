import { describe, expect, it } from "vitest";
import { findLiveSource, MODES, modeLabel, SOURCES } from "./sources";

describe("modeLabel", () => {
  it("labels the digital family as Any digital", () => {
    expect(modeLabel("digital")).toBe("Any digital");
  });

  it("uppercases a specific mode", () => {
    expect(modeLabel("ft8")).toBe("FT8");
  });
});

describe("MODES", () => {
  it("offers the digital family first", () => {
    expect(MODES[0]).toBe("digital");
  });
});

describe("SOURCES catalog fields", () => {
  const live = SOURCES.filter((s) => s.status === "live");
  const planned = SOURCES.filter((s) => s.status === "planned");

  it("gives every live source a title, tagline, mark, stats key and run-by rows", () => {
    for (const s of live) {
      expect(s.title, s.id).not.toBe("");
      expect(s.tagline, s.id).toMatch(/\.$/);
      expect(s.mark, s.id).toMatch(/^[A-Z]{2}$/);
      expect(s.statsKey, s.id).not.toBeNull();
      expect(s.runBy, s.id).not.toBeNull();
      expect(s.about.length, s.id).toBeGreaterThan(0);
      expect(s.showsUp.length, s.id).toBeGreaterThan(0);
    }
  });

  it("gives planned sources no stats key", () => {
    expect(planned.map((s) => s.id)).toEqual(["pskreporter"]);
    for (const s of planned) expect(s.statsKey).toBeNull();
  });

  it("marks only RBN, APRS-IS and PSK Reporter as high volume", () => {
    expect(SOURCES.filter((s) => s.volume === "high").map((s) => s.id).sort()).toEqual(["aprs", "pskreporter", "rbn"]);
  });

  it("gives every live source but APRS-IS a schema whose fields match its example", () => {
    for (const s of live) {
      if (s.id === "aprs") {
        expect(s.schema).toBeNull();
        expect(s.example).toBeNull();
        continue;
      }
      expect(s.schema, s.id).not.toBeNull();
      expect(s.schema!.map((f) => f.name)).toEqual(Object.keys(s.example!).filter((k) => s.schema!.some((f) => f.name === k)));
      expect(s.example!.source).toBe(s.id);
    }
  });

  it("lists the source's own reference fields after the common ones", () => {
    const names = (id: string) => findLiveSource(id)!.schema!.map((f) => f.name);
    expect(names("pota").slice(-3)).toEqual(["pota_reference", "pota_park_name", "pota_location"]);
    expect(names("sotawatch").at(-1)).toBe("sota_summit_ref");
    expect(names("wwff").slice(-2)).toEqual(["wwff_reference", "wwff_reference_name"]);
    expect(names("rbn").at(-1)).toBe("comment");
  });

  it("rewords RBN's spotter and marks DX Cluster's mode as derived", () => {
    const field = (id: string, name: string) => findLiveSource(id)!.schema!.find((f) => f.name === name)!;
    expect(field("rbn", "spotter").description).toBe("Callsign of the skimmer that heard the signal.");
    expect(field("dxcluster", "mode")).toMatchObject({ description: "From the comment, else the band plan.", derived: true });
    expect(field("pota", "mode").derived).toBe(false);
  });

  it("finds live sources only", () => {
    expect(findLiveSource("rbn")?.title).toBe("Reverse Beacon Network");
    expect(findLiveSource("wwff")?.statsKey).toBe("wwff");
    expect(findLiveSource("pskreporter")).toBeUndefined();
    expect(findLiveSource("nope")).toBeUndefined();
    expect(findLiveSource(undefined)).toBeUndefined();
  });
});

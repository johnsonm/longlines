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

  it("lists no planned sources and gives any planned source no stats key", () => {
    expect(planned).toEqual([]);
    for (const s of planned) expect(s.statsKey).toBeNull();
  });

  it("marks only RBN and APRS-IS as high volume", () => {
    expect(SOURCES.filter((s) => s.volume === "high").map((s) => s.id).sort()).toEqual(["aprs", "rbn"]);
  });

  // webhook_fields() order with the default snake_case keys and kHz (docs/WEBHOOKS.md).
  const CATALOG = [
    "id", "time", "callsign", "frequency_khz", "mode", "band", "source", "reference", "place_name", "state",
    "spotter", "country", "url", "comment",
  ];
  // webhook_default_settings()'s fields, sent with missing values left out.
  const DEFAULT_KEYS = CATALOG.slice(0, 11);

  it("gives every live source but APRS-IS the webhook field catalog and its default spot", () => {
    for (const s of live) {
      if (s.id === "aprs") {
        expect(s.schema).toBeNull();
        expect(s.example).toBeNull();
        continue;
      }
      expect(s.schema!.map((f) => f.name), s.id).toEqual(CATALOG);
      expect(s.schema!.every((f) => f.description !== ""), s.id).toBe(true);
      const keys = Object.keys(s.example!);
      // The default fields in order, less the ones this source has no value for.
      expect(keys, s.id).toEqual(DEFAULT_KEYS.filter((k) => keys.includes(k)));
      const missing = DEFAULT_KEYS.filter((k) => !keys.includes(k));
      for (const k of missing) {
        expect(s.schema!.find((f) => f.name === k)!.description, `${s.id} ${k}`).toMatch(/^No value on /);
      }
      expect(s.example!.source).toBe(s.id);
      expect(s.example!.time, s.id).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      expect(Object.values(s.example!).includes(null), s.id).toBe(false);
    }
  });

  it("fills the reference fields per source", () => {
    const field = (id: string, name: string) => findLiveSource(id)!.schema!.find((f) => f.name === name)!.description;
    expect(field("pota", "reference")).toBe("Park reference.");
    expect(field("sotawatch", "reference")).toBe("Summit reference.");
    expect(field("wwff", "place_name")).toBe("Reference name.");
    expect(field("pota", "state")).toMatch(/^The park's state or province/);
    expect(field("rbn", "reference")).toBe("No value on RBN spots, so the key is left out.");
    expect(findLiveSource("pota")!.example).toMatchObject({ reference: "US-2763", state: "NC" });
    expect(findLiveSource("dxcluster")!.example).not.toHaveProperty("reference");
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
    expect(findLiveSource("nope")).toBeUndefined();
    expect(findLiveSource(undefined)).toBeUndefined();
  });
});

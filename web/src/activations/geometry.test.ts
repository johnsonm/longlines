import { describe, expect, it } from "vitest";
import { geoPath } from "d3-geo";
import type { MultiPolygon } from "geojson";
import { STATE_SHAPES } from "../stats/stateShapes";
import { COUNTRIES, IOTA, TWOFER } from "./fixtures";
import { heardGeometry, MAP_HEIGHT, MAP_WIDTH, project } from "./geometry";
import type { ActivationPlace } from "./types";

/** A shape's SVG path ("M..L..Z", straight segments only) as planar polygons, for geoPath's centroid. */
function parseSvgPath(d: string): MultiPolygon {
  const rings = d.split("M").filter((r) => r).map((r) =>
    r.replace(/Z/g, "").split("L").map((pt) => pt.split(",").map(Number) as [number, number])
  );
  return { type: "MultiPolygon", coordinates: rings.map((ring) => [ring]) };
}

const inFrame = (p: { x: number; y: number } | null) => p !== null && p.x > 0 && p.x < MAP_WIDTH && p.y > 0 && p.y < MAP_HEIGHT;

describe("project", () => {
  it("puts US places on us-atlas's pre-projected frame", () => {
    const nc = project(-79.36, 35.55);
    const wa = project(-120.5, 47.4);
    expect(inFrame(nc)).toBe(true);
    expect(inFrame(wa)).toBe(true);
    // Washington is north-west of North Carolina.
    expect(wa!.x).toBeLessThan(nc!.x);
    expect(wa!.y).toBeLessThan(nc!.y);
    // Alaska and Hawaii are drawn in their insets.
    expect(inFrame(project(-152.3, 64.2))).toBe(true);
    expect(inFrame(project(-157.0, 20.8))).toBe(true);
  });

  it("lands SQL's state centroids on us-atlas's pre-projected states", () => {
    // us_state_centroids' values for these states, against each shape's planar centroid.
    const centroids: [string, number, number][] = [["NC", 35.5522, -79.3559], ["MA", 42.2543, -71.7924], ["AK", 64.0, -152.0]];
    for (const [code, lat, lon] of centroids) {
      const shape = STATE_SHAPES.find((s) => s.code === code)!;
      const [cx, cy] = geoPath().centroid(parseSvgPath(shape.d));
      const p = project(lon, lat)!;
      expect(Math.hypot(p.x - cx, p.y - cy), code).toBeLessThan(10);
    }
  });

  it("gives null outside the map", () => {
    expect(project(10, 51)).toBeNull();
  });
});

describe("heardGeometry", () => {
  it("draws a line to each heard state outside the reference's own, and shades both", () => {
    const g = heardGeometry(TWOFER);
    expect(inFrame(g.origin)).toBe(true);
    expect(g.home).toEqual(["NC"]);
    expect(g.heard).toEqual(["MA", "PA", "NY", "NC", "VA"]);
    expect(g.lines.map((l) => l.code)).toEqual(["MA", "PA", "NY", "VA"]);
    expect(g.lines[0]).toMatchObject({ name: "Massachusetts", spots: 2 });
    expect(g.lines.every(inFrame)).toBe(true);
  });

  it("draws no line without a location, but still shades the heard states", () => {
    const heard: ActivationPlace[] = [{ kind: "state", code: "OH", name: "Ohio", latitude: 40.3, longitude: -82.8, spots: 1 }];
    const g = heardGeometry({ ...IOTA, heard });
    expect(g).toEqual({ origin: null, home: [], heard: ["OH"], lines: [] });
  });

  it("leaves countries, a place without coordinates and an off-map reference without lines", () => {
    const heard: ActivationPlace[] = [
      ...COUNTRIES.heard,
      { kind: "state", code: "TX", name: null, latitude: null, longitude: null, spots: 1 },
      { kind: "state", code: "OH", name: null, latitude: 40.3, longitude: -82.8, spots: 2 },
    ];
    const g = heardGeometry({ location: { latitude: 35.67, longitude: -79.75, states: [] }, heard });
    expect(g.lines).toEqual([expect.objectContaining({ code: "OH", name: "OH", spots: 2 })]);
    const abroad = heardGeometry({ location: { latitude: 51, longitude: 10, states: [] }, heard });
    expect(abroad.origin).toBeNull();
    expect(abroad.lines).toEqual([]);
  });
});

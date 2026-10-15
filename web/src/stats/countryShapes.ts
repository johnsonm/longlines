// world-atlas ships the Natural Earth 1:110m countries as unprojected TopoJSON,
// so unlike the states this module projects them itself: Equal Earth, fitted to
// a 960-wide viewBox, computed once at module load (no DOM, so it is tested in
// node like stateShapes.ts). Antarctica is left off: it would take a fifth of
// the height for almost no spots, and the list beside the map still shows it.
import { geoEqualEarth, geoPath } from "d3-geo";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import worldTopology from "world-atlas/countries-110m.json";
import { NAMED_TO_ALPHA2, NUMERIC_TO_ALPHA2 } from "./countries";

/** One drawn country. A code can have more than one shape (CY covers N. Cyprus too). */
export type CountryShape = { code: string; d: string };

type WorldTopology = Topology<{ countries: GeometryCollection<{ name: string }> }>;

// The JSON import is typed as its literal shape; narrow it to the TopoJSON type
// the converter expects.
const topology = worldTopology as unknown as WorldTopology;
const WIDTH = 960;

function alpha2(f: Feature<Geometry, { name: string }>): string | undefined {
  return f.id === undefined ? NAMED_TO_ALPHA2[f.properties.name] : NUMERIC_TO_ALPHA2[String(f.id)];
}

const drawn = feature(topology, topology.objects.countries).features.flatMap((f) => {
  const code = alpha2(f);
  return code && code !== "AQ" ? [{ code, f }] : [];
});
const collection: FeatureCollection = { type: "FeatureCollection", features: drawn.map((x) => x.f) };
// One decimal is a tenth of a viewBox unit, finer than the map is ever drawn,
// and keeps the path strings a third of their default size.
const path = geoPath(geoEqualEarth().fitWidth(WIDTH, collection)).digits(1);
const [[, top], [, bottom]] = path.bounds(collection);

/** The SVG viewBox the shapes fill exactly. */
export const WORLD_VIEWBOX = `0 ${Math.floor(top)} ${WIDTH} ${Math.ceil(bottom - top)}`;

export const COUNTRY_SHAPES: readonly CountryShape[] = drawn.flatMap(({ code, f }) => {
  const d = path(f);
  return d ? [{ code, d }] : [];
});

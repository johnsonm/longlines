// us-atlas ships a pre-projected (Albers USA, 975x610) TopoJSON of the states,
// so the map needs no projection math at runtime. topojson-client turns it into
// GeoJSON features and d3-geo's geoPath (with no projection) turns those into
// SVG path strings. All three are pure data libraries with no DOM dependency,
// which is why the shapes can be computed once here at module load and tested
// in node.
import { geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import statesTopology from "us-atlas/states-albers-10m.json" with { type: "json" };
import { FIPS_TO_POSTAL } from "./states.ts";

export type StateShape = { code: string; name: string; d: string };

type StatesTopology = Topology<{ states: GeometryCollection<{ name: string }> }>;

// The JSON import is typed as its literal shape; narrow it to the TopoJSON type
// the converter expects.
const topology = statesTopology as unknown as StatesTopology;
const path = geoPath();

export const STATE_SHAPES: readonly StateShape[] = feature(topology, topology.objects.states).features
  .flatMap((f) => {
    const code = FIPS_TO_POSTAL[String(f.id)];
    const d = path(f);
    return code && d ? [{ code, name: f.properties.name, d }] : [];
  })
  .sort((a, b) => a.code.localeCompare(b.code));

const NAMES = new Map(STATE_SHAPES.map((s) => [s.code, s.name]));

/** Full state name for a postal code, or the code itself if unknown. */
export function stateName(code: string): string {
  return NAMES.get(code) ?? code;
}

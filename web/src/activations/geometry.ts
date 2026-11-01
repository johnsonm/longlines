// Where the heard map draws: SQL's coordinates projected onto us-atlas's pre-projected states
// (states-albers-10m, 975 by 610), whose projection is geoAlbersUsa at scale 1300 centred on
// the frame. DOM-free and imported with .ts extensions, so the link previews (web/api) can draw
// the same map from Node. It never works out a place: the reference's point and states and the
// heard states' centroids all come from the payload.

import { geoAlbersUsa } from "d3-geo";
import type { ActivationPlace, SpottedActivation } from "./types.ts";

export const MAP_WIDTH = 975;
export const MAP_HEIGHT = 610;

const projection = geoAlbersUsa().scale(1300).translate([MAP_WIDTH / 2, MAP_HEIGHT / 2]);

export interface MapPoint {
  x: number;
  y: number;
}

/** A longitude and latitude on the map, or null outside the lower 48, Alaska and Hawaii. */
export function project(longitude: number, latitude: number): MapPoint | null {
  const p = projection([longitude, latitude]);
  if (!p) return null;
  return { x: Math.round(p[0] * 10) / 10, y: Math.round(p[1] * 10) / 10 };
}

/** One heard state's line end: its centroid on the map. */
export interface HeardLine extends MapPoint {
  code: string;
  name: string;
  spots: number;
}

export interface HeardGeometry {
  /** The reference's point; null without a location or outside the map. */
  origin: MapPoint | null;
  /** The reference's own US states, shaded with no line. */
  home: string[];
  /** Every heard state, shaded. */
  heard: string[];
  /** One line per heard state outside the reference's own, only when there is an origin. */
  lines: HeardLine[];
}

function stateLine(place: ActivationPlace): HeardLine | null {
  if (place.kind !== "state" || place.latitude === null || place.longitude === null) return null;
  const at = project(place.longitude, place.latitude);
  return at ? { ...at, code: place.code, name: place.name ?? place.code, spots: place.spots } : null;
}

/** What the heard map draws for an activation. */
export function heardGeometry(a: Pick<SpottedActivation, "location" | "heard">): HeardGeometry {
  const origin = a.location ? project(a.location.longitude, a.location.latitude) : null;
  const home = a.location?.states ?? [];
  const heard = a.heard.filter((p) => p.kind === "state").map((p) => p.code);
  const lines = origin === null
    ? []
    : a.heard.flatMap((p) => {
      const line = home.includes(p.code) ? null : stateLine(p);
      return line ? [line] : [];
    });
  return { origin, home, heard, lines };
}

// The preview image (1200 by 630 PNG, since Discord does not show an SVG og:image): the
// activation's heading, names and date line beside the heard map, drawn from the same
// geometry.ts and us-atlas shapes as the page's HeardMap. No JSX: the builder returns Satori's
// plain element objects, so this stays a .ts file. Colours are MUI's stock light palette, the
// web app's theme (App.tsx's createTheme is stock), written out because nothing here loads MUI.
// SVG text needs fonts the renderer lacks, so the map carries no labels; every word is Satori text.

import { ImageResponse } from "@vercel/og";
import { heardGeometry, MAP_HEIGHT, MAP_WIDTH } from "../../src/activations/geometry.ts";
import { dateLine, heardSentence, LOCATION_UNKNOWN, namesLabel, overline, pageHeading } from "../../src/activations/model.ts";
import { STATE_SHAPES } from "../../src/stats/stateShapes.ts";
import { admit, CACHE_CONTROL, type EnvSource, type Fetch, type PreviewActivation, withActivation } from "./activation.ts";
import { IMAGE_HEIGHT, IMAGE_WIDTH } from "./preview.ts";

/** MUI's stock light palette: primary.main, text.primary, text.secondary, background.paper. */
export const COLORS = {
  primary: "#1976d2",
  text: "rgba(0, 0, 0, 0.87)",
  secondary: "rgba(0, 0, 0, 0.6)",
  paper: "#ffffff",
  /** action.selected: action.hover (the page's fill) is too faint to read at thumbnail size. */
  land: "rgba(0, 0, 0, 0.08)",
} as const;

/** One Satori node: a plain React-style element ({type, props, key}), or text. */
export interface OgElement {
  type: string;
  key: null;
  props: OgProps;
}

export type OgChild = OgElement | string;

export interface OgProps {
  style?: Readonly<Record<string, string | number>>;
  children?: OgChild | OgChild[];
  [attribute: string]: unknown;
}

/** An element; `children` goes in props, as React's own objects have it. */
export function el(type: string, props: OgProps): OgElement {
  return { type, key: null, props };
}

/** The map's width on the image; its height keeps us-atlas's 975 by 610. */
export const MAP_DRAWN_WIDTH = 620;
export const MAP_DRAWN_HEIGHT = Math.round(MAP_DRAWN_WIDTH * MAP_HEIGHT / MAP_WIDTH);

/** The image's padding, the gap between the columns, and the text column that fills the rest. */
export const IMAGE_PADDING = 56;
export const COLUMN_GAP = 32;
export const TEXT_WIDTH = IMAGE_WIDTH - 2 * IMAGE_PADDING - COLUMN_GAP - MAP_DRAWN_WIDTH;

/** The heard map as an inline SVG: shaded states, then a line to each other heard state. */
export function mapElement(a: Pick<PreviewActivation, "location" | "heard">): OgElement {
  const g = heardGeometry(a);
  const fillOf = (code: string): { fill: string; fillOpacity: number } => {
    if (g.home.includes(code)) return { fill: COLORS.primary, fillOpacity: 0.5 };
    if (g.heard.includes(code)) return { fill: COLORS.primary, fillOpacity: 0.16 };
    return { fill: COLORS.land, fillOpacity: 1 };
  };
  const states = STATE_SHAPES.map((s) => el("path", { d: s.d, ...fillOf(s.code), stroke: COLORS.paper, strokeWidth: 1 }));
  const origin = g.origin;
  const marks = origin === null ? [] : [
    ...g.lines.map((l) =>
      el("line", { x1: origin.x, y1: origin.y, x2: l.x, y2: l.y, stroke: COLORS.primary, strokeOpacity: 0.55, strokeWidth: 2.5 })
    ),
    ...g.lines.map((l) => el("circle", { cx: l.x, cy: l.y, r: 7, fill: COLORS.primary })),
    el("circle", { cx: origin.x, cy: origin.y, r: 12, fill: COLORS.primary, stroke: COLORS.paper, strokeWidth: 4 }),
  ];
  return el("svg", {
    width: MAP_DRAWN_WIDTH,
    height: MAP_DRAWN_HEIGHT,
    viewBox: `0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`,
    children: [...states, ...marks],
  });
}

function textBlock(content: string, style: Readonly<Record<string, string | number>>): OgElement {
  return el("div", { style: { display: "flex", ...style }, children: content });
}

/** The whole image for one activation. */
export function activationImage(a: PreviewActivation): OgElement {
  const names = namesLabel(a.referenceNames);
  const captions = a.location === null ? [heardSentence(a.heard), LOCATION_UNKNOWN] : [heardSentence(a.heard)];
  // The heading and the names are clamped (with an ellipsis) to lines that always fit, so several
  // references or long names never push the date line or the footer off the image.
  const left = el("div", {
    style: { display: "flex", flexDirection: "column", width: TEXT_WIDTH, flexShrink: 0, height: "100%", justifyContent: "space-between" },
    children: [
      el("div", {
        style: { display: "flex", flexDirection: "column", flexShrink: 1, minHeight: 0, overflow: "hidden" },
        children: [
          textBlock(overline(a.program), { fontSize: 26, color: COLORS.primary, marginBottom: 20 }),
          textBlock(pageHeading(a), {
            display: "block",
            lineClamp: 3,
            wordBreak: "break-word",
            fontSize: 54,
            lineHeight: 1.15,
            color: COLORS.text,
            marginBottom: 20,
          }),
          ...(names
            ? [textBlock(names, {
              display: "block",
              lineClamp: 3,
              wordBreak: "break-word",
              fontSize: 28,
              lineHeight: 1.3,
              color: COLORS.secondary,
              marginBottom: 16,
            })]
            : []),
          textBlock(dateLine(a), { fontSize: 28, lineHeight: 1.3, color: COLORS.secondary }),
        ],
      }),
      el("div", {
        style: { display: "flex", flexDirection: "column", flexShrink: 0 },
        children: [
          textBlock("Long Lines", { fontSize: 32, color: COLORS.text, marginBottom: 6 }),
          textBlock("Estimated from spots, not logs.", { fontSize: 24, color: COLORS.secondary }),
        ],
      }),
    ],
  });
  // Both columns have fixed widths that add up to the padded image, because Satori sizes a flex
  // item by its text laid out as one line: a long caption (many countries) widened the map's
  // column past the image's right edge, taking the centred map with it. Captions wrap within the
  // map's width, at most two lines.
  const right = el("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      width: MAP_DRAWN_WIDTH,
      flexShrink: 0,
      marginLeft: COLUMN_GAP,
      overflow: "hidden",
    },
    children: [
      mapElement(a),
      ...captions.map((caption, i) =>
        textBlock(caption, {
          display: "block",
          width: MAP_DRAWN_WIDTH,
          lineClamp: 2,
          wordBreak: "break-word",
          textAlign: "center",
          fontSize: 24,
          lineHeight: 1.3,
          color: COLORS.secondary,
          marginTop: i === 0 ? 16 : 4,
        })
      ),
    ],
  });
  return el("div", {
    style: {
      display: "flex",
      flexDirection: "row",
      width: IMAGE_WIDTH,
      height: IMAGE_HEIGHT,
      padding: IMAGE_PADDING,
      backgroundColor: COLORS.paper,
      fontFamily: "geist",
    },
    children: [left, right],
  });
}

/** GET /api/activation-image?id=<id>: the PNG, or the same plain replies as the preview. */
export async function handleImage(request: Request, env: EnvSource, fetchFn: Fetch): Promise<Response> {
  const admitted = admit(request, env);
  if ("refused" in admitted) return admitted.refused;
  return withActivation(admitted, fetchFn, async (a) => {
    const image = new ImageResponse(activationImage(a), {
      width: IMAGE_WIDTH,
      height: IMAGE_HEIGHT,
      // Lower case: ImageResponse spreads these over its own "cache-control" (a year, immutable),
      // and a differently cased key would add a second value instead of replacing it.
      headers: { "cache-control": CACHE_CONTROL },
    });
    // ImageResponse draws inside its body stream, after the 200 and its cache header are set, so
    // a failed drawing would go out as a cacheable 200 with a broken body. Drawing it here first
    // makes a failure throw instead: Vercel answers that with a 500, which nothing caches.
    const png = await image.arrayBuffer();
    return new Response(png, { status: image.status, headers: image.headers });
  });
}

import { beforeEach, describe, expect, it, vi } from "vitest";
import { IOTA, TWOFER } from "../../src/activations/fixtures.ts";
import { heardGeometry } from "../../src/activations/geometry.ts";
import { STATE_SHAPES } from "../../src/stats/stateShapes.ts";
import type { Fetch } from "./activation.ts";
import { activationImage, COLORS, COLUMN_GAP, el, IMAGE_PADDING, TEXT_WIDTH, handleImage, MAP_DRAWN_HEIGHT, MAP_DRAWN_WIDTH, mapElement, type OgChild, type OgElement } from "./image.ts";

// The renderer is mocked: a test never runs Satori or resvg. It records what it was handed.
// With `fail` set it draws as the real one does when Satori throws: a 200 whose body stream errors.
const rendered = vi.hoisted(() => ({
  fail: false,
  calls: [] as { element: unknown; options: { width?: number; height?: number; headers?: Record<string, string> } }[],
}));
vi.mock("@vercel/og", () => ({
  ImageResponse: class extends Response {
    constructor(element: unknown, options: { width?: number; height?: number; headers?: Record<string, string> }) {
      rendered.calls.push({ element, options });
      const body = rendered.fail
        ? new ReadableStream({
          start(controller) {
            controller.error(new Error("Satori failed"));
          },
        })
        : "png";
      super(body, { headers: { "content-type": "image/png", ...options.headers } });
    }
  },
}));

const ENV = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_ANON_KEY: "anon-key" };

function fetchReplying(status: number, body: unknown): { fetchFn: Fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchFn: Fetch = (url) => {
    calls.push(url);
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  };
  return { fetchFn, calls };
}

function isElement(child: OgChild): child is OgElement {
  return typeof child !== "string";
}

function childrenOf(node: OgElement): OgChild[] {
  const c = node.props.children;
  if (c === undefined) return [];
  return Array.isArray(c) ? c : [c];
}

/** Every element under `node`, itself included, depth first. */
function walk(node: OgElement): OgElement[] {
  return [node, ...childrenOf(node).filter(isElement).flatMap(walk)];
}

/** Every text under `node`, in order. */
function texts(node: OgElement): string[] {
  return childrenOf(node).flatMap((c) => (isElement(c) ? texts(c) : [c]));
}

describe("activationImage", () => {
  const image = activationImage(TWOFER);

  it("is 1200 by 630 on the paper colour", () => {
    expect(image.type).toBe("div");
    expect(image.key).toBeNull();
    expect(image.props.style).toMatchObject({ display: "flex", width: 1200, height: 630, backgroundColor: COLORS.paper });
  });

  it("says what the activation was, as the page does", () => {
    expect(texts(image)).toEqual([
      "Spotted activation · POTA",
      "KK4PWJ at US-1182 · US-1871",
      "Juniper Ridge Wildlife Management Area · Willow Hollow Wildlife Management Area",
      "Mon 26 Oct 2026 · 18:12–19:40 UTC · 1 h 28 min",
      "Long Lines",
      "Estimated from spots, not logs.",
      "Heard in 5 states, plus Fed. Rep. of Germany and Canada.",
    ]);
  });

  it("draws every state and a line to each heard state outside the reference's own", () => {
    const svg = walk(image).find((e) => e.type === "svg");
    expect(svg?.props).toMatchObject({ width: MAP_DRAWN_WIDTH, height: MAP_DRAWN_HEIGHT, viewBox: "0 0 975 610" });
    const nodes = svg ? walk(svg) : [];
    const paths = nodes.filter((e) => e.type === "path");
    expect(paths).toHaveLength(STATE_SHAPES.length);
    expect(paths.every((p) => typeof p.props.d === "string" && p.props.d.startsWith("M"))).toBe(true);
    const g = heardGeometry(TWOFER);
    expect(g.lines.length).toBeGreaterThan(0);
    expect(nodes.filter((e) => e.type === "line")).toHaveLength(g.lines.length);
    // A dot per line end, and the reference's own.
    expect(nodes.filter((e) => e.type === "circle")).toHaveLength(g.lines.length + 1);
  });

  it("shades the reference's own states darker than the heard ones", () => {
    const paths = walk(mapElement(TWOFER)).filter((e) => e.type === "path");
    const fillOf = (code: string) => {
      const shape = STATE_SHAPES.find((s) => s.code === code);
      return paths.find((p) => p.props.d === shape?.d)?.props;
    };
    expect(fillOf("NC")).toMatchObject({ fill: COLORS.primary, fillOpacity: 0.5 });
    expect(fillOf("VA")).toMatchObject({ fill: COLORS.primary, fillOpacity: 0.16 });
    expect(fillOf("TX")).toMatchObject({ fill: COLORS.land, fillOpacity: 1 });
  });

  it("draws no lines and says so without a location", () => {
    const iota = activationImage(IOTA);
    const nodes = walk(iota);
    expect(nodes.filter((e) => e.type === "path")).toHaveLength(STATE_SHAPES.length);
    expect(nodes.filter((e) => e.type === "line" || e.type === "circle")).toHaveLength(0);
    expect(texts(iota).slice(-2)).toEqual(["No spotter's place is known yet.", "Location not known for this reference."]);
  });

  it("leaves out the names line when no reference is named", () => {
    expect(texts(activationImage({ ...TWOFER, referenceNames: [null, null] }))).not.toContain("");
    expect(texts(activationImage({ ...TWOFER, referenceNames: [null, null] }))).toHaveLength(6);
  });

  it("clamps the heading and the names so the date line and the footer always fit", () => {
    const many = activationImage({ ...TWOFER, references: ["US-1182", "US-1871", "US-4560", "US-2730", "US-0001", "US-0002"] });
    const heading = walk(many).find((e) => e.props.children === "KK4PWJ at US-1182 · US-1871 · US-4560 · US-2730 · US-0001 · US-0002");
    expect(heading?.props.style).toMatchObject({ display: "block", lineClamp: 3 });
    const names = walk(many).find((e) => e.props.children === "Juniper Ridge Wildlife Management Area · Willow Hollow Wildlife Management Area");
    expect(names?.props.style).toMatchObject({ display: "block", lineClamp: 3 });
    const footer = walk(many).find((e) => texts(e).join("|") === "Long Lines|Estimated from spots, not logs.");
    expect(footer?.props.style).toMatchObject({ flexShrink: 0 });
    expect(texts(many)).toContain("Mon 26 Oct 2026 · 18:12–19:40 UTC · 1 h 28 min");
  });

  it("keeps the map column at the map's width and wraps a long caption within it", () => {
    const image = activationImage(TWOFER);
    const svg = walk(image).find((e) => e.type === "svg");
    const column = walk(image).find((e) => Array.isArray(e.props.children) && e.props.children.includes(svg as OgChild));
    expect(column?.props.style).toMatchObject({ width: MAP_DRAWN_WIDTH, flexShrink: 0 });
    // The two columns and the gap fill the padded width exactly, so nothing can push past the edge.
    expect(TEXT_WIDTH + COLUMN_GAP + MAP_DRAWN_WIDTH + 2 * IMAGE_PADDING).toBe(1200);
    const textColumn = image.props.children;
    expect(Array.isArray(textColumn) && typeof textColumn[0] !== "string" ? textColumn[0].props.style : undefined)
      .toMatchObject({ width: TEXT_WIDTH, flexShrink: 0 });
    const caption = walk(image).find((e) => typeof e.props.children === "string" && e.props.children.startsWith("Heard in"));
    expect(caption?.props.style).toMatchObject({ display: "block", width: MAP_DRAWN_WIDTH, lineClamp: 2, textAlign: "center" });
  });

  it("builds plain element objects", () => {
    expect(el("div", { children: "x" })).toEqual({ type: "div", key: null, props: { children: "x" } });
  });
});

describe("handleImage", () => {
  beforeEach(() => {
    rendered.calls.length = 0;
    rendered.fail = false;
  });

  it("renders the activation as a 1200 by 630 PNG, cached for 15 minutes", async () => {
    const { fetchFn, calls } = fetchReplying(200, TWOFER);
    const response = await handleImage(new Request("https://longlines.io/api/activation-image?id=kjw2khkyj47f"), ENV, fetchFn);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("public, s-maxage=900");
    expect(calls).toEqual(["https://project.supabase.co/functions/v1/spotted-activations?id=kjw2khkyj47f"]);
    expect(rendered.calls).toHaveLength(1);
    expect(rendered.calls[0]?.options).toMatchObject({ width: 1200, height: 630 });
    expect(rendered.calls[0]?.element).toEqual(activationImage(TWOFER));
  });

  it("throws when the drawing fails, so Vercel answers a 500 and never a cacheable 200", async () => {
    rendered.fail = true;
    const { fetchFn } = fetchReplying(200, TWOFER);
    await expect(handleImage(new Request("https://longlines.io/api/activation-image?id=kjw2khkyj47f"), ENV, fetchFn)).rejects.toThrow("Satori failed");
  });

  it("is a 404 for an unknown activation and renders nothing", async () => {
    const { fetchFn } = fetchReplying(404, { error: "Spotted activation not found." });
    const response = await handleImage(new Request("https://longlines.io/api/activation-image?id=kjw2khkyj47f"), ENV, fetchFn);
    expect(response.status).toBe(404);
    expect(rendered.calls).toHaveLength(0);
  });

  it("is a 404 for a malformed id before any request", async () => {
    const { fetchFn, calls } = fetchReplying(200, TWOFER);
    const response = await handleImage(new Request("https://longlines.io/api/activation-image?id=<b>"), ENV, fetchFn);
    expect(response.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("is a 500 without the environment", async () => {
    const { fetchFn, calls } = fetchReplying(200, TWOFER);
    const response = await handleImage(new Request("https://longlines.io/api/activation-image?id=kjw2khkyj47f"), {}, fetchFn);
    expect(response.status).toBe(500);
    expect(calls).toHaveLength(0);
  });
});

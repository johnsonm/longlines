// The link preview a crawler gets for /activations/<id> (and the /<callsign>/activations/<id>
// alias): a small HTML page of Open Graph and Twitter tags, a canonical link and a plain link.
// vercel.json rewrites only link-preview crawlers here (by user agent); people get the app.
// Every value is HTML-escaped: names and callsigns come from upstream feeds.

import { dateLine, documentTitle, namesLabel } from "../../src/activations/model.ts";
import { activationUrl } from "../../src/activations/paths.ts";
import { admit, CACHE_CONTROL, type EnvSource, type Fetch, type PreviewActivation, withActivation } from "./activation.ts";

/** The preview image's size: what Discord, Slack and X show large. */
export const IMAGE_WIDTH = 1200;
export const IMAGE_HEIGHT = 630;

const SITE_NAME = "Long Lines";
const ESTIMATED = "Estimated from spots, not logs.";

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
};

/** Text made safe for an HTML attribute value or element content. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** The preview image's URL for an activation. */
export function imageUrl(origin: string, id: string): string {
  return `${origin}/api/activation-image?${new URLSearchParams({ id }).toString()}`;
}

/**
 * The description: the names, the date line, then the estimate note:
 * "Eno River State Park. Thu 29 Oct 2026 · 18:12–19:40 UTC · 1 h 28 min. Estimated from spots, not logs."
 */
export function previewDescription(a: PreviewActivation): string {
  const names = namesLabel(a.referenceNames);
  return [names, dateLine(a), ESTIMATED].filter((s) => s).map((s) => (s.endsWith(".") ? s : `${s}.`)).join(" ");
}

function meta(attribute: "property" | "name", key: string, content: string): string {
  return `<meta ${attribute}="${key}" content="${escapeHtml(content)}">`;
}

/** The whole page for one activation; `origin` is the site's ("https://longlines.io"). */
export function previewHtml(a: PreviewActivation, origin: string): string {
  const url = activationUrl(origin, a.id);
  const title = documentTitle(a);
  const description = previewDescription(a);
  const tags = [
    meta("property", "og:type", "website"),
    meta("property", "og:site_name", SITE_NAME),
    meta("property", "og:title", title),
    meta("property", "og:description", description),
    meta("property", "og:url", url),
    meta("property", "og:image", imageUrl(origin, a.id)),
    meta("property", "og:image:type", "image/png"),
    meta("property", "og:image:width", String(IMAGE_WIDTH)),
    meta("property", "og:image:height", String(IMAGE_HEIGHT)),
    meta("property", "og:image:alt", `Map of where ${a.callsign} was heard`),
    meta("name", "twitter:card", "summary_large_image"),
    meta("name", "description", description),
  ];
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    `<title>${escapeHtml(title)}</title>`,
    `<link rel="canonical" href="${escapeHtml(url)}">`,
    ...tags,
    "</head>",
    "<body>",
    `<p><a href="${escapeHtml(url)}">${escapeHtml(title)}</a></p>`,
    `<p>${escapeHtml(description)}</p>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** GET /api/activation-preview?id=<id>. */
export async function handlePreview(request: Request, env: EnvSource, fetchFn: Fetch): Promise<Response> {
  const admitted = admit(request, env);
  if ("refused" in admitted) return admitted.refused;
  const origin = new URL(request.url).origin;
  return withActivation(admitted, fetchFn, (a) =>
    new Response(previewHtml(a, origin), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": CACHE_CONTROL },
    }));
}

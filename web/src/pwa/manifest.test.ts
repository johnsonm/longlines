import { describe, expect, it } from "vitest";

// Read at transform time by Vite so no Node APIs are needed.
const MANIFEST: string = Object.values(
  import.meta.glob("../../public/manifest.webmanifest", { query: "?raw", import: "default", eager: true }),
)[0] as string;
const INDEX_HTML: string = Object.values(
  import.meta.glob("../../index.html", { query: "?raw", import: "default", eager: true }),
)[0] as string;
// Keys only: a lazy glob lists the files without loading them.
const PUBLIC_FILES = new Set(Object.keys(import.meta.glob("../../public/*.png")).map((p) => p.replace("../../public", "")));

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
}

const manifest = JSON.parse(MANIFEST) as Record<string, unknown> & { icons: ManifestIcon[] };

describe("manifest.webmanifest", () => {
  it("describes a standalone app rooted at /", () => {
    expect(manifest).toMatchObject({
      name: "Long Lines",
      short_name: "Long Lines",
      description: "Alerts when the stations you follow are spotted on POTA, SOTA, RBN and the DX Cluster.",
      display: "standalone",
      start_url: "/",
      scope: "/",
      theme_color: "#1976d2",
      background_color: "#ffffff",
    });
  });

  it("lists 192 and 512 icons for both purposes", () => {
    const pairs = manifest.icons.map((i) => `${i.sizes} ${i.purpose}`).sort();
    expect(pairs).toEqual(["192x192 any", "192x192 maskable", "512x512 any", "512x512 maskable"]);
    for (const icon of manifest.icons) expect(icon.type).toBe("image/png");
  });

  it("points only at icons that exist", () => {
    for (const icon of manifest.icons) expect(PUBLIC_FILES).toContain(icon.src);
  });
});

describe("index.html install tags", () => {
  it("links the manifest and the Apple icon, and both exist", () => {
    expect(INDEX_HTML).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(INDEX_HTML).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    expect(PUBLIC_FILES).toContain("/apple-touch-icon.png");
    expect(PUBLIC_FILES).toContain("/badge-72.png");
  });

  it("has a theme colour for each colour scheme and the standalone meta", () => {
    expect(INDEX_HTML).toMatch(/<meta name="theme-color" content="#[0-9a-f]{6}" media="\(prefers-color-scheme: light\)" \/>/);
    expect(INDEX_HTML).toMatch(/<meta name="theme-color" content="#[0-9a-f]{6}" media="\(prefers-color-scheme: dark\)" \/>/);
    expect(INDEX_HTML).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
  });
});

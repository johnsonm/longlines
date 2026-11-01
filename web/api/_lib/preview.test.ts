import { describe, expect, it, vi } from "vitest";
import { COUNTRIES, IOTA, SINGLE, TWOFER } from "../../src/activations/fixtures.ts";
import type { SpottedActivation } from "../../src/activations/types.ts";
import { type Fetch, parseActivation, previewEnv, UpstreamError, withActivation } from "./activation.ts";
import { escapeHtml, handlePreview, imageUrl, previewDescription, previewHtml } from "./preview.ts";

const ENV = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_ANON_KEY: "anon-key" };
const DISCORDBOT = "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)";

function request(url: string, init: RequestInit = {}): Request {
  return new Request(url, { ...init, headers: { "User-Agent": DISCORDBOT, ...init.headers } });
}

/** A fetch that answers every call with one reply, recording what it was asked. */
function fetchReplying(status: number, body: unknown): { fetchFn: Fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn: Fetch = (url, init) => {
    calls.push({ url, init });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return Promise.resolve(new Response(text, { status, headers: { "Content-Type": "application/json" } }));
  };
  return { fetchFn, calls };
}

function metaContent(html: string, key: string): string | null {
  const match = new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)">`).exec(html);
  return match?.[1] ?? null;
}

describe("previewHtml", () => {
  const html = previewHtml(TWOFER, "https://longlines.io");

  it("carries the Open Graph and Twitter tags", () => {
    expect(metaContent(html, "og:title")).toBe("KK4PWJ at US-1182 · US-1871 · Spotted activation");
    expect(metaContent(html, "og:site_name")).toBe("Long Lines");
    expect(metaContent(html, "og:type")).toBe("website");
    expect(metaContent(html, "og:url")).toBe("https://longlines.io/activations/kjw2khkyj47f");
    expect(metaContent(html, "og:image")).toBe("https://longlines.io/api/activation-image?id=kjw2khkyj47f");
    expect(metaContent(html, "og:image:width")).toBe("1200");
    expect(metaContent(html, "og:image:height")).toBe("630");
    expect(metaContent(html, "og:image:type")).toBe("image/png");
    expect(metaContent(html, "twitter:card")).toBe("summary_large_image");
    expect(metaContent(html, "og:description")).toBe(
      "Juniper Ridge Wildlife Management Area · Willow Hollow Wildlife Management Area. "
        + "Mon 26 Oct 2026 · 18:12–19:40 UTC · 1 h 28 min. Estimated from spots, not logs.",
    );
  });

  it("links the canonical page", () => {
    expect(html).toContain("<link rel=\"canonical\" href=\"https://longlines.io/activations/kjw2khkyj47f\">");
    expect(html).toContain("<a href=\"https://longlines.io/activations/kjw2khkyj47f\">");
    expect(html.startsWith("<!doctype html>")).toBe(true);
  });

  it("describes an activation without names or a duration", () => {
    expect(previewDescription({ ...SINGLE, referenceNames: [null] })).toBe("Wed 28 Oct 2026 · 17:20 UTC. Estimated from spots, not logs.");
  });

  it("escapes every value from the feeds", () => {
    const hostile: SpottedActivation = {
      ...TWOFER,
      id: "kjw2khkyj47f",
      callsign: "K1\"><script>alert(1)</script>",
      references: ["US-1182'&"],
      referenceNames: ["<img src=x onerror=alert(1)>", "Tom & Jerry's \"Park\""],
    };
    const page = previewHtml(hostile, "https://longlines.io");
    expect(page).not.toContain("<script");
    expect(page).not.toContain("<img");
    expect(page).toContain("K1&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(page).toContain("Tom &amp; Jerry&#39;s &quot;Park&quot;");
    expect(page).toContain("US-1182&#39;&amp;");
  });
});

describe("escapeHtml and imageUrl", () => {
  it("escapes the five HTML characters and nothing else", () => {
    expect(escapeHtml(`<a href="x">Tom & 'Jerry'</a> · –`)).toBe("&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt; · –");
  });

  it("encodes the id", () => {
    expect(imageUrl("https://longlines.io", "a&b")).toBe("https://longlines.io/api/activation-image?id=a%26b");
  });
});

describe("handlePreview", () => {
  it("answers a crawler with the page, cached for 15 minutes", async () => {
    const { fetchFn, calls } = fetchReplying(200, TWOFER);
    const response = await handlePreview(request("https://longlines.io/api/activation-preview?id=kjw2khkyj47f"), ENV, fetchFn);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=900");
    expect(metaContent(await response.text(), "og:url")).toBe("https://longlines.io/activations/kjw2khkyj47f");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://project.supabase.co/functions/v1/spotted-activations?id=kjw2khkyj47f");
    expect(calls[0]?.init.headers).toEqual({ apikey: "anon-key" });
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses the request's origin, so a preview deployment links to itself", async () => {
    const { fetchFn } = fetchReplying(200, TWOFER);
    const response = await handlePreview(request("https://web-git-branch.vercel.app/api/activation-preview?id=kjw2khkyj47f"), ENV, fetchFn);
    expect(metaContent(await response.text(), "og:image")).toBe("https://web-git-branch.vercel.app/api/activation-image?id=kjw2khkyj47f");
  });

  it("links the canonical id when the function followed a redirect", async () => {
    const { fetchFn } = fetchReplying(200, { ...TWOFER, id: "bbbbbbbbbbbb" });
    const response = await handlePreview(request("https://longlines.io/api/activation-preview?id=aaaaaaaaaaaa"), ENV, fetchFn);
    const html = await response.text();
    expect(metaContent(html, "og:url")).toBe("https://longlines.io/activations/bbbbbbbbbbbb");
    expect(metaContent(html, "og:image")).toBe("https://longlines.io/api/activation-image?id=bbbbbbbbbbbb");
  });

  it("is a 404 when the function does not know the activation", async () => {
    const { fetchFn } = fetchReplying(404, { error: "Spotted activation not found." });
    const response = await handlePreview(request("https://longlines.io/api/activation-preview?id=kjw2khkyj47f"), ENV, fetchFn);
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("Spotted activation not found.\n");
  });

  it.each([["missing", "https://longlines.io/api/activation-preview"], ["too short", "https://longlines.io/api/activation-preview?id=abc"], [
    "not base32",
    "https://longlines.io/api/activation-preview?id=KJW2KHKYJ47F",
  ], ["a path", "https://longlines.io/api/activation-preview?id=..%2F..%2Fapi"]])("is a 404 before any request for an id %s", async (_label, url) => {
    const { fetchFn, calls } = fetchReplying(200, TWOFER);
    const response = await handlePreview(request(url), ENV, fetchFn);
    expect(response.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("is a 500 without the Supabase environment, before any request", async () => {
    const { fetchFn, calls } = fetchReplying(200, TWOFER);
    const response = await handlePreview(request("https://longlines.io/api/activation-preview?id=kjw2khkyj47f"), { SUPABASE_URL: "https://x.supabase.co" }, fetchFn);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Link previews are not configured.\n");
    expect(calls).toHaveLength(0);
  });

  it("refuses other methods", async () => {
    const { fetchFn, calls } = fetchReplying(200, TWOFER);
    const response = await handlePreview(request("https://longlines.io/api/activation-preview?id=kjw2khkyj47f", { method: "POST" }), ENV, fetchFn);
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD");
    expect(calls).toHaveLength(0);
  });

  it("answers HEAD like GET", async () => {
    const { fetchFn } = fetchReplying(200, TWOFER);
    const response = await handlePreview(request("https://longlines.io/api/activation-preview?id=kjw2khkyj47f", { method: "HEAD" }), ENV, fetchFn);
    expect(response.status).toBe(200);
  });

  it.each([
    ["another 404", 404, { error: "Requested function was not found" }],
    ["a 500", 500, { error: "Spotted activations are unavailable right now." }],
    ["a 429", 429, { error: "Too many lookups." }],
    ["a body that is not JSON", 200, "<html>"],
    ["a malformed payload", 200, { ...TWOFER, references: "US-1182" }],
  ])("is a 502 for %s", async (_label, status, body) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { fetchFn } = fetchReplying(status, body);
    const response = await handlePreview(request("https://longlines.io/api/activation-preview?id=kjw2khkyj47f"), ENV, fetchFn);
    expect(response.status).toBe(502);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]?.[0])).not.toContain("kjw2khkyj47f");
    errors.mockRestore();
  });

  it("is a 502 when the request fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchFn: Fetch = () => Promise.reject(new TypeError("fetch failed"));
    const response = await handlePreview(request("https://longlines.io/api/activation-preview?id=kjw2khkyj47f"), ENV, fetchFn);
    expect(response.status).toBe(502);
    errors.mockRestore();
  });

  it("lets an error that is not the function's through", async () => {
    const { fetchFn } = fetchReplying(200, TWOFER);
    const broken = (): Response => {
      throw new RangeError("bug");
    };
    await expect(withActivation({ env: { supabaseUrl: "https://x", anonKey: "k" }, id: "kjw2khkyj47f" }, fetchFn, broken)).rejects
      .toThrow(RangeError);
  });
});

describe("previewEnv", () => {
  it("reads the integration's names and trims a trailing slash", () => {
    expect(previewEnv(ENV)).toEqual({ supabaseUrl: "https://project.supabase.co", anonKey: "anon-key" });
    expect(previewEnv({ VITE_SUPABASE_URL: "https://a.co/", VITE_SUPABASE_ANON_KEY: "k" })).toEqual({ supabaseUrl: "https://a.co", anonKey: "k" });
    expect(previewEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://b.co", SUPABASE_PUBLISHABLE_KEY: "p" })).toEqual({ supabaseUrl: "https://b.co", anonKey: "p" });
    expect(previewEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://b.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "n" })?.anonKey).toBe("n");
    expect(previewEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://b.co", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "q" })?.anonKey).toBe("q");
  });

  it("is null without either value", () => {
    expect(previewEnv({})).toBeNull();
    expect(previewEnv({ SUPABASE_ANON_KEY: "k" })).toBeNull();
    expect(previewEnv({ SUPABASE_URL: "https://a.co", SUPABASE_ANON_KEY: "" })).toBeNull();
  });
});

describe("parseActivation", () => {
  it("reads every fixture the function returned", () => {
    for (const a of [TWOFER, COUNTRIES, IOTA, SINGLE]) {
      const parsed = parseActivation(JSON.parse(JSON.stringify(a)));
      expect(parsed.id).toBe(a.id);
      expect(parsed.heard).toEqual(a.heard);
      expect(parsed.location).toEqual(a.location);
      expect(parsed.referenceNames).toEqual(a.referenceNames);
    }
  });

  it.each([
    ["a list", []],
    ["no id", { ...TWOFER, id: 7 }],
    ["an unknown program", { ...TWOFER, program: "bota" }],
    ["a reference that is not text", { ...TWOFER, references: [1] }],
    ["a name that is not text", { ...TWOFER, referenceNames: [1] }],
    ["a duration that is not a number", { ...TWOFER, durationSeconds: "5280" }],
    ["an infinite duration", { ...TWOFER, durationSeconds: Number.POSITIVE_INFINITY }],
    ["a location without states", { ...TWOFER, location: { latitude: 1, longitude: 2 } }],
    ["a location that is text", { ...TWOFER, location: "NC" }],
    ["a place of another kind", { ...TWOFER, heard: [{ kind: "grid", code: "FM05", name: null, latitude: null, longitude: null, spots: 1 }] }],
    ["a place without spots", { ...TWOFER, heard: [{ kind: "state", code: "NC", name: null, latitude: null, longitude: null }] }],
    ["a place that is not one", { ...TWOFER, heard: ["NC"] }],
  ])("refuses %s", (_label, body) => {
    expect(() => parseActivation(body)).toThrow(UpstreamError);
  });
});

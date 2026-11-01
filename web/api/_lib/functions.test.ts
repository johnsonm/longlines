// The two function files and vercel.json: what Vercel deploys. The handlers' behaviour is tested
// beside them (preview.test.ts, image.test.ts); this checks the wiring.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TWOFER } from "../../src/activations/fixtures.ts";
import imageFunction from "../activation-image.ts";
import previewFunction from "../activation-preview.ts";

vi.mock("@vercel/og", () => ({
  ImageResponse: class extends Response {
    constructor(_element: unknown, options: { headers?: Record<string, string> }) {
      super("png", { headers: { "content-type": "image/png", ...options.headers } });
    }
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function stubFunction(): string[] {
  vi.stubEnv("SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("SUPABASE_ANON_KEY", "anon-key");
  const calls: string[] = [];
  vi.stubGlobal("fetch", (url: string) => {
    calls.push(url);
    return Promise.resolve(new Response(JSON.stringify(TWOFER), { headers: { "Content-Type": "application/json" } }));
  });
  return calls;
}

describe("the function files", () => {
  it("serve the preview with the Web-standard fetch export, reading process.env and the global fetch", async () => {
    const calls = stubFunction();
    const response = await previewFunction.fetch(new Request("https://longlines.io/api/activation-preview?id=kjw2khkyj47f"));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("og:title");
    expect(calls).toEqual(["https://project.supabase.co/functions/v1/spotted-activations?id=kjw2khkyj47f"]);
  });

  it("serve the image the same way", async () => {
    stubFunction();
    const response = await imageFunction.fetch(new Request("https://longlines.io/api/activation-image?id=kjw2khkyj47f"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
  });
});

interface Rewrite {
  source: string;
  destination: string;
  has?: { type: string; key?: string; value: string }[];
}

function rewrites(): Rewrite[] {
  const config: unknown = JSON.parse(readFileSync(new URL("../../vercel.json", import.meta.url), "utf8"));
  if (typeof config !== "object" || config === null || !("rewrites" in config) || !Array.isArray(config.rewrites)) {
    throw new Error("vercel.json has no rewrites");
  }
  return config.rewrites.flatMap((r: unknown): Rewrite[] => {
    if (typeof r !== "object" || r === null || !("source" in r) || !("destination" in r)) return [];
    if (typeof r.source !== "string" || typeof r.destination !== "string") return [];
    const has = "has" in r && Array.isArray(r.has) ? r.has.flatMap((h: unknown) => {
      if (typeof h !== "object" || h === null || !("type" in h) || !("value" in h)) return [];
      if (typeof h.type !== "string" || typeof h.value !== "string") return [];
      return [{ type: h.type, value: h.value, ...("key" in h && typeof h.key === "string" ? { key: h.key } : {}) }];
    }) : undefined;
    return [{ source: r.source, destination: r.destination, ...(has ? { has } : {}) }];
  });
}

const CRAWLERS = [
  "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
  "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
  "Twitterbot/1.0",
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  "TelegramBot (like TwitterBot)",
  "WhatsApp/2.23.20.0",
  "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
  "Mastodon/4.3.0 (http.rb/5.2.0; +https://mastodon.social/)",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 (Applebot/0.1)",
  "Mozilla/5.0 (compatible; Bluesky Cardyb/1.1; +mailto:support@bsky.app)",
];
const PEOPLE = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0",
];

describe("vercel.json", () => {
  const all = rewrites();
  const previews = all.filter((r) => r.destination === "/api/activation-preview?id=:id");

  it("sends crawlers on both activation paths to the preview, ahead of the app's catch-all", () => {
    expect(previews.map((r) => r.source)).toEqual(["/activations/:id", "/:call/activations/:id"]);
    const catchAll = all.findIndex((r) => r.source === "/(.*)");
    expect(catchAll).toBe(all.length - 1);
    for (const r of previews) expect(all.indexOf(r)).toBeLessThan(catchAll);
  });

  it("matches link-preview crawlers by user agent and never a browser", () => {
    for (const r of previews) {
      expect(r.has).toHaveLength(1);
      const header = r.has?.[0];
      expect(header?.type).toBe("header");
      expect(header?.key).toBe("user-agent");
      const pattern = new RegExp(`^${header?.value ?? "(?!)"}$`);
      for (const ua of CRAWLERS) expect(pattern.test(ua), ua).toBe(true);
      for (const ua of PEOPLE) expect(pattern.test(ua), ua).toBe(false);
    }
  });
});

// The Discord mock-up's renderer for the plain line SQL builds
// (discord_plain_line): only **bold** and [text](url), the two pieces of
// markup SQL ever writes. Anything else, including a token the
// 190-character clip cut in half, stays literal text. It returns React
// nodes, never HTML. Also the mock-up's colour and time helpers.

import { createElement, Fragment, type ComponentType, type ReactNode } from "react";

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "bold"; children: Segment[] }
  | { kind: "link"; url: string; children: Segment[] };

/** Only http(s) targets become links; anything else stays text. */
function safeUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url);
}

/** Splits text into segments; bold may hold links and a link's text may hold bold. */
export function parseDiscordMarkdown(text: string): Segment[] {
  const out: Segment[] = [];
  let plain = "";
  const flush = () => {
    if (plain) out.push({ kind: "text", text: plain });
    plain = "";
  };
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ kind: "bold", children: parseDiscordMarkdown(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (text[i] === "[") {
      const close = text.indexOf("](", i + 1);
      const end = close === -1 ? -1 : text.indexOf(")", close + 2);
      if (close > i + 1 && end !== -1) {
        const url = text.slice(close + 2, end);
        if (safeUrl(url)) {
          flush();
          out.push({ kind: "link", url, children: parseDiscordMarkdown(text.slice(i + 1, close)) });
          i = end + 1;
          continue;
        }
      }
    }
    plain += text[i];
    i += 1;
  }
  flush();
  return out;
}

export interface MarkdownComponents {
  Bold: ComponentType<{ children?: ReactNode }>;
  Link: ComponentType<{ href: string; target: string; rel: string; children?: ReactNode }>;
}

function renderSegments(segments: Segment[], components: MarkdownComponents, prefix: string): ReactNode[] {
  return segments.map((s, i) => {
    const key = `${prefix}${i}`;
    switch (s.kind) {
      case "text":
        return createElement(Fragment, { key }, s.text);
      case "bold":
        return createElement(components.Bold, { key }, ...renderSegments(s.children, components, `${key}.`));
      case "link":
        return createElement(
          components.Link,
          { key, href: s.url, target: "_blank", rel: "noopener noreferrer" },
          ...renderSegments(s.children, components, `${key}.`),
        );
    }
  });
}

/** The plain line as React nodes, bold and links drawn with the given components. */
export function renderDiscordMarkdown(text: string, components: MarkdownComponents): ReactNode[] {
  return renderSegments(parseDiscordMarkdown(text), components, "");
}

/** discord_color as a CSS hex colour. */
export function colorHex(color: number): string {
  return `#${Math.max(0, Math.min(0xffffff, Math.trunc(color))).toString(16).padStart(6, "0")}`;
}

/** Discord's own stamp for a message posted today, such as "Today at 1:42 PM". */
export function todayAt(now: Date): string {
  return `Today at ${now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

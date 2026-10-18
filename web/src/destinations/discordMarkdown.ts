// The Discord mock-up's renderer for what SQL writes in a message
// (discord_spot_fields): **bold** and [text](url), the two pieces of markup
// SQL ever writes, and backslash escapes, since discord_escape puts a
// backslash before every markdown character in a value. As in Discord, a
// backslash before ASCII punctuation is dropped and the character is
// literal, so it never opens or closes bold or opens a link; a backslash
// before anything else stays. A link's text is matched as Discord matches
// it, where backslashes mean nothing (LINK_TEXT). Anything else, including a token the clip cut in
// half, stays literal text. It returns React nodes, never HTML. Also the
// mock-up's colour and time helpers.

import { createElement, Fragment, type ComponentType, type ReactNode } from "react";

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "bold"; children: Segment[] }
  | { kind: "link"; url: string; children: Segment[] };

/** Only http(s) targets become links; anything else stays text. */
function safeUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url);
}

/** Whether text[i] is a backslash that escapes the next character (ASCII punctuation, as in Discord). */
function escapes(text: string, i: number): boolean {
  return text[i] === "\\" && i + 1 < text.length && /[!-/:-@[-`{-~]/.test(text[i + 1] ?? "");
}

/** The first `token` at or after `from` that no backslash escapes, or -1. */
function findUnescaped(text: string, token: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    if (escapes(text, i)) {
      i += 1;
      continue;
    }
    if (text.startsWith(token, i)) return i;
  }
  return -1;
}

// A masked link's text as Discord's parser (simple-markdown) matches it:
// bracket pairs, any character but a bracket, or a ']' that a later ']'
// closes before any '['. Backslashes mean nothing here (they are dropped
// only when the text is parsed again), so an escaped '[' with no ']' after
// it ends the match and the link fails, as it does in Discord.
const LINK_TEXT = /^\[((?:\[[^\]]*\]|[^[\]]|\](?=[^[]*\]))*)\]\(/;

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
    if (escapes(text, i)) {
      plain += text[i + 1];
      i += 2;
      continue;
    }
    if (text.startsWith("**", i)) {
      const end = findUnescaped(text, "**", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ kind: "bold", children: parseDiscordMarkdown(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (text[i] === "[") {
      const inside = LINK_TEXT.exec(text.slice(i));
      const close = inside ? i + 1 + (inside[1] ?? "").length : -1;
      const end = close === -1 ? -1 : findUnescaped(text, ")", close + 2);
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

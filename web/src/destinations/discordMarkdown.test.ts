import { describe, expect, it } from "vitest";
import { parseDiscordMarkdown } from "./discordMarkdown";

const URL = "https://app.longlines.io/call/KK4PWJ";

describe("parseDiscordMarkdown", () => {
  it("leaves plain text alone", () => {
    expect(parseDiscordMarkdown("K1ABC · 14.062 MHz")).toEqual([{ kind: "text", text: "K1ABC · 14.062 MHz" }]);
    expect(parseDiscordMarkdown("")).toEqual([]);
  });

  it("parses a bold first field holding the profile link", () => {
    expect(parseDiscordMarkdown(`**[KK4PWJ](${URL})** · 14.062 MHz · CW`)).toEqual([
      { kind: "bold", children: [{ kind: "link", url: URL, children: [{ kind: "text", text: "KK4PWJ" }] }] },
      { kind: "text", text: " · 14.062 MHz · CW" },
    ]);
  });

  it("parses a labelled bold field and a later link", () => {
    expect(parseDiscordMarkdown(`**State: NC**, Callsign: [KK4PWJ](${URL})`)).toEqual([
      { kind: "bold", children: [{ kind: "text", text: "State: NC" }] },
      { kind: "text", text: ", Callsign: " },
      { kind: "link", url: URL, children: [{ kind: "text", text: "KK4PWJ" }] },
    ]);
  });

  it("keeps bold inside link text", () => {
    expect(parseDiscordMarkdown(`[**K1**](${URL})`)).toEqual([
      { kind: "link", url: URL, children: [{ kind: "bold", children: [{ kind: "text", text: "K1" }] }] },
    ]);
  });

  it("keeps a token the clip cut in half as text", () => {
    expect(parseDiscordMarkdown("**[KK4PWJ](https://app.lo")).toEqual([{ kind: "text", text: "**[KK4PWJ](https://app.lo" }]);
    expect(parseDiscordMarkdown("a ** b")).toEqual([{ kind: "text", text: "a ** b" }]);
    expect(parseDiscordMarkdown("****")).toEqual([{ kind: "text", text: "****" }]);
    expect(parseDiscordMarkdown("[](x) [a]b")).toEqual([{ kind: "text", text: "[](x) [a]b" }]);
  });

  it("never links a non-http target", () => {
    expect(parseDiscordMarkdown("[x](javascript:alert(1))")).toEqual([{ kind: "text", text: "[x](javascript:alert(1))" }]);
  });

  it("keeps newlines in text", () => {
    expect(parseDiscordMarkdown("**K1**\n14.062 MHz")).toEqual([
      { kind: "bold", children: [{ kind: "text", text: "K1" }] },
      { kind: "text", text: "\n14.062 MHz" },
    ]);
  });
});

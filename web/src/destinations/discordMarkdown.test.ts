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

  it("drops a backslash before ASCII punctuation and keeps the character literal", () => {
    expect(parseDiscordMarkdown("\\*\\*K1\\*\\* \\[x\\]\\(https://a.example\\)")).toEqual([
      { kind: "text", text: "**K1** [x](https://a.example)" },
    ]);
    expect(parseDiscordMarkdown("a\\\\b")).toEqual([{ kind: "text", text: "a\\b" }]);
    expect(parseDiscordMarkdown("\\- 1\\. \\<\\@x\\>")).toEqual([{ kind: "text", text: "- 1. <@x>" }]);
  });

  it("keeps a backslash before anything but ASCII punctuation, and a trailing one", () => {
    expect(parseDiscordMarkdown("a\\b \\é \\")).toEqual([{ kind: "text", text: "a\\b \\é \\" }]);
  });

  it("never lets an escaped character close bold or a link", () => {
    expect(parseDiscordMarkdown("**a\\**")).toEqual([{ kind: "text", text: "**a**" }]);
    expect(parseDiscordMarkdown("**a\\*\\*b**")).toEqual([{ kind: "bold", children: [{ kind: "text", text: "a**b" }] }]);
    expect(parseDiscordMarkdown(`[a\\]b](${URL})`)).toEqual([
      { kind: "link", url: URL, children: [{ kind: "text", text: "a]b" }] },
    ]);
  });

  // Discord's link text ignores backslashes (simple-markdown's grammar):
  // only bracket pairs, non-brackets and a ']' that a later ']' closes.
  it("matches link text as Discord does, ignoring escapes", () => {
    const profile = "https://app.longlines.io/call/K1ABC";
    expect(parseDiscordMarkdown(`**[K1ABC/\\[](${profile})**`)).toEqual([
      { kind: "bold", children: [{ kind: "text", text: `[K1ABC/[](${profile})` }] },
    ]);
    expect(parseDiscordMarkdown(`[a [b] c](${URL})`)).toEqual([
      { kind: "link", url: URL, children: [{ kind: "text", text: "a [b] c" }] },
    ]);
    expect(parseDiscordMarkdown(`[a\\](${URL})`)).toEqual([
      { kind: "link", url: URL, children: [{ kind: "text", text: "a\\" }] },
    ]);
    expect(parseDiscordMarkdown(`[a](${URL}) · [b](${URL})`)).toEqual([
      { kind: "link", url: URL, children: [{ kind: "text", text: "a" }] },
      { kind: "text", text: " · " },
      { kind: "link", url: URL, children: [{ kind: "text", text: "b" }] },
    ]);
  });

  // SQL's line for DX Cluster's 'K1ABC/[' (20261018000200): no link, since
  // Discord would not draw one.
  it("renders SQL's line for a callsign with a bracket as bold text", () => {
    expect(parseDiscordMarkdown("**K1ABC/\\[** · 14.062 MHz · CW · DX Cluster")).toEqual([
      { kind: "bold", children: [{ kind: "text", text: "K1ABC/[" }] },
      { kind: "text", text: " · 14.062 MHz · CW · DX Cluster" },
    ]);
  });

  // preview_discord_message on the local db (20261018000100) for a POTA spot
  // whose callsign, spotter and park name are hostile markdown; the strings
  // are SQL's discord_line, byte for byte.
  it("renders SQL's escaped plain line as Discord shows it", () => {
    expect(
      parseDiscordMarkdown(
        "**\\*\\*K1\\*X\\_\\[Y\\]\\(https://evil.example\\)** · 14.062 MHz · CW · POTA · US-2763 · \\- \\*\\*Pwn\\*\\* \\[click\\]\\(javascript:alert\\(1\\)\\) \\\\ end",
      ),
    ).toEqual([
      { kind: "bold", children: [{ kind: "text", text: "**K1*X_[Y](https://evil.example)" }] },
      { kind: "text", text: " · 14.062 MHz · CW · POTA · US-2763 · - **Pwn** [click](javascript:alert(1)) \\ end" },
    ]);
    expect(
      parseDiscordMarkdown(
        "**Spotter: \\<\\@everyone\\>\\#W1\\~\\~AW\\`**\nCallsign: \\*\\*K1\\*X\\_\\[Y\\]\\(https://evil.example\\)\nPlace name: \\- \\*\\*Pwn\\*\\* \\[click\\]\\(javascript:alert\\(1\\)\\) \\\\ end",
      ),
    ).toEqual([
      { kind: "bold", children: [{ kind: "text", text: "Spotter: <@everyone>#W1~~AW`" }] },
      { kind: "text", text: "\nCallsign: **K1*X_[Y](https://evil.example)\nPlace name: - **Pwn** [click](javascript:alert(1)) \\ end" },
    ]);
  });

  it("renders SQL's escaped link text inside the profile link", () => {
    const profile = "https://app.longlines.io/call/K1ABC";
    expect(
      parseDiscordMarkdown(
        `**[K1ABC/\\*\\*](${profile})** · 14.062 MHz · CW · POTA · US-2763 · 1\\. \\[Park\\]\\(https://evil.example\\) \\<\\#123\\>`,
      ),
    ).toEqual([
      { kind: "bold", children: [{ kind: "link", url: profile, children: [{ kind: "text", text: "K1ABC/**" }] }] },
      { kind: "text", text: " · 14.062 MHz · CW · POTA · US-2763 · 1. [Park](https://evil.example) <#123>" },
    ]);
  });
});

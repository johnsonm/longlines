import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import type { DiscordPreview } from "../lib/api";
import { DiscordMockup } from "./DiscordMockup";
import { colorHex, todayAt } from "./discordMarkdown";

const PROFILE = "https://longlines.io/call/N0CALL";
const NOW = new Date(2026, 9, 18, 13, 42);

const CARD: DiscordPreview = {
  discord_style: "card",
  discord_title: "N0CALL · 14.062 MHz · CW",
  discord_description: "POTA · US-0000\nTest Park",
  discord_grid: [{ name: "Band", value: "20m" }, { name: "Spotter", value: "W1AW" }],
  discord_footer: "POTA, 17:42 UTC",
  discord_color: 0x3ba55c,
  discord_url: PROFILE,
  discord_line: `**[N0CALL](${PROFILE})** · 14.062 MHz · CW`,
  discord_suppress_embeds: false,
};

// preview_discord_message('{}') on the local db (20261018000100) for a POTA
// spot whose callsign, spotter and park name are hostile markdown: SQL's
// keys byte for byte, every value escaped by discord_escape.
const HOSTILE: DiscordPreview = {
  discord_style: "card",
  discord_title: "\\*\\*K1\\*X\\_\\[Y\\]\\(https://evil.example\\) · 14.062 MHz · CW",
  discord_description: "POTA · US-2763 · \\- \\*\\*Pwn\\*\\* \\[click\\]\\(javascript:alert\\(1\\)\\) \\\\ end · NC",
  discord_grid: [{ name: "Band", value: "20m" }, { name: "Spotter", value: "\\<\\@everyone\\>\\#W1\\~\\~AW\\`" }],
  discord_footer: "POTA · 17:42 UTC",
  discord_color: 3066993,
  discord_url: null,
  discord_line:
    "**\\*\\*K1\\*X\\_\\[Y\\]\\(https://evil.example\\)** · 14.062 MHz · CW · POTA · US-2763 · \\- \\*\\*Pwn\\*\\* \\[click\\]\\(javascript:alert\\(1\\)\\) \\\\ end",
  discord_suppress_embeds: false,
};

// The same for a spot whose call is linkable (its base call is K1ABC) but
// whose text is not, so the escaped text sits inside the profile links.
const LINKED: DiscordPreview = {
  discord_style: "card",
  discord_title: "K1ABC/\\*\\* · 14.062 MHz · CW",
  discord_description: "POTA · US-2763 · 1\\. \\[Park\\]\\(https://evil.example\\) \\<\\#123\\> · NC",
  discord_grid: [{ name: "Band", value: "20m" }, { name: "Spotter", value: "W1AW" }],
  discord_footer: "POTA · 17:42 UTC",
  discord_color: 3066993,
  discord_url: "https://longlines.io/call/K1ABC",
  discord_line:
    "**[K1ABC/\\*\\*](https://longlines.io/call/K1ABC)** · 14.062 MHz · CW · POTA · US-2763 · 1\\. \\[Park\\]\\(https://evil.example\\) \\<\\#123\\>",
  discord_suppress_embeds: false,
};

const figure = () => within(screen.getByRole("figure", { name: "Discord message" }));

describe("DiscordMockup", () => {
  it("shows the author row with the APP badge and today's time", () => {
    renderPage(<DiscordMockup preview={CARD} now={NOW} />);
    expect(figure().getByText("Long Lines")).toBeInTheDocument();
    expect(figure().getByText("APP")).toBeInTheDocument();
    expect(figure().getByText("Today at 1:42 PM")).toBeInTheDocument();
  });

  it("draws the card from SQL's keys", () => {
    renderPage(<DiscordMockup preview={CARD} now={NOW} />);
    const title = figure().getByRole("link", { name: "N0CALL · 14.062 MHz · CW" });
    expect(title).toHaveAttribute("href", PROFILE);
    expect(title).toHaveAttribute("target", "_blank");
    expect(title).toHaveAttribute("rel", "noopener noreferrer");
    expect(figure().getByText(/POTA · US-0000/).textContent).toBe("POTA · US-0000\nTest Park");
    expect(figure().getByText("Band")).toBeInTheDocument();
    expect(figure().getByText("20m")).toBeInTheDocument();
    expect(figure().getByText("Spotter")).toBeInTheDocument();
    expect(figure().getByText("W1AW")).toBeInTheDocument();
    expect(figure().getByText("POTA, 17:42 UTC")).toBeInTheDocument();
    expect(screen.getByTestId("discord-embed")).toHaveStyle({ borderLeft: "4px solid #3ba55c" });
    expect(screen.queryByTestId("discord-line")).not.toBeInTheDocument();
  });

  it("leaves out a plain title's link, an empty description, grid and footer", () => {
    renderPage(
      <DiscordMockup preview={{ ...CARD, discord_url: null, discord_description: "", discord_grid: [], discord_footer: null }} now={NOW} />,
    );
    expect(figure().getByText("N0CALL · 14.062 MHz · CW")).toBeInTheDocument();
    expect(figure().queryByRole("link")).not.toBeInTheDocument();
    expect(figure().queryByText("Band")).not.toBeInTheDocument();
    expect(figure().queryByText("POTA, 17:42 UTC")).not.toBeInTheDocument();
  });

  it("draws the title as text when its URL is not http(s)", () => {
    renderPage(<DiscordMockup preview={{ ...CARD, discord_url: "javascript:alert(1)" }} now={NOW} />);
    expect(figure().getByText("N0CALL · 14.062 MHz · CW")).toBeInTheDocument();
    expect(figure().queryByRole("link", { name: "N0CALL · 14.062 MHz · CW" })).not.toBeInTheDocument();
  });

  it("draws the plain line with bold and a new-tab link", () => {
    renderPage(<DiscordMockup preview={{ ...CARD, discord_style: "plain" }} now={NOW} />);
    const line = screen.getByTestId("discord-line");
    expect(line).toHaveTextContent("N0CALL · 14.062 MHz · CW");
    const link = within(line).getByRole("link", { name: "N0CALL" });
    expect(link).toHaveAttribute("href", PROFILE);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link.closest("strong")).not.toBeNull();
    expect(line.textContent).not.toContain("**");
    expect(screen.queryByTestId("discord-embed")).not.toBeInTheDocument();
  });

  it("shows a placeholder before the first preview", () => {
    renderPage(<DiscordMockup preview={null} now={NOW} />);
    expect(figure().getByText("…")).toBeInTheDocument();
  });

  it("formats the colour and the time", () => {
    expect(colorHex(0)).toBe("#000000");
    expect(colorHex(0x5865f2)).toBe("#5865f2");
    expect(colorHex(-5)).toBe("#000000");
    expect(colorHex(0x1ffffff)).toBe("#ffffff");
    expect(todayAt(new Date(2026, 9, 18, 9, 5))).toBe("Today at 9:05 AM");
  });

  it("draws SQL's escaped card values as Discord shows them, with no markup", () => {
    renderPage(<DiscordMockup preview={HOSTILE} now={NOW} />);
    const embed = screen.getByTestId("discord-embed");
    expect(figure().getByText("**K1*X_[Y](https://evil.example) · 14.062 MHz · CW")).toBeInTheDocument();
    expect(figure().getByText("POTA · US-2763 · - **Pwn** [click](javascript:alert(1)) \\ end · NC")).toBeInTheDocument();
    expect(figure().getByText("<@everyone>#W1~~AW`")).toBeInTheDocument();
    expect(within(embed).queryByRole("link")).not.toBeInTheDocument();
    expect(embed.querySelector("strong")).toBeNull();
    expect(embed.textContent).not.toContain("\\*");
  });

  it("draws SQL's escaped plain line with only SQL's own bold", () => {
    renderPage(<DiscordMockup preview={{ ...HOSTILE, discord_style: "plain" }} now={NOW} />);
    const line = screen.getByTestId("discord-line");
    expect(line.textContent).toBe(
      "**K1*X_[Y](https://evil.example) · 14.062 MHz · CW · POTA · US-2763 · - **Pwn** [click](javascript:alert(1)) \\ end",
    );
    expect(within(line).queryByRole("link")).not.toBeInTheDocument();
    const bold = line.querySelectorAll("strong");
    expect(bold).toHaveLength(1);
    expect(bold[0]?.textContent).toBe("**K1*X_[Y](https://evil.example)");
  });

  it("keeps escaped text inside the title and plain-line profile links", () => {
    const { unmount } = renderPage(<DiscordMockup preview={LINKED} now={NOW} />);
    const title = figure().getByRole("link", { name: "K1ABC/** · 14.062 MHz · CW" });
    expect(title).toHaveAttribute("href", "https://longlines.io/call/K1ABC");
    expect(figure().getByText("POTA · US-2763 · 1. [Park](https://evil.example) <#123> · NC")).toBeInTheDocument();
    expect(figure().getAllByRole("link")).toHaveLength(1);
    unmount();
    renderPage(<DiscordMockup preview={{ ...LINKED, discord_style: "plain" }} now={NOW} />);
    const line = screen.getByTestId("discord-line");
    const link = within(line).getByRole("link", { name: "K1ABC/**" });
    expect(link).toHaveAttribute("href", "https://longlines.io/call/K1ABC");
    expect(within(line).getAllByRole("link")).toHaveLength(1);
    expect(line.textContent).toBe("K1ABC/** · 14.062 MHz · CW · POTA · US-2763 · 1. [Park](https://evil.example) <#123>");
  });

  it("drops a masked link from a card title but keeps its text", () => {
    renderPage(<DiscordMockup preview={{ ...CARD, discord_url: null, discord_title: "[K1](https://a.example) **b**" }} now={NOW} />);
    expect(figure().queryByRole("link")).not.toBeInTheDocument();
    expect(figure().getByText("b").tagName).toBe("STRONG");
  });
});

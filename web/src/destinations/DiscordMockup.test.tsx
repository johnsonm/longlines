import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import type { DiscordPreview } from "../lib/api";
import { DiscordMockup } from "./DiscordMockup";
import { colorHex, todayAt } from "./discordMarkdown";

const PROFILE = "https://app.longlines.io/call/N0CALL";
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
});

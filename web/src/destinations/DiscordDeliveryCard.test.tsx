import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderPage } from "../test/render";
import type { DiscordSettings } from "../lib/api";
import { DEFAULT_SETTINGS } from "./discordModel";
import { DiscordDeliveryCard } from "./DiscordDeliveryCard";

vi.mock("../lib/api", () => ({}));

function render(overrides: Partial<DiscordSettings> = {}) {
  const onChange = vi.fn();
  const r = renderPage(<DiscordDeliveryCard settings={{ ...DEFAULT_SETTINGS, ...overrides }} onChange={onChange} />);
  return { ...r, onChange };
}

describe("DiscordDeliveryCard", () => {
  it("shows the header, the Messages select and the rate-limit note", () => {
    render();
    expect(screen.getByText("Delivery")).toBeInTheDocument();
    expect(screen.getByText("How messages are sent")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Messages" })).toHaveTextContent("One message per spot");
    expect(screen.getByText("Or group spots into one message every 10, 30 or 60 seconds, up to 10 spots each.")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Discord allows about 30 messages a minute per webhook. If a connection is busier than that, spots are grouped automatically so none are dropped.",
    );
    // No pause row (spec decision 9).
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("shows the stored window", () => {
    render({ batch_seconds: 30 });
    expect(screen.getByRole("combobox", { name: "Messages" })).toHaveTextContent("Group spots every 30 seconds");
  });

  it("offers every option and reports the pick as a number", async () => {
    const { user, onChange } = render();
    await user.click(screen.getByRole("combobox", { name: "Messages" }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "One message per spot",
      "Group spots every 10 seconds",
      "Group spots every 30 seconds",
      "Group spots every 60 seconds",
    ]);
    await user.click(screen.getByRole("option", { name: "Group spots every 60 seconds" }));
    expect(onChange).toHaveBeenCalledWith({ batch_seconds: 60 });
  });
});

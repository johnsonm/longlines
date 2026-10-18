import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { useState } from "react";
import { renderPage } from "../test/render";
import { DiscordChannelCard } from "./DiscordChannelCard";

vi.mock("../lib/api", () => ({}));

const ERROR = "That is a channel link, not a webhook URL. A webhook URL starts with https://discord.com/api/webhooks/";

function Harness({ urlDisplay, initial, spy }: { urlDisplay: string | null; initial: string | null; spy: (u: string | null) => void }) {
  const [url, setUrl] = useState<string | null>(initial);
  return <DiscordChannelCard urlDisplay={urlDisplay} url={url} onUrlChange={(u) => { spy(u); setUrl(u); }} />;
}

describe("DiscordChannelCard", () => {
  it("shows the masked URL and Replace URL when editing", async () => {
    const onUrlChange = vi.fn();
    const { user } = renderPage(<DiscordChannelCard urlDisplay="https://discord.com/api/webhooks/123/••••" url={null} onUrlChange={onUrlChange} />);
    expect(screen.getByText("Discord channel")).toBeInTheDocument();
    expect(screen.getByText("Where messages are posted")).toBeInTheDocument();
    const code = screen.getByText("https://discord.com/api/webhooks/123/••••");
    expect(code.tagName).toBe("CODE");
    expect(screen.getByText("Treat the URL like a password. Anyone who has it can post to the channel. It is hidden after saving.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Webhook URL")).not.toBeInTheDocument();
    expect(screen.queryByText("Get a webhook URL from Discord")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Replace URL" }));
    expect(onUrlChange).toHaveBeenCalledWith("");
  });

  it("shows the field, the help box and the warning for a new destination", () => {
    renderPage(<DiscordChannelCard urlDisplay={null} url="" onUrlChange={vi.fn()} />);
    expect(screen.getByLabelText("Webhook URL")).toHaveValue("");
    expect(screen.getByText("Get a webhook URL from Discord")).toBeInTheDocument();
    const items = within(screen.getByRole("list")).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual([
      "Open the channel settings and choose Integrations.",
      "Choose Webhooks, then New Webhook.",
      "Copy the webhook URL and paste it here.",
    ]);
    expect(screen.getByText("Treat the URL like a password. Anyone who has it can post to the channel.")).toBeInTheDocument();
    expect(screen.queryByText(ERROR)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Replace URL" })).not.toBeInTheDocument();
  });

  it("treats a null url with no stored URL as a new, empty field", () => {
    renderPage(<DiscordChannelCard urlDisplay={null} url={null} onUrlChange={vi.fn()} />);
    expect(screen.getByLabelText("Webhook URL")).toHaveValue("");
  });

  it("flags a channel link and clears the error for a webhook URL", async () => {
    const spy = vi.fn();
    const { user } = renderPage(<Harness urlDisplay={null} initial="" spy={spy} />);
    const field = screen.getByLabelText("Webhook URL");
    await user.type(field, "https://discord.com/channels/1/2");
    expect(screen.getByText(ERROR)).toBeInTheDocument();
    expect(field).toHaveAttribute("aria-invalid", "true");
    await user.clear(field);
    expect(screen.queryByText(ERROR)).not.toBeInTheDocument();
    await user.type(field, "https://discord.com/api/webhooks/1/abc");
    expect(screen.queryByText(ERROR)).not.toBeInTheDocument();
    expect(field).toHaveAttribute("aria-invalid", "false");
    expect(spy).toHaveBeenLastCalledWith("https://discord.com/api/webhooks/1/abc");
  });

  it("opens an empty field after Replace URL", async () => {
    const spy = vi.fn();
    const { user } = renderPage(<Harness urlDisplay="https://discord.com/api/webhooks/123/••••" initial={null} spy={spy} />);
    await user.click(screen.getByRole("button", { name: "Replace URL" }));
    expect(screen.getByLabelText("Webhook URL")).toHaveValue("");
    expect(screen.queryByText("https://discord.com/api/webhooks/123/••••")).not.toBeInTheDocument();
    expect(screen.getByText("Get a webhook URL from Discord")).toBeInTheDocument();
    expect(screen.getByText("Treat the URL like a password. Anyone who has it can post to the channel.")).toBeInTheDocument();
  });

  it("moves focus to the Webhook URL field after Replace URL", async () => {
    const { user } = renderPage(<Harness urlDisplay="https://discord.com/api/webhooks/123/••••" initial={null} spy={vi.fn()} />);
    screen.getByRole("button", { name: "Replace URL" }).focus();
    await user.keyboard("{Enter}");
    expect(screen.getByLabelText("Webhook URL")).toHaveFocus();
  });

  it("does not take focus on a new destination", () => {
    renderPage(<DiscordChannelCard urlDisplay={null} url="" onUrlChange={vi.fn()} />);
    expect(screen.getByLabelText("Webhook URL")).not.toHaveFocus();
    expect(screen.queryByRole("button", { name: "Keep current URL" })).not.toBeInTheDocument();
  });

  it("closes the field with Keep current URL", async () => {
    const spy = vi.fn();
    const { user } = renderPage(<Harness urlDisplay="https://discord.com/api/webhooks/123/••••" initial={null} spy={spy} />);
    await user.click(screen.getByRole("button", { name: "Replace URL" }));
    await user.type(screen.getByLabelText("Webhook URL"), "https://discord.com/channels/1/2");
    await user.click(screen.getByRole("button", { name: "Keep current URL" }));
    expect(spy).toHaveBeenLastCalledWith(null);
    expect(screen.queryByLabelText("Webhook URL")).not.toBeInTheDocument();
    expect(screen.getByText("https://discord.com/api/webhooks/123/••••")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replace URL" })).toBeInTheDocument();
  });
});

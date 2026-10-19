import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import { DestinationDialog } from "./DestinationDialog";

function render() {
  const onClose = vi.fn();
  const r = renderPage(<DestinationDialog open onClose={onClose} />, { route: "/destinations" });
  return { ...r, onClose, dialog: screen.getByRole("dialog") };
}

describe("DestinationDialog", () => {
  it("is the type picker with its page 5 copy and nothing else", () => {
    const { dialog } = render();
    expect(within(dialog).getByText("Add destination")).toBeInTheDocument();
    expect(within(dialog).getByText(/Pick where matching spots should go\. You can add as many of each type as you like, for example one push destination per source or per device\./))
      .toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /^Discord channel/ })).toBeChecked();
    expect(within(dialog).getByText("Post each spot to a channel through a webhook.")).toBeInTheDocument();
    expect(within(dialog).getByText("Send each spot as JSON to your own URL.")).toBeInTheDocument();
    expect(within(dialog).getByText("Notify your phone or computer. Works in the browser, no app to install.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Continue" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
  });

  it.each([
    ["Discord channel", "discord"],
    ["Webhook", "webhook"],
    ["Push notification", "push"],
  ])("continues with %s into its editor and closes", async (label, type) => {
    const { user, dialog, onClose } = render();
    await user.click(within(dialog).getByRole("radio", { name: new RegExp(`^${label}`) }));
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    expect(onClose).toHaveBeenCalled();
    const location = screen.getByTestId("location");
    expect(location).toHaveTextContent("/destinations/new");
    expect(location).toHaveAttribute("data-search", `?type=${type}`);
  });

  it("cancels and starts over on Discord", async () => {
    const { user, dialog, onClose } = render();
    await user.click(within(dialog).getByRole("radio", { name: /^Webhook/ }));
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("location")).toHaveTextContent("/destinations");
    // The parent keeps it open here; the dialog itself went back to Discord.
    expect(within(dialog).getByRole("radio", { name: /^Discord channel/ })).toBeChecked();
  });
});

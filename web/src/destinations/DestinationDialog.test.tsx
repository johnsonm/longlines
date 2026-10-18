import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import { createDestination } from "../lib/api";
import { DestinationDialog } from "./DestinationDialog";

vi.mock("../lib/api", () => ({ createDestination: vi.fn() }));

beforeEach(() => {
  vi.mocked(createDestination).mockReset();
});

function render() {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  const r = renderPage(<DestinationDialog open onClose={onClose} onCreated={onCreated} />, { route: "/destinations" });
  return { ...r, onClose, onCreated, dialog: screen.getByRole("dialog") };
}

describe("DestinationDialog", () => {
  it("starts with the type picker and its page 5 copy", () => {
    const { dialog } = render();
    expect(within(dialog).getByText("Add destination")).toBeInTheDocument();
    expect(within(dialog).getByText(/Pick where matching spots should go\. You can add as many of each type as you like, for example one push destination per source or per device\./))
      .toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /^Discord channel/ })).toBeChecked();
    expect(within(dialog).getByText("Post each spot to a channel through a webhook.")).toBeInTheDocument();
    expect(within(dialog).getByText("Send each spot as JSON to your own URL.")).toBeInTheDocument();
    expect(within(dialog).getByText("Notify your phone or computer. Works in the browser, no app to install.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Continue" })).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Name")).not.toBeInTheDocument();
  });

  it("continues with Discord into its editor and closes", async () => {
    const { user, dialog, onClose } = render();
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    expect(onClose).toHaveBeenCalled();
    expect(createDestination).not.toHaveBeenCalled();
    const location = screen.getByTestId("location");
    expect(location).toHaveTextContent("/destinations/new");
    expect(location).toHaveAttribute("data-search", "?type=discord");
  });

  it("goes on to the webhook details and adds the destination", async () => {
    vi.mocked(createDestination).mockResolvedValue({ id: "n", type: "webhook", name: "Hook", url_display: "x", signing_secret: "whsec_1" });
    const { user, dialog, onCreated } = render();
    await user.click(within(dialog).getByRole("radio", { name: /^Webhook/ }));
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    expect(within(dialog).getByText("Webhook")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Discord webhook URL")).not.toBeInTheDocument();
    const add = within(dialog).getByRole("button", { name: "Add destination" });
    expect(add).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Name"), "Hook");
    await user.type(within(dialog).getByLabelText("Endpoint URL"), "https://example.com/spots");
    await user.click(add);
    expect(createDestination).toHaveBeenCalledWith("webhook", "Hook", "https://example.com/spots");
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "n" })));
  });

  it("goes on to the webhook details", async () => {
    const { user, dialog } = render();
    await user.click(within(dialog).getByRole("radio", { name: /^Webhook/ }));
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    expect(within(dialog).getByLabelText("Endpoint URL")).toBeInTheDocument();
    expect(within(dialog).getByText("We'll show the signing secret once the destination is added.")).toBeInTheDocument();
  });

  it("continues with push into the editor and closes", async () => {
    const { user, dialog, onClose } = render();
    await user.click(within(dialog).getByRole("radio", { name: /^Push notification/ }));
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    expect(onClose).toHaveBeenCalled();
    expect(createDestination).not.toHaveBeenCalled();
    const location = screen.getByTestId("location");
    expect(location).toHaveTextContent("/destinations/new");
    expect(location).toHaveAttribute("data-search", "?type=push");
  });

  it("cancels from either step and starts over on the picker", async () => {
    const { user, dialog, onClose } = render();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(within(dialog).getByRole("radio", { name: /^Webhook/ }));
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    // The parent keeps it open here; the dialog itself went back to the picker with Discord selected.
    expect(within(dialog).getByRole("radio", { name: /^Discord channel/ })).toBeChecked();
    expect(within(dialog).getByRole("button", { name: "Continue" })).toBeInTheDocument();
  });
});

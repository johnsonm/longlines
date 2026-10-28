import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import { setMobile } from "../test/media";
import { deleteRelayToken, loadRelayTokens, type RelayToken } from "../lib/api";
import { RelayTokensCard } from "./RelayTokensCard";
import { RELAY_DOWNLOAD_URL } from "./model";

vi.mock("../lib/api", () => ({
  loadRelayTokens: vi.fn(),
  deleteRelayToken: vi.fn(),
}));

const RELAY: RelayToken = {
  id: "r1", user_id: "u1", token_prefix: "ll_relay_k3q", device_name: "SHACK-PC", client_version: "0.1.0",
  scopes: ["contacts:write"], created_at: "2026-10-28T00:00:00Z", last_used_at: null,
};

beforeEach(() => {
  setMobile(false);
  vi.mocked(loadRelayTokens).mockReset().mockResolvedValue([RELAY]);
  vi.mocked(deleteRelayToken).mockReset().mockResolvedValue(undefined);
});

const render = () => renderPage(<RelayTokensCard />, { route: "/api-tokens" });

describe("RelayTokensCard", () => {
  it("lists signed-in relays by computer with their version and dates", async () => {
    render();
    const row = (await screen.findByText("SHACK-PC")).closest("tr")!;
    expect(within(row).getByText("ll_relay_k3q… · version 0.1.0")).toBeInTheDocument();
    expect(within(row).getByText("Oct 28, 2026")).toBeInTheDocument();
    expect(within(row).getByText("Never")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Long Lines Relay" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Get the relay" })).toHaveAttribute("href", RELAY_DOWNLOAD_URL);
  });

  it("says when no relay is connected", async () => {
    vi.mocked(loadRelayTokens).mockResolvedValueOnce([]);
    render();
    expect(await screen.findByText("No relays connected.")).toBeInTheDocument();
  });

  it("shows a failed load with Retry, and recovers", async () => {
    vi.mocked(loadRelayTokens).mockRejectedValueOnce(new Error("offline"));
    const { user } = render();
    expect(await screen.findByText("offline")).toBeInTheDocument();
    expect(screen.queryByText("No relays connected.")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("SHACK-PC")).toBeInTheDocument();
    expect(loadRelayTokens).toHaveBeenCalledTimes(2);
  });

  it("revokes a relay after confirming", async () => {
    const { user, app } = render();
    await user.click(await screen.findByRole("button", { name: "Revoke SHACK-PC" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("SHACK-PC stops posting your logged contacts right away and signs out.")).toBeInTheDocument();
    vi.mocked(loadRelayTokens).mockResolvedValueOnce([]);
    await user.click(within(dialog).getByRole("button", { name: "Revoke" }));
    expect(deleteRelayToken).toHaveBeenCalledWith("r1");
    expect(await screen.findByText("No relays connected.")).toBeInTheDocument();
    expect(app.notify).toHaveBeenCalledWith("Relay revoked.");
  });

  it("keeps the relay when revoking is cancelled", async () => {
    const { user } = render();
    await user.click(await screen.findByRole("button", { name: "Revoke SHACK-PC" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(deleteRelayToken).not.toHaveBeenCalled();
  });

  it("says when revoking fails", async () => {
    vi.mocked(deleteRelayToken).mockRejectedValueOnce(new Error("Couldn't disconnect the relay."));
    const { user, app } = render();
    await user.click(await screen.findByRole("button", { name: "Revoke SHACK-PC" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Couldn't disconnect the relay."));
    expect(screen.getByText("SHACK-PC")).toBeInTheDocument();
  });
});

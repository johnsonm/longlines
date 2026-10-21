import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import { setMobile } from "../test/media";
import { createApiToken, deleteApiToken, loadApiTokens, rotateApiToken, type ApiToken } from "../lib/api";
import { ApiTokensPage } from "./ApiTokensPage";
import { API_DOCS_URL, expiresLabel, scopeLabel } from "./model";

vi.mock("../lib/api", () => ({
  loadApiTokens: vi.fn(),
  createApiToken: vi.fn(),
  rotateApiToken: vi.fn(),
  deleteApiToken: vi.fn(),
}));

const TOKEN: ApiToken = {
  id: "t1", user_id: "u1", name: "Club Discord bot", scope: "write", token_prefix: "ll_live_7hq2", lifetime_days: 365,
  expires_at: "2099-09-02T00:00:00Z", created_at: "2026-09-02T00:00:00Z", rotated_at: null, last_used_at: null,
};

beforeEach(() => {
  setMobile(false);
  vi.mocked(loadApiTokens).mockReset().mockResolvedValue([TOKEN]);
  vi.mocked(createApiToken).mockReset().mockResolvedValue("ll_live_secret");
  vi.mocked(rotateApiToken).mockReset().mockResolvedValue("ll_live_rotated");
  vi.mocked(deleteApiToken).mockReset().mockResolvedValue(undefined);
});

const render = () => renderPage(<ApiTokensPage />, { route: "/api-tokens" });

describe("ApiTokensPage", () => {
  it("lists tokens by prefix with their permissions and dates", async () => {
    render();
    const row = (await screen.findByText("Club Discord bot")).closest("tr")!;
    expect(within(row).getByText("ll_live_7hq2…")).toBeInTheDocument();
    expect(within(row).getByText("Read and write")).toBeInTheDocument();
    expect(within(row).getByText("Sep 2, 2026")).toBeInTheDocument();
    expect(within(row).getByText("Never")).toBeInTheDocument();
    expect(within(row).getByText("Sep 2, 2099")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "API docs" })).toHaveAttribute("href", API_DOCS_URL);
    expect(screen.getByText(/Limit: 60 requests per minute per token/)).toBeInTheDocument();
  });

  it("says when there are no tokens", async () => {
    vi.mocked(loadApiTokens).mockResolvedValueOnce([]);
    render();
    expect(await screen.findByText("No tokens yet.")).toBeInTheDocument();
  });

  it("shows a failed load in the table with Retry instead of the empty state, and recovers", async () => {
    vi.mocked(loadApiTokens).mockRejectedValueOnce(new Error("offline"));
    const { user } = render();
    expect(await screen.findByText("offline")).toBeInTheDocument();
    expect(screen.queryByText("No tokens yet.")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Club Discord bot")).toBeInTheDocument();
    expect(screen.queryByText("offline")).not.toBeInTheDocument();
    expect(loadApiTokens).toHaveBeenCalledTimes(2);
  });

  it("hides a stale list when the reload after an action fails", async () => {
    vi.mocked(loadApiTokens).mockResolvedValueOnce([TOKEN]).mockRejectedValueOnce(new Error("offline"));
    const { user } = render();
    await user.click(await screen.findByRole("button", { name: "Revoke Club Discord bot" }));
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    expect(await screen.findByText("offline")).toBeInTheDocument();
    expect(screen.queryByText("Club Discord bot")).not.toBeInTheDocument();
  });

  it("creates a token and shows the secret once", async () => {
    const { user } = render();
    await user.click(screen.getByRole("button", { name: "New token" }));
    const dialog = screen.getByRole("dialog");
    const create = within(dialog).getByRole("button", { name: "Create token" });
    expect(create).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Name"), " Club roster sync ");
    await user.click(within(dialog).getByRole("combobox", { name: "Access" }));
    await user.click(screen.getByRole("option", { name: "Read and write" }));
    await user.click(within(dialog).getByRole("combobox", { name: "Expires" }));
    await user.click(screen.getByRole("option", { name: "In 90 days" }));
    await user.click(create);
    expect(createApiToken).toHaveBeenCalledWith("Club roster sync", "write", 90);
    expect(await screen.findByLabelText("Token")).toHaveValue("ll_live_secret");
    expect(screen.getByText("Copy this token now. You won't see it again.")).toBeInTheDocument();
    // Only Done closes it: the token can't be shown again.
    await user.keyboard("{Escape}");
    // The token dialog's own backdrop: the create dialog's may still be in the DOM, closing.
    await user.click(screen.getByLabelText("Token").closest(".MuiDialog-root")!.querySelector(".MuiBackdrop-root")!);
    expect(screen.getByLabelText("Token")).toHaveValue("ll_live_secret");
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByLabelText("Token")).not.toBeInTheDocument());
    expect(loadApiTokens).toHaveBeenCalledTimes(2);
  });

  it("defaults to a read-only token that never expires", async () => {
    const { user } = render();
    await user.click(screen.getByRole("button", { name: "New token" }));
    await user.type(screen.getByLabelText("Name"), "Board");
    await user.click(screen.getByRole("button", { name: "Create token" }));
    expect(createApiToken).toHaveBeenCalledWith("Board", "read", null);
  });

  it("copies the secret to the clipboard", async () => {
    const { user, app } = render();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    await user.click(await screen.findByRole("button", { name: "Rotate Club Discord bot" }));
    await user.click(screen.getByRole("button", { name: "Rotate" }));
    await user.click(await screen.findByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("ll_live_rotated");
    expect(app.notify).toHaveBeenCalledWith("Token copied.");
  });

  it("rotates after confirming", async () => {
    const { user } = render();
    await user.click(await screen.findByRole("button", { name: "Rotate Club Discord bot" }));
    expect(screen.getByText("Scripts using the current token stop working right away. You'll get a new one to copy.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Rotate" }));
    expect(rotateApiToken).toHaveBeenCalledWith("t1");
    expect(await screen.findByLabelText("Token")).toHaveValue("ll_live_rotated");
  });

  it("revokes after confirming, and can be cancelled", async () => {
    const { user, app } = render();
    await user.click(await screen.findByRole("button", { name: "Revoke Club Discord bot" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(deleteApiToken).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Revoke Club Discord bot" }));
    expect(screen.getByText("Revoke this token?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    expect(deleteApiToken).toHaveBeenCalledWith("t1");
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Token revoked."));
  });

  it("reports a failed action", async () => {
    vi.mocked(deleteApiToken).mockRejectedValue(new Error("nope"));
    const { user, app } = render();
    await user.click(await screen.findByRole("button", { name: "Revoke Club Discord bot" }));
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("nope"));
  });

  it("renders on a phone", async () => {
    setMobile(true);
    render();
    expect(await screen.findByText("Club Discord bot")).toBeInTheDocument();
  });
});

describe("token labels", () => {
  it("names the scope and the expiry", () => {
    expect(scopeLabel("read")).toBe("Read only");
    expect(scopeLabel("write")).toBe("Read and write");
    const now = new Date("2026-10-13T00:00:00Z");
    expect(expiresLabel(null, now)).toBe("Never");
    expect(expiresLabel("2026-10-01T00:00:00Z", now)).toBe("Expired");
    expect(expiresLabel("2027-01-11T00:00:00Z", now)).toBe("Jan 11, 2027");
  });
});

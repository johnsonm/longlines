import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderPage } from "../test/render";
import { updatePassword } from "../lib/api";
import { SetPasswordPage } from "./SetPasswordPage";

vi.mock("../lib/api", () => ({ updatePassword: vi.fn() }));

beforeEach(() => {
  vi.mocked(updatePassword).mockReset().mockResolvedValue(undefined);
});

describe("SetPasswordPage", () => {
  it("validates length and confirmation", async () => {
    const { user } = renderPage(<SetPasswordPage />, { route: "/set-password" });
    await user.type(screen.getByLabelText("New password"), "short");
    await user.type(screen.getByLabelText("Confirm new password"), "other");
    expect(screen.getByText("Use at least 8 characters.")).toBeInTheDocument();
    expect(screen.getByText("Passwords don't match.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set password" })).toBeDisabled();
  });

  it("sets the password and goes to Sources", async () => {
    const { user, app } = renderPage(<SetPasswordPage />, { route: "/set-password" });
    await user.type(screen.getByLabelText("New password"), "hunter22");
    await user.type(screen.getByLabelText("Confirm new password"), "hunter22");
    await user.click(screen.getByRole("button", { name: "Set password" }));
    expect(updatePassword).toHaveBeenCalledWith("hunter22");
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/home"));
    expect(app.notify).toHaveBeenCalledWith("Password changed");
  });

  it("does nothing when submitted while invalid", async () => {
    const { user } = renderPage(<SetPasswordPage />, { route: "/set-password" });
    await user.type(screen.getByLabelText("New password"), "short{Enter}");
    expect(updatePassword).not.toHaveBeenCalled();
  });

  it("shows the update error", async () => {
    vi.mocked(updatePassword).mockRejectedValue(new Error("Password is too weak"));
    const { user } = renderPage(<SetPasswordPage />, { route: "/set-password" });
    await user.type(screen.getByLabelText("New password"), "hunter22");
    await user.type(screen.getByLabelText("Confirm new password"), "hunter22");
    await user.click(screen.getByRole("button", { name: "Set password" }));
    expect(await screen.findByText("Password is too weak")).toBeInTheDocument();
  });

  it("warns when the recovery link produced no session", async () => {
    const { user } = renderPage(<SetPasswordPage />, { route: "/set-password", app: { session: null } });
    expect(screen.getByText(/This link has expired or was already used/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to sign in" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/signin");
  });
});

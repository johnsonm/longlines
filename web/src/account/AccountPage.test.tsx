import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { PROFILE, renderPage } from "../test/render";
import { deleteAccount, signOut, updateEmail, updatePassword, updateProfile, verifyPassword } from "../lib/api";
import { pushCleanup } from "../pwa/push";
import { AccountPage } from "./AccountPage";

vi.mock("../lib/api", () => ({
  deleteAccount: vi.fn(),
  signOut: vi.fn(),
  updateEmail: vi.fn(),
  updateProfile: vi.fn(),
  updatePassword: vi.fn(),
  verifyPassword: vi.fn(),
}));
vi.mock("../pwa/push", () => ({ pushCleanup: vi.fn() }));

beforeEach(() => {
  for (const fn of [deleteAccount, signOut, updateEmail, updateProfile, updatePassword, verifyPassword]) {
    vi.mocked(fn).mockReset().mockResolvedValue(undefined);
  }
});

const render = (overrides: Parameters<typeof renderPage>[1] = {}) =>
  renderPage(<AccountPage profile={PROFILE} />, { route: "/account", ...overrides });

describe("AccountPage profile", () => {
  it("enables Save only when something changed and the callsign is valid", async () => {
    const { user } = render();
    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save).toBeDisabled();
    const callsign = screen.getByLabelText("Callsign");
    await user.clear(callsign);
    await user.type(callsign, "abc");
    expect(screen.getByText("Enter a valid amateur callsign, like KK4PWJ.")).toBeInTheDocument();
    expect(save).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(callsign).toHaveValue("KK4PWJ");
  });

  it("saves profile fields and refreshes", async () => {
    const { user, app } = render();
    await user.type(screen.getByLabelText("Name"), " Jr");
    await user.click(screen.getByLabelText("Show spot times in UTC"));
    await user.click(screen.getByRole("combobox", { name: "Time zone" }));
    await user.click(screen.getByRole("option", { name: "Asia/Tokyo" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(updateProfile).toHaveBeenCalledWith("u1", { callsign: "KK4PWJ", name: "Brad Jr", timezone: "Asia/Tokyo", utc_times: false });
    expect(updateEmail).not.toHaveBeenCalled();
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Saved changes"));
    expect(app.refreshProfile).toHaveBeenCalled();
  });

  it("asks the user to confirm a changed email", async () => {
    const { user, app } = render();
    const email = screen.getByLabelText("Email");
    await user.clear(email);
    await user.type(email, "new@example.com");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Saved. Check new@example.com to confirm the change."));
    expect(updateEmail).toHaveBeenCalledWith("new@example.com");
  });

  it("refreshes the saved profile and says so when only the email change fails", async () => {
    vi.mocked(updateEmail).mockRejectedValue(new Error("Email rate limit exceeded"));
    const { user, app } = render();
    await user.type(screen.getByLabelText("Name"), " Jr");
    const email = screen.getByLabelText("Email");
    await user.clear(email);
    await user.type(email, "new@example.com");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Saved your profile, but your email didn't change. Email rate limit exceeded"));
    expect(updateProfile).toHaveBeenCalled();
    expect(app.refreshProfile).toHaveBeenCalled();
  });

  it("says the email didn't change when the failure has no message", async () => {
    vi.mocked(updateEmail).mockRejectedValue(new Error(""));
    const { user, app } = render();
    const email = screen.getByLabelText("Email");
    await user.clear(email);
    await user.type(email, "new@example.com");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Saved your profile, but your email didn't change."));
    expect(app.refreshProfile).toHaveBeenCalled();
  });

  it("reports save errors", async () => {
    vi.mocked(updateProfile).mockRejectedValue(new Error("That callsign is already taken."));
    const { user, app } = render();
    await user.type(screen.getByLabelText("Name"), "x");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("That callsign is already taken."));
  });

  it("keeps an unlisted time zone selectable", () => {
    renderPage(<AccountPage profile={{ ...PROFILE, timezone: "Pacific/Honolulu" }} />, { route: "/account" });
    expect(screen.getByRole("combobox", { name: "Time zone" })).toHaveTextContent("Pacific/Honolulu");
  });

  it("adopts a new profile as the baseline after a save", async () => {
    function Harness() {
      const [profile, setProfile] = useState(PROFILE);
      return (
        <>
          <button onClick={() => setProfile({ ...PROFILE, name: "Renamed" })}>refresh</button>
          <AccountPage profile={profile} />
        </>
      );
    }
    const { user } = renderPage(<Harness />, { route: "/account" });
    await user.type(screen.getByLabelText("Name"), "x");
    await user.click(screen.getByRole("button", { name: "refresh" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Renamed");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });
});

describe("AccountPage sessions", () => {
  it("signs out other devices, keeping this browser's push device", async () => {
    const { user, app } = render();
    await user.click(screen.getByRole("button", { name: "Sign out other devices" }));
    expect(signOut).toHaveBeenCalledWith("others");
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Signed out of all other devices"));
  });

  it("signs out here with the push cleanup", async () => {
    const { user } = render();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(signOut).toHaveBeenCalledWith("local", pushCleanup);
  });

  it("reports sign-out failures", async () => {
    vi.mocked(signOut).mockRejectedValue(new Error(""));
    const { user, app } = render();
    await user.click(screen.getByRole("button", { name: "Sign out other devices" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Couldn't sign out other devices."));
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Couldn't sign out."));
  });
});

describe("AccountPage delete", () => {
  async function openConfirm() {
    const r = render();
    await r.user.click(screen.getByRole("button", { name: "Delete account" }));
    return { ...r, dialog: await screen.findByRole("dialog") };
  }

  it("requires typing the callsign, then deletes and signs out", async () => {
    const { user, app, dialog } = await openConfirm();
    const confirm = within(dialog).getByRole("button", { name: "Delete account" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByRole("textbox"), "kk4pwj");
    await user.click(confirm);
    expect(deleteAccount).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/signin"));
    expect(app.setSignInNotice).toHaveBeenCalledWith("Your account was deleted. You can create a new one any time.");
    expect(signOut).toHaveBeenCalledWith("local", pushCleanup);
  });

  it("reports a failed delete", async () => {
    vi.mocked(deleteAccount).mockRejectedValue(new Error("Couldn't delete your account. Try again."));
    const { user, app, dialog } = await openConfirm();
    await user.type(within(dialog).getByRole("textbox"), "KK4PWJ");
    await user.click(within(dialog).getByRole("button", { name: "Delete account" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Couldn't delete your account. Try again."));
  });

  it("can be cancelled", async () => {
    const { user, dialog } = await openConfirm();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(deleteAccount).not.toHaveBeenCalled();
  });
});

describe("ChangePassword", () => {
  async function fill(user: ReturnType<typeof render>["user"], next = "hunter22", confirm = next) {
    await user.type(screen.getByLabelText("Current password"), "oldpass1");
    await user.type(screen.getByLabelText("New password"), next);
    await user.type(screen.getByLabelText("Confirm new password"), confirm);
  }

  it("validates the new password", async () => {
    const { user } = render();
    await fill(user, "short", "other");
    expect(screen.getByText("Use at least 8 characters.")).toBeInTheDocument();
    expect(screen.getByText("Passwords don't match.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change password" })).toBeDisabled();
  });

  it("verifies the current password before changing it", async () => {
    const { user, app } = render();
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(verifyPassword).toHaveBeenCalledWith("kk4pwj@example.com", "oldpass1");
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Password changed"));
    expect(updatePassword).toHaveBeenCalledWith("hunter22");
    expect(screen.getByLabelText("Current password")).toHaveValue("");
  });

  it("does not change the password when verification fails", async () => {
    vi.mocked(verifyPassword).mockRejectedValue(new Error("That callsign or email and password don't match."));
    const { user, app } = render();
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("That callsign or email and password don't match."));
    expect(updatePassword).not.toHaveBeenCalled();
  });
});

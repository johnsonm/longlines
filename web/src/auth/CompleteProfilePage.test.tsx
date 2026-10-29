import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderPage, SESSION } from "../test/render";
import { completeProfile, signOut } from "../lib/api";
import { pushCleanup } from "../pwa/push";
import { CompleteProfilePage } from "./CompleteProfilePage";

vi.mock("../lib/api", () => ({ completeProfile: vi.fn(), signOut: vi.fn() }));
vi.mock("../pwa/push", () => ({ pushCleanup: vi.fn() }));

const GOOGLE = { ...SESSION, user: { ...SESSION.user, user_metadata: { full_name: "Brad Bazemore" } } };

beforeEach(() => {
  vi.mocked(completeProfile).mockReset().mockResolvedValue(undefined);
  vi.mocked(signOut).mockReset().mockResolvedValue(undefined);
});

describe("CompleteProfilePage", () => {
  it("starts the name from Google and says which account is signed in", () => {
    renderPage(<CompleteProfilePage />, { app: { session: GOOGLE, profile: null, profileMissing: true } });
    expect(screen.getByLabelText("Name")).toHaveValue("Brad Bazemore");
    expect(screen.getByText(/Signed in with Google as kk4pwj@example.com\./)).toBeInTheDocument();
  });

  it("checks the callsign before asking SQL", async () => {
    const { user } = renderPage(<CompleteProfilePage />, { app: { profile: null, profileMissing: true } });
    expect(screen.getByLabelText("Name")).toHaveValue("");
    await user.type(screen.getByLabelText(/^Callsign/), "abc");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(screen.getByText("Enter a valid amateur callsign, like KK4PWJ.")).toBeInTheDocument();
    expect(completeProfile).not.toHaveBeenCalled();
  });

  it("creates the profile and reloads it", async () => {
    const { user, app } = renderPage(<CompleteProfilePage />, { app: { session: GOOGLE, profile: null, profileMissing: true } });
    await user.type(screen.getByLabelText(/^Callsign/), "kk4pwj");
    await user.type(screen.getByLabelText("Name"), " ");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(completeProfile).toHaveBeenCalledWith("KK4PWJ", "Brad Bazemore");
    await waitFor(() => expect(app.refreshProfile).toHaveBeenCalledTimes(1));
  });

  it("shows SQL's refusal and lets the user try another callsign", async () => {
    vi.mocked(completeProfile).mockRejectedValueOnce(new Error("Enter a valid amateur callsign."));
    const { user, app } = renderPage(<CompleteProfilePage />, { app: { profile: null, profileMissing: true } });
    await user.type(screen.getByLabelText(/^Callsign/), "W1AW");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("Enter a valid amateur callsign.")).toBeInTheDocument();
    expect(app.refreshProfile).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Create account" })).toBeEnabled();
  });

  it("signs out to use a different account, and says so when that fails", async () => {
    const { user, app } = renderPage(<CompleteProfilePage />, { app: { profile: null, profileMissing: true } });
    await user.click(screen.getByRole("button", { name: "Use a different account" }));
    expect(signOut).toHaveBeenCalledWith("local", pushCleanup);
    vi.mocked(signOut).mockRejectedValueOnce(new Error("x"));
    await user.click(screen.getByRole("button", { name: "Use a different account" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Couldn't sign out. Try again."));
  });
});

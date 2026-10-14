import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderPage } from "../test/render";
import { setMobile } from "../test/media";
import { WELCOME_KEY } from "../app/hooks";
import { callsignAvailable, signIn, signUp } from "../lib/api";
import { SignInPage } from "./SignInPage";

vi.mock("../lib/api", () => ({
  signIn: vi.fn(),
  signUp: vi.fn(),
  callsignAvailable: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(signIn).mockReset().mockResolvedValue(undefined);
  vi.mocked(signUp).mockReset().mockResolvedValue(undefined);
  vi.mocked(callsignAvailable).mockReset().mockResolvedValue(true);
  localStorage.clear();
});

const where = () => screen.getByTestId("location");

describe("SignInPage: sign in", () => {
  it("signs in and returns to the page the user came from", async () => {
    const { user } = renderPage(<SignInPage />, { route: "/signin", state: { from: "/destinations" } });
    const submit = screen.getByRole("button", { name: "Sign in" });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText("Callsign or email"), "kk4pwj");
    await user.type(screen.getByLabelText("Password"), "hunter22");
    await user.click(submit);
    expect(signIn).toHaveBeenCalledWith("kk4pwj", "hunter22");
    await waitFor(() => expect(where()).toHaveTextContent("/destinations"));
  });

  it("defaults to Sources after sign in", async () => {
    setMobile(true);
    const { user } = renderPage(<SignInPage />, { route: "/signin" });
    await user.type(screen.getByLabelText("Callsign or email"), "kk4pwj");
    await user.type(screen.getByLabelText("Password"), "hunter22");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(where()).toHaveTextContent("/sources"));
  });

  it("shows the sign-in error", async () => {
    vi.mocked(signIn).mockRejectedValue(new Error("That callsign or email and password don't match."));
    const { user } = renderPage(<SignInPage />, { route: "/signin" });
    await user.type(screen.getByLabelText("Callsign or email"), "x");
    await user.type(screen.getByLabelText("Password"), "y");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("That callsign or email and password don't match.")).toBeInTheDocument();
  });

  it("shows a notice from navigation state and lets the user dismiss it", async () => {
    const { user } = renderPage(<SignInPage />, { route: "/signin", state: { notice: "Reset link sent." } });
    expect(screen.getByText("Reset link sent.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("Reset link sent.")).not.toBeInTheDocument();
  });

  it("consumes the app-level sign-in notice once", () => {
    const { app } = renderPage(<SignInPage />, { route: "/signin", app: { signInNotice: "Your account was deleted." } });
    expect(screen.getByText("Your account was deleted.")).toBeInTheDocument();
    expect(app.setSignInNotice).toHaveBeenCalledWith(null);
  });

  it("links to password reset and stats", async () => {
    const { user } = renderPage(<SignInPage />, { route: "/signin" });
    await user.click(screen.getByRole("button", { name: "Forgot your password?" }));
    expect(where()).toHaveTextContent("/reset-password");
  });

  it("links to the public stats page", async () => {
    const { user } = renderPage(<SignInPage />, { route: "/signin" });
    await user.click(screen.getByRole("button", { name: "View recent activity" }));
    expect(where()).toHaveTextContent("/stats");
  });

  it("links to callsign lookup", async () => {
    const { user } = renderPage(<SignInPage />, { route: "/signin" });
    await user.click(screen.getByRole("button", { name: "Look up a callsign" }));
    expect(where()).toHaveTextContent("/lookup");
  });
});

describe("SignInPage: create account", () => {
  async function openSignUp() {
    const r = renderPage(<SignInPage />, { route: "/signin", state: { notice: "hello" } });
    await r.user.click(screen.getByRole("tab", { name: "Create account" }));
    expect(screen.queryByText("hello")).not.toBeInTheDocument();
    return r;
  }

  async function fill(user: Awaited<ReturnType<typeof openSignUp>>["user"], values: Partial<Record<string, string>> = {}) {
    const v = { callsign: "kk4pwj", name: " Brad ", email: "brad@example.com", password: "hunter22", confirm: "hunter22", ...values };
    if (v.callsign) await user.type(screen.getByLabelText(/^Callsign/), v.callsign);
    if (v.name) await user.type(screen.getByLabelText("Name"), v.name);
    if (v.email) await user.type(screen.getByLabelText(/^Email/), v.email);
    if (v.password) await user.type(screen.getByLabelText(/^Password/), v.password);
    if (v.confirm) await user.type(screen.getByLabelText(/^Confirm password/), v.confirm);
  }

  it("validates every field before submitting", async () => {
    const { user } = await openSignUp();
    await fill(user, { callsign: "abc", email: "nope", password: "short", confirm: "other" });
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(screen.getByText("Enter a valid amateur callsign, like KK4PWJ.")).toBeInTheDocument();
    expect(screen.getByText("Enter a valid email address.")).toBeInTheDocument();
    expect(screen.getByText("Use at least 8 characters.")).toBeInTheDocument();
    expect(screen.getByText("Passwords don't match.")).toBeInTheDocument();
    expect(callsignAvailable).not.toHaveBeenCalled();
  });

  it("creates the account, remembers the welcome tour and shows the email step", async () => {
    const { user } = await openSignUp();
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(where()).toHaveTextContent("/check-email"));
    expect(callsignAvailable).toHaveBeenCalledWith("KK4PWJ");
    expect(signUp).toHaveBeenCalledWith({ callsign: "KK4PWJ", name: "Brad", email: "brad@example.com", password: "hunter22" });
    expect(localStorage.getItem(WELCOME_KEY)).toBe("KK4PWJ");
    expect(JSON.parse(where().dataset.state ?? "null")).toEqual({ email: "brad@example.com" });
  });

  it("still signs up when storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { user } = await openSignUp();
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(where()).toHaveTextContent("/check-email"));
  });

  it("refuses a taken callsign", async () => {
    vi.mocked(callsignAvailable).mockResolvedValue(false);
    const { user } = await openSignUp();
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("That callsign is already taken.")).toBeInTheDocument();
    expect(signUp).not.toHaveBeenCalled();
  });

  it("shows sign-up errors", async () => {
    vi.mocked(signUp).mockRejectedValue(new Error("Email rate limit exceeded"));
    const { user } = await openSignUp();
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("Email rate limit exceeded")).toBeInTheDocument();
  });
});

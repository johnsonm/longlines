import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderPage } from "../test/render";
import { setMobile } from "../test/media";
import { signIn, signInWithGoogle, signUp } from "../lib/api";
import { SignInPage } from "./SignInPage";
import { peekReturnPath, saveReturnPath } from "./returnPath";

vi.mock("../lib/api", () => ({
  signIn: vi.fn(),
  signUp: vi.fn(),
  signInWithGoogle: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(signIn).mockReset().mockResolvedValue(undefined);
  vi.mocked(signUp).mockReset().mockResolvedValue(undefined);
  vi.mocked(signInWithGoogle).mockReset().mockResolvedValue(undefined);
  localStorage.clear();
  sessionStorage.clear();
});

const where = () => screen.getByTestId("location");

describe("SignInPage: sign in", () => {
  it("signs in and returns to the page the user came from", async () => {
    saveReturnPath("/relay/approve?code=KQ7M-X4PD"); // left by a Google attempt abandoned on Google's page
    const { user } = renderPage(<SignInPage initialMode="signin" />, { route: "/signin", state: { from: "/destinations" } });
    const submit = screen.getByRole("button", { name: "Sign in" });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText("Email"), "kk4pwj@example.com");
    await user.type(screen.getByLabelText("Password"), "hunter22");
    await user.click(submit);
    expect(signIn).toHaveBeenCalledWith("kk4pwj@example.com", "hunter22");
    await waitFor(() => expect(where()).toHaveTextContent("/destinations"));
    expect(peekReturnPath()).toBeNull();
  });

  it("defaults to Home after sign in", async () => {
    setMobile(true);
    const { user } = renderPage(<SignInPage initialMode="signin" />, { route: "/signin" });
    await user.type(screen.getByLabelText("Email"), "kk4pwj@example.com");
    await user.type(screen.getByLabelText("Password"), "hunter22");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(where()).toHaveTextContent("/home"));
  });

  it("shows the sign-in error", async () => {
    vi.mocked(signIn).mockRejectedValue(new Error("That email and password don't match."));
    const { user } = renderPage(<SignInPage initialMode="signin" />, { route: "/signin" });
    await user.type(screen.getByLabelText("Email"), "x@y.z");
    await user.type(screen.getByLabelText("Password"), "y");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("That email and password don't match.")).toBeInTheDocument();
  });

  it("shows a notice from navigation state and lets the user dismiss it", async () => {
    const { user } = renderPage(<SignInPage initialMode="signin" />, { route: "/signin", state: { notice: "Reset link sent." } });
    expect(screen.getByText("Reset link sent.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("Reset link sent.")).not.toBeInTheDocument();
  });

  it("consumes the app-level sign-in notice once", () => {
    const { app } = renderPage(<SignInPage initialMode="signin" />, { route: "/signin", app: { signInNotice: "Your account was deleted." } });
    expect(screen.getByText("Your account was deleted.")).toBeInTheDocument();
    expect(app.setSignInNotice).toHaveBeenCalledWith(null);
  });

  it("links to password reset", async () => {
    const { user } = renderPage(<SignInPage initialMode="signin" />, { route: "/signin" });
    await user.click(screen.getByRole("button", { name: "Forgot your password?" }));
    expect(where()).toHaveTextContent("/reset-password");
  });

  it("stands alone, with no nav, and leads back to the site root by its name", async () => {
    const { user } = renderPage(<SignInPage initialMode="signin" />, { route: "/signin" });
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Account menu" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Long Lines" }));
    expect(where()).toHaveTextContent(/^\/$/);
  });
});

describe("SignInPage: create account", () => {
  it("opens on Create account at /signup", () => {
    renderPage(<SignInPage initialMode="signup" />, { route: "/signup" });
    expect(screen.getByRole("tab", { name: "Create account" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText(/^Callsign/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign up with Google" })).toBeInTheDocument();
  });

  async function openSignUp() {
    const r = renderPage(<SignInPage initialMode="signin" />, { route: "/signin", state: { notice: "hello" } });
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
  });

  it("creates the account and shows the email step", async () => {
    const { user } = await openSignUp();
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(where()).toHaveTextContent("/check-email"));
    expect(signUp).toHaveBeenCalledWith({ callsign: "KK4PWJ", name: "Brad", email: "brad@example.com", password: "hunter22" });
    expect(JSON.parse(where().dataset.state ?? "null")).toEqual({ email: "brad@example.com" });
  });

  it("shows sign-up errors", async () => {
    vi.mocked(signUp).mockRejectedValue(new Error("Email rate limit exceeded"));
    const { user } = await openSignUp();
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("Email rate limit exceeded")).toBeInTheDocument();
  });
});

describe("SignInPage: Google", () => {
  it("signs in with Google and stays busy while the browser leaves", async () => {
    const { user } = renderPage(<SignInPage initialMode="signin" />, { route: "/signin" });
    const google = screen.getByRole("button", { name: "Sign in with Google" });
    await user.click(google);
    expect(signInWithGoogle).toHaveBeenCalledTimes(1);
    expect(google).toBeDisabled();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("keeps the page the user came from for the trip to Google", async () => {
    const { user } = renderPage(<SignInPage initialMode="signin" />, { route: "/signin", state: { from: "/relay/approve?code=KQ7M-X4PD" } });
    await user.click(screen.getByRole("button", { name: "Sign in with Google" }));
    expect(signInWithGoogle).toHaveBeenCalledTimes(1);
    expect(peekReturnPath()).toBe("/relay/approve?code=KQ7M-X4PD");
  });

  it("forgets an older saved page when this sign-in came from nowhere", async () => {
    saveReturnPath("/destinations");
    const { user } = renderPage(<SignInPage initialMode="signin" />, { route: "/signin" });
    await user.click(screen.getByRole("button", { name: "Sign in with Google" }));
    expect(peekReturnPath()).toBeNull();
  });

  it("offers Google sign-up without submitting the form", async () => {
    const { user } = renderPage(<SignInPage initialMode="signin" />, { route: "/signin" });
    await user.click(screen.getByRole("tab", { name: "Create account" }));
    await user.click(screen.getByRole("button", { name: "Sign up with Google" }));
    expect(signInWithGoogle).toHaveBeenCalledTimes(1);
    expect(signUp).not.toHaveBeenCalled();
  });

  it("shows a Google error and lets the user try again", async () => {
    vi.mocked(signInWithGoogle).mockRejectedValue(new Error("Unsupported provider: provider is not enabled"));
    const { user } = renderPage(<SignInPage initialMode="signin" />, { route: "/signin" });
    await user.click(screen.getByRole("button", { name: "Sign in with Google" }));
    expect(await screen.findByText("Unsupported provider: provider is not enabled")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeEnabled();
  });

  it("forgets the saved page when Google's sign-in can't start", async () => {
    vi.mocked(signInWithGoogle).mockRejectedValue(new Error("Unsupported provider: provider is not enabled"));
    const { user } = renderPage(<SignInPage initialMode="signin" />, { route: "/signin", state: { from: "/destinations" } });
    await user.click(screen.getByRole("button", { name: "Sign in with Google" }));
    await screen.findByText("Unsupported provider: provider is not enabled");
    expect(peekReturnPath()).toBeNull();
  });
});

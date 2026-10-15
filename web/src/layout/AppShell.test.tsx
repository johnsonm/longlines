import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderPage } from "../test/render";
import { setMobile } from "../test/media";
import { signOut } from "../lib/api";
import { AppShell } from "./AppShell";
import { PublicShell } from "./PublicShell";

vi.mock("../lib/api", () => ({ signOut: vi.fn() }));

beforeEach(() => {
  vi.mocked(signOut).mockReset().mockResolvedValue(undefined);
});

const shell = (failing = false) => <AppShell destinationsFailing={failing}><p>page body</p></AppShell>;

describe("AppShell", () => {
  it("renders the page with navigation, highlighting the current page", () => {
    renderPage(shell(), { route: "/subscriptions" });
    expect(screen.getByText("page body")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Subscriptions" })).toHaveClass("Mui-selected");
    expect(screen.queryByRole("button", { name: "Open navigation" })).not.toBeInTheDocument();
  });

  it("puts Groups between Subscriptions and Destinations", async () => {
    const { user } = renderPage(shell(), { route: "/groups" });
    const labels = screen.getAllByRole("button").map((b) => b.textContent);
    expect(labels.indexOf("Groups")).toBe(labels.indexOf("Subscriptions") + 1);
    expect(labels.indexOf("Destinations")).toBe(labels.indexOf("Groups") + 1);
    expect(screen.getByRole("button", { name: "Groups" })).toHaveClass("Mui-selected");
    await user.click(screen.getByRole("button", { name: "Destinations" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/destinations");
  });

  it("navigates from the drawer", async () => {
    const { user } = renderPage(shell(), { route: "/sources" });
    await user.click(screen.getByRole("button", { name: "Stats" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/stats");
  });

  it("opens a temporary drawer on phones", async () => {
    setMobile(true);
    const { user } = renderPage(shell(true), { route: "/sources" });
    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    await user.click(await screen.findByRole("button", { name: "Destinations" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/destinations");
  });

  it("shows who is signed in and opens Account", async () => {
    const { user } = renderPage(shell(), { route: "/sources" });
    await user.click(screen.getAllByRole("button", { name: "Account menu" })[1]!);
    expect(screen.getByText("Brad")).toBeInTheDocument();
    expect(screen.getByText("kk4pwj@example.com")).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Account" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/account");
  });

  it("signs out, and reports a failure", async () => {
    const { user, app } = renderPage(shell(), { route: "/sources" });
    await user.click(screen.getAllByRole("button", { name: "Account menu" })[0]!);
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(signOut).toHaveBeenCalled();

    vi.mocked(signOut).mockRejectedValue(new Error("offline"));
    await user.click(screen.getAllByRole("button", { name: "Account menu" })[0]!);
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Couldn't sign out. Try again."));
  });

  it("lists Callsign lookup after Stats and keeps it highlighted on profiles", () => {
    renderPage(shell(), { route: "/call/KK4PWJ" });
    const labels = screen.getAllByRole("button").map((b) => b.textContent);
    expect(labels.indexOf("Callsign lookup")).toBe(labels.indexOf("Stats") + 1);
    expect(screen.getByRole("button", { name: "Callsign lookup" })).toHaveClass("Mui-selected");
  });

  it("looks up a callsign from the app bar search box", async () => {
    const { user } = renderPage(shell(), { route: "/sources" });
    const box = screen.getByRole("textbox", { name: "Look up a callsign" });
    await user.click(screen.getByRole("button", { name: "Look up" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/sources");
    await user.type(box, "kk4pwj/p{Enter}");
    expect(screen.getByTestId("location")).toHaveTextContent("/call/KK4PWJ/P");
    expect(box).toHaveValue("");
  });

  it("swaps the search box for an icon that opens lookup on phones", async () => {
    setMobile(true);
    const { user } = renderPage(shell(), { route: "/sources" });
    expect(screen.queryByRole("textbox", { name: "Look up a callsign" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Callsign lookup" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/lookup");
  });

  it("falls back to the callsign and a placeholder avatar", () => {
    renderPage(shell(), { route: "/sources", app: { profile: null } });
    expect(screen.getAllByText("?").length).toBeGreaterThan(0);
  });
});

describe("PublicShell", () => {
  it("offers sign in and remembers the page", async () => {
    const { user } = renderPage(<PublicShell><p>public body</p></PublicShell>, { route: "/stats" });
    expect(screen.getByText("public body")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    const where = screen.getByTestId("location");
    expect(where).toHaveTextContent("/signin");
    expect(JSON.parse(where.dataset.state ?? "null")).toEqual({ from: "/stats" });
  });

  it("keeps the original page when Sign in is clicked on the sign-in page", async () => {
    const { user } = renderPage(<PublicShell><p>public body</p></PublicShell>, { route: "/signin", state: { from: "/groups" } });
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(JSON.parse(screen.getByTestId("location").dataset.state ?? "null")).toEqual({ from: "/groups" });
  });

  it.each([["Lookup", "/lookup"], ["Stats", "/stats"]])("links to %s", async (name, path) => {
    const { user } = renderPage(<PublicShell><p>public body</p></PublicShell>, { route: "/call/KK4PWJ" });
    await user.click(screen.getByRole("button", { name }));
    expect(screen.getByTestId("location")).toHaveTextContent(path);
  });

  it("shows the links as icons on phones", async () => {
    setMobile(true);
    const { user } = renderPage(<PublicShell><p>public body</p></PublicShell>, { route: "/call/KK4PWJ" });
    expect(screen.queryByText("Lookup")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lookup" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stats" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(JSON.parse(screen.getByTestId("location").dataset.state ?? "null")).toEqual({ from: "/call/KK4PWJ" });
  });
});

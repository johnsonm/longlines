import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderPage } from "../test/render";
import { setMobile } from "../test/media";
import { signOut } from "../lib/api";
import { installState, promptInstall, subscribeInstall } from "../pwa/install";
import { pushCleanup } from "../pwa/push";
import { AppShell } from "./AppShell";

vi.mock("../lib/api", () => ({ signOut: vi.fn() }));
vi.mock("../pwa/install", () => ({ installState: vi.fn(), promptInstall: vi.fn(), subscribeInstall: vi.fn() }));
vi.mock("../pwa/push", () => ({ pushCleanup: vi.fn() }));

beforeEach(() => {
  vi.mocked(signOut).mockReset().mockResolvedValue(undefined);
  vi.mocked(installState).mockReset().mockReturnValue("none");
  vi.mocked(promptInstall).mockReset().mockResolvedValue(true);
  vi.mocked(subscribeInstall).mockReset().mockReturnValue(() => {});
});

const shell = (failing = false) => <AppShell destinationsFailing={failing}><p>page body</p></AppShell>;

describe("AppShell", () => {
  it("renders the page with navigation, highlighting the current page", () => {
    renderPage(shell(), { route: "/connections" });
    expect(screen.getByText("page body")).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toHaveTextContent("Brad Bazemore");
    expect(screen.getByRole("button", { name: "Connections" })).toHaveClass("Mui-selected");
    expect(screen.queryByRole("button", { name: "Open navigation" })).not.toBeInTheDocument();
  });

  it("highlights Groups and navigates on to Destinations", async () => {
    const { user } = renderPage(shell(), { route: "/groups" });
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

  it("switches between light, dark and automatic themes", async () => {
    const { user } = renderPage(shell(), { route: "/sources" });
    await user.click(screen.getAllByRole("button", { name: "Account menu" })[0]!);
    expect(screen.getByRole("button", { name: "Automatic" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Dark" }));
    expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Automatic" })).toHaveAttribute("aria-pressed", "false");
    // Clicking the selected mode again keeps it.
    await user.click(screen.getByRole("button", { name: "Dark" }));
    expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Light" }));
    expect(screen.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "true");
  });

  it("signs out with the push cleanup, and reports a failure", async () => {
    const { user, app } = renderPage(shell(), { route: "/sources" });
    await user.click(screen.getAllByRole("button", { name: "Account menu" })[0]!);
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(signOut).toHaveBeenCalledWith("local", pushCleanup);

    vi.mocked(signOut).mockRejectedValue(new Error("offline"));
    await user.click(screen.getAllByRole("button", { name: "Account menu" })[0]!);
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Couldn't sign out. Try again."));
  });

  it("lists the sections in order and keeps Callsign lookup highlighted on profiles", () => {
    renderPage(shell(), { route: "/call/KK4PWJ" });
    const labels = screen.getAllByRole("button").map((b) => b.textContent);
    const order = ["Home", "Sources", "Connections", "Destinations", "Groups", "Goals", "Band map", "Callsign lookup", "Reference lookup", "Stats", "API tokens"];
    expect(labels.filter((l) => order.includes(l ?? ""))).toEqual(order);
    expect(screen.getByRole("button", { name: "Callsign lookup" })).toHaveClass("Mui-selected");
    expect(screen.getByRole("button", { name: "Reference lookup" })).not.toHaveClass("Mui-selected");
  });

  it("ends the nav with Docs, which opens the docs site in a new tab", () => {
    renderPage(shell(), { route: "/sources" });
    const docs = screen.getByRole("link", { name: "Docs" });
    expect(docs).toHaveAttribute("href", "https://docs.longlines.io");
    expect(docs).toHaveAttribute("target", "_blank");
    expect(docs).toHaveAttribute("rel", "noopener noreferrer");
    expect(docs.parentElement!.lastElementChild).toBe(docs);
  });

  it("highlights Reference lookup on the lookup page and on every reference page, and opens it", async () => {
    const { unmount } = renderPage(shell(), { route: "/ref" });
    expect(screen.getByRole("button", { name: "Reference lookup" })).toHaveClass("Mui-selected");
    unmount();
    const { user } = renderPage(shell(), { route: "/ref/sota/W4C/CM-001" });
    expect(screen.getByRole("button", { name: "Reference lookup" })).toHaveClass("Mui-selected");
    expect(screen.getByRole("button", { name: "Callsign lookup" })).not.toHaveClass("Mui-selected");
    await user.click(screen.getByRole("button", { name: "Reference lookup" }));
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/ref$/);
  });

  it("has no search in the app bar", () => {
    renderPage(shell(), { route: "/sources" });
    expect(screen.queryByRole("search")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Look up a callsign" })).not.toBeInTheDocument();
  });

  it("has no Install app item where the app cannot be installed", async () => {
    const { user } = renderPage(shell(), { route: "/sources" });
    await user.click(screen.getAllByRole("button", { name: "Account menu" })[0]!);
    const items = screen.getAllByRole("menuitem").map((m) => m.textContent);
    expect(items).toEqual(["Account", "Sign out"]);
  });

  it("offers Install app between Account and Sign out, and shows the browser's prompt", async () => {
    vi.mocked(installState).mockReturnValue("prompt");
    const { user } = renderPage(shell(), { route: "/sources" });
    await user.click(screen.getAllByRole("button", { name: "Account menu" })[0]!);
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Account", "Install app", "Sign out"]);
    await user.click(screen.getByRole("menuitem", { name: "Install app" }));
    expect(promptInstall).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("walks Safari on iPhone through Add to Home Screen", async () => {
    vi.mocked(installState).mockReturnValue("ios");
    const { user } = renderPage(shell(), { route: "/sources" });
    await user.click(screen.getAllByRole("button", { name: "Account menu" })[0]!);
    await user.click(screen.getByRole("menuitem", { name: "Install app" }));
    expect(promptInstall).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog", { name: "Install Long Lines" });
    expect(dialog).toHaveTextContent("Tap the Share button in Safari.");
    expect(dialog).toHaveTextContent("Choose Add to Home Screen, then Add.");
    expect(dialog).toHaveTextContent("Open Long Lines from your Home Screen.");
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Install Long Lines" })).not.toBeInTheDocument());
  });

  it("falls back to the callsign and a placeholder avatar", () => {
    renderPage(shell(), { route: "/sources", app: { profile: null } });
    expect(screen.getAllByText("?").length).toBeGreaterThan(0);
  });
});

describe("AppShell signed out", () => {
  const signedOut = { app: { session: null, profile: null } };
  const LOCKED = ["Home", "Sources", "Connections", "Destinations", "Groups", "Goals", "API tokens"];
  const OPEN = ["Band map", "Callsign lookup", "Reference lookup", "Stats", "Health"];

  it("shows every section, with the account ones disabled and explained", async () => {
    const { user } = renderPage(shell(), { route: "/stats", ...signedOut });
    expect(screen.getByText("page body")).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toHaveTextContent("Brad Bazemore");
    for (const name of LOCKED) expect(screen.getByRole("button", { name })).toHaveAttribute("aria-disabled", "true");
    for (const name of OPEN) expect(screen.getByRole("button", { name })).not.toHaveAttribute("aria-disabled");
    expect(screen.getByRole("link", { name: "Docs" })).not.toHaveAttribute("aria-disabled");
    expect(screen.getByRole("button", { name: "Stats" })).toHaveClass("Mui-selected");
    await user.hover(screen.getByRole("button", { name: "Connections" }).parentElement!);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Create an account or sign in to use Connections.");
  });

  it("explains a locked section to keyboard and screen reader users", async () => {
    const { user } = renderPage(shell(), { route: "/stats", ...signedOut });
    const wrapper = screen.getByRole("button", { name: "Sources" }).parentElement!;
    expect(wrapper).toHaveAttribute("tabindex", "0");
    // Tab reaches it (the disabled button inside is skipped); a browser then opens the tooltip on
    // focus-visible, which jsdom can't match, so the description is what is checked here.
    for (let i = 0; i < 20 && document.activeElement !== wrapper; i += 1) await user.tab();
    expect(wrapper).toHaveFocus();
    expect(wrapper).toHaveAccessibleDescription("Create an account or sign in to use Sources.");
  });

  it("offers the Theme switch signed out", async () => {
    const { user } = renderPage(shell(), { route: "/stats", ...signedOut });
    await user.click(screen.getByRole("button", { name: "Theme" }));
    const dark = await screen.findByRole("button", { name: "Dark" });
    await user.click(dark);
    expect(dark).toHaveAttribute("aria-pressed", "true");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Theme" })).toBeInTheDocument();
  });

  it("has no account menu, and offers sign in that remembers the page, query and hash included", async () => {
    const { user } = renderPage(shell(), { route: "/stats", search: "?range=7d", hash: "#bands", ...signedOut });
    expect(screen.queryByRole("button", { name: "Account menu" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    const where = screen.getByTestId("location");
    expect(where).toHaveTextContent("/signin");
    expect(JSON.parse(where.dataset.state ?? "null")).toEqual({ from: "/stats?range=7d#bands" });
  });

  it("hides the Sign in button on the sign-in page itself", () => {
    renderPage(shell(), { route: "/signin", ...signedOut });
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sources" })).toHaveAttribute("aria-disabled", "true");
  });

  it("navigates to the public sections", async () => {
    const { user } = renderPage(shell(), { route: "/signin", ...signedOut });
    await user.click(screen.getByRole("button", { name: "Band map" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/band-map");
  });

  it("shows Sign in as an icon on phones, next to the drawer", async () => {
    setMobile(true);
    const { user } = renderPage(shell(), { route: "/call/KK4PWJ", ...signedOut });
    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(await screen.findByRole("button", { name: "Groups" })).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");
    await user.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(JSON.parse(screen.getByTestId("location").dataset.state ?? "null")).toEqual({ from: "/call/KK4PWJ" });
  });
});

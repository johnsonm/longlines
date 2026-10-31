import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import { setMobile } from "../test/media";
import { PublicShell } from "./PublicShell";

const shell = <PublicShell><p>page body</p></PublicShell>;
const signedOut = { app: { session: null, profile: null } };
const where = () => screen.getByTestId("location");

describe("PublicShell", () => {
  it("puts the public pages in a top nav, in order, with Docs last and no account sections", () => {
    renderPage(shell, { route: "/stats", ...signedOut });
    expect(screen.getByText("page body")).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toHaveTextContent("Brad Bazemore");
    const nav = screen.getByRole("navigation", { name: "Public pages" });
    expect(within(nav).getAllByRole("tab").map((t) => t.textContent)).toEqual(
      ["Band map", "Callsign lookup", "Reference lookup", "Stats", "Docs"],
    );
    for (const name of ["Home", "Connections", "Destinations", "Groups", "Goals", "API tokens"]) {
      expect(screen.queryByText(name)).not.toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Open navigation" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Account menu" })).not.toBeInTheDocument();
  });

  it("marks the current page, Callsign lookup on a profile and Reference lookup on every reference page", () => {
    const { unmount } = renderPage(shell, { route: "/stats", ...signedOut });
    expect(screen.getByRole("tab", { name: "Stats" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("tab", { name: "Band map" })).not.toHaveAttribute("aria-current");
    unmount();
    const profile = renderPage(shell, { route: "/call/KK4PWJ", ...signedOut });
    expect(screen.getByRole("tab", { name: "Callsign lookup" })).toHaveAttribute("aria-current", "page");
    profile.unmount();
    renderPage(shell, { route: "/ref/sota/W4C/CM-001", ...signedOut });
    expect(screen.getByRole("tab", { name: "Reference lookup" })).toHaveAttribute("aria-current", "page");
  });

  it("marks nothing on a page outside the nav, like Health", () => {
    renderPage(shell, { route: "/health", ...signedOut });
    expect(screen.queryByRole("tab", { current: "page" })).not.toBeInTheDocument();
  });

  it("navigates between the public pages", async () => {
    const { user } = renderPage(shell, { route: "/stats", ...signedOut });
    await user.click(screen.getByRole("tab", { name: "Band map" }));
    expect(where()).toHaveTextContent("/band-map");
  });

  it("leads home by the name", async () => {
    const { user } = renderPage(shell, { route: "/stats", ...signedOut });
    await user.click(screen.getByRole("link", { name: "Long Lines" }));
    expect(where()).toHaveTextContent(/^\/$/);
  });

  it("opens Docs in a new tab", () => {
    renderPage(shell, { route: "/stats", ...signedOut });
    const docs = screen.getByRole("tab", { name: "Docs" });
    expect(docs).toHaveAttribute("href", "https://docs.longlines.io");
    expect(docs).toHaveAttribute("target", "_blank");
    expect(docs).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("offers sign in that remembers the page, query and hash included", async () => {
    const { user } = renderPage(shell, { route: "/stats", search: "?range=7d", hash: "#bands", ...signedOut });
    await user.click(screen.getByRole("link", { name: "Sign in" }));
    expect(where()).toHaveTextContent("/signin");
    expect(JSON.parse(where().dataset.state ?? "null")).toEqual({ from: "/stats?range=7d#bands" });
  });

  it("signs in from the landing page with nothing to come back to", async () => {
    const { user } = renderPage(shell, { route: "/", ...signedOut });
    await user.click(screen.getByRole("link", { name: "Sign in" }));
    expect(where()).toHaveTextContent("/signin");
    expect(where().dataset.state).toBe("null");
  });

  it("offers the Theme switch", async () => {
    const { user } = renderPage(shell, { route: "/stats", ...signedOut });
    await user.click(screen.getByRole("button", { name: "Theme" }));
    const dark = await screen.findByRole("button", { name: "Dark" });
    await user.click(dark);
    expect(dark).toHaveAttribute("aria-pressed", "true");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Theme" })).toBeInTheDocument();
  });

  it("moves the pages into a drawer on narrow screens, keeping Sign in in the bar", async () => {
    setMobile(true);
    const { user } = renderPage(shell, { route: "/call/KK4PWJ", ...signedOut });
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    const nav = await screen.findByRole("navigation", { name: "Public pages" });
    expect(within(nav).getAllByRole("link").map((l) => l.textContent)).toEqual(
      ["Band map", "Callsign lookup", "Reference lookup", "Stats", "Docs"],
    );
    expect(within(nav).getByRole("link", { name: "Callsign lookup" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Docs" })).toHaveAttribute("href", "https://docs.longlines.io");
    await user.click(within(nav).getByRole("link", { name: "Reference lookup" }));
    expect(where()).toHaveTextContent("/ref");
  });
});

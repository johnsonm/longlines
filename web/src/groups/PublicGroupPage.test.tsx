import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderPage } from "../test/render";
import { loadPublicGroup } from "../lib/api";
import { PublicGroupPage } from "./PublicGroupPage";
import { redacted, STATS } from "./stats/fixtures";
import type { PublicGroupStatistics } from "./stats/types";

vi.mock("../lib/api", () => ({ loadPublicGroup: vi.fn() }));

const PAGE: PublicGroupStatistics = {
  ...redacted(STATS),
  group: { name: "Piedmont ARC", member_count: 12, show_callsigns: false },
};

beforeEach(() => {
  vi.mocked(loadPublicGroup).mockReset().mockResolvedValue(PAGE);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const robots = () => document.head.querySelector('meta[name="robots"]');

describe("PublicGroupPage", () => {
  it("shows the club's statistics without callsigns, asks not to be indexed, and names the tab", async () => {
    const { unmount } = renderPage(<PublicGroupPage slug="7f3kq6xm2a" />, { route: "/g/7f3kq6xm2a" });
    expect(robots()).toHaveAttribute("content", "noindex");
    expect(await screen.findByRole("heading", { name: "Piedmont ARC", level: 1 })).toBeInTheDocument();
    expect(loadPublicGroup).toHaveBeenCalledWith("7f3kq6xm2a", "30d");
    expect(screen.getByText("Public page")).toBeInTheDocument();
    expect(screen.getByText(/^Club statistics · 12 members · Updated /)).toBeInTheDocument();
    expect(screen.getByText("Spots heard")).toBeInTheDocument();
    expect(screen.queryByText("Who is most active")).not.toBeInTheDocument();
    expect(screen.getByText(/Long Lines does not show addresses\./)).toBeInTheDocument();
    expect(document.title).toBe("Piedmont ARC statistics");
    unmount();
    expect(robots()).toBeNull();
    expect(document.title).not.toBe("Piedmont ARC statistics");
  });

  it("reads the period from the address and changes it", async () => {
    const { user } = renderPage(<PublicGroupPage slug="7f3kq6xm2a" />, { route: "/g/7f3kq6xm2a" });
    await screen.findByRole("heading", { name: "Piedmont ARC", level: 1 });
    await user.click(screen.getByRole("combobox", { name: "Period" }));
    await user.click(await screen.findByRole("option", { name: "Last 7 days" }));
    await waitFor(() => expect(loadPublicGroup).toHaveBeenLastCalledWith("7f3kq6xm2a", "7d"));
    expect(screen.getByTestId("location").dataset.search).toBe("?period=7d");
  });

  it("shows the private page for a private or unknown code, with Sign in when signed out", async () => {
    vi.mocked(loadPublicGroup).mockResolvedValue(null);
    renderPage(<PublicGroupPage slug="7f3kq6xm2a" />, { route: "/g/7f3kq6xm2a", app: { session: null } });
    expect(await screen.findByRole("heading", { name: "This page is private" })).toBeInTheDocument();
    expect(screen.getByText("The statistics for this group are not public. If you own the group, sign in to see them.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/signin");
  });

  it("leaves Sign in off the private page when signed in", async () => {
    vi.mocked(loadPublicGroup).mockResolvedValue(null);
    renderPage(<PublicGroupPage slug="7f3kq6xm2a" />, { route: "/g/7f3kq6xm2a" });
    await screen.findByRole("heading", { name: "This page is private" });
    expect(screen.queryByRole("link", { name: "Sign in" })).not.toBeInTheDocument();
  });

  it("reports a failure", async () => {
    vi.mocked(loadPublicGroup).mockRejectedValue(new Error("Too many lookups. Try again in a minute."));
    renderPage(<PublicGroupPage slug="7f3kq6xm2a" />, { route: "/g/7f3kq6xm2a" });
    expect(await screen.findByText("Too many lookups. Try again in a minute.")).toBeInTheDocument();
  });

  it("shares with the browser's share sheet, and copies the link without one", async () => {
    const shareFn = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, share: shareFn, clipboard: navigator.clipboard });
    const { user } = renderPage(<PublicGroupPage slug="7f3kq6xm2a" />, { route: "/g/7f3kq6xm2a" });
    await user.click(await screen.findByRole("button", { name: "Share" }));
    expect(shareFn).toHaveBeenCalledWith({ title: "Piedmont ARC statistics", url: `${window.location.origin}/g/7f3kq6xm2a` });
  });

  it("copies the link where the browser can't share", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValueOnce(undefined);
    const { user, app } = renderPage(<PublicGroupPage slug="7f3kq6xm2a" />, { route: "/g/7f3kq6xm2a" });
    await user.click(await screen.findByRole("button", { name: "Share" }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/g/7f3kq6xm2a`);
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Link copied"));
  });
});

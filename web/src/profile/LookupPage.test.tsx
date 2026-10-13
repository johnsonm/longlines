import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderPage } from "../test/render";
import { setMobile } from "../test/media";
import type { StatsPayload } from "../stats/types";
import { useStats } from "../stats/useStats";
import { LookupPage } from "./LookupPage";

vi.mock("../stats/useStats", () => ({ useStats: vi.fn() }));

// Only topActivators matters here.
const PAYLOAD = {
  topActivators: [
    { callsign: "KK4PWJ/P", base: "KK4PWJ", references: 9, activations: 11, spots: 120, topBand: "20m" },
    { callsign: "W1AW", base: "W1AW", references: 2, activations: 2, spots: 10, topBand: null },
  ],
} as StatsPayload;

beforeEach(() => {
  vi.mocked(useStats).mockReset().mockReturnValue({ stats: { payload: PAYLOAD, generatedAt: "2026-10-05T13:00:00Z" }, loading: false, error: null });
});

describe("LookupPage", () => {
  it("explains the page and focuses the search box on desktop", () => {
    renderPage(<LookupPage />, { route: "/lookup" });
    expect(screen.getByRole("heading", { name: "Callsign lookup" })).toBeInTheDocument();
    expect(screen.getByText(/See what Long Lines has heard from any station/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Callsign" })).toHaveFocus();
    expect(screen.getByPlaceholderText("Callsign, like KK4PWJ")).toBeInTheDocument();
  });

  it("does not focus the search box on phones", () => {
    setMobile(true);
    renderPage(<LookupPage />, { route: "/lookup" });
    expect(screen.getByRole("textbox", { name: "Callsign" })).not.toHaveFocus();
  });

  it("opens the profile for what was typed, and ignores a blank search", async () => {
    const { user } = renderPage(<LookupPage />, { route: "/lookup" });
    await user.click(screen.getByRole("button", { name: "Look up" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/lookup");
    await user.type(screen.getByRole("textbox", { name: "Callsign" }), " kk4pwj/p ");
    await user.click(screen.getByRole("button", { name: "Look up" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/call/KK4PWJ/P");
  });

  it("links the Stats snapshot's top activators as Busy this week", async () => {
    const { user } = renderPage(<LookupPage />, { route: "/lookup" });
    expect(screen.getByText("Busy this week")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "W1AW" })).toHaveAttribute("href", "/call/W1AW");
    // A chip shows the call as spotted and opens the profile of its base call.
    await user.click(screen.getByRole("link", { name: "KK4PWJ/P" }));
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/call\/KK4PWJ$/);
  });

  it("leaves out Busy this week without a snapshot", () => {
    vi.mocked(useStats).mockReturnValue({ stats: null, loading: false, error: null });
    renderPage(<LookupPage />, { route: "/lookup" });
    expect(screen.queryByText("Busy this week")).not.toBeInTheDocument();
  });
});

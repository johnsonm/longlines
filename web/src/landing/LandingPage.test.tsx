import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import { setMobile } from "../test/media";
import { LandingPage } from "./LandingPage";

const signedOut = { app: { session: null, profile: null } };
const where = () => screen.getByTestId("location");

describe("LandingPage", () => {
  it("leads with what Long Lines does and the two ways in", () => {
    renderPage(<LandingPage />, { route: "/", ...signedOut });
    expect(screen.getByRole("heading", { level: 1, name: "Ham radio spots, routed where you want them." })).toBeInTheDocument();
    expect(screen.getByText("Free. The band map, callsign lookup and reference lookup work without an account.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create account" })).toHaveAttribute("href", "/signup");
    expect(screen.getByRole("link", { name: "Look up a callsign" })).toHaveAttribute("href", "/lookup");
  });

  it("sends Create account to the sign-up page", async () => {
    const { user } = renderPage(<LandingPage />, { route: "/", ...signedOut });
    await user.click(screen.getByRole("link", { name: "Create account" }));
    expect(where()).toHaveTextContent("/signup");
  });

  it("shows one spot delivered three ways", () => {
    renderPage(<LandingPage />, { route: "/", ...signedOut });
    const figure = screen.getByRole("figure", { name: "One POTA spot, delivered three ways" });
    expect(figure).toHaveTextContent("Push to your phone");
    expect(figure).toHaveTextContent("Discord · #pota-spots");
    expect(within(figure).getByText("DX de LONGLINES: 14062.0 KK4PWJ POTA US-2799 CW 1842Z").tagName).toBe("CODE");
  });

  it("walks through how it works, goals, groups and stats", () => {
    setMobile(true);
    renderPage(<LandingPage />, { route: "/", ...signedOut });
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(
      ["How it works", "Goals keep up with your log", "Groups and public stats"],
    );
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(
      ["Pick a source", "Add a filter", "Send it anywhere", "Groups", "Public stats"],
    );
    expect(screen.getByText("WWBOTA")).toBeInTheDocument();
    expect(screen.getByText("Local DX cluster")).toBeInTheDocument();
    // Long Lines has no email destination.
    expect(screen.queryByText("Email")).not.toBeInTheDocument();
    expect(screen.getByText("Relay reads your log")).toBeInTheDocument();
  });
});

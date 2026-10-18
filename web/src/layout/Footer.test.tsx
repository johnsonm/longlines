import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderPage } from "../test/render";
import { Footer, REPO_URL } from "./Footer";

describe("Footer", () => {
  it("shows the copyright for this year and links to the repository in a new tab", () => {
    renderPage(<Footer />);
    expect(screen.getByRole("contentinfo")).toHaveTextContent(`© ${new Date().getFullYear()} Brad Bazemore`);
    const link = screen.getByRole("link", { name: "GitHub" });
    expect(link).toHaveAttribute("href", REPO_URL);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
});

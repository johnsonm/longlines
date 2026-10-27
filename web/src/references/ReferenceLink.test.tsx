import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderPage } from "../test/render";
import { ReferenceLink } from "./ReferenceLink";

describe("ReferenceLink", () => {
  it("links a park, summit or WWFF reference to its page", () => {
    renderPage(<ReferenceLink program="SOTA" reference="W4C/CM-001" />);
    expect(screen.getByRole("link", { name: "W4C/CM-001" })).toHaveAttribute("href", "/ref/sota/W4C/CM-001");
  });

  it("leaves a bunker or island as plain text", () => {
    renderPage(<ReferenceLink program="WWBOTA" reference="B/G-0001" />);
    expect(screen.getByText("B/G-0001")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

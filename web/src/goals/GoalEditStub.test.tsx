import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderPage } from "../test/render";
import { GoalEditStub } from "./GoalEditStub";

describe("GoalEditStub", () => {
  it("leads back to the list it would edit", () => {
    renderPage(<GoalEditStub id="n1" />, { route: "/goals/n1/edit" });
    expect(screen.getByRole("heading", { name: "Edit goal" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go back" })).toHaveAttribute("href", "/goals/n1");
  });

  it("leads back to the index from a new list", () => {
    renderPage(<GoalEditStub id={null} />, { route: "/goals/new" });
    expect(screen.getByRole("heading", { name: "Add goal" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go back" })).toHaveAttribute("href", "/goals");
  });
});

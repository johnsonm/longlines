import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderPage } from "../test/render";
import { CheckEmailPage } from "./CheckEmailPage";

describe("CheckEmailPage", () => {
  it("names the address the link went to", () => {
    renderPage(<CheckEmailPage />, { route: "/check-email", state: { email: "kk4pwj@example.com" } });
    expect(screen.getByText(/We sent a confirmation link to kk4pwj@example.com\./)).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toHaveTextContent("Brad Bazemore");
  });

  it("falls back to generic copy without an address and links back to sign in", async () => {
    const { user } = renderPage(<CheckEmailPage />, { route: "/check-email" });
    expect(screen.getByText(/We sent you a confirmation link\./)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to sign in" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/signin");
  });
});

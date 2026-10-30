import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import { setMobile } from "../test/media";
import { card } from "../test/goals";
import { listGoals } from "../lib/api";
import { GoalsPage } from "./GoalsPage";

vi.mock("../lib/api", () => ({ listGoals: vi.fn() }));

beforeEach(() => {
  vi.mocked(listGoals).mockReset();
  setMobile(false);
});

const cardOf = (name: string) => screen.getByRole("heading", { name }).closest("a") as HTMLElement;

describe("GoalsPage", () => {
  it("shows active cards, then the Finished section with its chips and note", async () => {
    vi.mocked(listGoals).mockResolvedValue([
      card(),
      card({ id: "n2", name: "POTA hunter award", requirement_count: 1, starts_on: null, ends_on: null, worked: 41, total: 100, connection_count: 1 }),
      card({ id: "n3", name: "Winter Field Day 2026", status: "complete", requirement_count: 2, starts_on: "2026-01-24", ends_on: "2026-01-25", worked: 30, total: 30, connection_count: 1 }),
      card({ id: "n4", name: "2025 chase", status: "ended", starts_on: "2025-01-01", ends_on: "2025-12-31", worked: 51, connection_count: 0 }),
    ]);
    const { user } = renderPage(<GoalsPage />, { route: "/goals" });
    expect(screen.getByRole("heading", { name: "Goals" })).toBeInTheDocument();
    expect(screen.getByText("Tell Long Lines what you still need. Connections stop alerting for anything you've worked.")).toBeInTheDocument();

    const chase = await screen.findByRole("heading", { name: "2026 chase" });
    const c1 = within(chase.closest("a")!);
    expect(c1.getByText("3 requirements · Jan 1 – Dec 31, 2026")).toBeInTheDocument();
    expect(c1.getByText("18 of 64 worked")).toBeInTheDocument();
    expect(c1.getByRole("progressbar", { name: "2026 chase progress" })).toHaveAttribute("aria-valuenow", "28");
    expect(c1.getByText("Used by 2 connections")).toBeInTheDocument();
    expect(within(cardOf("POTA hunter award")).getByText("1 requirement · No end date")).toBeInTheDocument();
    expect(within(cardOf("POTA hunter award")).getByText("Used by 1 connection")).toBeInTheDocument();

    expect(screen.getByRole("heading", { name: "Finished · 2" })).toBeInTheDocument();
    const wfd = within(cardOf("Winter Field Day 2026"));
    expect(wfd.getByText("Complete")).toBeInTheDocument();
    expect(wfd.getByText("2 requirements · Jan 24 – 25, 2026")).toBeInTheDocument();
    expect(wfd.getByText("Rule off on 1 connection")).toBeInTheDocument();
    const old = within(cardOf("2025 chase"));
    expect(old.getByText("Ended")).toBeInTheDocument();
    expect(old.getByText("Not used by any connection")).toBeInTheDocument();
    expect(screen.getByText(/^Finished goals stop counting contacts\./)).toBeInTheDocument();

    await user.click(chase);
    expect(screen.getByTestId("location")).toHaveTextContent("/goals/n1");
  });

  it("has no Finished section without finished lists", async () => {
    vi.mocked(listGoals).mockResolvedValue([card()]);
    renderPage(<GoalsPage />, { route: "/goals" });
    expect(await screen.findByRole("heading", { name: "2026 chase" })).toBeInTheDocument();
    expect(screen.queryByText(/^Finished/)).not.toBeInTheDocument();
  });

  it("shows the empty state with Add goal", async () => {
    vi.mocked(listGoals).mockResolvedValue([]);
    const { user } = renderPage(<GoalsPage />, { route: "/goals" });
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "No goals yet" })).toBeInTheDocument();
    expect(screen.getByText(/^A goal is what you're still chasing: states, parks, bands\./)).toBeInTheDocument();
    const add = screen.getAllByRole("link", { name: "Add goal" });
    expect(add).toHaveLength(1);
    await user.click(add[0]!);
    expect(screen.getByTestId("location")).toHaveTextContent("/goals/new");
  });

  it("stacks the cards under a full-width Add goal on a phone", async () => {
    setMobile(true);
    vi.mocked(listGoals).mockResolvedValue([card()]);
    renderPage(<GoalsPage />, { route: "/goals" });
    expect(await screen.findByRole("heading", { name: "2026 chase" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add goal" })).toHaveClass("MuiButton-fullWidth");
  });

  it("reports a load failure", async () => {
    vi.mocked(listGoals).mockRejectedValue(new Error("offline"));
    const { app } = renderPage(<GoalsPage />, { route: "/goals" });
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("offline"));
  });
});

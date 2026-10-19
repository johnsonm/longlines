import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import { setMobile } from "../test/media";
import { listGroups, loadGroupStatistics, loadSubscriptions } from "../lib/api";
import { GroupPage } from "./GroupPage";
import { OWNER } from "./stats/fixtures";

vi.mock("../lib/api", () => ({
  deleteGroup: vi.fn(),
  listGroups: vi.fn(),
  loadGroupStatistics: vi.fn(),
  loadSubscriptions: vi.fn(),
  normalizeCallsigns: vi.fn(),
  saveGroup: vi.fn(),
}));
vi.mock("../stats/useStats", () => ({ useStats: () => ({ stats: null, loading: false, error: null }) }));

beforeEach(() => {
  setMobile(false);
  for (const fn of [listGroups, loadGroupStatistics, loadSubscriptions]) vi.mocked(fn).mockReset();
  vi.mocked(loadGroupStatistics).mockResolvedValue(OWNER);
  vi.mocked(listGroups).mockResolvedValue([]);
  vi.mocked(loadSubscriptions).mockResolvedValue([]);
});

describe("GroupPage", () => {
  it("shows the header, the tabs and the statistics for 30 days", async () => {
    renderPage(<GroupPage id="g1" tab="statistics" />, { route: "/groups/g1" });
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Piedmont ARC", level: 1 })).toBeInTheDocument();
    expect(loadGroupStatistics).toHaveBeenCalledWith("g1", "30d");
    expect(screen.getByRole("link", { name: "Groups" })).toHaveAttribute("href", "/groups");
    expect(screen.getByText("Public page")).toBeInTheDocument();
    expect(screen.getByText("12 members · used by 2 connections")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Get alerts" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Statistics", selected: true })).toHaveAttribute("href", "/groups/g1");
    expect(screen.getByRole("tab", { name: "Settings" })).toHaveAttribute("href", "/groups/g1/settings");
    expect(screen.getByText("Who is most active")).toBeInTheDocument();
  });

  it("reads and sets the period in the address", async () => {
    vi.mocked(loadGroupStatistics).mockResolvedValue({ ...OWNER, period: "7d", group: { ...OWNER.group, public: false } });
    const { user } = renderPage(<GroupPage id="g1" tab="statistics" />, { route: "/groups/g1" });
    await screen.findByText("Private page");
    await user.click(screen.getByRole("combobox", { name: "Period" }));
    await user.click(await screen.findByRole("option", { name: "Last 7 days" }));
    await waitFor(() => expect(loadGroupStatistics).toHaveBeenLastCalledWith("g1", "7d"));
    expect(screen.getByTestId("location").dataset.search).toBe("?period=7d");
    expect(screen.getByRole("tab", { name: "Statistics" })).toHaveAttribute("href", "/groups/g1?period=7d");
  });

  it("says when the group can't be found", async () => {
    vi.mocked(loadGroupStatistics).mockRejectedValue(new Error("Group not found."));
    renderPage(<GroupPage id="nope" tab="statistics" />, { route: "/groups/nope" });
    expect(await screen.findByText("Group not found.")).toBeInTheDocument();
  });

  it("hides the chip and Get alerts on phones", async () => {
    setMobile(true);
    renderPage(<GroupPage id="g1" tab="statistics" />, { route: "/groups/g1" });
    await screen.findByRole("heading", { name: "Piedmont ARC", level: 1 });
    expect(screen.queryByText("Public page")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Get alerts" })).not.toBeInTheDocument();
  });

  it("opens Get alerts on the source picker", async () => {
    const { user } = renderPage(<GroupPage id="g1" tab="statistics" />, { route: "/groups/g1" });
    await user.click(await screen.findByRole("button", { name: "Get alerts" }));
    expect(within(await screen.findByRole("dialog", { name: "New connection" })).getByRole("button", { name: "Continue" })).toBeInTheDocument();
  });

  it("shows the Settings tab", async () => {
    renderPage(<GroupPage id="g1" tab="settings" />, { route: "/groups/g1/settings" });
    expect(await screen.findByText("Shown on the statistics page and in connection rules")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Settings", selected: true })).toBeInTheDocument();
  });
});

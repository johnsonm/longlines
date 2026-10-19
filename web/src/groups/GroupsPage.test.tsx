import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import { setMobile } from "../test/media";
import { listGroups, listGroupSummaries, loadSubscriptions, saveGroup, type SubscriptionWithLinks } from "../lib/api";
import { GroupsPage } from "./GroupsPage";
import type { GroupSummary } from "./stats/types";
import type { CallsignGroup } from "./types";

vi.mock("../lib/api", () => ({
  listGroups: vi.fn(),
  listGroupSummaries: vi.fn(),
  loadSubscriptions: vi.fn(),
  saveGroup: vi.fn(),
}));
vi.mock("../stats/useStats", () => ({ useStats: () => ({ stats: null, loading: false, error: null }) }));

function group(id: string, overrides: Partial<CallsignGroup> = {}): CallsignGroup {
  return {
    id, name: `Group ${id}`, callsigns: ["KK4PWJ"], member_count: 1, subscription_count: 0, updated_at: "2026-10-13T00:00:00Z",
    on_air: { count: 0, latest: null }, ...overrides,
  };
}

function summary(id: string, overrides: Partial<GroupSummary> = {}): GroupSummary {
  return {
    id, public: false, spots: 1386, members_heard: 7, member_count: 12, daily: Array.from({ length: 30 }, (_, i) => i), on_air: [],
    ...overrides,
  };
}

const sub = (name: string, group_ids: string[], op = "is") =>
  ({ id: name, name, group_ids, rules: [[{ field: "group", op, values: group_ids }]] }) as unknown as SubscriptionWithLinks;

beforeEach(() => {
  for (const fn of [listGroups, listGroupSummaries, loadSubscriptions, saveGroup]) vi.mocked(fn).mockReset();
  setMobile(false);
});

function render(groups: CallsignGroup[], summaries: GroupSummary[] = groups.map((g) => summary(g.id))) {
  vi.mocked(listGroups).mockResolvedValue(groups);
  vi.mocked(listGroupSummaries).mockResolvedValue(summaries);
  return renderPage(<GroupsPage />, { route: "/groups" });
}

const card = (name: string) => screen.getByRole("heading", { name }).closest(".MuiCard-root") as HTMLElement;

describe("GroupsPage", () => {
  it("shows progress, then the empty state, and opens the new group dialog from it", async () => {
    const { user } = render([]);
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(await screen.findByText("No groups yet.")).toBeInTheDocument();
    expect(screen.getByText(/See how the group is doing, share its statistics, and use it in connection rules\./)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create your first group" }));
    expect(await screen.findByRole("dialog", { name: "New group" })).toBeInTheDocument();
  });

  it("reports a load failure", async () => {
    vi.mocked(listGroups).mockResolvedValue([]);
    vi.mocked(listGroupSummaries).mockRejectedValue(new Error("Not signed in."));
    const { app } = renderPage(<GroupsPage />, { route: "/groups" });
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Not signed in."));
  });

  it("shows a public group's last 30 days and who is on the air", async () => {
    render(
      [group("a", { name: "Piedmont ARC", member_count: 24, subscription_count: 2 })],
      [summary("a", { public: true, spots: 10082, members_heard: 19, member_count: 24, on_air: ["W4ABC", "KK4PWJ", "N4GHI"] })],
    );
    const c = await screen.findByRole("heading", { name: "Piedmont ARC" }).then(() => card("Piedmont ARC"));
    expect(within(c).getByText("24 members · used by 2 connections")).toBeInTheDocument();
    expect(within(c).getByText("Public")).toBeInTheDocument();
    expect(within(c).getByText("Last 30 days")).toBeInTheDocument();
    expect(within(c).getByText("10,082 spots")).toBeInTheDocument();
    expect(within(c).getByText("19 of 24 members heard")).toBeInTheDocument();
    expect(within(c).getByRole("img", { name: "Spots per day, last 30 days" })).toBeInTheDocument();
    expect(within(c).getByText("3 on the air now: W4ABC, KK4PWJ, N4GHI")).toBeInTheDocument();
    expect(within(c).getByRole("link", { name: "Statistics" })).toHaveAttribute("href", "/groups/a");
    expect(within(c).getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/groups/a/settings");
  });

  it("shows a private group nobody is on, and one whose figures aren't built yet", async () => {
    render(
      [group("a", { name: "SOTA chasers", member_count: 12 }), group("b", { name: "New club" })],
      [summary("a"), summary("b", { spots: null, members_heard: null, member_count: null, daily: null })],
    );
    const c = await screen.findByRole("heading", { name: "SOTA chasers" }).then(() => card("SOTA chasers"));
    expect(within(c).getByText("12 members · not used by any connection")).toBeInTheDocument();
    expect(within(c).getByText("Private")).toBeInTheDocument();
    expect(within(c).getByText("Nobody on the air right now")).toBeInTheDocument();
    const b = card("New club");
    expect(within(b).queryByText("Last 30 days")).not.toBeInTheDocument();
    expect(within(b).queryByRole("img")).not.toBeInTheDocument();
  });

  it("uses the shorter sentence and a full-width button on phones", async () => {
    setMobile(true);
    render([]);
    await screen.findByText("No groups yet.");
    expect(screen.getByText("A group is a named list of callsigns, like a club roster. See how the group is doing and share its statistics."))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New group" })).toHaveClass("MuiButton-fullWidth");
  });

  it("creates a group and opens its page", async () => {
    vi.mocked(saveGroup).mockResolvedValue("n1");
    const { user, app } = render([]);
    await user.click(screen.getByRole("button", { name: "New group" }));
    await user.type(await screen.findByRole("textbox", { name: "Name" }), "  Friends ");
    await user.type(screen.getByRole("textbox", { name: "Callsigns" }), "w1aw, kk4pwj");
    await user.click(screen.getByRole("button", { name: "Create group" }));
    expect(saveGroup).toHaveBeenCalledWith({ name: "Friends", callsigns: ["w1aw", "kk4pwj"], public: false, show_callsigns: false });
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Created Friends"));
    expect(screen.getByTestId("location")).toHaveTextContent("/groups/n1");
  });

  describe("Get alerts", () => {
    it("asks for a source, then opens the editor on it with the group as the filter", async () => {
      // A connection that only leaves the group out doesn't count as alerts on it.
      vi.mocked(loadSubscriptions).mockResolvedValue([sub("Other", ["z"]), sub("Not RARS", ["a"], "is_not")]);
      const { user } = render([group("a", { name: "RARS" })]);
      await user.click(await screen.findByRole("button", { name: "Get alerts" }));
      const dialog = within(await screen.findByRole("dialog", { name: "New connection" }));
      await user.click(dialog.getByRole("radio", { name: /Reverse Beacon Network/ }));
      await user.click(dialog.getByRole("button", { name: "Continue" }));
      const where = screen.getByTestId("location");
      expect(where).toHaveTextContent(/^\/connections\/new$/);
      expect(where.dataset.search).toBe("?source=rbn&group=a");
    });

    it("stays on Groups when the picker is cancelled", async () => {
      vi.mocked(loadSubscriptions).mockResolvedValue([]);
      const { user } = render([group("a")]);
      await user.click(await screen.findByRole("button", { name: "Get alerts" }));
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(screen.getByTestId("location")).toHaveTextContent(/^\/groups$/);
    });

    it("opens the connection that already uses the group", async () => {
      vi.mocked(loadSubscriptions).mockResolvedValue([sub("Club alerts", ["a"])]);
      const { user, app } = render([group("a")]);
      await user.click(await screen.findByRole("button", { name: "Get alerts" }));
      await waitFor(() => expect(app.notify).toHaveBeenCalledWith("You already have Club alerts."));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      // The fixture's id is its name.
      await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/connections/Club"));
    });

    it("reports connections that don't load", async () => {
      vi.mocked(loadSubscriptions).mockRejectedValue(new Error(""));
      const { user, app } = render([group("a")]);
      await user.click(await screen.findByRole("button", { name: "Get alerts" }));
      await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Couldn't load your connections."));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Get alerts" })).toBeEnabled();
    });
  });
});

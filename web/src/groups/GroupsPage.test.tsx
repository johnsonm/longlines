import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import {
  deleteGroup, listGroups, loadDestinations, loadSubscriptions, saveGroup, saveSubscription,
  type Destination, type SubscriptionWithLinks,
} from "../lib/api";
import { GroupsPage } from "./GroupsPage";
import type { CallsignGroup } from "./types";

vi.mock("../lib/api", () => ({
  deleteGroup: vi.fn(),
  listGroups: vi.fn(),
  loadDestinations: vi.fn(),
  loadSubscriptions: vi.fn(),
  normalizeCallsigns: vi.fn(),
  saveGroup: vi.fn(),
  saveSubscription: vi.fn(),
}));

const CALLS = ["AA4MS", "AB4RD", "K4SWL", "KD4AA", "KK4PWJ", "KN4QHW", "KO4YUF", "N4CPA", "N4DXX", "W4ABC", "W4KNX", "WB4SZK"];

function group(id: string, overrides: Partial<CallsignGroup> = {}): CallsignGroup {
  return {
    id, name: `Group ${id}`, callsigns: ["KK4PWJ"], member_count: 1, subscription_count: 0, updated_at: "2026-10-13T00:00:00Z",
    on_air: { count: 0, latest: null }, ...overrides,
  };
}

const dest = (id: string, health: Destination["health"]) => ({ id, name: id, health }) as Destination;
const sub = (name: string, group_ids: string[], op = "is") =>
  ({ id: name, name, group_ids, rules: [[{ field: "group", op, values: group_ids }]] }) as unknown as SubscriptionWithLinks;

beforeEach(() => {
  for (const fn of [deleteGroup, listGroups, loadDestinations, loadSubscriptions, saveGroup, saveSubscription]) vi.mocked(fn).mockReset();
});

function render(groups: CallsignGroup[]) {
  vi.mocked(listGroups).mockResolvedValue(groups);
  const reload = vi.fn(() => Promise.resolve());
  const r = renderPage(<GroupsPage reload={reload} />, { route: "/groups" });
  return { ...r, reload };
}

const card = (name: string) => screen.getByRole("heading", { name }).closest(".MuiCard-root") as HTMLElement;

describe("GroupsPage", () => {
  it("shows progress, then the empty state, and opens the new group dialog from it", async () => {
    const { user } = render([]);
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(await screen.findByText("No groups yet.")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create your first group" }));
    expect(await screen.findByRole("dialog", { name: "New group" })).toBeInTheDocument();
  });

  it("reports a load failure", async () => {
    vi.mocked(listGroups).mockRejectedValue(new Error("Not signed in."));
    const { app } = renderPage(<GroupsPage reload={vi.fn()} />, { route: "/groups" });
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Not signed in."));
  });

  it("shows ten members, +N more and the latest spot of a group on the air", async () => {
    const spotTime = new Date(Date.now() - 2 * 60_000 - 5_000).toISOString();
    render([group("a", {
      name: "RARS members", callsigns: CALLS, member_count: 12, subscription_count: 1,
      on_air: {
        count: 1,
        latest: { callsign: "KK4PWJ", frequency_khz: 14062, band: "20m", mode: "CW", source: "pota", reference: "US-2763", spot_time: spotTime },
      },
    })]);
    const c = await screen.findByRole("heading", { name: "RARS members" }).then(() => card("RARS members"));
    expect(within(c).getByText("12 callsigns · used by 1 subscription")).toBeInTheDocument();
    for (const call of CALLS.slice(0, 10)) expect(within(c).getByText(call)).toBeInTheDocument();
    expect(within(c).queryByText("W4KNX")).not.toBeInTheDocument();
    expect(within(c).getByText("+2 more")).toBeInTheDocument();
    expect(within(c).getByText("1 on the air now")).toBeInTheDocument();
    expect(within(c).getByText("KK4PWJ 14062.0 kHz CW")).toBeInTheDocument();
    expect(within(c).getByText("20m · POTA · US-2763 · 2m ago")).toBeInTheDocument();
    expect(within(c).getByRole("button", { name: "Delete RARS members" })).toBeDisabled();
  });

  it("shows an unused group that is off the air", async () => {
    render([group("a", { name: "Field Day crew", callsigns: ["AC4ZO", "KK4PWJ"], member_count: 2 }), group("b", { callsigns: [], member_count: 0 })]);
    const c = await screen.findByRole("heading", { name: "Field Day crew" }).then(() => card("Field Day crew"));
    expect(within(c).getByText("2 callsigns · used by 0 subscriptions")).toBeInTheDocument();
    expect(within(c).queryByText(/more$/)).not.toBeInTheDocument();
    expect(within(c).queryByText(/on the air now/)).not.toBeInTheDocument();
    expect(within(c).getByRole("button", { name: "Delete Field Day crew" })).toBeEnabled();
    expect(within(card("Group b")).getByText("0 callsigns · used by 0 subscriptions")).toBeInTheDocument();
  });

  it("deletes an unused group and reloads", async () => {
    vi.mocked(deleteGroup).mockResolvedValue(undefined);
    const { user, app } = render([group("a")]);
    await user.click(await screen.findByRole("button", { name: "Delete Group a" }));
    expect(deleteGroup).toHaveBeenCalledWith("a");
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Deleted Group a"));
    expect(listGroups).toHaveBeenCalledTimes(2);
  });

  it("reports a delete the server refuses", async () => {
    vi.mocked(deleteGroup).mockRejectedValue(new Error("Remove it from its subscriptions first."));
    const { user, app } = render([group("a")]);
    await user.click(await screen.findByRole("button", { name: "Delete Group a" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Remove it from its subscriptions first."));
  });

  describe("Get alerts", () => {
    it("creates a subscription on the group with the first healthy destination", async () => {
      vi.mocked(loadDestinations).mockResolvedValue([dest("bad", "failing"), dest("good", "ok")]);
      // A subscription that only leaves the group out doesn't count as alerts on it.
      vi.mocked(loadSubscriptions).mockResolvedValue([sub("Other", ["z"]), sub("Not RARS", ["a"], "is_not")]);
      vi.mocked(saveSubscription).mockResolvedValue("s1");
      const { user, app, reload } = render([group("a", { name: "RARS" })]);
      await user.click(await screen.findByRole("button", { name: "Get alerts" }));
      await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Created RARS on the air"));
      expect(saveSubscription).toHaveBeenCalledWith({
        name: "RARS on the air", enabled: true, quiet_minutes: 30, destinations: ["good"],
        sources: [], rules: [[{ field: "group", op: "is", values: ["a"] }]],
      });
      expect(reload).toHaveBeenCalled();
      await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/subscriptions/s1"));
    });

    it("opens the subscription that already uses the group", async () => {
      vi.mocked(loadDestinations).mockResolvedValue([dest("good", "ok")]);
      vi.mocked(loadSubscriptions).mockResolvedValue([sub("Club alerts", ["a"])]);
      const { user, app } = render([group("a")]);
      await user.click(await screen.findByRole("button", { name: "Get alerts" }));
      await waitFor(() => expect(app.notify).toHaveBeenCalledWith("You already have Club alerts."));
      expect(saveSubscription).not.toHaveBeenCalled();
      // The fixture's id is its name.
      await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/subscriptions/Club"));
    });

    it("creates it without a destination when none is healthy and opens its editor", async () => {
      vi.mocked(loadDestinations).mockResolvedValue([dest("paused", "paused")]);
      vi.mocked(loadSubscriptions).mockResolvedValue([]);
      vi.mocked(saveSubscription).mockResolvedValue("s1");
      const { user, app } = render([group("a", { name: "RARS" })]);
      await user.click(await screen.findByRole("button", { name: "Get alerts" }));
      await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Created RARS on the air"));
      expect(saveSubscription).toHaveBeenCalledWith(expect.objectContaining({ destinations: [] }));
      await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/subscriptions/s1"));
    });

    it("reports a failed save", async () => {
      vi.mocked(loadDestinations).mockResolvedValue([dest("good", "ok")]);
      vi.mocked(loadSubscriptions).mockResolvedValue([]);
      vi.mocked(saveSubscription).mockRejectedValue(new Error(""));
      const { user, app } = render([group("a")]);
      await user.click(await screen.findByRole("button", { name: "Get alerts" }));
      await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Couldn't save the subscription."));
      expect(screen.getByRole("button", { name: "Get alerts" })).toBeEnabled();
    });
  });

  it("creates a group from the New group button", async () => {
    vi.mocked(saveGroup).mockResolvedValue("n1");
    const { user, app } = render([]);
    await user.click(screen.getByRole("button", { name: "New group" }));
    await user.type(await screen.findByRole("textbox", { name: "Group name" }), "  Friends ");
    await user.click(screen.getByRole("button", { name: "Create group" }));
    expect(saveGroup).toHaveBeenCalledWith({ name: "Friends", callsigns: [] });
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Created Friends"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(listGroups).toHaveBeenCalledTimes(2);
  });

  it("edits a group's whole list and closes on Cancel", async () => {
    vi.mocked(saveGroup).mockResolvedValue("a");
    const { user, app } = render([group("a", { name: "RARS", callsigns: ["AB4RD", "KK4PWJ"], member_count: 2 })]);
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit group" });
    expect(within(dialog).getByRole("textbox", { name: "Group name" })).toHaveValue("RARS");
    expect(within(dialog).getByText("2 callsigns")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(await screen.findByRole("button", { name: "Save changes" }));
    expect(saveGroup).toHaveBeenCalledWith({ id: "a", name: "RARS", callsigns: ["AB4RD", "KK4PWJ"] });
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Saved changes"));
  });
});

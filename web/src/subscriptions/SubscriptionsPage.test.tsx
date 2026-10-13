import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import {
  deleteSubscription, listGroups, previewSubscription, saveSubscription, setSubscriptionEnabled,
  type Destination, type Preview, type RecentSpot, type SubscriptionWithLinks,
} from "../lib/api";
import type { CallsignGroup } from "../groups/types";
import { SubscriptionsPage } from "./SubscriptionsPage";

vi.mock("../lib/api", () => ({
  deleteSubscription: vi.fn(),
  listGroups: vi.fn(),
  previewSubscription: vi.fn(),
  saveSubscription: vi.fn(),
  setSubscriptionEnabled: vi.fn(),
}));

const PREFS = { utcTimes: true, timezone: "UTC" };

function dest(id: string, name: string, overrides: Partial<Destination> = {}): Destination {
  return {
    id, user_id: "u1", type: "discord", name, url_display: "x", health: "ok", consecutive_failures: 0, last_success_at: null,
    last_error: null, last_error_at: null, created_at: "2026-10-01T00:00:00Z", ...overrides,
  };
}

function sub(overrides: Partial<SubscriptionWithLinks> = {}): SubscriptionWithLinks {
  return {
    id: "s1", user_id: "u1", name: "NC parks", enabled: true, sources: ["pota"], bands: ["20m"], modes: ["cw"], callsigns: [],
    reference: "US-NC", quiet_minutes: 10, group_ids: [], created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    destinations: ["d1"], ...overrides,
  } as SubscriptionWithLinks;
}

const SPOT = {
  id: 1, source: "pota", callsign: "W1AW", frequency_khz: 14062, mode: "cw", pota_reference: "US-0817",
  sota_summit_ref: null, spot_time: "2026-10-05T14:00:00Z",
} as RecentSpot;

function group(id: string, name: string): CallsignGroup {
  return {
    id, name, callsigns: ["KK4PWJ"], member_count: 1, subscription_count: 0, updated_at: "2026-10-13T00:00:00Z",
    on_air: { count: 0, latest: null },
  };
}

const GROUPS = [group("g1", "Friends"), group("g2", "RARS members")];

const DESTS = [dest("d1", "Shack"), dest("d2", "Club", { type: "webhook", health: "failing" })];

beforeEach(() => {
  for (const fn of [deleteSubscription, saveSubscription, setSubscriptionEnabled]) vi.mocked(fn).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(previewSubscription).mockReset().mockResolvedValue({ count: 3, spots: [SPOT], station_count: 0 });
  vi.mocked(listGroups).mockReset().mockResolvedValue(GROUPS);
});

function render(subs: SubscriptionWithLinks[], dests: Destination[] = DESTS, loading = false) {
  const reload = vi.fn(() => Promise.resolve());
  const r = renderPage(
    <SubscriptionsPage subs={subs} dests={dests} loading={loading} reload={reload} prefs={PREFS} fullScreen={false} />,
    { route: "/subscriptions" },
  );
  return { ...r, reload };
}

describe("SubscriptionsPage", () => {
  it("shows each subscription's filters, destinations and recent hits", async () => {
    render([sub(), sub({ id: "s2", name: "Anything", enabled: false, destinations: [], sources: [], bands: [], modes: [], reference: "", quiet_minutes: 0 })]);
    expect(screen.getByText("NC parks")).toBeInTheDocument();
    expect(screen.getByText("Ref contains US-NC")).toBeInTheDocument();
    expect(screen.getByText("Sends to Shack.")).toBeInTheDocument();
    expect(screen.getByText("Sends to nothing.")).toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(await screen.findAllByText("3 of the last 200 spots matched.")).toHaveLength(2);
  });

  it("leaves the hit count blank when the preview fails", async () => {
    vi.mocked(previewSubscription).mockRejectedValue(new Error("x"));
    render([sub()]);
    await waitFor(() => expect(previewSubscription).toHaveBeenCalled());
    expect(screen.queryByText(/spots matched/)).not.toBeInTheDocument();
  });

  it("points to Destinations when there are none", async () => {
    const { user } = render([], []);
    expect(screen.getByText("You need at least one destination before creating a subscription.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add one" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/destinations");
  });

  it("shows progress while loading", () => {
    render([], [], true);
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("toggles a subscription", async () => {
    const { user, reload } = render([sub()]);
    await user.click(screen.getByRole("switch"));
    expect(setSubscriptionEnabled).toHaveBeenCalledWith("s1", false);
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it("deletes a subscription", async () => {
    const { user, app } = render([sub()]);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(deleteSubscription).toHaveBeenCalledWith("s1");
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Deleted NC parks"));
  });

  it("reports toggle and delete failures", async () => {
    vi.mocked(setSubscriptionEnabled).mockRejectedValue(new Error(""));
    vi.mocked(deleteSubscription).mockRejectedValue(new Error(""));
    const { user, app } = render([sub()]);
    await user.click(screen.getByRole("switch"));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Couldn't update the subscription."));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Couldn't delete the subscription."));
  });

  it("creates a subscription through the dialog and tells the tour", async () => {
    const { user, app, tour } = render([], DESTS);
    await user.click(screen.getByRole("button", { name: "New subscription" }));
    expect(tour.report).toHaveBeenCalledWith("subscription-dialog-opened");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("New subscription")).toBeInTheDocument();
    const create = within(dialog).getByRole("button", { name: "Create subscription" });
    expect(create).toBeDisabled();

    await user.type(within(dialog).getByLabelText(/^Name/), "My sub");
    await user.click(within(dialog).getByLabelText("POTA"));
    await user.click(within(dialog).getByLabelText(/^Send matches to/));
    await user.click(await screen.findByRole("option", { name: /Shack/ }));
    await user.keyboard("{Escape}");
    await user.click(create);

    expect(saveSubscription).toHaveBeenCalledWith(expect.objectContaining({ name: "My sub", sources: ["pota"], destinations: ["d1"] }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Created My sub"));
    expect(tour.report).toHaveBeenCalledWith("subscription-created");
  });

  it("edits an existing subscription", async () => {
    const { user, app, tour } = render([sub()]);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Edit subscription")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(saveSubscription).toHaveBeenCalledWith(expect.objectContaining({ id: "s1", name: "NC parks" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Saved changes"));
    expect(tour.report).not.toHaveBeenCalledWith("subscription-created");
  });

  it("keeps the dialog open when saving fails, and cancel closes it", async () => {
    vi.mocked(saveSubscription).mockRejectedValue(new Error("Pick at least one destination."));
    const { user, app, tour } = render([sub()]);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Pick at least one destination."));
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(tour.report).toHaveBeenCalledWith("subscription-dialog-closed");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("SubscriptionDialog preview", () => {
  it("shows the database preview for the current filter", async () => {
    const { user } = render([sub()]);
    await waitFor(() => expect(previewSubscription).toHaveBeenCalled());
    // Hold the dialog's preview until "Checking" has been seen: on a slow runner finding the dialog
    // can outlast the 300 ms debounce, and an instant answer would replace the text first.
    let answer: ((preview: Preview) => void) | undefined;
    vi.mocked(previewSubscription).mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Checking recent spots…")).toBeInTheDocument();
    await waitFor(() => expect(answer).toBeDefined());
    answer?.({ count: 3, spots: [SPOT], station_count: 0 });
    expect(await within(dialog).findByText("3 of the last 200 spots would have matched.")).toBeInTheDocument();
    expect(within(dialog).getByText("W1AW on 14062.0 kHz CW")).toBeInTheDocument();
    expect(within(dialog).getByText(/US-0817 · POTA ·/)).toBeInTheDocument();
  });

  it("warns when the filter matches everything and notes an empty match", async () => {
    vi.mocked(previewSubscription).mockResolvedValueOnce({ count: 200, spots: [], station_count: 0 }).mockResolvedValue({ count: 0, spots: [], station_count: 0 });
    const { user } = render([sub()]);
    await waitFor(() => expect(previewSubscription).toHaveBeenCalledTimes(1));
    vi.mocked(previewSubscription).mockResolvedValueOnce({ count: 200, spots: [], station_count: 0 });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/This matches everything/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/^Park, summit/), "X");
    expect(await within(dialog).findByText(/Nothing recent matches/)).toBeInTheDocument();
  });

  it("shows preview errors", async () => {
    const { user } = render([sub()]);
    await waitFor(() => expect(previewSubscription).toHaveBeenCalled());
    vi.mocked(previewSubscription).mockRejectedValue(new Error("Couldn't load the preview."));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Couldn't load the preview.")).toBeInTheDocument();
  });

  it("edits bands, modes, callsigns, quiet time and sources", async () => {
    const { user } = render([sub({ destinations: ["d1"] })]);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");

    await user.click(within(dialog).getByLabelText("POTA"));
    await user.click(within(dialog).getByLabelText("SOTAwatch"));
    await user.click(within(dialog).getByLabelText("Bands"));
    await user.click(await screen.findByRole("option", { name: "40m" }));
    await user.click(within(dialog).getByLabelText("Modes"));
    await user.click(await screen.findByRole("option", { name: "Any digital" }));
    await user.type(within(dialog).getByLabelText("Callsigns"), " w1aw {Enter}");
    await user.click(within(dialog).getByRole("combobox", { name: "Repeat spots for the same station" }));
    await user.click(await screen.findByRole("option", { name: "At most once an hour" }));
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));

    expect(saveSubscription).toHaveBeenCalledWith(expect.objectContaining({
      sources: ["sotawatch"],
      bands: ["20m", "40m"],
      modes: ["cw", "digital"],
      callsigns: ["W1AW"],
      quiet_minutes: 60,
    }));
  });

  it("flags a failing destination in the picker", async () => {
    const { user } = render([sub()]);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByLabelText(/^Send matches to/));
    const club = await screen.findByRole("option", { name: /Club/ });
    expect(within(club).getByText("Failing")).toBeInTheDocument();
  });
});

describe("Callsign groups", () => {
  async function openEdit(overrides: Partial<SubscriptionWithLinks> = {}) {
    const r = render([sub(overrides)]);
    await waitFor(() => expect(listGroups).toHaveBeenCalled());
    await r.user.click(screen.getByRole("button", { name: "Edit" }));
    return { ...r, dialog: await screen.findByRole("dialog") };
  }

  it("shows a Group chip on the card for each of its groups", async () => {
    render([sub({ group_ids: ["g2"] })]);
    expect(await screen.findByText("Group: RARS members")).toBeInTheDocument();
    expect(screen.queryByText("Group: Friends")).not.toBeInTheDocument();
  });

  it("picks groups, swaps the Callsigns helper and previews and saves them", async () => {
    vi.mocked(previewSubscription).mockResolvedValue({ count: 3, spots: [SPOT], station_count: 12 });
    const { user, dialog } = await openEdit();
    expect(within(dialog).getByText("Leave empty to match any station.")).toBeInTheDocument();
    expect(within(dialog).queryByText(/stations? from your groups/)).not.toBeInTheDocument();

    await user.click(within(dialog).getByLabelText("Callsign groups"));
    await user.click(await screen.findByRole("option", { name: "RARS members" }));
    expect(within(dialog).getByText("Added to the groups below.")).toBeInTheDocument();
    await waitFor(() => expect(previewSubscription).toHaveBeenLastCalledWith(expect.objectContaining({ group_ids: ["g2"] })));
    expect(await within(dialog).findByText("Matches 12 stations from your groups and callsigns.")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(saveSubscription).toHaveBeenCalledWith(expect.objectContaining({ id: "s1", group_ids: ["g2"] }));
  });

  it("counts typed calls alone, in the singular", async () => {
    vi.mocked(previewSubscription).mockResolvedValue({ count: 3, spots: [SPOT], station_count: 1 });
    const { dialog } = await openEdit({ callsigns: ["W1AW"] });
    expect(await within(dialog).findByText("Matches 1 station from your groups and callsigns.")).toBeInTheDocument();
    expect(within(dialog).getByText("Leave empty to match any station.")).toBeInTheDocument();
  });

  it("removes a group from an existing subscription", async () => {
    const { user, dialog } = await openEdit({ group_ids: ["g1"] });
    expect(within(dialog).getByText("Added to the groups below.")).toBeInTheDocument();
    await user.click(within(within(dialog).getByRole("button", { name: "Friends" })).getByTestId("CancelIcon"));
    expect(within(dialog).getByText("Leave empty to match any station.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(saveSubscription).toHaveBeenCalledWith(expect.objectContaining({ group_ids: [] }));
  });

  it("links to Groups when the account has none", async () => {
    vi.mocked(listGroups).mockResolvedValue([]);
    const { user, dialog } = await openEdit();
    expect(within(dialog).queryByLabelText("Callsign groups")).not.toBeInTheDocument();
    expect(within(dialog).getByText(/No callsign groups yet\./)).toHaveTextContent(
      "No callsign groups yet. Create a group to watch a club roster or an award list.",
    );
    await user.click(within(dialog).getByRole("link", { name: "Create a group" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/groups");
  });

  it("hides the field and the chips but keeps the groups when the list doesn't load", async () => {
    vi.mocked(listGroups).mockRejectedValue(new Error("x"));
    const { user, dialog } = await openEdit({ group_ids: ["g1"] });
    expect(screen.queryByText(/^Group: /)).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Callsign groups")).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/No callsign groups yet/)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(saveSubscription).toHaveBeenCalledWith(expect.objectContaining({ group_ids: ["g1"] }));
  });
});

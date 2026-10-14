import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import {
  listGroups, previewSubscription, saveSubscription, type Destination, type Preview, type RecentSpot, type SubscriptionWithLinks,
} from "../lib/api";
import type { CallsignGroup } from "../groups/types";
import { useStats } from "../stats/useStats";
import { SubscriptionEditorPage } from "./SubscriptionEditorPage";

vi.mock("../lib/api", () => ({
  listGroups: vi.fn(),
  previewSubscription: vi.fn(),
  saveSubscription: vi.fn(),
}));
vi.mock("../stats/useStats", () => ({ useStats: vi.fn() }));

const PREFS = { utcTimes: true, timezone: "UTC" };

function dest(id: string, name: string, overrides: Partial<Destination> = {}): Destination {
  return {
    id, user_id: "u1", type: "discord", name, url_display: "x", health: "ok", consecutive_failures: 0, last_success_at: null,
    last_error: null, last_error_at: null, created_at: "2026-10-01T00:00:00Z", ...overrides,
  };
}

function sub(overrides: Partial<SubscriptionWithLinks> = {}): SubscriptionWithLinks {
  return {
    id: "s1", user_id: "u1", name: "NC parks", enabled: true, sources: ["pota"], bands: ["20m"], modes: [], callsigns: [],
    reference: "", quiet_minutes: 10, group_ids: [], created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    destinations: ["d1"], ...overrides,
  } as SubscriptionWithLinks;
}

function group(id: string, name: string): CallsignGroup {
  return {
    id, name, callsigns: ["KK4PWJ"], member_count: 1, subscription_count: 0, updated_at: "2026-10-13T00:00:00Z",
    on_air: { count: 0, latest: null },
  };
}

const spot = (id: number, callsign: string): RecentSpot => ({
  id, source: "pota", callsign, frequency_khz: 14062, mode: "cw", pota_reference: "US-0817", sota_summit_ref: null,
  spot_time: "2026-10-05T14:00:00Z",
} as RecentSpot);

const DESTS = [dest("d1", "Shack"), dest("d2", "Club", { type: "webhook", health: "failing" }), dest("d3", "Alerts")];
const HOURLY = Array.from({ length: 168 }, (_, i) => ({
  hour: new Date(Date.UTC(2026, 9, 7, i)).toISOString(), pota: 36, sota: 5, rbn: 192, dx: 56, aprs: 0,
}));

const preview = (p: Partial<Preview> = {}): Preview => ({ count: 7, spots: [], station_count: 0, window_size: 42, ...p });

beforeEach(() => {
  vi.mocked(saveSubscription).mockReset().mockResolvedValue("s9");
  vi.mocked(previewSubscription).mockReset().mockResolvedValue(preview({
    spots: [spot(1, "K8ABC"), spot(2, "W7XYZ"), spot(3, "N0DEF"), spot(4, "KL7GHI"), spot(5, "N4DXX")],
  }));
  vi.mocked(listGroups).mockReset().mockResolvedValue([group("g1", "Friends"), group("g2", "RARS members")]);
  vi.mocked(useStats).mockReset().mockReturnValue({
    stats: { generatedAt: "2026-10-14T13:00:00Z", payload: { hourly: HOURLY } } as never, loading: false, error: null,
  });
});

interface Opts {
  id?: string;
  source?: string | null;
  subs?: SubscriptionWithLinks[];
  dests?: Destination[];
  loading?: boolean;
  mobile?: boolean;
}

function render({ id, source = null, subs = [sub()], dests = DESTS, loading = false, mobile = false }: Opts) {
  const reload = vi.fn(() => Promise.resolve());
  const r = renderPage(
    <SubscriptionEditorPage id={id} source={source} subs={subs} dests={dests} loading={loading} reload={reload} prefs={PREFS} mobile={mobile} />,
    { route: "/subscriptions/x" },
  );
  return { ...r, reload };
}

const save = () => screen.getByRole("button", { name: "Save subscription" });

describe("routing", () => {
  it("waits for subscriptions to load before giving up on an id", () => {
    render({ id: "nope", loading: true });
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("sends an unknown id back to the list", () => {
    render({ id: "nope" });
    expect(screen.getByTestId("location")).toHaveTextContent("/subscriptions");
  });

  it("sends a source that can't alert back to the list", () => {
    render({ source: "aprs" });
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/subscriptions$/);
  });
});

describe("new subscription", () => {
  it("starts from the picked source, tells the tour, and saves with no destinations", async () => {
    const { user, app, tour, reload } = render({ source: "pota" });
    expect(tour.report).toHaveBeenCalledWith("subscription-form-opened");
    expect(screen.getByRole("heading", { name: "New subscription" })).toBeInTheDocument();
    expect(screen.getByText("Parks on the Air")).toBeInTheDocument();
    expect(screen.getByText("36 spots/hour on average")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View schema" })).toHaveAttribute("href", "/sources/pota");
    expect(screen.getByText("Optional. Leave it empty to pass every spot")).toBeInTheDocument();
    expect(screen.queryByText("Pass spots that match all of these rules")).not.toBeInTheDocument();
    expect(screen.getByText("No destinations yet")).toBeInTheDocument();
    expect(save()).toBeDisabled();

    await user.type(screen.getByLabelText(/^Name/), " Parks ");
    await user.click(save());
    expect(saveSubscription).toHaveBeenCalledWith(expect.objectContaining({ name: "Parks", sources: ["pota"], destinations: [], enabled: true }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Created Parks"));
    expect(reload).toHaveBeenCalled();
    expect(tour.report).toHaveBeenCalledWith("subscription-created");
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/subscriptions$/);
  });

  it("requires a callsign or group on RBN, with the day's volume", async () => {
    const { user } = render({ source: "rbn" });
    expect(screen.getByText("Required for this source")).toBeInTheDocument();
    expect(screen.getByText("Reverse Beacon Network is a high volume source")).toBeInTheDocument();
    expect(screen.getByText(/Without one it would pass about 4,600 spots a day\./)).toBeInTheDocument();
    expect(screen.getByText("High volume source: at least one callsign or group is required.")).toBeInTheDocument();
    expect(screen.getByText("Add a callsign to see a preview")).toBeInTheDocument();
    expect(await screen.findByText("The preview shows how many of the last 42 RBN spots would pass your filter.")).toBeInTheDocument();
    // No park, summit, or location field on RBN.
    await user.click(screen.getByRole("combobox", { name: "Field" }));
    expect(screen.queryByRole("option", { name: "Park, summit, or location" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.type(screen.getByLabelText(/^Name/), "Me");
    expect(save()).toBeDisabled();
    await user.type(screen.getByLabelText("Values"), "kk4pwj{Enter}");
    expect(save()).toBeEnabled();
    expect(screen.getByText("Type a call and press Enter.")).toBeInTheDocument();
    await user.click(save());
    expect(saveSubscription).toHaveBeenCalledWith(expect.objectContaining({ sources: ["rbn"], callsigns: ["KK4PWJ"] }));
  });

  it("leaves the per-day sentence out before the stats load", () => {
    vi.mocked(useStats).mockReturnValue({ stats: null, loading: true, error: null });
    render({ source: "rbn" });
    expect(screen.queryByText(/spots a day/)).not.toBeInTheDocument();
    expect(screen.queryByText(/on average/)).not.toBeInTheDocument();
  });

  it("keeps the form when saving fails, and Cancel tells the tour and goes back", async () => {
    vi.mocked(saveSubscription).mockRejectedValue(new Error("Group not found."));
    const { user, app, tour } = render({ source: "pota" });
    await user.type(screen.getByLabelText(/^Name/), "X");
    await user.click(save());
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Group not found."));
    expect(save()).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(tour.report).toHaveBeenCalledWith("subscription-form-cancelled");
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/subscriptions$/);
  });
});

describe("edit subscription", () => {
  it("loads the subscription's rules, destinations and preview", async () => {
    const { tour } = render({ id: "s1", subs: [sub({ destinations: ["d1", "d2"], callsigns: ["W1AW"] })] });
    expect(tour.report).not.toHaveBeenCalledWith("subscription-form-opened");
    expect(screen.getByRole("heading", { name: "Edit subscription" })).toBeInTheDocument();
    expect(screen.getByText("Pass spots that match all of these rules")).toBeInTheDocument();
    expect(screen.getAllByLabelText("Field")).toHaveLength(2);
    expect(screen.getByText("W1AW")).toBeInTheDocument();
    expect(screen.getByText("Shack")).toBeInTheDocument();
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText("Failing")).toBeInTheDocument();
    expect(await screen.findByText("7 of the last 42 POTA spots would pass")).toBeInTheDocument();
    expect(screen.getByText("K8ABC US-0817")).toBeInTheDocument();
    expect(screen.queryByText("N4DXX US-0817")).not.toBeInTheDocument();
    expect(screen.getByText("Showing 4 of 7. Preview uses the last 42 POTA spots.")).toBeInTheDocument();
    expect(previewSubscription).toHaveBeenCalledWith(expect.objectContaining({ sources: ["pota"], bands: ["20m"], callsigns: ["W1AW"] }));
  });

  it("adds, changes and deletes rules, and saves them with the repeat window", async () => {
    const { user, app } = render({ id: "s1" });
    // Band is the one rule; Add rule takes the first unused field, Callsign.
    await user.click(screen.getByRole("button", { name: "Add rule" }));
    expect(screen.getAllByLabelText("Field")).toHaveLength(2);
    await user.type(screen.getAllByLabelText("Values")[1]!, "w1aw{Enter}");

    // Swap the band rule for a mode rule: its bands are cleared.
    await user.click(screen.getAllByRole("combobox", { name: "Field" })[0]!);
    await user.click(await screen.findByRole("option", { name: "Mode" }));
    await user.click(screen.getAllByLabelText("Values")[0]!);
    await user.click(await screen.findByRole("option", { name: "Any digital" }));
    expect(screen.getByText("SOTAwatch reports every digital mode as DATA. Choose Any digital to include those spots.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add rule" }));
    await user.click(screen.getAllByRole("combobox", { name: "Field" })[2]!);
    await user.click(await screen.findByRole("option", { name: "Park, summit, or location" }));
    await user.type(screen.getByPlaceholderText("US-NC, W4C/, US-0817"), "US-NC");
    expect(screen.getByText("Matches POTA references and locations, and SOTA summit codes.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete Callsign rule" }));
    await user.click(screen.getByRole("combobox", { name: "Repeat spots for the same station" }));
    await user.click(await screen.findByRole("option", { name: "At most once per hour" }));
    await user.click(screen.getByRole("switch", { name: "Enabled" }));
    await user.click(save());

    expect(saveSubscription).toHaveBeenCalledWith(expect.objectContaining({
      id: "s1", callsigns: [], bands: [], modes: ["digital"], reference: "US-NC", quiet_minutes: 60, enabled: false,
    }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Saved changes"));
  });

  it("disables Add rule once every field is used", async () => {
    const { user } = render({ id: "s1", subs: [sub({ sources: ["rbn"], callsigns: ["W1AW"], bands: [] })] });
    for (let i = 0; i < 3; i++) await user.click(screen.getByRole("button", { name: "Add rule" }));
    expect(screen.getByRole("button", { name: "Add rule" })).toBeDisabled();
  });

  it("adds and removes destinations", async () => {
    const { user } = render({ id: "s1" });
    await user.click(screen.getByRole("button", { name: "Add destination" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByText("Shack")).not.toBeInTheDocument();
    await user.click(within(menu).getByText("Club"));
    expect(screen.getByText("Webhook")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove Shack" }));
    await user.click(save());
    expect(saveSubscription).toHaveBeenCalledWith(expect.objectContaining({ destinations: ["d2"] }));
  });

  it("disables Add destination when every one is used, and links to Destinations when there are none", async () => {
    const { unmount } = render({ id: "s1", subs: [sub({ destinations: ["d1", "d2", "d3"] })] });
    expect(screen.getByRole("button", { name: "Add destination" })).toBeDisabled();
    unmount();
    const { user } = render({ id: "s1", subs: [sub({ destinations: [] })], dests: [] });
    await user.click(screen.getByRole("button", { name: "Add destination" }));
    await user.click(await screen.findByRole("menuitem", { name: "Add one on the Destinations page" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/destinations");
  });

  it("keeps an older subscription's sources", async () => {
    const { user } = render({ id: "s1", subs: [sub({ sources: ["pota", "sotawatch"] })] });
    expect(screen.getByText(/made before subscriptions had one source/)).toBeInTheDocument();
    expect(screen.getByText("SOTAwatch")).toBeInTheDocument();
    expect(await screen.findByText("7 of the last 42 spots would pass")).toBeInTheDocument();
    await user.click(save());
    expect(saveSubscription).toHaveBeenCalledWith(expect.objectContaining({ sources: ["pota", "sotawatch"] }));
    render({ id: "s1", subs: [sub({ sources: [] })] });
    expect(screen.getByText("All sources")).toBeInTheDocument();
  });

  it("lays rules out stacked on a phone", () => {
    render({ id: "s1", mobile: true });
    expect(screen.getByLabelText("Condition")).toHaveValue("is");
  });
});

describe("preview", () => {
  it("says when nothing passes, when everything does, and when there is nothing to sample", async () => {
    vi.mocked(previewSubscription).mockResolvedValue(preview({ count: 0 }));
    const { unmount } = render({ id: "s1" });
    expect(await screen.findByText(/Nothing recent passes/)).toBeInTheDocument();
    unmount();

    vi.mocked(previewSubscription).mockResolvedValue(preview({ count: 42, spots: [spot(1, "K8ABC")] }));
    const second = render({ id: "s1" });
    expect(await screen.findByText(/This passes everything/)).toBeInTheDocument();
    second.unmount();

    vi.mocked(previewSubscription).mockResolvedValue(preview({ count: 0, window_size: 0 }));
    render({ id: "s1" });
    expect(await screen.findByText("No recent POTA spots to preview yet")).toBeInTheDocument();
  });

  it("shows preview errors", async () => {
    vi.mocked(previewSubscription).mockRejectedValue(new Error("Couldn't load the preview."));
    render({ id: "s1" });
    expect(await screen.findByText("Couldn't load the preview.")).toBeInTheDocument();
  });

  it("shows Checking until the first answer", () => {
    vi.mocked(previewSubscription).mockReturnValue(new Promise(() => undefined));
    render({ id: "s1" });
    expect(screen.getByText("Checking recent spots…")).toBeInTheDocument();
  });
});

describe("callsign groups", () => {
  it("picks a group, counts its stations and saves it", async () => {
    vi.mocked(previewSubscription).mockResolvedValue(preview({ station_count: 12 }));
    const { user } = render({ id: "s1" });
    await waitFor(() => expect(listGroups).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "Add rule" }));
    await user.click(screen.getAllByRole("combobox", { name: "Field" })[1]!);
    await user.click(await screen.findByRole("option", { name: "Callsign group" }));
    await user.click(screen.getAllByLabelText("Values")[1]!);
    await user.click(await screen.findByRole("option", { name: "RARS members" }));
    await waitFor(() => expect(previewSubscription).toHaveBeenLastCalledWith(expect.objectContaining({ group_ids: ["g2"] })));
    expect(await screen.findByText("Matches 12 stations from your groups and callsigns.")).toBeInTheDocument();
    await user.click(save());
    expect(saveSubscription).toHaveBeenCalledWith(expect.objectContaining({ group_ids: ["g2"] }));
  });

  it("counts one station in the singular", async () => {
    vi.mocked(previewSubscription).mockResolvedValue(preview({ station_count: 1 }));
    render({ id: "s1", subs: [sub({ group_ids: ["g1"] })] });
    expect(await screen.findByText("Matches 1 station from your groups and callsigns.")).toBeInTheDocument();
  });

  it("links to Groups when the account has none", async () => {
    vi.mocked(listGroups).mockResolvedValue([]);
    const { user } = render({ id: "s1", subs: [sub({ group_ids: ["g1"] })] });
    const link = await screen.findByRole("link", { name: "Create a group" });
    await user.click(link);
    expect(screen.getByTestId("location")).toHaveTextContent("/groups");
  });

  it("keeps the groups when the list doesn't load", async () => {
    vi.mocked(listGroups).mockRejectedValue(new Error("x"));
    const { user } = render({ id: "s1", subs: [sub({ group_ids: ["g1"] })] });
    expect(await screen.findByText("Couldn't load your groups.")).toBeInTheDocument();
    await user.click(save());
    expect(saveSubscription).toHaveBeenCalledWith(expect.objectContaining({ group_ids: ["g1"] }));
  });
});

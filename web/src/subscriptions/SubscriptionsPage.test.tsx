import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import {
  deleteSubscription, listGroups, previewSubscription, setSubscriptionEnabled, type Destination, type SubscriptionWithLinks,
} from "../lib/api";
import type { CallsignGroup } from "../groups/types";
import { useStats } from "../stats/useStats";
import { SubscriptionsPage } from "./SubscriptionsPage";

vi.mock("../lib/api", () => ({
  deleteSubscription: vi.fn(),
  listGroups: vi.fn(),
  previewSubscription: vi.fn(),
  setSubscriptionEnabled: vi.fn(),
}));
vi.mock("../stats/useStats", () => ({ useStats: vi.fn() }));

function dest(id: string, name: string, overrides: Partial<Destination> = {}): Destination {
  return {
    id, user_id: "u1", type: "discord", name, enabled: true, url_display: "x", health: "ok", consecutive_failures: 0, last_success_at: null,
    last_error: null, last_error_at: null, created_at: "2026-10-01T00:00:00Z", auto_disabled_at: null, ...overrides,
  };
}

function sub(overrides: Partial<SubscriptionWithLinks> = {}): SubscriptionWithLinks {
  return {
    id: "s1", user_id: "u1", name: "NC parks", enabled: true, sources: ["pota"],
    rules: [[rule("band", "is", "20m"), rule("mode", "is", "cw"), rule("reference", "contains", "US-NC")]],
    quiet_minutes: 10, group_ids: [], created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    destinations: ["d1"], ...overrides,
  } as SubscriptionWithLinks;
}

function rule(field: string, op: string, ...values: (string | number)[]) {
  return { field, op, values };
}

function group(id: string, name: string): CallsignGroup {
  return {
    id, name, callsigns: ["KK4PWJ"], member_count: 1, subscription_count: 0, updated_at: "2026-10-13T00:00:00Z",
    on_air: { count: 0, latest: null },
  };
}

const DESTS = [dest("d1", "Shack"), dest("d2", "Club", { type: "webhook", health: "failing" })];

// 168 hours of 36 POTA spots and 192 RBN spots (3.2 a minute).
const HOURLY = Array.from({ length: 168 }, (_, i) => ({
  hour: new Date(Date.UTC(2026, 9, 7, i)).toISOString(), pota: 36, sota: 5, rbn: 192, dx: 56, aprs: 0,
}));

beforeEach(() => {
  for (const fn of [deleteSubscription, setSubscriptionEnabled]) vi.mocked(fn).mockReset().mockResolvedValue(undefined);
  vi.mocked(previewSubscription).mockReset().mockResolvedValue({ count: 3, spots: [], station_count: 0, window_size: 42 });
  vi.mocked(listGroups).mockReset().mockResolvedValue([group("g1", "Friends"), group("g2", "RARS members")]);
  vi.mocked(useStats).mockReset().mockReturnValue({
    stats: { generatedAt: "2026-10-14T13:00:00Z", payload: { hourly: HOURLY } } as never, loading: false, error: null,
  });
});

function render(subs: SubscriptionWithLinks[], { dests = DESTS, loading = false, mobile = false } = {}) {
  const reload = vi.fn(() => Promise.resolve());
  const r = renderPage(<SubscriptionsPage subs={subs} dests={dests} loading={loading} reload={reload} mobile={mobile} />, { route: "/connections" });
  return { ...r, reload };
}

describe("SubscriptionsPage", () => {
  it("shows each subscription's source, rules, destinations and recent passes", async () => {
    render([
      sub({ destinations: ["d1", "d2"] }),
      sub({
        id: "s2", name: "Anything", enabled: true, destinations: [], sources: ["rbn"], quiet_minutes: 0,
        rules: [[rule("callsign", "is", "W1AW")], [rule("callsign", "is", "K1ABC"), rule("frequency", "lt", 7100)]],
      }),
    ]);
    expect(screen.getByText("NC parks")).toBeInTheDocument();
    expect(screen.getByText("Parks on the Air")).toBeInTheDocument();
    expect(screen.getByText("Band is")).toBeInTheDocument();
    expect(screen.getByText("Park, summit, or location contains")).toBeInTheDocument();
    expect(screen.getByText("US-NC")).toBeInTheDocument();
    expect(screen.getAllByText("and")).toHaveLength(3);
    expect(screen.getAllByText("or")).toHaveLength(1);
    expect(screen.getByText("Frequency (kHz) is less than")).toBeInTheDocument();
    expect(screen.getByText("7100")).toBeInTheDocument();
    expect(screen.getByText("Shack")).toBeInTheDocument();
    expect(screen.getByText("Club")).toBeInTheDocument();
    expect(screen.getByText("No destinations")).toBeInTheDocument();
    expect(screen.getByText("Reverse Beacon Network")).toBeInTheDocument();
    expect(screen.getByText("Every spot · Waiting for a destination")).toBeInTheDocument();
    const waiting = screen.getByRole("switch", { name: "Anything on" });
    expect(waiting).not.toBeChecked();
    expect(waiting).toBeDisabled();
    expect(await screen.findByText("Once per 10 min · 3 of the last 42 POTA spots passed")).toBeInTheDocument();
  });

  it("shows a paused subscription", () => {
    render([sub({ enabled: false })]);
    expect(screen.getByText("Once per 10 min · Paused")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "NC parks on" })).not.toBeChecked();
  });

  it("names the group rule once the groups load, and lists older subscriptions' sources", async () => {
    render([sub({ sources: [], group_ids: ["g2"], rules: [[rule("group", "is", "g2")]] }), sub({ id: "s2", sources: ["pota", "sotawatch"] })]);
    expect(await screen.findByText("RARS members")).toBeInTheDocument();
    expect(screen.getByText("Callsign group is in")).toBeInTheDocument();
    expect(screen.getByText("All sources")).toBeInTheDocument();
    expect(screen.getByText("SOTAwatch")).toBeInTheDocument();
    expect(await screen.findAllByText("Once per 10 min · 3 of the last 42 spots passed")).toHaveLength(2);
  });

  it("leaves the passes out when the preview fails", async () => {
    vi.mocked(previewSubscription).mockRejectedValue(new Error("x"));
    render([sub()]);
    await waitFor(() => expect(previewSubscription).toHaveBeenCalled());
    expect(screen.getByText("Once per 10 min")).toBeInTheDocument();
  });

  it("shows progress while loading and the short copy on a phone", () => {
    render([], { loading: true, mobile: true });
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(screen.getByText("One source, a filter, and zero or more destinations.")).toBeInTheDocument();
  });

  it("toggles a subscription", async () => {
    const { user, reload } = render([sub()]);
    await user.click(screen.getByRole("switch", { name: "NC parks on" }));
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
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Couldn't update the connection."));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Couldn't delete the connection."));
  });

  it("links Edit to the subscription's page", async () => {
    const { user } = render([sub()]);
    await user.click(screen.getByRole("link", { name: "Edit" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/connections/s1");
  });
});

describe("Pick your source", () => {
  it("lists live sources with rates, then opens the editor", async () => {
    const { user } = render([]);
    await user.click(screen.getByRole("button", { name: "New connection" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Pick your source")).toBeInTheDocument();
    expect(within(dialog).getByText("36 / hour")).toBeInTheDocument();
    expect(within(dialog).getByText("192 / hour")).toBeInTheDocument();
    expect(within(dialog).getAllByText("High volume. Needs a callsign filter")).toHaveLength(1); // RBN
    expect(within(dialog).queryByText("APRS-IS")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /WWFF/ })).toBeEnabled();
    expect(within(dialog).queryByText("Not yet available")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /Parks on the Air/ })).toBeChecked();
    // IOTA rides on DX Cluster; the editor starts it as a DX Cluster connection with an island rule.
    expect(within(dialog).getByRole("radio", { name: /IOTA/ })).toBeEnabled();

    await user.click(within(dialog).getByRole("radio", { name: /Reverse Beacon Network/ }));
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    const where = screen.getByTestId("location");
    expect(where).toHaveTextContent("/connections/new");
    expect(where).toHaveAttribute("data-search", "?source=rbn");
  });

  it("shows no rates before the stats load, and Cancel closes the picker", async () => {
    vi.mocked(useStats).mockReturnValue({ stats: null, loading: true, error: null });
    const { user } = render([]);
    await user.click(screen.getByRole("button", { name: "New connection" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText(/\/ hour/)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

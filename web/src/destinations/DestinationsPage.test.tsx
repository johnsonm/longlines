import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import { setMobile } from "../test/media";
import {
  deleteDestination, duplicateDestination, listDiscordDestinationSettings, listLocalClusterDestinationSettings, listPushDevices,
  listWebhookDestinationSettings, sendTest, type Destination, type PushDevice, type SubscriptionWithLinks,
} from "../lib/api";
import { cardMeta } from "./cardMeta";
import { DestinationsPage } from "./DestinationsPage";

vi.mock("../lib/api", () => ({
  deleteDestination: vi.fn(),
  duplicateDestination: vi.fn(),
  listDiscordDestinationSettings: vi.fn(),
  listLocalClusterDestinationSettings: vi.fn(),
  listPushDevices: vi.fn(),
  listWebhookDestinationSettings: vi.fn(),
  sendTest: vi.fn(),
}));

function dest(id: string, overrides: Partial<Destination> = {}): Destination {
  return {
    id, user_id: "u1", type: "webhook", name: `Dest ${id}`, enabled: true, url_display: "https://example.com/…", health: "ok",
    consecutive_failures: 0, last_success_at: null, last_error: null, last_error_at: null, created_at: "2026-10-01T00:00:00Z", auto_disabled_at: null,
    ...overrides,
  };
}

function device(id: string, overrides: Partial<PushDevice> = {}): PushDevice {
  return {
    id, label: `Device ${id}`, agent: "Chrome on Android", standalone: false, created_at: "2026-10-01T00:00:00Z", last_success_at: null,
    last_error: null, last_error_at: null, blocked_at: null, is_current: false, destination_ids: [], ...overrides,
  };
}

const sub = (id: string, destinations: string[]) => ({ id, destinations }) as SubscriptionWithLinks;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

beforeEach(() => {
  for (const fn of [
    deleteDestination, duplicateDestination, listDiscordDestinationSettings, listLocalClusterDestinationSettings, listPushDevices,
    listWebhookDestinationSettings, sendTest,
  ]) {
    vi.mocked(fn).mockReset();
  }
  vi.mocked(listLocalClusterDestinationSettings).mockResolvedValue([]);
  vi.mocked(listPushDevices).mockResolvedValue([]);
  vi.mocked(listDiscordDestinationSettings).mockResolvedValue([]);
  vi.mocked(listWebhookDestinationSettings).mockResolvedValue([]);
});

function render(dests: Destination[], subs: SubscriptionWithLinks[] = [], loading = false) {
  const reload = vi.fn(() => Promise.resolve());
  const r = renderPage(<DestinationsPage dests={dests} subs={subs} loading={loading} reload={reload} />, {
    route: "/destinations",
  });
  return { ...r, reload };
}

describe("cardMeta", () => {
  const now = new Date("2026-10-17T12:00:00Z");

  it("joins usage and the last delivery, capitalized for every type (webhook spec, decision 17)", () => {
    expect(cardMeta(dest("a"), 0, now)).toBe("Not used by any connection · Never used");
    expect(cardMeta(dest("a", { last_success_at: "2026-10-17T11:57:00Z" }), 1, now)).toBe("Used by 1 connection · Last delivery 3 minutes ago");
    expect(cardMeta(dest("a", { last_success_at: "2026-10-17T09:00:00Z", last_error_at: "2026-10-17T11:00:00Z" }), 2, now))
      .toBe("Used by 2 connections · Last delivery failed 1 hour ago");
    expect(cardMeta(dest("a", { last_success_at: "2026-10-17T11:00:00Z", last_error_at: "2026-10-16T11:00:00Z" }), 2, now))
      .toBe("Used by 2 connections · Last delivery 1 hour ago");
    expect(cardMeta(dest("a", { last_error_at: "2026-10-15T12:00:00Z" }), 0, now)).toBe("Not used by any connection · Last delivery failed 2 days ago");
  });
});

describe("DestinationsPage", () => {
  it("shows the empty state and opens the add dialog from it", async () => {
    const { user } = render([]);
    expect(screen.getByText("Where matching spots are sent.")).toBeInTheDocument();
    expect(screen.getByText("No destinations yet.")).toBeInTheDocument();
    expect(listPushDevices).not.toHaveBeenCalled();
    expect(listDiscordDestinationSettings).not.toHaveBeenCalled();
    expect(listWebhookDestinationSettings).not.toHaveBeenCalled();
    expect(listLocalClusterDestinationSettings).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Add your first destination" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("shows a progress bar while loading", () => {
    render([], [], true);
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(screen.queryByText("No destinations yet.")).not.toBeInTheDocument();
  });

  it("shows a card per destination with its chip, type, URL and meta", () => {
    render(
      [
        dest("a", { health: "failing", consecutive_failures: 4, last_error: "HTTP 500", last_error_at: ago(120), last_success_at: ago(600) }),
        dest("b", { health: "paused", type: "discord", url_display: "discord.com/api/webhooks/1234…", last_success_at: ago(3) }),
        dest("c"),
      ],
      [sub("s1", ["a"]), sub("s2", ["a", "c"])],
    );
    expect(screen.getByText("Failing")).toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText("Discord channel")).toBeInTheDocument();
    expect(screen.getAllByText("Webhook")).toHaveLength(2);
    expect(screen.getByText("discord.com/api/webhooks/1234…")).toBeInTheDocument();
    expect(screen.getByText("Used by 2 connections · Last delivery failed 2 hours ago")).toBeInTheDocument();
    expect(screen.getByText("Not used by any connection · Last delivery 3 minutes ago")).toBeInTheDocument();
    expect(screen.getByText("Used by 1 connection · Never used")).toBeInTheDocument();
    // Every type has an editor now; Rotate moved into the webhook editor.
    expect(screen.queryByRole("button", { name: "Rotate secret" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Edit / })).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: /^Duplicate / })).toHaveLength(3);
  });

  it("shows each webhook card's field count and window from one settings list, and Paused while auto-disabled", async () => {
    vi.mocked(listWebhookDestinationSettings).mockResolvedValue([
      { destination_id: "w1", field_count: 11, batch_seconds: 0 },
      { destination_id: "w2", field_count: 1, batch_seconds: 30 },
    ]);
    const { user } = render([
      dest("w1", { name: "Logger" }),
      dest("w2", { name: "Batch", health: "failing", enabled: false, auto_disabled_at: ago(14) }),
      dest("w3", { name: "New" }),
      dest("d1", { type: "discord" }),
    ]);
    expect(await screen.findByText("Webhook · 11 fields")).toBeInTheDocument();
    expect(screen.getByText("Webhook · 1 field · grouped every 30 seconds")).toBeInTheDocument();
    // A card the list doesn't cover keeps the type name.
    expect(screen.getByText("Webhook")).toBeInTheDocument();
    expect(listWebhookDestinationSettings).toHaveBeenCalledTimes(1);
    expect(listDiscordDestinationSettings).toHaveBeenCalledTimes(1);
    expect(listPushDevices).not.toHaveBeenCalled();
    // The pause wins over failing health.
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getAllByText("Healthy")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Edit Logger" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Duplicate Logger" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit Batch" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/destinations/w2");
  });

  it("keeps the type name when the webhook settings fail to load", async () => {
    vi.mocked(listWebhookDestinationSettings).mockRejectedValue(new Error("Sign in again."));
    const { app } = render([dest("w1")]);
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Sign in again."));
    expect(screen.getByText("Webhook")).toBeInTheDocument();
  });

  it("duplicates a webhook into its editor", async () => {
    vi.mocked(duplicateDestination).mockResolvedValue("w9");
    const { user, app } = render([dest("w1", { name: "Logger" })]);
    await user.click(screen.getByRole("button", { name: "Duplicate Logger" }));
    expect(duplicateDestination).toHaveBeenCalledWith("w1");
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/destinations/w9"));
    expect(app.notify).toHaveBeenCalledWith("Duplicated Logger");
  });

  it("shows each Local DX cluster card's relay and Relay offline from one settings list, with no Send test", async () => {
    vi.mocked(listLocalClusterDestinationSettings).mockResolvedValue([
      { destination_id: "l1", relay_id: "r1", device_name: "Shack PC", platform: "windows", cluster_connected_at: ago(5), fields: ["reference"] },
      { destination_id: "l2", relay_id: "r2", device_name: "Laptop", platform: "macos", cluster_connected_at: null, fields: [] },
      { destination_id: "l3", relay_id: null, device_name: null, platform: null, cluster_connected_at: null, fields: ["reference"] },
    ]);
    const { user } = render([
      dest("l1", { type: "local_cluster", name: "Shack bandmap", url_display: "Long Lines Relay" }),
      dest("l2", { type: "local_cluster", name: "Portable", url_display: "Long Lines Relay" }),
      dest("l3", { type: "local_cluster", name: "Revoked", url_display: "Long Lines Relay" }),
      dest("w1", { name: "Logger" }),
    ]);
    expect(await screen.findByText("Local DX cluster · Shack PC")).toBeInTheDocument();
    expect(screen.getByText("Local DX cluster · Laptop")).toBeInTheDocument();
    // A revoked relay leaves the bare type, and is offline.
    expect(screen.getByText("Local DX cluster")).toBeInTheDocument();
    expect(screen.getAllByText("Relay offline")).toHaveLength(2);
    expect(screen.getAllByText("Healthy")).toHaveLength(2);
    expect(listLocalClusterDestinationSettings).toHaveBeenCalledTimes(1);
    // The relay is not a URL, and only the webhook has Send test.
    expect(screen.queryByText("Long Lines Relay")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Send test" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Edit Shack bandmap" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/destinations/l1");
  });

  it("keeps the type name when the Local DX cluster settings fail to load", async () => {
    vi.mocked(listLocalClusterDestinationSettings).mockRejectedValue({});
    const { app } = render([dest("l1", { type: "local_cluster", url_display: "Long Lines Relay" })]);
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Couldn't load your Local DX cluster settings."));
    expect(screen.getByText("Local DX cluster")).toBeInTheDocument();
    expect(screen.getByText("Healthy")).toBeInTheDocument();
  });

  it("shows each Discord card's style and field count from one settings list", async () => {
    vi.mocked(listDiscordDestinationSettings).mockResolvedValue([
      { destination_id: "d1", style: "card", field_count: 9 },
      { destination_id: "d2", style: "plain", field_count: 1 },
    ]);
    const { user } = render([
      dest("d1", { type: "discord", name: "Club" }), dest("d2", { type: "discord", name: "Quiet" }), dest("d3", { type: "discord", name: "New" }),
      dest("w"),
    ]);
    expect(await screen.findByText("Discord channel · Card · 9 fields")).toBeInTheDocument();
    expect(screen.getByText("Discord channel · Plain line · 1 field")).toBeInTheDocument();
    // A card the list doesn't cover keeps the type name.
    expect(screen.getByText("Discord channel")).toBeInTheDocument();
    expect(listDiscordDestinationSettings).toHaveBeenCalledTimes(1);
    expect(listPushDevices).not.toHaveBeenCalled();
    expect(screen.getAllByRole("button", { name: /^Edit / })).toHaveLength(4);
    expect(screen.getAllByRole("button", { name: /^Duplicate / })).toHaveLength(4);
    await user.click(screen.getByRole("button", { name: "Edit Club" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/destinations/d1");
  });

  it("keeps the type name when the Discord settings fail to load", async () => {
    vi.mocked(listDiscordDestinationSettings).mockRejectedValue(new Error("Sign in again."));
    const { app } = render([dest("d1", { type: "discord" })]);
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Sign in again."));
    expect(screen.getByText("Discord channel")).toBeInTheDocument();
  });

  it("duplicates a Discord destination into its editor", async () => {
    vi.mocked(duplicateDestination).mockResolvedValue("d9");
    const { user, app } = render([dest("d1", { type: "discord", name: "Club" })]);
    await user.click(screen.getByRole("button", { name: "Duplicate Club" }));
    expect(duplicateDestination).toHaveBeenCalledWith("d1");
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/destinations/d9"));
    expect(app.notify).toHaveBeenCalledWith("Duplicated Club");
  });

  it("shows the failing alert with a Send test action", async () => {
    vi.mocked(sendTest).mockResolvedValue({ status: null });
    const { user, app } = render(
      [dest("a", { health: "failing", consecutive_failures: 4, last_error: "HTTP 500", last_error_at: ago(1) })],
      [sub("s1", ["a"]), sub("s2", ["a"])],
    );
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Dest a is failing")).toBeInTheDocument();
    expect(alert).toHaveTextContent(
      "The last 4 deliveries returned HTTP 500. Spots for 2 connections are not being sent. Check the URL, then send a test.",
    );
    await user.click(within(alert).getByRole("button", { name: "Send test" }));
    expect(sendTest).toHaveBeenCalledWith("a");
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Test spot sent to Dest a"));
  });

  it("explains a disabled Delete in the singular", async () => {
    const { user } = render([dest("a")], [sub("s1", ["a"])]);
    const button = screen.getByRole("button", { name: "Delete Dest a" });
    expect(button).toBeDisabled();
    await user.hover(button.parentElement!);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Used by 1 connection. Remove it from them first.");
  });

  it("disables Delete for a used destination and explains why", async () => {
    const { user } = render([dest("a")], [sub("s1", ["a"]), sub("s2", ["a"])]);
    const button = screen.getByRole("button", { name: "Delete Dest a" });
    expect(button).toBeDisabled();
    await user.hover(button.parentElement!);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Used by 2 connections. Remove it from them first.");
  });

  it("renders push cards with their devices from one device list", async () => {
    vi.mocked(listPushDevices).mockResolvedValue([
      device("d1", { label: "Pixel", destination_ids: ["p", "q"] }),
      device("d2", { label: "Laptop", agent: "Firefox on Linux", blocked_at: "2026-10-16T00:00:00Z", destination_ids: ["p"] }),
      device("d3", { label: "Spare", destination_ids: [] }),
    ]);
    const { user } = render(
      [dest("p", { type: "push", name: "POTA phone", url_display: "Your devices" }), dest("q", { type: "push", name: "SOTA phone" }), dest("r", { type: "push", name: "Empty" })],
      [sub("s1", ["p"])],
    );
    await waitFor(() => expect(listPushDevices).toHaveBeenCalledTimes(1));
    expect(listPushDevices).toHaveBeenCalledWith(null);
    expect(await screen.findAllByText("Pixel")).toHaveLength(2);
    expect(screen.getByText("Laptop (blocked)")).toBeInTheDocument();
    expect(screen.queryByText("Spare")).not.toBeInTheDocument();
    expect(screen.getAllByText("Push notification")).toHaveLength(3);
    expect(screen.queryByText("Your devices")).not.toBeInTheDocument();
    expect(screen.getByText("1 device blocked")).toBeInTheDocument();
    expect(screen.getAllByText("Healthy")).toHaveLength(2);
    expect(screen.getByText("No devices yet")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Edit / })).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: /^Duplicate / })).toHaveLength(3);

    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Laptop cannot receive notifications")).toBeInTheDocument();
    expect(alert).toHaveTextContent(
      "Notifications are blocked for longlines.io in Firefox on Linux on that device. Allow them in the browser site settings, or remove the device from POTA phone.",
    );
    await user.click(within(alert).getByRole("button", { name: "Manage devices" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/destinations/p");
  });

  it("keeps Failing and Paused ahead of a blocked count", async () => {
    vi.mocked(listPushDevices).mockResolvedValue([device("d2", { label: "Laptop", blocked_at: "2026-10-16T00:00:00Z", destination_ids: ["p", "q"] })]);
    render([dest("p", { type: "push", name: "A", health: "failing", consecutive_failures: 2, last_error: "no devices" }), dest("q", { type: "push", name: "B", health: "paused" })]);
    await screen.findAllByRole("alert");
    expect(screen.getByText("Failing")).toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.queryByText("1 device blocked")).not.toBeInTheDocument();
  });

  it("names every destination a blocked device belongs to", async () => {
    vi.mocked(listPushDevices).mockResolvedValue([device("d2", { label: "Laptop", blocked_at: "2026-10-16T00:00:00Z", destination_ids: ["p", "q", "r"] })]);
    render([dest("p", { type: "push", name: "A" }), dest("q", { type: "push", name: "B" }), dest("r", { type: "push", name: "C" })]);
    expect(await screen.findByRole("alert")).toHaveTextContent("remove the device from A, B and C.");
    expect(screen.getAllByText("1 device blocked")).toHaveLength(3);
  });

  it("reports a failed device list", async () => {
    vi.mocked(listPushDevices).mockRejectedValue(new Error("Sign in again."));
    const { app } = render([dest("p", { type: "push" })]);
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Sign in again."));
  });

  it("opens the editor from Edit", async () => {
    const { user } = render([dest("p", { type: "push", name: "POTA phone" })]);
    // The names say which destination each button acts on.
    expect(screen.getByRole("button", { name: "Edit POTA phone" })).toHaveTextContent("Edit");
    await user.click(screen.getByRole("button", { name: "Edit POTA phone" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/destinations/p");
  });

  it("duplicates into a new editor", async () => {
    vi.mocked(duplicateDestination).mockResolvedValue("p2");
    const { user, app, reload } = render([dest("p", { type: "push", name: "POTA phone" })]);
    expect(screen.getByRole("button", { name: "Duplicate POTA phone" })).toHaveTextContent("Duplicate");
    await user.click(screen.getByRole("button", { name: "Duplicate POTA phone" }));
    expect(duplicateDestination).toHaveBeenCalledWith("p");
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/destinations/p2"));
    expect(app.notify).toHaveBeenCalledWith("Duplicated POTA phone");
    expect(reload).toHaveBeenCalled();
  });

  it("stacks the card actions on phones", async () => {
    setMobile(true);
    vi.mocked(listPushDevices).mockResolvedValue([device("d1", { label: "Pixel", destination_ids: ["p"] })]);
    render([dest("a"), dest("p", { type: "push" })]);
    expect(await screen.findByText("Pixel")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Send test" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Delete Dest a" })).toHaveClass("MuiButton-fullWidth");
  });

  it("sends a test and toasts a webhook receiver's status", async () => {
    vi.mocked(sendTest).mockResolvedValue({ status: 204 });
    const { user, app } = render([dest("a")]);
    await user.click(screen.getByRole("button", { name: "Send test" }));
    expect(sendTest).toHaveBeenCalledWith("a");
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Dest a answered HTTP 204."));
  });

  it("toasts a receiver's non-2xx status with the destination's name", async () => {
    vi.mocked(sendTest).mockRejectedValue(Object.assign(new Error("Webhook HTTP 500"), { code: "502", receiverStatus: 500 }));
    const { user, app } = render([dest("a")]);
    await user.click(screen.getByRole("button", { name: "Send test" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Dest a answered HTTP 500."));
    expect(app.notify).not.toHaveBeenCalledWith("Webhook HTTP 500");
  });

  it("sends a test without a status", async () => {
    vi.mocked(sendTest).mockResolvedValue({ status: null });
    const { user, app } = render([dest("d", { type: "discord" })]);
    await user.click(screen.getByRole("button", { name: "Send test" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Test spot sent to Dest d"));
  });

  it("reports action errors", async () => {
    vi.mocked(sendTest).mockRejectedValue(new Error("HTTP 404"));
    const { user, app } = render([dest("a")]);
    await user.click(screen.getByRole("button", { name: "Send test" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("HTTP 404"));
  });

  it("deletes an unused destination", async () => {
    vi.mocked(deleteDestination).mockResolvedValue(undefined);
    const { user, app, reload } = render([dest("a")]);
    await user.click(screen.getByRole("button", { name: "Delete Dest a" }));
    expect(deleteDestination).toHaveBeenCalledWith("a");
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Deleted Dest a"));
    expect(reload).toHaveBeenCalled();
  });

  it("opens the Discord editor from the add dialog", async () => {
    const { user } = render([]);
    await user.click(screen.getByRole("button", { name: "Add destination" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    expect(screen.getByTestId("location")).toHaveAttribute("data-search", "?type=discord");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("opens the webhook editor from the add dialog", async () => {
    const { user } = render([]);
    await user.click(screen.getByRole("button", { name: "Add destination" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: /^Webhook/ }));
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    expect(screen.getByTestId("location")).toHaveAttribute("data-search", "?type=webhook");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

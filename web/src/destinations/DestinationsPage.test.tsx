import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import { setMobile } from "../test/media";
import {
  createDestination, deleteDestination, duplicateDestination, listPushDevices, rotateSigningSecret, sendTest,
  type Destination, type PushDevice, type SubscriptionWithLinks,
} from "../lib/api";
import { cardMeta } from "./cardMeta";
import { DestinationsPage } from "./DestinationsPage";

vi.mock("../lib/api", () => ({
  createDestination: vi.fn(),
  deleteDestination: vi.fn(),
  duplicateDestination: vi.fn(),
  listPushDevices: vi.fn(),
  rotateSigningSecret: vi.fn(),
  sendTest: vi.fn(),
}));

function dest(id: string, overrides: Partial<Destination> = {}): Destination {
  return {
    id, user_id: "u1", type: "webhook", name: `Dest ${id}`, enabled: true, url_display: "https://example.com/…", health: "ok",
    consecutive_failures: 0, last_success_at: null, last_error: null, last_error_at: null, created_at: "2026-10-01T00:00:00Z",
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
  for (const fn of [createDestination, deleteDestination, duplicateDestination, listPushDevices, rotateSigningSecret, sendTest]) vi.mocked(fn).mockReset();
  vi.mocked(listPushDevices).mockResolvedValue([]);
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

  it("joins usage and the last delivery", () => {
    expect(cardMeta(dest("a"), 0, now)).toBe("not used by any subscription · Never used");
    expect(cardMeta(dest("a", { last_success_at: "2026-10-17T11:57:00Z" }), 1, now)).toBe("used by 1 subscription · Last delivery 3 minutes ago");
    expect(cardMeta(dest("a", { last_success_at: "2026-10-17T09:00:00Z", last_error_at: "2026-10-17T11:00:00Z" }), 2, now))
      .toBe("used by 2 subscriptions · Last delivery failed 1 hour ago");
    expect(cardMeta(dest("a", { last_success_at: "2026-10-17T11:00:00Z", last_error_at: "2026-10-16T11:00:00Z" }), 2, now))
      .toBe("used by 2 subscriptions · Last delivery 1 hour ago");
    expect(cardMeta(dest("a", { last_error_at: "2026-10-15T12:00:00Z" }), 0, now)).toBe("not used by any subscription · Last delivery failed 2 days ago");
  });
});

describe("DestinationsPage", () => {
  it("shows the empty state and opens the add dialog from it", async () => {
    const { user } = render([]);
    expect(screen.getByText("Where matching spots are sent.")).toBeInTheDocument();
    expect(screen.getByText("No destinations yet.")).toBeInTheDocument();
    expect(listPushDevices).not.toHaveBeenCalled();
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
    expect(screen.getByText("used by 2 subscriptions · Last delivery failed 2 hours ago")).toBeInTheDocument();
    expect(screen.getByText("not used by any subscription · Last delivery 3 minutes ago")).toBeInTheDocument();
    expect(screen.getByText("used by 1 subscription · Never used")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Rotate secret" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Duplicate" })).not.toBeInTheDocument();
  });

  it("shows the failing alert with a Send test action", async () => {
    vi.mocked(sendTest).mockResolvedValue(undefined);
    const { user, app } = render(
      [dest("a", { health: "failing", consecutive_failures: 4, last_error: "HTTP 500", last_error_at: ago(1) })],
      [sub("s1", ["a"]), sub("s2", ["a"])],
    );
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Dest a is failing")).toBeInTheDocument();
    expect(alert).toHaveTextContent(
      "The last 4 deliveries returned HTTP 500. Spots for 2 subscriptions are not being sent. Check the URL, then send a test.",
    );
    await user.click(within(alert).getByRole("button", { name: "Send test" }));
    expect(sendTest).toHaveBeenCalledWith("a");
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Test spot sent to Dest a"));
  });

  it("disables Delete for a used destination and explains why", async () => {
    const { user } = render([dest("a")], [sub("s1", ["a"]), sub("s2", ["a"])]);
    const button = screen.getByRole("button", { name: "Delete Dest a" });
    expect(button).toBeDisabled();
    await user.hover(button.parentElement!);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Used by 2 subscriptions. Remove it from them first.");
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
    expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: "Duplicate" })).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Rotate secret" })).not.toBeInTheDocument();

    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Laptop cannot receive notifications")).toBeInTheDocument();
    expect(alert).toHaveTextContent(
      "Notifications are blocked for longlines.io in Firefox on Linux on that device. Allow them in the browser site settings, or remove the device from POTA phone.",
    );
    await user.click(within(alert).getByRole("button", { name: "Manage devices" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/destinations/p");
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
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/destinations/p");
  });

  it("duplicates into a new editor", async () => {
    vi.mocked(duplicateDestination).mockResolvedValue("p2");
    const { user, app, reload } = render([dest("p", { type: "push", name: "POTA phone" })]);
    await user.click(screen.getByRole("button", { name: "Duplicate" }));
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

  it("sends a test", async () => {
    vi.mocked(sendTest).mockResolvedValue(undefined);
    const { user, app } = render([dest("a")]);
    await user.click(screen.getByRole("button", { name: "Send test" }));
    expect(sendTest).toHaveBeenCalledWith("a");
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Test spot sent to Dest a"));
  });

  it("reports action errors", async () => {
    vi.mocked(sendTest).mockRejectedValue(new Error("HTTP 404"));
    const { user, app } = render([dest("a")]);
    await user.click(screen.getByRole("button", { name: "Send test" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("HTTP 404"));
  });

  it("rotates a webhook secret and shows it once", async () => {
    vi.mocked(rotateSigningSecret).mockResolvedValue("whsec_rotated");
    const { user } = render([dest("a")]);
    await user.click(screen.getByRole("button", { name: "Rotate secret" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Signing secret for Dest a")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Signing secret")).toHaveValue("whsec_rotated");
    await user.click(within(dialog).getByLabelText("Signing secret"));
    // Only Done closes it: the secret can't be shown again.
    await user.keyboard("{Escape}");
    await user.click(document.querySelector(".MuiBackdrop-root:not(.MuiBackdrop-invisible)")!);
    expect(screen.getByLabelText("Signing secret")).toHaveValue("whsec_rotated");
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("deletes an unused destination", async () => {
    vi.mocked(deleteDestination).mockResolvedValue(undefined);
    const { user, app, reload } = render([dest("a")]);
    await user.click(screen.getByRole("button", { name: "Delete Dest a" }));
    expect(deleteDestination).toHaveBeenCalledWith("a");
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Deleted Dest a"));
    expect(reload).toHaveBeenCalled();
  });

  it("adds a webhook destination and shows its signing secret", async () => {
    vi.mocked(createDestination).mockResolvedValue({ id: "n", type: "webhook", name: "Hook", url_display: "x", signing_secret: "whsec_1" });
    const { user, app, reload } = render([]);
    await user.click(screen.getByRole("button", { name: "Add destination" }));
    const dialog = await screen.findByRole("dialog");
    const add = within(dialog).getByRole("button", { name: "Add destination" });
    expect(add).toBeDisabled();
    await user.click(within(dialog).getByLabelText("Webhook"));
    await user.type(within(dialog).getByLabelText("Name"), "Hook");
    await user.type(within(dialog).getByLabelText("Endpoint URL"), " https://example.com/spots ");
    await user.click(add);
    expect(createDestination).toHaveBeenCalledWith("webhook", "Hook", "https://example.com/spots");
    expect(await screen.findByText("Signing secret for Hook")).toBeInTheDocument();
    expect(app.notify).toHaveBeenCalledWith("Added Hook");
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it("names a Discord destination after its type when left blank", async () => {
    vi.mocked(createDestination).mockResolvedValue({ id: "n", type: "discord", name: "Discord channel", url_display: "x", signing_secret: null });
    const { user, app } = render([]);
    await user.click(screen.getByRole("button", { name: "Add destination" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Discord webhook URL"), "https://discord.com/api/webhooks/1/x");
    await user.click(within(dialog).getByRole("button", { name: "Add destination" }));
    expect(createDestination).toHaveBeenCalledWith("discord", "Discord channel", "https://discord.com/api/webhooks/1/x");
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Added Discord channel"));
    expect(screen.queryByText(/Signing secret for/)).not.toBeInTheDocument();
  });

  it("shows create errors in the dialog and can be cancelled", async () => {
    vi.mocked(createDestination).mockRejectedValue(new Error("That URL isn't a Discord webhook."));
    const { user } = render([]);
    await user.click(screen.getByRole("button", { name: "Add destination" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Discord webhook URL"), "https://nope");
    await user.click(within(dialog).getByRole("button", { name: "Add destination" }));
    expect(await within(dialog).findByText("That URL isn't a Discord webhook.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

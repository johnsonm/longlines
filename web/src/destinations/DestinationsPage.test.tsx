import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import { createDestination, deleteDestination, rotateSigningSecret, sendTest, type Destination, type SubscriptionWithLinks } from "../lib/api";
import { DestinationsPage } from "./DestinationsPage";

vi.mock("../lib/api", () => ({
  createDestination: vi.fn(),
  deleteDestination: vi.fn(),
  rotateSigningSecret: vi.fn(),
  sendTest: vi.fn(),
}));

function dest(id: string, overrides: Partial<Destination> = {}): Destination {
  return {
    id, user_id: "u1", type: "webhook", name: `Dest ${id}`, url_display: "https://example.com/…", health: "ok",
    consecutive_failures: 0, last_success_at: null, last_error: null, last_error_at: null, created_at: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

const sub = (id: string, destinations: string[]) => ({ id, destinations }) as SubscriptionWithLinks;

beforeEach(() => {
  for (const fn of [createDestination, deleteDestination, rotateSigningSecret, sendTest]) vi.mocked(fn).mockReset();
});

function render(dests: Destination[], subs: SubscriptionWithLinks[] = [], loading = false) {
  const reload = vi.fn(() => Promise.resolve());
  const r = renderPage(<DestinationsPage dests={dests} subs={subs} loading={loading} reload={reload} />, {
    route: "/destinations",
    tour: { destinationId: "a" },
  });
  return { ...r, reload };
}

describe("DestinationsPage", () => {
  it("shows the empty state and opens the add dialog from it", async () => {
    const { user, tour } = render([]);
    expect(screen.getByText("No destinations yet.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add your first destination" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(tour.report).toHaveBeenCalledWith("destination-dialog-opened");
  });

  it("shows a progress bar while loading", () => {
    render([], [], true);
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(screen.queryByText("No destinations yet.")).not.toBeInTheDocument();
  });

  it("lists health, usage and a failing warning", () => {
    render(
      [dest("a", { health: "failing", consecutive_failures: 4 }), dest("b", { health: "paused", type: "discord" }), dest("c")],
      [sub("s1", ["a"]), sub("s2", ["a", "c"])],
    );
    expect(screen.getByText("Failing")).toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText("Used by 2 subscriptions")).toBeInTheDocument();
    expect(screen.getByText("Used by 1 subscription")).toBeInTheDocument();
    expect(screen.getByText(/Dest a has returned errors for the last 4 deliveries/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Dest a" })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Rotate secret" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Send test" })[0]).toHaveAttribute("data-tour", "send-test");
  });

  it("sends a test and reports it to the tour", async () => {
    vi.mocked(sendTest).mockResolvedValue(undefined);
    const { user, app, tour } = render([dest("a")]);
    await user.click(screen.getByRole("button", { name: "Send test" }));
    expect(sendTest).toHaveBeenCalledWith("a");
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Test spot sent to Dest a"));
    expect(tour.report).toHaveBeenCalledWith("test-sent");
  });

  it("reports action errors", async () => {
    vi.mocked(sendTest).mockRejectedValue(new Error("HTTP 404"));
    const { user, app } = render([dest("a")]);
    await user.click(screen.getByRole("button", { name: "Send test" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("HTTP 404"));
  });

  it("rotates a webhook secret and shows it once", async () => {
    vi.mocked(rotateSigningSecret).mockResolvedValue("whsec_rotated");
    const { user, tour } = render([dest("a")]);
    await user.click(screen.getByRole("button", { name: "Rotate secret" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Signing secret for Dest a")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Signing secret")).toHaveValue("whsec_rotated");
    await user.click(within(dialog).getByLabelText("Signing secret"));
    // Only Done closes it: the secret can't be shown again.
    await user.keyboard("{Escape}");
    await user.click(document.querySelector(".MuiBackdrop-root:not(.MuiBackdrop-invisible)")!);
    expect(screen.getByLabelText("Signing secret")).toHaveValue("whsec_rotated");
    expect(tour.report).not.toHaveBeenCalledWith("secret-dismissed");
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(tour.report).toHaveBeenCalledWith("secret-dismissed");
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
    const { user, app, tour, reload } = render([]);
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
    expect(tour.report).toHaveBeenCalledWith("destination-created", { destinationId: "n", secret: true });
    expect(app.notify).toHaveBeenCalledWith("Added Hook");
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it("names a Discord destination after its type when left blank", async () => {
    vi.mocked(createDestination).mockResolvedValue({ id: "n", type: "discord", name: "Discord channel", url_display: "x", signing_secret: null });
    const { user, tour } = render([]);
    await user.click(screen.getByRole("button", { name: "Add destination" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Discord webhook URL"), "https://discord.com/api/webhooks/1/x");
    await user.click(within(dialog).getByRole("button", { name: "Add destination" }));
    expect(createDestination).toHaveBeenCalledWith("discord", "Discord channel", "https://discord.com/api/webhooks/1/x");
    await waitFor(() => expect(tour.report).toHaveBeenCalledWith("destination-created", { destinationId: "n", secret: false }));
    expect(screen.queryByText(/Signing secret for/)).not.toBeInTheDocument();
  });

  it("shows create errors in the dialog and can be cancelled", async () => {
    vi.mocked(createDestination).mockRejectedValue(new Error("That URL isn't a Discord webhook."));
    const { user, tour } = render([]);
    await user.click(screen.getByRole("button", { name: "Add destination" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Discord webhook URL"), "https://nope");
    await user.click(within(dialog).getByRole("button", { name: "Add destination" }));
    expect(await within(dialog).findByText("That URL isn't a Discord webhook.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(tour.report).toHaveBeenCalledWith("destination-dialog-closed");
  });
});
